import { SKILL_ALIASES } from "@/skills/index.js";
import type { VaultState } from "../vault";
import type { RouteResult } from "./types";

// A skill mention isn't always an order.
//
// "Once you're done with that inbox brief, tell me about Fable 5" REFERENCES
// the running brief — it doesn't ask for a second one. When any engine routes
// tier 1 for a skill already queued or running, and the user didn't ask for a
// repeat, this reroutes: substantial residue beyond the alias becomes a
// tier-3 background ask carrying the whole sentence; a bare re-dispatch
// becomes "already running".
//
// It runs on the chain's OUTPUT, not inside any one engine, so a model engine
// gets the same protection the rules engine does.

// A skill mention isn't always a dispatch: "once you're done with that inbox
// brief, tell me about Fable 5" REFERENCES the running brief — it doesn't
// order a second one. When any engine routes tier 1 for a skill that's
// already queued or running (and the user didn't explicitly ask for a
// repeat), reroute: substantial residue beyond the alias → tier-3 background
// ask with the full sentence; bare re-dispatch → "already running".

const RERUN_RE = /\b(again|another|re-?run|one more|fresh|new one)\b/;
// dispatch verbs, temporal connectives, and politeness — NOT content words
const RESIDUE_FILLER =
  /\b(once|when|after|while|you'?re?|are|is|it'?s?|done|finished|finish(es)?|complete(s|d)?|with|that|the|a|an|and|then|can|could|would|you|please|jarvis|hey|ok|okay|so|also|me|my|run|pull|do|start|fire|kick|queue|launch|scan|fetch|refresh|get|brief|report|audit)\b/g;

function skillInFlight(skill: string, state: VaultState): boolean {
  return (
    state.queue.some((q) => q.skill === skill) ||
    state.runs.some((r) => r.skill === skill && r.status === "running")
  );
}

// exported for tests — route() applies it internally
export function inFlightGuard(r: RouteResult, transcript: string, state: VaultState): RouteResult {
  if (r.tier !== 1 || !r.skill || !skillInFlight(r.skill, state)) return r;
  const t = transcript.toLowerCase();
  if (RERUN_RE.test(t)) return r; // explicit repeat — let it through
  const name = r.skill.replace(/-/g, " ");
  const alias = SKILL_ALIASES.find(([re]) => re.test(t))?.[0];
  const residue = t
    .replace(alias ?? /$^/, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(RESIDUE_FILLER, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (residue.length >= 3) {
    // there's a real ask riding along with the reference — background it
    return {
      tier: 3,
      reply: `The ${name} is already in the works — I'll dig into the rest of that and get back to you.`,
      engine: r.engine,
      panels: ["pipeline"],
    };
  }
  return {
    tier: 2,
    reply: `The ${name} is already running — I'll let you know the moment it lands.`,
    engine: r.engine,
    panels: ["pipeline"],
  };
}
