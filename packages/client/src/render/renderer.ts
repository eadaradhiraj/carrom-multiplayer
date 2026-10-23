// Render loop — runs on EVERY client (host and non-host alike) at 60fps.
// Deliberately has zero knowledge of networking (SPEC.md section 4): it
// just draws whatever the current known/interpolated disc positions are.
//
// Basic shapes only per project constraints: circles for discs, a rect for
// the board, a line for the aim indicator. No sprites/textures for v1.

import type { DiscState } from "../network/protocol";

const DISC_COLORS: Record<DiscState["disc_type"], string> = {
  striker: "#f4f1ea",
  black: "#2b2b2b",
  white: "#f4f1ea",
  queen: "#c0392b",
};

export interface AimState {
  strikerX: number;
  strikerY: number;
  angle: number;
  power: number; // 0..1
}

let currentDiscs: DiscState[] = [];
let currentAim: AimState | null = null;
let baselinePlayerOrder: string[] = [];
let baselineCurrentPlayerId: string | null = null;

export function setDiscs(discs: DiscState[]) {
  currentDiscs = discs;
}

export function setAim(aim: AimState | null) {
  currentAim = aim;
}

export function setBaseline(playerOrder: string[], currentPlayerId: string) {
  baselinePlayerOrder = playerOrder;
  baselineCurrentPlayerId = currentPlayerId;
}

export function startRenderLoop(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Board.
    ctx.fillStyle = "#c8a165";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Baselines — inset 60px from edge, span 120..560 to avoid pockets (Spec: striker must start on baseline)
    const BASELINE_OFFSET = 60;
    const BASELINE_START = 120;
    const BASELINE_END = canvas.width - 120;
    const BASELINE_WIDTH = 3;
    const n = baselinePlayerOrder.length || 2;
    const activeIdx = baselineCurrentPlayerId ? baselinePlayerOrder.indexOf(baselineCurrentPlayerId) : 0;

    function drawBaseline(
      x1: number, y1: number, x2: number, y2: number,
      isActive: boolean, isHorizontal: boolean
    ) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isActive ? "#fff" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = isActive ? BASELINE_WIDTH + 1 : BASELINE_WIDTH;
      ctx.stroke();
      // End circles (striker placement limits) — standard carrom has 26mm circles at baseline ends
      ctx.fillStyle = isActive ? "#fff" : "rgba(255,255,255,0.5)";
      for (const [cx, cy] of [[x1, y1], [x2, y2]] as const) {
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Arrow/chevron indicating shooting direction for active baseline
      if (isActive) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        ctx.fillStyle = "#fff";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("▶", isHorizontal ? mx : x1 + (x1 < canvas.width/2 ? 12 : -12), isHorizontal ? y1 + (y1 < canvas.height/2 ? 14 : -6) : my);
      }
    }

    // Draw baselines per player count — active one is bold white, others dimmed
    if (n === 2) {
      drawBaseline(BASELINE_START, canvas.height - BASELINE_OFFSET, BASELINE_END, canvas.height - BASELINE_OFFSET, activeIdx === 0, true); // south p0
      drawBaseline(BASELINE_START, BASELINE_OFFSET, BASELINE_END, BASELINE_OFFSET, activeIdx === 1, true); // north p1
    } else if (n === 3) {
      drawBaseline(BASELINE_START, canvas.height - BASELINE_OFFSET, BASELINE_END, canvas.height - BASELINE_OFFSET, activeIdx === 0, true); // south p0
      drawBaseline(BASELINE_OFFSET, BASELINE_START, BASELINE_OFFSET, BASELINE_END, activeIdx === 1, false); // west p1
      drawBaseline(BASELINE_START, BASELINE_OFFSET, BASELINE_END, BASELINE_OFFSET, activeIdx === 2, true); // north p2
    } else if (n >= 4) {
      drawBaseline(BASELINE_START, canvas.height - BASELINE_OFFSET, BASELINE_END, canvas.height - BASELINE_OFFSET, activeIdx === 0, true); // south p0
      drawBaseline(BASELINE_OFFSET, BASELINE_START, BASELINE_OFFSET, BASELINE_END, activeIdx === 1, false); // west p1
      drawBaseline(BASELINE_START, BASELINE_OFFSET, BASELINE_END, BASELINE_OFFSET, activeIdx === 2, true); // north p2
      drawBaseline(canvas.width - BASELINE_OFFSET, BASELINE_START, canvas.width - BASELINE_OFFSET, BASELINE_END, activeIdx === 3, false); // east p3
    }

    // Corner pockets — must match POCKET_RADIUS in physics-core (24).
    ctx.fillStyle = "#1a1a1a";
    const pocketRadius = 24;
    for (const [px, py] of [
      [0, 0],
      [canvas.width, 0],
      [0, canvas.height],
      [canvas.width, canvas.height],
    ]) {
      ctx.beginPath();
      ctx.arc(px, py, pocketRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Discs.
    for (const disc of currentDiscs) {
      if (!disc.active) continue;
      ctx.beginPath();
      ctx.arc(disc.x, disc.y, disc.radius, 0, Math.PI * 2);
      ctx.fillStyle = DISC_COLORS[disc.disc_type];
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.stroke();
    }

    // Aim line, drawn only while the local player is aiming their own shot
    // (handled entirely client-side, never waiting on the network — see
    // SPEC.md section 4).
    if (currentAim) {
      const { strikerX, strikerY, angle, power } = currentAim;
      const length = 40 + power * 120;
      ctx.beginPath();
      ctx.moveTo(strikerX, strikerY);
      ctx.lineTo(strikerX + Math.cos(angle) * length, strikerY + Math.sin(angle) * length);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
