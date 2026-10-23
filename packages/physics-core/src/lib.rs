//! Physics core — runs ONLY on the host client (see SPEC.md section 3).
//! Non-host clients never link this module; they consume snapshot data
//! over the network and interpolate/render only.
//!
//! Simplified for a first playable pass:
//!   - equal-mass elastic disc-disc collisions (no spin/rotation)
//!   - 4 corner pockets only (no side/center pockets)
//!   - linear velocity-multiplier friction, not a physically-derived model
//! These are reasonable simplifications for v1 and easy to refine later
//! without changing the public API surface below.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const BOARD_SIZE: f32 = 680.0;
const POCKET_RADIUS: f32 = 24.0;
const FRICTION: f32 = 0.985; // velocity multiplier applied per tick
const WALL_RESTITUTION: f32 = 0.75;
const SETTLE_VELOCITY_EPSILON: f32 = 2.0; // px/sec, below this treated as stopped
const SETTLE_DEBOUNCE_TICKS: u32 = 18; // ~0.3s at 60Hz — see SPEC.md section 5
const MAX_SHOT_SPEED: f32 = 900.0; // px/sec at full power

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscType {
    Striker,
    Black,
    White,
    Queen,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Disc {
    pub id: u32,
    pub disc_type: DiscType,
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub radius: f32,
    pub active: bool, // false once pocketed — excluded from physics/render
}

#[wasm_bindgen]
pub struct Simulation {
    discs: Vec<Disc>,
    settled_ticks: u32,
    pending_pocketed: Vec<u32>,
}

impl Default for Simulation {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Simulation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Simulation {
        let mut discs = Vec::new();
        let center = BOARD_SIZE / 2.0;
        let coin_radius = 12.0;

        // Queen at center.
        discs.push(Disc {
            id: 0,
            disc_type: DiscType::Queen,
            x: center,
            y: center,
            vx: 0.0,
            vy: 0.0,
            radius: 13.0,
            active: true,
        });

        // Standard carrom start: two concentric hex rings around queen (6 inner + 12 outer = 18 coins).
        // Inner ring r=26, outer ring r=48 — chosen so min center distance >= 24 (2*coin_radius)
        // and no overlap with queen (queen 13 + coin 12 = 25).
        let inner_radius: f32 = 26.0;
        let outer_radius: f32 = 48.0;
        let mut coin_id: u32 = 1;
        // Inner ring: 6 coins, 60° apart, alternating colors
        for i in 0..6u32 {
            let angle = (i as f32) / 6.0 * std::f32::consts::TAU;
            let x = center + angle.cos() * inner_radius;
            let y = center + angle.sin() * inner_radius;
            let disc_type = if i % 2 == 0 { DiscType::Black } else { DiscType::White };
            discs.push(Disc {
                id: coin_id,
                disc_type,
                x,
                y,
                vx: 0.0,
                vy: 0.0,
                radius: coin_radius,
                active: true,
            });
            coin_id += 1;
        }
        // Outer ring: 12 coins, 30° apart, offset by 15° so they sit in gaps of inner ring
        for i in 0..12u32 {
            let angle = (i as f32) / 12.0 * std::f32::consts::TAU + std::f32::consts::PI / 12.0;
            let x = center + angle.cos() * outer_radius;
            let y = center + angle.sin() * outer_radius;
            let disc_type = if i % 2 == 0 { DiscType::White } else { DiscType::Black };
            discs.push(Disc {
                id: coin_id,
                disc_type,
                x,
                y,
                vx: 0.0,
                vy: 0.0,
                radius: coin_radius,
                active: true,
            });
            coin_id += 1;
        }

        // Striker starts on the current shooter's baseline.
        discs.push(Disc {
            id: 19,
            disc_type: DiscType::Striker,
            x: center,
            y: BOARD_SIZE - 60.0,
            vx: 0.0,
            vy: 0.0,
            radius: 15.0,
            active: true,
        });

        Simulation {
            discs,
            settled_ticks: SETTLE_DEBOUNCE_TICKS, // starts "settled" (idle)
            pending_pocketed: Vec::new(),
        }
    }

    /// Reposition the striker along the shooter's baseline before a shot
    /// (player drags it left/right to aim). Does not affect velocity.
    pub fn set_striker_position(&mut self, x: f32, y: f32) {
        if let Some(s) = self.discs.iter_mut().find(|d| d.disc_type == DiscType::Striker) {
            s.x = x.clamp(s.radius, BOARD_SIZE - s.radius);
            s.y = y.clamp(s.radius, BOARD_SIZE - s.radius);
        }
    }

    /// Apply a shot. `angle` in radians, `power` in [0, 1].
    /// Called on the host when a `shot_input` message is processed.
    pub fn apply_shot(&mut self, angle: f32, power: f32) {
        if let Some(s) = self.discs.iter_mut().find(|d| d.disc_type == DiscType::Striker) {
            let speed = power.clamp(0.0, 1.0) * MAX_SHOT_SPEED;
            s.vx = angle.cos() * speed;
            s.vy = angle.sin() * speed;
        }
        self.settled_ticks = 0;
        self.pending_pocketed.clear();
    }

    /// Advance the simulation by one fixed timestep (seconds).
    pub fn step(&mut self, dt: f32) {
        self.integrate(dt);
        self.resolve_walls();
        self.resolve_disc_collisions();
        self.resolve_pockets();
        self.update_settle_state();
    }

    /// True once all active discs have been below the velocity epsilon for
    /// SETTLE_DEBOUNCE_TICKS consecutive ticks. Host uses this to decide
    /// when to emit `shot_resolved`.
    pub fn is_settled(&self) -> bool {
        self.settled_ticks >= SETTLE_DEBOUNCE_TICKS
    }

    /// Drain and return disc ids pocketed since the last call.
    /// Call this once per resolved shot, after `is_settled()` is true.
    pub fn take_pocketed_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pending_pocketed)
    }

    /// Serialize current disc state for a `state_snapshot` broadcast.
    /// Cheap enough to call at broadcast rate (~20-30Hz per SPEC.md).
    pub fn snapshot(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.discs).unwrap_or(JsValue::NULL)
    }

    /// Restore full disc state after host migration (SPEC.md section 6).
    /// Takes a JS array of DiscState objects (as produced by `snapshot`).
    /// Velocities are zeroed and settle state reset — "void and retake" for
    /// mid-shot drops (SPEC.md section 6: don't resurrect in-flight physics).
    pub fn set_discs(&mut self, discs_js: JsValue) {
        if let Ok(mut discs) = serde_wasm_bindgen::from_value::<Vec<Disc>>(discs_js) {
            // Ensure resting state: zero velocities so sim starts settled
            for d in discs.iter_mut() {
                d.vx = 0.0;
                d.vy = 0.0;
            }
            self.discs = discs;
            self.settled_ticks = SETTLE_DEBOUNCE_TICKS;
            self.pending_pocketed.clear();
        }
    }

    // --- internal ---

    fn integrate(&mut self, dt: f32) {
        for d in self.discs.iter_mut().filter(|d| d.active) {
            d.x += d.vx * dt;
            d.y += d.vy * dt;
            d.vx *= FRICTION;
            d.vy *= FRICTION;
            if d.vx.abs() < SETTLE_VELOCITY_EPSILON {
                d.vx = 0.0;
            }
            if d.vy.abs() < SETTLE_VELOCITY_EPSILON {
                d.vy = 0.0;
            }
        }
    }

    fn resolve_walls(&mut self) {
        for d in self.discs.iter_mut().filter(|d| d.active) {
            if d.x - d.radius < 0.0 {
                d.x = d.radius;
                d.vx = -d.vx * WALL_RESTITUTION;
            }
            if d.x + d.radius > BOARD_SIZE {
                d.x = BOARD_SIZE - d.radius;
                d.vx = -d.vx * WALL_RESTITUTION;
            }
            if d.y - d.radius < 0.0 {
                d.y = d.radius;
                d.vy = -d.vy * WALL_RESTITUTION;
            }
            if d.y + d.radius > BOARD_SIZE {
                d.y = BOARD_SIZE - d.radius;
                d.vy = -d.vy * WALL_RESTITUTION;
            }
        }
    }

    fn resolve_disc_collisions(&mut self) {
        // O(n^2) is fine at ~20 discs; revisit with spatial hashing only
        // if disc count grows substantially.
        let n = self.discs.len();
        for i in 0..n {
            for j in (i + 1)..n {
                if !self.discs[i].active || !self.discs[j].active {
                    continue;
                }
                let (dx, dy, dist, min_dist) = {
                    let a = &self.discs[i];
                    let b = &self.discs[j];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    (dx, dy, (dx * dx + dy * dy).sqrt(), a.radius + b.radius)
                };
                if dist > 0.0 && dist < min_dist {
                    let overlap = min_dist - dist;
                    let nx = dx / dist;
                    let ny = dy / dist;

                    // Separate overlapping discs.
                    self.discs[i].x -= nx * overlap / 2.0;
                    self.discs[i].y -= ny * overlap / 2.0;
                    self.discs[j].x += nx * overlap / 2.0;
                    self.discs[j].y += ny * overlap / 2.0;

                    // Equal-mass elastic collision: swap velocity components
                    // along the collision normal.
                    let (avx, avy) = (self.discs[i].vx, self.discs[i].vy);
                    let (bvx, bvy) = (self.discs[j].vx, self.discs[j].vy);
                    let a_dot = avx * nx + avy * ny;
                    let b_dot = bvx * nx + bvy * ny;
                    self.discs[i].vx += (b_dot - a_dot) * nx;
                    self.discs[i].vy += (b_dot - a_dot) * ny;
                    self.discs[j].vx += (a_dot - b_dot) * nx;
                    self.discs[j].vy += (a_dot - b_dot) * ny;
                }
            }
        }
    }

    fn resolve_pockets(&mut self) {
        let pockets = [
            (0.0, 0.0),
            (BOARD_SIZE, 0.0),
            (0.0, BOARD_SIZE),
            (BOARD_SIZE, BOARD_SIZE),
        ];
        for d in self.discs.iter_mut().filter(|d| d.active) {
            for (px, py) in pockets.iter() {
                let dx = d.x - px;
                let dy = d.y - py;
                if (dx * dx + dy * dy).sqrt() < POCKET_RADIUS {
                    d.active = false;
                    self.pending_pocketed.push(d.id);
                    break;
                }
            }
        }
    }

    fn update_settle_state(&mut self) {
        let all_still = self
            .discs
            .iter()
            .filter(|d| d.active)
            .all(|d| d.vx == 0.0 && d.vy == 0.0);
        if all_still {
            self.settled_ticks += 1;
        } else {
            self.settled_ticks = 0;
        }
    }
}
