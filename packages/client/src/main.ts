// Entry point. Wires together: rendering (always local), networking
// (RoomManager: signaling + peer connections + host election/migration),
// and the host-simulation module (active only on whichever peer currently
// holds host_epoch).
//
// See SPEC.md for the full design. Build order per SPEC.md section 8 — if
// you're validating physics feel first, you can temporarily bypass all of
// this and drive renderer.ts from a local Simulation directly.

import { setAim, setBaseline, setDiscs, startRenderLoop, type AimState } from "./render/renderer";
import { RoomManager } from "./network/room-manager";
import { HostSimulation } from "./host/host-simulation";
import { InterpolationBuffer } from "./state/interpolation";
import type { DiscState } from "./network/protocol";

const SIGNALING_URL = "ws://localhost:8080";

async function main() {
  const canvas = document.getElementById("board") as HTMLCanvasElement;
  startRenderLoop(canvas);

  const roomCode = prompt("Room code:") ?? "default-room";
  const myPeerId = crypto.randomUUID();

  // Lobby UI elements
  const roomCodeEl = document.getElementById("room-code")!;
  const roleBadgeEl = document.getElementById("role-badge")!;
  const playerListEl = document.getElementById("player-list")!;
  const playerCountEl = document.getElementById("player-count")!;
  const reconnectBannerEl = document.getElementById("reconnect-banner")!;
  roomCodeEl.textContent = roomCode;

  function updateLobby(playerOrder: string[], amIHost: boolean, hostId: string | null) {
    setBaseline(playerOrder, room.getCurrentPlayerId());
    const gracePeers = room ? room.getGracePeers() : [];
    playerCountEl.textContent = String(playerOrder.length);
    roleBadgeEl.textContent = amIHost ? "HOST" : "CLIENT";
    roleBadgeEl.style.background = amIHost ? "#2d6a4f" : "#444";
    playerListEl.innerHTML = "";
    for (const pid of playerOrder) {
      const li = document.createElement("li");
      const isMe = pid === myPeerId;
      const isHost = pid === hostId;
      const isGrace = gracePeers.includes(pid);
      const isCurrentTurn = pid === room.getCurrentPlayerId();
      li.style.padding = "4px 0";
      li.style.opacity = isGrace ? "0.5" : isMe ? "1" : "0.85";
      let label = `${pid.slice(0, 6)}${isMe ? " (you)" : ""}${isHost ? " 👑" : ""}`;
      if (isCurrentTurn) label += " ▶";
      if (isGrace) label += " (reconnecting…)";
      li.textContent = label;
      if (isGrace) li.style.fontStyle = "italic";
      playerListEl.appendChild(li);
    }
  }

  function updatePauseOverlay(gracePeers: string[], isPaused: boolean, waitingFor: string | null) {
    if (isPaused && waitingFor) {
      reconnectBannerEl.style.display = "block";
      reconnectBannerEl.textContent = `⏸ Paused — waiting for ${waitingFor.slice(0, 6)} to reconnect (${gracePeers.length} pending)…`;
      canvas.style.opacity = "0.6";
      canvas.style.pointerEvents = "none";
    } else if (gracePeers.length > 0) {
      reconnectBannerEl.style.display = "block";
      reconnectBannerEl.textContent = `⚠ ${gracePeers.map((id) => id.slice(0, 6)).join(", ")} reconnecting… game continues`;
      canvas.style.opacity = "1";
      canvas.style.pointerEvents = "auto";
    } else {
      reconnectBannerEl.style.display = "none";
      canvas.style.opacity = "1";
      canvas.style.pointerEvents = "auto";
    }
  }

  const interpolation = new InterpolationBuffer();
  let hostSim: HostSimulation | null = null;
  let amIHost = false;

  const room = new RoomManager(SIGNALING_URL, roomCode, myPeerId, {
    onRoleChange: ({ amIHost: nowHost }) => {
      amIHost = nowHost;
      updateLobby(room.getPlayerOrder(), amIHost, room.getHostId());
      if (amIHost) {
        const lastDiscs = room.getLastKnownDiscs();
        const lastPlayerId = room.getCurrentPlayerId();
        hostSim = new HostSimulation(
          room.getPlayerOrder(),
          (discs) => {
            room.broadcastSnapshot(discs);
            setDiscs(discs);
          },
          (result) => {
            room.broadcastShotResolved(result);
            setDiscs(result.discs);
          },
        );
        hostSim.waitUntilReady().then(() => {
          if (lastDiscs.length > 0) {
            hostSim!.seedFromLastKnownState(lastDiscs, room.getPlayerOrder(), lastPlayerId);
          }
          requestAnimationFrame(hostLoop);
        });
      } else {
        hostSim = null;
        interpolation.reset();
      }
    },
    onSnapshot: (discs) => {
      if (!amIHost) interpolation.addSnapshot(discs, Date.now());
    },
    onShotResolved: (msg) => {
      if (!amIHost) setDiscs(msg.discs);
      setBaseline(room.getPlayerOrder(), msg.nextPlayerId);
    },
    onFullResync: (msg) => {
      interpolation.reset();
      setDiscs(msg.discs);
      setBaseline(msg.playerOrder, msg.currentPlayerId);
    },
    onShotInput: (_playerId, angle, power) => {
      hostSim?.applyShot(angle, power);
    },
    onStrikerMoved: (_playerId, x, y) => {
      hostSim?.setStrikerPosition(x, y);
    },
    onPlayersChanged: (playerOrder) => {
      updateLobby(playerOrder, room.isHost(), room.getHostId());
    },
    onGraceChanged: (gracePeers, isPaused, waitingFor) => {
      updatePauseOverlay(gracePeers, isPaused, waitingFor);
      updateLobby(room.getPlayerOrder(), room.isHost(), room.getHostId());
      if (hostSim) hostSim.syncPlayerState(room.getPlayerOrder(), room.getCurrentPlayerId());
    },
    onPlayerForfeited: (peerId, nextPlayerId) => {
      console.log(`Player ${peerId.slice(0, 6)} forfeited, next: ${nextPlayerId.slice(0, 6)}`);
      if (hostSim) hostSim.syncPlayerState(room.getPlayerOrder(), nextPlayerId);
      updateLobby(room.getPlayerOrder(), room.isHost(), room.getHostId());
    },
  });

  await room.join();

  function hostLoop(now: number) {
    hostSim?.update(now);
    if (hostSim && amIHost) setDiscs(hostSim.getSnapshot()); // 60fps local smooth, broadcast still throttled at 25Hz inside HostSimulation
    requestAnimationFrame(hostLoop);
  }

  function nonHostRenderTick() {
    if (!amIHost) setDiscs(interpolation.getInterpolatedState(Date.now()));
    requestAnimationFrame(nonHostRenderTick);
  }
  requestAnimationFrame(nonHostRenderTick);

  setupAimInput(canvas, room, () => amIHost, () => hostSim);
}

/** Local-only aim/power input (drag to aim, release to shoot). Never waits
 * on the network — SPEC.md section 4: the shooter's own aim must feel
 * instant regardless of host-authoritative resolution. */
function setupAimInput(
  canvas: HTMLCanvasElement,
  room: RoomManager,
  isHost: () => boolean,
  getHostSim: () => HostSimulation | null,
) {
  let dragging = false;
  let strikerX = canvas.width / 2;
  let strikerY = canvas.height - 60;

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    const rect = canvas.getBoundingClientRect();
    strikerX = e.clientX - rect.left;
    strikerY = e.clientY - rect.top;
    room.sendStrikerPosition(strikerX, strikerY);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - strikerX;
    const dy = e.clientY - rect.top - strikerY;
    const angle = Math.atan2(dy, dx);
    const power = Math.min(1, Math.hypot(dx, dy) / 150);
    const aim: AimState = { strikerX, strikerY, angle, power };
    setAim(aim);
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - strikerX;
    const dy = e.clientY - rect.top - strikerY;
    // Shoot in the direction opposite the drag (pull back, then release),
    // matching the usual carrom/pool-style input convention.
    const angle = Math.atan2(dy, dx) + Math.PI;
    const power = Math.min(1, Math.hypot(dx, dy) / 150);
    setAim(null);

    if (isHost()) {
      getHostSim()?.applyShot(angle, power);
    } else {
      room.sendShotInput(angle, power);
    }
  });
}

main();
