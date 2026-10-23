// WebSocket client for the signaling server (packages/signaling-server).
// Only used during connection setup — never in the gameplay hot path
// (SPEC.md section 2). Relays SDP offers/answers and ICE candidates
// between peers in a room, and tells us who's in the room.

type SignalingEvent =
  | { type: "peer_joined"; peerId: string }
  | { type: "peer_left"; peerId: string }
  | { type: "room_state"; peers: string[] }
  | { type: "offer"; fromPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; fromPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; fromPeerId: string; candidate: RTCIceCandidateInit };

type Listener<T> = (payload: T) => void;

export class SignalingClient {
  private ws: WebSocket;
  private ready: Promise<void>;

  private peerJoinedListeners: Listener<{ peerId: string }>[] = [];
  private peerLeftListeners: Listener<{ peerId: string }>[] = [];
  private roomStateListeners: Listener<{ peers: string[] }>[] = [];
  private offerListeners: Listener<{ fromPeerId: string; sdp: RTCSessionDescriptionInit }>[] = [];
  private answerListeners: Listener<{ fromPeerId: string; sdp: RTCSessionDescriptionInit }>[] = [];
  private iceListeners: Listener<{ fromPeerId: string; candidate: RTCIceCandidateInit }>[] = [];

  constructor(serverUrl: string) {
    this.ws = new WebSocket(serverUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", (e) => reject(e), { once: true });
    });

    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data) as SignalingEvent;
      switch (msg.type) {
        case "peer_joined":
          this.peerJoinedListeners.forEach((cb) => cb({ peerId: msg.peerId }));
          break;
        case "peer_left":
          this.peerLeftListeners.forEach((cb) => cb({ peerId: msg.peerId }));
          break;
        case "room_state":
          this.roomStateListeners.forEach((cb) => cb({ peers: msg.peers }));
          break;
        case "offer":
          this.offerListeners.forEach((cb) => cb({ fromPeerId: msg.fromPeerId, sdp: msg.sdp }));
          break;
        case "answer":
          this.answerListeners.forEach((cb) => cb({ fromPeerId: msg.fromPeerId, sdp: msg.sdp }));
          break;
        case "ice_candidate":
          this.iceListeners.forEach((cb) =>
            cb({ fromPeerId: msg.fromPeerId, candidate: msg.candidate }),
          );
          break;
      }
    });
  }

  async waitUntilOpen() {
    await this.ready;
  }

  async joinRoom(roomCode: string, peerId: string) {
    await this.ready;
    this.send({ type: "join", roomCode, peerId });
  }

  sendOffer(toPeerId: string, sdp: RTCSessionDescriptionInit) {
    this.send({ type: "offer", toPeerId, sdp });
  }

  sendAnswer(toPeerId: string, sdp: RTCSessionDescriptionInit) {
    this.send({ type: "answer", toPeerId, sdp });
  }

  sendIceCandidate(toPeerId: string, candidate: RTCIceCandidateInit) {
    this.send({ type: "ice_candidate", toPeerId, candidate });
  }

  onPeerJoined(cb: Listener<{ peerId: string }>) {
    this.peerJoinedListeners.push(cb);
  }
  onPeerLeft(cb: Listener<{ peerId: string }>) {
    this.peerLeftListeners.push(cb);
  }
  onRoomState(cb: Listener<{ peers: string[] }>) {
    this.roomStateListeners.push(cb);
  }
  onOffer(cb: Listener<{ fromPeerId: string; sdp: RTCSessionDescriptionInit }>) {
    this.offerListeners.push(cb);
  }
  onAnswer(cb: Listener<{ fromPeerId: string; sdp: RTCSessionDescriptionInit }>) {
    this.answerListeners.push(cb);
  }
  onIceCandidate(cb: Listener<{ fromPeerId: string; candidate: RTCIceCandidateInit }>) {
    this.iceListeners.push(cb);
  }

  private send(payload: unknown) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    this.ws.close();
  }
}

export function connectSignaling(serverUrl: string): SignalingClient {
  return new SignalingClient(serverUrl);
}
