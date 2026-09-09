// The skill registry — one definition per skill, consumed by everything.
//
// This replaces three hand-synchronised lists that used to live apart and
// had to be edited together:
//
//   ALLOWED_SKILLS   lib/skills.ts      what the HTTP layer will queue
//   buildPrompt()    runner/runner.js   what each skill actually asks Claude
//   DECK_SKILLS      components/HUD.tsx what the Ops Board renders
//
// plus SKILL_ALIASES in lib/router.ts and the three scheduling sets in the
// runner. Adding a skill meant five edits in four files, and forgetting one
// failed quietly: a button that queued an intent no runner branch answered,
// or a voice alias for a skill the API refused. Now a skill is one file in
// definitions/ and every consumer derives its own view from this list.
//
// Plain JavaScript on purpose. runner/runner.js is a dependency-free Node
// daemon that imports this directly; a TypeScript registry would force a
// loader into the runner just to read a list. The types live in types.js as
// JSDoc, which TypeScript understands through allowJs.

import { AUTONOMOUS_PREFIX } from "./prompt.js";

import morningReport from "./definitions/morning-report.js";
import inboxBrief from "./definitions/inbox-brief.js";
import planToday from "./definitions/plan-today.js";
import planTomorrow from "./definitions/plan-tomorrow.js";
import vaultCleanup from "./definitions/vault-cleanup.js";
import voiceAsk from "./definitions/voice-ask.js";

/** @type {import('./types.js').SkillDefinition[]} */
const DEFINITIONS = [morningReport, inboxBrief, planToday, planTomorrow, vaultCleanup, voiceAsk];

/** Every skill, in roster order (deck order, then the non-deck ones). */
export const SKILLS = [...DEFINITIONS].sort((a, b) => a.order - b.order);

/** id → definition. */
export const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

/** Ids the HTTP layer will accept, in roster order. */
export const SKILL_IDS = SKILLS.map((s) => s.id);

/** The Ops Board buttons: {skill, label}, in deck order. */
export const DECK_SKILLS = SKILLS.filter((s) => s.deck).map((s) => ({
  skill: s.id,
  label: /** @type {string} */ (s.label),
}));

/**
 * Voice aliases as [pattern, skillId] pairs, in match order.
 *
 * Order matters: the patterns are tried in sequence and one can shadow
 * another by substring, so each definition declares an explicit aliasOrder
 * rather than inheriting the roster's.
 * @type {[RegExp, string][]}
 */
export const SKILL_ALIASES = SKILLS.filter((s) => s.aliasOrder !== null && s.aliases.length > 0)
  .sort((a, b) => /** @type {number} */ (a.aliasOrder) - /** @type {number} */ (b.aliasOrder))
  .flatMap((s) => s.aliases.map((re) => /** @type {[RegExp, string]} */ ([re, s.id])));

/** Skills that share a single worker slot (they write the same files). */
export const SERIAL_SKILLS = new Set(SKILLS.filter((s) => s.serial).map((s) => s.id));

/** Skills that refuse a second intent while one is already in flight. */
export const DEDUPE_SKILLS = new Set(SKILLS.filter((s) => s.dedupe).map((s) => s.id));

/** Skills allowed the longer hard timeout. */
export const LONG_SKILLS = new Set(SKILLS.filter((s) => s.long).map((s) => s.id));

export function isKnownSkill(/** @type {string} */ id) {
  return SKILL_BY_ID.has(id);
}

/**
 * Where a skill's user-facing artifact lands, vault-relative.
 * Returns null for an unknown skill — the runner treats that as a rejection.
 * @param {string} id
 * @param {import('./types.js').DeliverableContext} ctx
 * @returns {string|null}
 */
export function deliverablePath(id, ctx) {
  const skill = SKILL_BY_ID.get(id);
  return skill ? skill.deliverable(ctx) : null;
}

/**
 * The prompt handed to `claude -p`. Null for an unknown skill, and also for
 * a known skill whose arguments make it unrunnable (voice-ask with no ask).
 * @param {string} id
 * @param {Omit<import('./types.js').PromptContext, 'prefix'>} ctx
 * @returns {string|null}
 */
export function buildSkillPrompt(id, ctx) {
  const skill = SKILL_BY_ID.get(id);
  return skill ? skill.prompt({ ...ctx, prefix: AUTONOMOUS_PREFIX }) : null;
}

export { AUTONOMOUS_PREFIX };
