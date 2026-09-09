// Shared shapes for the skill registry. Plain JS with JSDoc rather than
// TypeScript, because runner/runner.js is a dependency-free Node process
// that imports these modules directly — a .ts registry would need a loader
// in the daemon just to read a list of skills.

/**
 * @typedef {object} DeliverableContext
 * @property {string} date      today in HUD_TZ, YYYY-MM-DD
 * @property {string} tomorrow  the next local day, YYYY-MM-DD
 * @property {string} id8       first 8 chars of the run id
 * @property {Record<string, unknown>} args  the intent's args
 * @property {(s: string, max?: number) => string} slugify
 */

/**
 * @typedef {object} PromptContext
 * @property {{ id?: string, skill: string, args?: Record<string, unknown> }} intent
 * @property {string} deliverable  vault-relative path the skill must write
 * @property {string} prefix       AUTONOMOUS_PREFIX
 * @property {string} tz           HUD_TZ, for prompts that pass a timezone on
 */

/**
 * One skill, in one place. Everything the HUD, the router and the runner
 * each used to hold separately now hangs off this object.
 *
 * @typedef {object} SkillDefinition
 * @property {string} id            queue contract; never rename casually
 * @property {string|null} label    Ops Board button text (null = not on the deck)
 * @property {boolean} deck         render a button for it
 * @property {number} order         deck and roster order
 * @property {number|null} aliasOrder  match order for voice aliases; null = none
 * @property {RegExp[]} aliases     spoken phrasings that dispatch it
 * @property {boolean} [serial]     shares a single worker slot with other serial skills
 * @property {boolean} [dedupe]     refuse a second intent while one is in flight
 * @property {boolean} [long]       20-minute hard timeout instead of 10
 * @property {(ctx: DeliverableContext) => string} deliverable
 * @property {(ctx: PromptContext) => string|null} prompt
 */

export {};
