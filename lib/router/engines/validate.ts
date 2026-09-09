import { ALLOWED_SKILLS } from "../../skills";
import { PANEL_IDS, type PanelId, type RouteResult } from "../types";

// The sanity layer every model engine's answer passes through. A model can
// name a skill that does not exist or a panel that was never on the board;
// this is where that gets caught, so no engine has to police itself.
//
// Returning null means "unusable answer" — the chain treats it exactly like
// an engine that declined, and moves on.

export interface RoutedJson {
  tier?: number;
  skill?: string;
  reply?: string;
  panels?: unknown;
}

// shared sanity layer for model engines — skill must be real, panels must be
// real, tier-1 without a valid skill bounces back to the caller's fallback
export function validateRouted(
  parsed: RoutedJson,
  engine: "haiku" | "local" | "cli"
): RouteResult | null {
  const tier = parsed.tier === 1 || parsed.tier === 2 ? parsed.tier : 3;
  const skill =
    tier === 1 && parsed.skill && ALLOWED_SKILLS.has(parsed.skill) ? parsed.skill : undefined;
  if (tier === 1 && !skill) return null;
  const panels = Array.isArray(parsed.panels)
    ? (parsed.panels.filter((p) => (PANEL_IDS as readonly string[]).includes(String(p))) as PanelId[])
    : undefined;
  return { tier, skill, reply: String(parsed.reply ?? "Done."), engine, panels };
}

// fire-and-forget warmup — the first HTTPS call to api.anthropic.com pays
// ~7s of TLS/connection setup per server process; a 1-token ping at module
// load moves that cost off the user's first real ask. Mirrors warmLocal().
let haikuWarmed = false;
