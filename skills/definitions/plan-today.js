// plan-today
//
// Writes today's daily note. Serial with plan-tomorrow — both merge into
// the same file.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "plan-today",
  label: "Triage Today",
  deck: true,
  order: 3,
  aliasOrder: 4,
  aliases: [/plan today|plan the day|plan my day|triage today/],
  /** shares one worker slot with the other serial skills */
  serial: true,
  deliverable: ({ date }) =>
    `daily-notes/${date}.md`,
  prompt: ({ deliverable, prefix, tz }) =>
    `${prefix}\n\nTask: plan today's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read the last 3 daily notes under daily-notes/ for incomplete Top 3 priorities and reflections (carryover candidates).\n2. If a Google Calendar MCP connector is available, pull today's events (timeZone=${tz}, sorted by start time). If not, skip the schedule.\n3. Scan projects/*.md (if the folder exists) for active or due items.\n4. Pick the 3 highest-leverage priorities: carryover from yesterday beats new, due-today beats someday.\n5. Write the daily note following the schema at system/schemas/daily-note.md — exact section order. If the note already exists, MERGE: fill only empty Top 3 slots and replace ## Schedule; never overwrite user-set text.\n\nEnd your reply with: SAVED ${deliverable}`,
};
