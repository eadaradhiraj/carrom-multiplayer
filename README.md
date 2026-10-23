# Carrom Multiplayer

A real-time multiplayer carrom game (2-4 players) using peer-to-peer networking
with a host-authoritative physics model. Web-first (WASM physics), mobile later.

See [SPEC.md](./SPEC.md) for the full architecture, protocol, and design rationale.

## Project structure

```
carrom-multiplayer/
├── packages/
│   ├── physics-core/       # Rust -> WASM physics engine (runs on host only)
│   ├── client/              # Web client: rendering, networking, host simulation
│   └── signaling-server/    # WebSocket signaling for WebRTC handshake (SDP/ICE)
├── SPEC.md                  # Architecture, protocol, and design decisions
└── README.md
```

## Why this structure

- **physics-core** is isolated because only the *host* client ever runs it.
  Non-host clients never import it — they just decode snapshots and render.
  Keeping it a separate package makes that boundary explicit and makes the
  physics engine reusable later (e.g. from a native mobile shell) without
  dragging in any web/rendering code.
- **client** contains both host and non-host code paths side by side, since
  any peer can become host via migration — there's no separate "host build."
- **signaling-server** is deliberately tiny and stateless beyond active rooms.
  It only brokers the WebRTC handshake; it is never in the gameplay hot path.

## Getting started

```bash
# 1. Build the physics engine to WASM
cd packages/physics-core
wasm-pack build --target web

# 2. Install and run the signaling server
cd ../signaling-server
npm install
npm run dev

# 3. Install and run the client
cd ../client
npm install
npm run dev
```

## Build order (recommended)

This mirrors the prototyping plan in SPEC.md section 8:

1. Local physics + rendering only (no networking) — tune feel of shots/collisions.
2. Two-peer host/client over WebRTC — get the core protocol working end to end.
3. Extend to 4 peers (star topology).
4. Wire in real signaling + STUN/TURN.
5. Host migration and reconnect handling.

## Status

A working first pass, not a polished game. What's implemented:

- **physics-core**: real circle-circle collisions, wall bounces, friction,
  4 corner pockets, settle detection. Simplified: single-ring coin layout
  (not the real two-ring carrom pattern), no spin, no foul rules beyond
  pocketing.
- **networking**: full WebRTC handshake (offer/answer/ICE) over the
  signaling server, star topology, host election (first joiner), host
  migration with epoch versioning, and a full-resync-on-any-connect
  mechanism that covers both first join and reconnect.
- **client**: 60fps render loop, mouse-drag aim/power input, snapshot
  interpolation for non-host players.

Known gaps to close before this is a real game (see inline `TODO`s):

- Non-host peer disconnect currently drops them immediately rather than
  giving the grace period described in SPEC.md section 7.
- Host migration reconstructs a fresh simulation rather than the exact
  last-known disc layout (`seedFromLastKnownState` — needs a `set_discs`
  method added to the wasm `Simulation`).
- No TURN credentials wired in — STUN-only will fail behind strict/symmetric
  NATs (SPEC.md section 2 flags this as a real risk, not an edge case).
- Turn/foul rules are a placeholder round-robin, not real carrom scoring.
- Nothing has been run/compiled — `wasm-pack build` and `npm install` still
  need to happen in your environment before this executes.
