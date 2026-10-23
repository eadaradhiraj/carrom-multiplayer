// Message types for the host-centric protocol (SPEC.md section 5).
// Reliability is enforced by which WebRTC data channel a message is sent
// on (see peer-connection.ts) — this file only defines shapes.

export interface DiscState {
  id: number;
  disc_type: "striker" | "black" | "white" | "queen";
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  active: boolean;
}

// --- Reliable, ordered channel ---

export interface ShotInputMessage {
  type: "shot_input";
  playerId: string;
  angle: number;
  power: number;
}

export interface StrikerPositionMessage {
  type: "striker_position";
  playerId: string;
  x: number;
  y: number;
}

export interface ShotResolvedMessage {
  type: "shot_resolved";
  hostEpoch: number;
  pocketedDiscIds: number[];
  discs: DiscState[]; // final resting state
  nextPlayerId: string;
}

export interface HostMigratedMessage {
  type: "host_migrated";
  hostEpoch: number;
  newHostId: string;
}

/** Full ground-truth resync, used for both migration and reconnect
 * (SPEC.md sections 6-7) — never an incremental replay of history. */
export interface FullResyncMessage {
  type: "full_resync";
  hostEpoch: number;
  discs: DiscState[];
  currentPlayerId: string;
  playerOrder: string[];
}

export interface HeartbeatMessage {
  type: "heartbeat";
  hostEpoch: number;
}

// --- Unreliable, unordered channel ---

export interface StateSnapshotMessage {
  type: "state_snapshot";
  hostEpoch: number;
  timestamp: number;
  discs: DiscState[];
}

export type ReliableMessage =
  | ShotInputMessage
  | StrikerPositionMessage
  | ShotResolvedMessage
  | HostMigratedMessage
  | FullResyncMessage
  | HeartbeatMessage;

export type UnreliableMessage = StateSnapshotMessage;

export type AnyMessage = ReliableMessage | UnreliableMessage;
