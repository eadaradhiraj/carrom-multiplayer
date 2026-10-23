# Carrom Multiplayer — Design Spec

## 1. Constraints

- 2-4 players per match, standard carrom rules (coins, queen, striker).
- Platform: web first (WASM physics), mobile (iOS/Android) deferred.
- Target: 60fps rendering on modest hardware; basic shape rendering (circles,
  rects) is acceptable — no requirement for high-fidelity art.
- Networking: peer-to-peer, no dedicated game server in the hot path.

## 2. Topology

Star topology, not full mesh:

- One peer is elected **host** and runs the authoritative physics simulation.
- The other 1-3 peers connect only to the host (not to each other).
- A **signaling server** (WebSocket) brokers the initial WebRTC handshake
  (SDP offer/answer, ICE candidates) between peers, then steps out of the
  loop — it is not involved once connections are established.
- **STUN/TURN** servers handle NAT traversal. TURN relay should be treated as
  a normal, expected path (not a rare fallback) — mobile carrier CGNAT makes
  direct P2P unreliable for a meaningful fraction of connections.
- A minimal **backend service** handles matchmaking/room codes and match
  history/persistence — entirely off the real-time path.

Rationale: with 4 players, full mesh means 6 simultaneous connections and no
single source of truth for physics. Star topology cuts that to 3 connections
per non-host peer and gives one clear authority for resolving shots.

## 3. Physics model: host-authoritative (not lockstep)

Two approaches were considered:

**A. Deterministic lockstep** — every client simulates locally from shared
inputs. Rejected for now: floating-point divergence across different
runtimes/hardware makes agreement fragile, and it requires either a custom
fixed-point physics engine or heavy engineering to guarantee determinism.
Not worth it before mobile is even in scope.

**B. Host-authoritative (chosen)** — the host runs the real physics
simulation. Other peers send input, host simulates, host broadcasts resulting
state. Non-host clients never run physics — they just interpolate and render.

This is the right tradeoff given the constraints: single-runtime web/WASM
today removes most of lockstep's original motivation, host-authoritative is
far simpler to build and debug, and carrom's turn-based nature (no one is
making decisions mid-shot) hides the host's slight latency advantage.

## 4. Render vs. simulation loop

These are deliberately decoupled:

- **Render loop**: every client, 60fps, always local (`requestAnimationFrame`
  or platform equivalent). Never blocks on network. Draws whatever the latest
  known/interpolated object state is.
- **Simulation loop**: host only, fixed timestep (60Hz internally is cheap
  given ~20 simple circular objects). Broadcasts snapshots at a lower rate
  (~20-30Hz) — not every tick.
- Non-host clients interpolate between the last two snapshots to keep their
  60fps render loop smooth between network updates. Optional short-range
  extrapolation (position + velocity) can reduce perceived lag right after a
  shot, before the next snapshot lands.

### Interpolation buffer

- Standard game-networking default is ~100ms (2-3 snapshots at 20-30Hz),
  because most games have players reacting moment-to-moment.
- Carrom is more forgiving: once the striker is hit, nobody is making
  decisions until coins settle. A **150-200ms buffer** is safe and buys
  meaningfully better resilience to jitter/dropped packets, since more
  snapshots are queued to smooth over gaps.
- The one path that must stay near-zero latency is the *shooter's own aim*
  (striker position, pull-back, angle) — this is predicted and rendered
  entirely locally, never waiting on the network.

## 5. Message protocol

Sent over WebRTC data channels, host-centric (star topology):

| Message | Direction | Reliability | When |
|---|---|---|---|
| `shot_input` | non-host → host | reliable, ordered | Player releases striker (angle, power) |
| `state_snapshot` | host → all | unreliable, unordered | ~20-30Hz while objects are moving |
| `shot_resolved` | host → all | reliable, ordered | Host detects all objects below velocity threshold |
| `turn_change` | host → all | reliable, ordered | Bundled with/after `shot_resolved` |
| `foul` / `pocket_event` | host → all | reliable, ordered | Emitted by host as physics detects it |

Key principle: **snapshots are best-effort, game-state-changing events are
guaranteed.** Losing a snapshot costs one frame of smoothness. Losing
`shot_resolved` would desync the match, so it must not be allowed to drop.

Resolution uses a debounce (e.g. ~15-20 ticks, a quarter-to-a-third of a
second at 60Hz) of sustained near-zero velocity across all objects before
declaring the shot resolved — avoids false positives from momentary stillness
mid-collision-chain.

Clients never infer "is the shot over" from watching positions themselves —
they wait for the explicit `shot_resolved` event. This is the single source
of truth for turn state and avoids a whole class of timing-based desync bugs.

## 6. Host migration

**Standing backup**: an ordered fallback list of peers (e.g. turn order),
not just a single designated backup. Host snapshots include a lightweight
extra field (last known positions/velocities, whose turn it is, score) so
any backup can take over without a separate sync step.

**Detection**: heartbeat/timeout on the host's data channel (~2-3s with no
snapshot/heartbeat = host presumed gone).

**Promotion & ordering**: every host message carries a monotonically
increasing `host_epoch`. Any client ignores messages with a lower epoch than
the highest it has seen. If the current backup doesn't respond within ~1-2s,
the next peer in the fallback list promotes itself instead. Simultaneous
promotion attempts are tie-broken deterministically (e.g. lowest peer ID
wins) so all clients converge on one host within a round trip.

**Resync — deliberately not "resume exact physics state":**
- Drop happens *between* shots (idle) → seamless resume from last known
  resting positions.
- Drop happens *mid-shot* → **void the shot and have the same player retake
  it**, rather than trying to reconstruct exact in-flight physics from a
  stale snapshot. Mid-shot host drops should be rare; a retake is a much
  smaller UX hit than a visible physics discontinuity (coins "teleporting").

**Old host reconnecting after replacement**: no special-casing needed — it
simply observes a higher `host_epoch` from other peers and demotes itself.

## 7. Reconnect flow (non-host peer drops)

Reuses the same primitives as migration:

1. Host detects the peer's WebRTC connection state change (dropped).
2. Grace period (~15-30s) before treating it as a forfeit — game pauses if
   it's currently that player's turn, continues otherwise.
3. Peer re-runs the signaling handshake using the retained room/session ID,
   reconnecting to whoever is the *current* host (may differ if migration
   happened while they were gone).
4. Host sends a **full state snapshot** (all positions, scores, current
   turn, current `host_epoch`) — never an incremental replay of missed
   history.
5. If the grace period expires without reconnect, treat as forfeit/leave.

Core principle shared by both flows: **always resync via a full, current
snapshot, never by replaying or patching history.** This is the safest
primitive to protect as the system grows — cleverness here is where P2P
state bugs tend to live.

## 8. Build order for prototyping

1. Local physics + rendering only, no networking — validate shot/collision
   feel in WASM with basic shapes.
2. Two-peer host/client over WebRTC — `shot_input` → simulate →
   `shot_resolved` end to end, with snapshot interpolation on the client.
3. Extend to 4 peers, star topology.
4. Wire in real signaling server + STUN/TURN (replace any hardcoded local
   connection).
5. Host migration and reconnect — last, since it's edge-case handling on top
   of an already-working happy path.

## 9. Explicitly deferred / out of scope for v1

- Native mobile clients (iOS/Android) — architecture should accommodate this
  later (physics-core as a portable Rust module), but not built now.
- Deterministic lockstep simulation.
- Anti-cheat / host-integrity verification (matters more once ranked play or
  stakes exist; not needed for casual P2P play).
- Full mesh or dedicated-server fallback for when P2P entirely fails.
