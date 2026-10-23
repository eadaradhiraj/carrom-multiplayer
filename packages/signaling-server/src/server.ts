// Minimal WebSocket signaling server (SPEC.md section 2).
//
// Responsibility is deliberately narrow: track room membership and relay
// SDP offers/answers and ICE candidates between peers in the same room.
// It has no knowledge of game state or the message protocol used once
// peers are connected (see packages/client/src/network/protocol.ts) —
// once WebRTC connections are up, this server is out of the loop entirely.

import { WebSocketServer, WebSocket } from "ws";

const MAX_PEERS_PER_ROOM = 4; // SPEC.md constraint: 2-4 players

interface Room {
  peers: Map<string, WebSocket>;
  order: string[]; // join order — client uses this for host election + turn order
}

const rooms = new Map<string, Room>();

// Reverse lookup so we can clean up on socket close without the client
// having to tell us again which room/peerId it was.
const socketInfo = new WeakMap<WebSocket, { roomCode: string; peerId: string }>();

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case "join":
        handleJoin(ws, msg.roomCode, msg.peerId);
        break;
      case "offer":
      case "answer":
      case "ice_candidate":
        relay(ws, msg);
        break;
    }
  });

  ws.on("close", () => {
    const info = socketInfo.get(ws);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;

    room.peers.delete(info.peerId);
    room.order = room.order.filter((id) => id !== info.peerId);

    for (const peerWs of room.peers.values()) {
      send(peerWs, { type: "peer_left", peerId: info.peerId });
    }
    if (room.peers.size === 0) rooms.delete(info.roomCode);
  });
});

function handleJoin(ws: WebSocket, roomCode: string, peerId: string) {
  let room = rooms.get(roomCode);
  if (!room) {
    room = { peers: new Map(), order: [] };
    rooms.set(roomCode, room);
  }

  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    send(ws, { type: "room_full" });
    return;
  }

  room.peers.set(peerId, ws);
  room.order.push(peerId);
  socketInfo.set(ws, { roomCode, peerId });

  // Tell the new peer the full current membership (including itself) so
  // it can determine the host (first in join order) and turn order —
  // see RoomManager.handleRoomState on the client.
  send(ws, { type: "room_state", peers: [...room.order] });

  // Tell everyone else a new peer joined so the host (or whoever needs to)
  // can open a connection to them.
  for (const [existingPeerId, peerWs] of room.peers) {
    if (existingPeerId !== peerId) {
      send(peerWs, { type: "peer_joined", peerId });
    }
  }
}

function relay(ws: WebSocket, msg: { type: string; toPeerId: string; [key: string]: unknown }) {
  const info = socketInfo.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  if (!room) return;

  const target = room.peers.get(msg.toPeerId);
  if (!target) return;

  const { toPeerId, ...rest } = msg;
  send(target, { ...rest, fromPeerId: info.peerId });
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

console.log("Signaling server listening on ws://localhost:8080");
