// morning-report
//
// Researches the last ~24h and writes the briefing the Signal Scan panel
// and the spoken rundown both read.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "morning-report",
  label: "Morning Report",
  deck: true,
  order: 1,
  aliasOrder: 1,
  aliases: [/morning report|am report/],
  /** a second intent is refused while one is already in flight */
  dedupe: true,
  /** 20-minute hard timeout instead of the default 10 */
  long: true,
  deliverable: ({ date, id8 }) =>
    `inbox/reports/morning/${date}-morning-report-${id8}.md`,
  prompt: ({ deliverable, prefix, tz }) =>
    `${prefix}\n\nTask: produce today's AI/tech morning briefing and save it at exactly ${deliverable}.\n\nResearch the last ~24 hours via web search (model releases, agent tooling, dev-tool launches, the conversation on X/HN). Structure the note: top-level "# Morning Report" + "**Date:** <today>", then "## Headlines" (3-5 bullets ranked by impact; each bullet MUST end with a markdown link to its primary source, e.g. [source](https://...)), "## Web — News & Articles", "## X / Twitter — The Conversation", "## GitHub — Builder Activity", "## Sources". YAML frontmatter: \`date\`, \`skill: morning-report\`, \`tags: [morning, briefing]\`.\n\nThe HUD's AI Wire panel and the spoken daily brief both read the ## Headlines section — keep those bullets tight.\n\nEnd your reply with: SAVED ${deliverable}`,
};
