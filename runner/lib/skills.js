import { buildSkillPrompt, deliverablePath } from "../../skills/index.js";
import { HUD_TZ } from "./config.js";
import { slugify, todayDate, tomorrowDate } from "./files.js";

// The runner's view of the skill registry.
//
// Both functions are thin on purpose: the paths and the prompts belong to the
// skills themselves (skills/definitions/), and this only supplies the values
// they interpolate — today's date in HUD_TZ, the run id, the slugifier.
// Null from either means "do not run this", which processOne turns into a
// rejected run record rather than a silent drop.

export function deliverablePathFor(intent) {
  return deliverablePath(intent.skill, {
    date: todayDate(),
    tomorrow: tomorrowDate(),
    id8: (intent.id || "x").slice(0, 8),
    args: intent.args || {},
    slugify,
  });
}

/**
 * The prompt handed to `claude -p`. Also from the registry: every prompt is
 * self-contained (no dependency on locally installed slash-skills) and tells
 * the model the exact path to write.
 *
 * Null means "do not run this": either an unknown skill, or a known one whose
 * arguments make it a no-op (voice-ask with an empty ask).
 */
export function buildPrompt(intent, deliverable) {
  return buildSkillPrompt(intent.skill, { intent, deliverable, tz: HUD_TZ });
}

// Worker pool — parallel execution gated by category.
//
// MAX_CONCURRENT caps total in-flight `claude -p` subprocesses. The three
// category sets come from the skill registry, where each skill declares its
// own scheduling needs next to its prompt: `serial` skills share one slot
// among themselves (they write the same file — the daily note), `dedupe`
// skills refuse a second intent while one is in flight, and `long` skills
// get the 20-minute hard timeout instead of 10.
