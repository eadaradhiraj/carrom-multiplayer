// Orchestrates room join, star-topology connection setup, host election,
// host migration, and reconnect (SPEC.md sections 2, 6, 7). This is the
// glue between signaling.ts / peer-connection.ts and the game logic in
// main.ts / host-simulation.ts / interpolation.ts.
//
// Design principle carried over from SPEC.md: never try to be clever about
// partial state transfer. Any time a connection to the host is (re-)
// established, the host just sends a fresh `full_resync`. That single
// mechanism covers first join, reconnect, and post-migration resync.

import { PeerConnection } from "./peer-connection";
import { connectSignaling, SignalingClient } from "./signaling";
import type {
  DiscState,
  FullResyncMessage,
  HeartbeatMessage,
  HostMigratedMessage,
  ReliableMessage,
  ShotInputMessage,
  ShotResolvedMessage,
  StateSnapshotMessage,
  StrikerPositionMessage,
  UnreliableMessage,
} from "./protocol";

const HOST_HEARTBEAT_INTERVAL_MS = 1000;
const HOST_TIMEOUT_MS = 3000; // SPEC.md section 6: ~2-3s
const RECONNECT_GRACE_MS = 20000; // SPEC.md section 7: 15-30s grace before forfeit

export interface RoomManagerHandlers {
  /** Fires once with the initial role; also fires again after migration. */
  onRoleChange: (info: { amIHost: boolean; hostEpoch: number }) => void;
  onSnapshot: (discs: DiscState[]) => void;
  onShotResolved: (msg: ShotResolvedMessage) => void;
  onFullResync: (msg: FullResyncMessage) => void;
  /** Host side only: another player's shot input arrived. */
  onShotInput: (playerId: string, angle: number, power: number) => void;
  onStrikerMoved: (playerId: string, x: number, y: number) => void;
  onPlayersChanged: (playerOrder: string[]) => void;
  onGraceChanged?: (gracePeers: string[], isPaused: boolean, waitingFor: string | null) => void;
  onPlayerForfeited?: (peerId: string, nextPlayerId: string) => void;
}

export class RoomManager {
  private signaling: SignalingClient;
  private peers = new Map<string, PeerConnection>();
  private playerOrder: string[] = [];
  private hostEpoch = 0;
  private amIHost = false;
  private currentHostId: string | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private hostWatchdogTimer?: ReturnType<typeof setTimeout>;
  private reconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Peers in grace period — still in playerOrder but RTC disconnected, awaiting reconnect. */
  private gracePeers = new Set<string>();

  /** Host keeps the last broadcast disc state so a promoted backup has
   * something to resync from (SPEC.md section 6, "standing backup"). */
  private lastKnownDiscs: DiscState[] = [];
  private currentPlayerId = "";

  constructor(
    private serverUrl: string,
    private roomCode: string,
    private myPeerId: string,
    private handlers: RoomManagerHandlers,
  ) {
    this.signaling = connectSignaling(serverUrl);
    this.wireSignaling();
  }

  async join() {
    await this.signaling.waitUntilOpen();
    await this.signaling.joinRoom(this.roomCode, this.myPeerId);
  }

  isHost() {
    return this.amIHost;
  }

  getHostEpoch() {
    return this.hostEpoch;
  }

  getPlayerOrder() {
    return [...this.playerOrder];
  }

  getHostId() {
    return this.currentHostId;
  }

  getLastKnownDiscs(): DiscState[] {
    return [...this.lastKnownDiscs];
  }

  getCurrentPlayerId(): string {
    return this.currentPlayerId;
  }

  getGracePeers(): string[] {
    return [...this.gracePeers];
  }

  isPaused(): boolean {
    return this.gracePeers.has(this.currentPlayerId) && this.currentPlayerId !== "";
  }

  // --- Outbound game messages ---

  /** Non-host: send a shot to the host. */
  sendShotInput(angle: number, power: number) {
    const host = this.currentHostId ? this.peers.get(this.currentHostId) : undefined;
    host?.sendReliable({ type: "shot_input", playerId: this.myPeerId, angle, power });
    this.resetHostWatchdog();
  }

  sendStrikerPosition(x: number, y: number) {
    const host = this.currentHostId ? this.peers.get(this.currentHostId) : undefined;
    host?.sendReliable({ type: "striker_position", playerId: this.myPeerId, x, y });
  }

  /** Host: broadcast a snapshot to every connected peer. */
  broadcastSnapshot(discs: DiscState[]) {
    this.lastKnownDiscs = discs;
    const msg: StateSnapshotMessage = {
      type: "state_snapshot",
      hostEpoch: this.hostEpoch,
      timestamp: Date.now(),
      discs,
    };
    for (const peer of this.peers.values()) peer.sendUnreliable(msg);
  }

  /** Host: broadcast that a shot has resolved (SPEC.md section 5). */
  broadcastShotResolved(msg: Omit<ShotResolvedMessage, "type" | "hostEpoch">) {
    this.currentPlayerId = msg.nextPlayerId;
    const full: ShotResolvedMessage = { type: "shot_resolved", hostEpoch: this.hostEpoch, ...msg };
    for (const peer of this.peers.values()) peer.sendReliable(full);
  }

  // --- Signaling wiring ---

  private wireSignaling() {
    this.signaling.onRoomState(({ peers }) => this.handleRoomState(peers));
    this.signaling.onPeerJoined(({ peerId }) => this.handlePeerJoined(peerId));
    this.signaling.onPeerLeft(({ peerId }) => this.handlePeerLeft(peerId));

    this.signaling.onOffer(async ({ fromPeerId, sdp }) => {
      let pc = this.peers.get(fromPeerId);
      if (!pc) pc = this.createPeerConnection(fromPeerId, /* isInitiator */ false);
      await pc.handleOffer(sdp);
    });
    this.signaling.onAnswer(async ({ fromPeerId, sdp }) => {
      await this.peers.get(fromPeerId)?.handleAnswer(sdp);
    });
    this.signaling.onIceCandidate(async ({ fromPeerId, candidate }) => {
      await this.peers.get(fromPeerId)?.handleIceCandidate(candidate);
    });
  }

  private handleRoomState(peers: string[]) {
    // Join-order list doubles as the migration fallback order (SPEC.md
    // section 6) and initial turn order.
    this.playerOrder = peers;
    this.currentHostId = peers[0] ?? this.myPeerId;
    this.amIHost = this.currentHostId === this.myPeerId;
    this.currentPlayerId = this.playerOrder[0];

    if (this.amIHost) {
      // Connect out to everyone already in the room; wait for their offers
      // (they connect in, since the star topology centers on the host).
      for (const peerId of peers) {
        if (peerId !== this.myPeerId && !this.peers.has(peerId)) {
          this.createPeerConnection(peerId, /* isInitiator */ false);
        }
      }
      this.startHeartbeat();
    } else {
      this.createPeerConnection(this.currentHostId, /* isInitiator */ true);
      this.resetHostWatchdog();
    }

    this.handlers.onRoleChange({ amIHost: this.amIHost, hostEpoch: this.hostEpoch });
    this.handlers.onPlayersChanged(this.playerOrder);
  }

  private handlePeerJoined(peerId: string) {
    // If peer was in grace period, cancel forfeit and restore connection
    if (this.gracePeers.has(peerId)) {
      clearTimeout(this.reconnectGraceTimers.get(peerId));
      this.reconnectGraceTimers.delete(peerId);
      this.gracePeers.delete(peerId);
      // playerOrder already contains them — just re-establish RTC if we're host
      if (this.amIHost && !this.peers.has(peerId)) {
        this.createPeerConnection(peerId, /* isInitiator */ false);
      }
      this.handlers.onPlayersChanged(this.playerOrder);
      this.notifyGraceChanged();
      return;
    }

    if (!this.playerOrder.includes(peerId)) this.playerOrder.push(peerId);
    if (this.amIHost && !this.peers.has(peerId)) {
      this.createPeerConnection(peerId, /* isInitiator */ false);
    }
    this.handlers.onPlayersChanged(this.playerOrder);
    // Non-host peers don't need a direct connection to other non-host
    // peers in a star topology — they only track them for turn order and
    // as future migration candidates.
  }

  private handlePeerLeft(peerId: string) {
    // Signaling-detected leave — treat as disconnect with grace period for
    // non-host peers (SPEC.md §7), immediate for host (triggers migration).
    this.handlePeerDisconnected(peerId);
  }

  private createPeerConnection(peerId: string, isInitiator: boolean): PeerConnection {
    const pc = new PeerConnection(peerId, isInitiator, this.signaling, {
      onReliableMessage: (msg) => this.handleReliableMessage(peerId, msg),
      onUnreliableMessage: (msg) => this.handleUnreliableMessage(msg),
      onConnected: () => this.handlePeerConnected(peerId),
      onDisconnected: () => this.handlePeerDisconnected(peerId),
    });
    this.peers.set(peerId, pc);
    return pc;
  }

  private handlePeerConnected(peerId: string) {
    // Covers first join AND reconnect with one mechanism, per the design
    // note at the top of this file: any fresh connection to the host gets
    // a full ground-truth resync, never an incremental replay.
    if (this.amIHost) {
      const resync: FullResyncMessage = {
        type: "full_resync",
        hostEpoch: this.hostEpoch,
        discs: this.lastKnownDiscs,
        currentPlayerId: this.currentPlayerId,
        playerOrder: this.playerOrder,
      };
      this.peers.get(peerId)?.sendReliable(resync);
    }
  }

  // --- Message handling ---

  private handleReliableMessage(fromPeerId: string, msg: ReliableMessage) {
    switch (msg.type) {
      case "shot_input":
        if (this.amIHost) this.handlers.onShotInput(msg.playerId, msg.angle, msg.power);
        this.resetHostWatchdog(fromPeerId);
        break;
      case "striker_position":
        if (this.amIHost) this.handlers.onStrikerMoved(msg.playerId, msg.x, msg.y);
        break;
      case "shot_resolved":
        if (this.acceptFromEpoch(msg.hostEpoch)) {
          this.currentPlayerId = msg.nextPlayerId;
          this.handlers.onShotResolved(msg);
        }
        this.resetHostWatchdog(fromPeerId);
        break;
      case "full_resync":
        if (this.acceptFromEpoch(msg.hostEpoch)) {
          this.playerOrder = msg.playerOrder;
          this.currentPlayerId = msg.currentPlayerId;
          this.lastKnownDiscs = msg.discs;
          this.handlers.onFullResync(msg);
        }
        this.resetHostWatchdog(fromPeerId);
        break;
      case "host_migrated":
        this.handleHostMigrated(msg);
        break;
      case "heartbeat":
        this.acceptFromEpoch(msg.hostEpoch);
        this.resetHostWatchdog(fromPeerId);
        break;
    }
  }

  private handleUnreliableMessage(msg: UnreliableMessage) {
    if (msg.type === "state_snapshot" && this.acceptFromEpoch(msg.hostEpoch)) {
      this.lastKnownDiscs = msg.discs;
      this.handlers.onSnapshot(msg.discs);
      this.resetHostWatchdog();
    }
  }

  /** Epoch guard from SPEC.md section 6: ignore anything from a stale
   * (lower) host_epoch than the highest we've seen. */
  private acceptFromEpoch(epoch: number): boolean {
    if (epoch < this.hostEpoch) return false;
    this.hostEpoch = epoch;
    return true;
  }

  private handleHostMigrated(msg: HostMigratedMessage) {
    if (!this.acceptFromEpoch(msg.hostEpoch)) return;
    this.currentHostId = msg.newHostId;
    this.amIHost = msg.newHostId === this.myPeerId;
    this.handlers.onRoleChange({ amIHost: this.amIHost, hostEpoch: this.hostEpoch });
    if (!this.amIHost && !this.peers.has(this.currentHostId)) {
      this.createPeerConnection(this.currentHostId, /* isInitiator */ true);
    }
    this.resetHostWatchdog();
  }

  // --- Host migration (SPEC.md section 6) ---

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const msg: HeartbeatMessage = { type: "heartbeat", hostEpoch: this.hostEpoch };
      for (const peer of this.peers.values()) peer.sendReliable(msg);
    }, HOST_HEARTBEAT_INTERVAL_MS);
  }

  private resetHostWatchdog(_fromPeerId?: string) {
    if (this.amIHost) return; // host doesn't watchdog itself
    clearTimeout(this.hostWatchdogTimer);
    this.hostWatchdogTimer = setTimeout(() => this.onHostTimeout(), HOST_TIMEOUT_MS);
  }

  private onHostTimeout() {
    if (this.currentHostId) this.handlePeerDisconnected(this.currentHostId);
  }

  private handlePeerDisconnected(peerId: string) {
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);

    if (peerId === this.currentHostId) {
      // Host gone — immediate migration (SPEC.md §6), no grace period.
      this.playerOrder = this.playerOrder.filter((id) => id !== peerId);
      this.gracePeers.delete(peerId);
      clearTimeout(this.reconnectGraceTimers.get(peerId));
      this.reconnectGraceTimers.delete(peerId);
      this.handlers.onPlayersChanged(this.playerOrder);
      this.promoteNextHost();
      return;
    }

    // Non-host peer: grace period before forfeit (SPEC.md §7).
    // Keep them in playerOrder but mark as disconnected. Pause if it was
    // their turn, otherwise game continues.
    if (!this.playerOrder.includes(peerId)) return; // already removed / unknown
    if (this.gracePeers.has(peerId)) return; // already in grace period

    this.gracePeers.add(peerId);
    this.handlers.onPlayersChanged(this.playerOrder);
    this.notifyGraceChanged();

    const timer = setTimeout(() => {
      const wasCurrentTurn = peerId === this.currentPlayerId;
      const oldIndex = this.playerOrder.indexOf(peerId);
      this.gracePeers.delete(peerId);
      this.reconnectGraceTimers.delete(peerId);
      this.playerOrder = this.playerOrder.filter((id) => id !== peerId);
      if (wasCurrentTurn && this.playerOrder.length > 0) {
        // Advance to next player after forfeit (SPEC.md §7)
        const nextIdx = oldIndex % this.playerOrder.length;
        this.currentPlayerId = this.playerOrder[nextIdx] ?? this.playerOrder[0];
      }
      this.handlers.onPlayersChanged(this.playerOrder);
      this.notifyGraceChanged();
      this.handlers.onPlayerForfeited?.(peerId, this.currentPlayerId);
      // Host will sync its HostSimulation via main.ts handler; broadcast new turn via full_resync on next connect
      if (this.amIHost && wasCurrentTurn) {
        // Push updated turn to all peers via reliable broadcast ( piggyback on host_migrated epoch or send full_resync )
        const forfeitResync: FullResyncMessage = {
          type: "full_resync",
          hostEpoch: this.hostEpoch,
          discs: this.lastKnownDiscs,
          currentPlayerId: this.currentPlayerId,
          playerOrder: this.playerOrder,
        };
        for (const p of this.peers.values()) p.sendReliable(forfeitResync);
      }
    }, RECONNECT_GRACE_MS);
    this.reconnectGraceTimers.set(peerId, timer);
  }

  private notifyGraceChanged() {
    const isPaused = this.isPaused();
    const waitingFor = isPaused ? this.currentPlayerId : null;
    this.handlers.onGraceChanged?.([...this.gracePeers], isPaused, waitingFor);
  }

  private promoteNextHost() {
    // Fallback list is turn/join order minus anyone already gone
    // (SPEC.md section 6, "ordered fallback list").
    const nextHostId = this.playerOrder[0];
    if (!nextHostId) return; // everyone's gone; match is over

    this.hostEpoch += 1;
    this.currentHostId = nextHostId;
    this.amIHost = nextHostId === this.myPeerId;

    if (this.amIHost) {
      clearTimeout(this.hostWatchdogTimer);
      this.startHeartbeat();
      // Remaining peers will reconnect to us; each connection triggers
      // handlePeerConnected -> full_resync automatically. We seed our
      // "last known" state from whatever we last received as a non-host,
      // which HostSimulation uses to reconstruct a resting-state sim
      // rather than trying to resurrect exact in-flight physics
      // (SPEC.md section 6: "void and retake" for mid-shot drops).
      for (const peerId of this.playerOrder) {
        if (peerId !== this.myPeerId) {
          this.createPeerConnection(peerId, /* isInitiator */ false);
        }
      }
    } else {
      this.createPeerConnection(nextHostId, /* isInitiator */ true);
    }

    this.handlers.onRoleChange({ amIHost: this.amIHost, hostEpoch: this.hostEpoch });

    // Tell everyone still around who the new host is (best-effort — peers
    // will also converge on their own via the epoch check as connections
    // re-establish, but this speeds it up for anyone still connected to us).
    const msg: HostMigratedMessage = {
      type: "host_migrated",
      hostEpoch: this.hostEpoch,
      newHostId: nextHostId,
    };
    for (const peer of this.peers.values()) peer.sendReliable(msg);
  }

  destroy() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.hostWatchdogTimer);
    for (const t of this.reconnectGraceTimers.values()) clearTimeout(t);
    this.reconnectGraceTimers.clear();
    this.gracePeers.clear();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.signaling.close();
  }
}
