// Used by non-host clients only. Buffers incoming state_snapshot messages
// and interpolates between them so the local 60fps render loop always has
// a smooth position to draw, even though snapshots arrive at ~20-30Hz.
//
// SPEC.md section 4: target ~150-200ms buffer delay for carrom specifically
// (more generous than the ~100ms typical-shooter default), since nobody is
// making moment-to-moment decisions while a shot is resolving.

import type { DiscState } from "../network/protocol";

const BUFFER_DELAY_MS = 175;
const MAX_BUFFERED_SNAPSHOTS = 30; // ~1.2s at 25Hz — plenty for the delay window
const MAX_EXTRAPOLATION_MS = 100; // cap extrapolation to avoid flying off on packet loss (SPEC.md §4)

interface TimestampedSnapshot {
  timestamp: number;
  discs: DiscState[];
}

export class InterpolationBuffer {
  private snapshots: TimestampedSnapshot[] = [];

  addSnapshot(discs: DiscState[], timestamp: number) {
    this.snapshots.push({ timestamp, discs });
    if (this.snapshots.length > MAX_BUFFERED_SNAPSHOTS) {
      this.snapshots.shift();
    }
  }

  /** Call every render frame with the current time (e.g. `performance.now()`
   * on the client, aligned to the sender's clock — see note below). */
  getInterpolatedState(renderTime: number): DiscState[] {
    if (this.snapshots.length === 0) return [];

    const targetTime = renderTime - BUFFER_DELAY_MS;

    // Find the two snapshots bracketing targetTime.
    let before: TimestampedSnapshot | undefined;
    let after: TimestampedSnapshot | undefined;
    for (let i = 0; i < this.snapshots.length; i++) {
      if (this.snapshots[i].timestamp <= targetTime) {
        before = this.snapshots[i];
      } else {
        after = this.snapshots[i];
        break;
      }
    }

    if (before && after) {
      const span = after.timestamp - before.timestamp;
      const t = span > 0 ? (targetTime - before.timestamp) / span : 0;
      return lerpDiscs(before.discs, after.discs, t);
    }

    // Startup: targetTime before first snapshot
    if (!before && after) return after.discs;
    if (before && !after) {
      // Buffer underrun: extrapolate from latest snapshot using velocity (SPEC.md §4)
      const latest = this.snapshots[this.snapshots.length - 1];
      const dtMs = Math.min(targetTime - latest.timestamp, MAX_EXTRAPOLATION_MS);
      if (dtMs <= 0) return latest.discs;
      const dtSec = dtMs / 1000;
      return latest.discs
        .filter((d) => d.active)
        .map((d) => ({
          ...d,
          x: d.x + d.vx * dtSec,
          y: d.y + d.vy * dtSec,
        }));
    }
    return (after ?? before ?? this.snapshots[this.snapshots.length - 1]).discs;
  }

  /** Reset when a host_migrated or full_resync arrives — don't interpolate
   * across a discontinuity in the state source. */
  reset() {
    this.snapshots = [];
  }
}

function lerpDiscs(a: DiscState[], b: DiscState[], t: number): DiscState[] {
  const byId = new Map(b.map((d) => [d.id, d]));
  return a
    .filter((d) => d.active)
    .map((from) => {
      const to = byId.get(from.id);
      if (!to || !to.active) return from;
      return {
        ...from,
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      };
    });
}
