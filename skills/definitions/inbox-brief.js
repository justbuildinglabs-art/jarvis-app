// inbox-brief
//
// Gmail triage. Needs the Anthropic Gmail connector; degrades to a note
// saying so when it is absent.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "inbox-brief",
  label: "Inbox Summary",
  deck: true,
  order: 2,
  aliasOrder: 2,
  aliases: [/inbox/],
  /** a second intent is refused while one is already in flight */
  dedupe: true,
  deliverable: ({ date, id8 }) =>
    `inbox/reports/inbox-briefs/${date}-${id8}.md`,
  prompt: ({ deliverable, prefix, tz }) =>
    `${prefix}\n\nTask: triage the Gmail inbox and save the brief at exactly ${deliverable}.\n\nSteps:\n1. Pull the last 24h via the Anthropic Gmail MCP connector — mcp__claude_ai_Gmail__search_threads with query "in:inbox newer_than:1d", pageSize 50. If the connector is unavailable, write a short note saying so and stop.\n2. Classify each thread: urgent (deadlines, money, blocked people) / warm (real humans worth replying to) / opportunities (sponsorships, partnerships) / meetings / noise.\n3. Save the triage at ${deliverable}. YAML frontmatter \`date\`, \`skill: inbox-brief\`, \`tags: [inbox, triage]\`. Body groups messages by category, most urgent first.\n4. Do NOT send anything — drafting and sending stay manual.\n\nEnd your reply with: SAVED ${deliverable}`,
};
