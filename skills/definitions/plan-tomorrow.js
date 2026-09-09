// plan-tomorrow
//
// Drafts tomorrow's daily note. Serial with plan-today.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "plan-tomorrow",
  label: "Triage Tomorrow",
  deck: true,
  order: 4,
  aliasOrder: 5,
  aliases: [/plan tomorrow|triage tomorrow|triage tmrw/],
  /** shares one worker slot with the other serial skills */
  serial: true,
  deliverable: ({ tomorrow }) =>
    `daily-notes/${tomorrow}.md`,
  prompt: ({ deliverable, prefix, tz }) =>
    `${prefix}\n\nTask: draft tomorrow's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read today's daily note for unfinished Top 3 priorities (carryover).\n2. If a Google Calendar MCP connector is available, pull tomorrow's events (timeZone=${tz}).\n3. Suggest 3 priorities for tomorrow.\n4. Write the note following the schema at system/schemas/daily-note.md.\n\nEnd your reply with: SAVED ${deliverable}`,
};
