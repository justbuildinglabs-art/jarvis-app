// What the core is doing, and how each state should feel.
//
// Colour is deliberately NOT a mode signal. The orb holds one fixed cyan and
// the HUD chrome around it is a static white ramp, so a mode reads through
// TEMPO and BRIGHTNESS instead — the difference between idle and working is
// something you notice peripherally without having to name a colour. Error is
// the single exception, and it locks the hue to red precisely because it
// should break that rule loudly.

export type CoreMode = "idle" | "working" | "listening" | "speaking" | "error";
export type BgMode = "flat" | "depth" | "nebula";
export const BG_MODES: BgMode[] = ["flat", "depth", "nebula"];

// color is FIXED at the cyan anchor; modes shape tempo + brightness only,
// error locks the hue to red
export interface ModeFeel {
  speed: number; // rotation/drift multiplier
  boost: number; // brightness multiplier
}

export const FEELS: Record<CoreMode, ModeFeel> = {
  idle: { speed: 1, boost: 1 },
  working: { speed: 1.7, boost: 1.25 },
  listening: { speed: 1.2, boost: 1.1 },
  speaking: { speed: 1.3, boost: 1.15 },
  error: { speed: 1.8, boost: 1.2 },
};

export const ERROR_HUE = 0.015;
// Cyan anchor (~190deg) — the orb's one fixed color. The HUD chrome no longer
// derives from it (globals.css is a static white ramp).
export const CYAN_HUE = 0.528;

export const CLOUD_R = 1.5;
export const N_NODES = 1100;
// links scale with nodes, so halving N alone would leave the cloud looking
// as busy as before — 3 links each on half the nodes still reads dense
export const LINKS_PER_NODE = 2;
