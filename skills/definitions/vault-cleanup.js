// vault-cleanup
//
// Archives stale files and reports what moved. The deck label reads
// "AI Clean" while the id stays vault-cleanup — the id is the contract.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "vault-cleanup",
  label: "AI Clean",
  deck: true,
  order: 5,
  aliasOrder: 3,
  aliases: [/clean ?up|ai clean|vault clean/],
  deliverable: ({ date, id8 }) =>
    `inbox/reports/vault-cleanup/${date}-cleanup-${id8}.md`,
  prompt: ({ deliverable, prefix, tz }) =>
    `${prefix}\n\nTask: tidy the vault and report at exactly ${deliverable}.\n\nScan the vault for stale files (untouched > 7 days, outside system/ and archive/). Move them into archive/ subfolders mirroring their source folder. Write a one-page report at ${deliverable} — YAML frontmatter \`date\`, \`skill: vault-cleanup\`, \`tags: [cleanup, ops]\`; body lists what moved and what was skipped.\n\nEnd your reply with: SAVED ${deliverable}`,
};
