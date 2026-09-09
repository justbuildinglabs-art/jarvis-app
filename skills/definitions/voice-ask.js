// voice-ask
//
// Open-ended spoken asks (tier 3). Never on the deck: it has no fixed
// task, only whatever was said.
//
// Generated behavior is pinned by tests/golden/runner/* — the prompt text is
// the contract, so edit it only with a golden update and a reason.

/** @type {import('../types.js').SkillDefinition} */
export default {
  id: "voice-ask",
  label: null, // never rendered on the deck
  deck: false,
  order: 6,
  aliasOrder: null, // not voice-dispatchable by name
  aliases: [],
  deliverable: ({ date, id8, args, slugify }) =>
    `inbox/voice/${date}-${slugify(args.prompt || "ask")}-${id8}.md`,
  prompt({ intent, deliverable, prefix }) {
    const args = intent.args || {};
    const ask = (args.prompt || "").trim();
    // no ask, no run — an empty prompt would spawn a session with nothing to do
    if (!ask) return null;
    const convo = (args.context || "").trim();
    const convoBlock = convo
      ? `\n\nRecent voice conversation (context — the ask may refer back to it):\n${convo}`
      : "";
    return `${prefix}\n\nVoice request from the user (spoken via push-to-talk, machine-transcribed — minor transcription errors possible): ${JSON.stringify(ask)}${convoBlock}\n\nDo the task fully. Write the complete result as a markdown note at exactly ${deliverable} — YAML frontmatter \`date\`, \`skill: voice-ask\`, \`prompt: ${JSON.stringify(ask)}\`, \`tags: [voice]\`. If the REAL output of the task lives at a URL — a Gmail draft you created (the create_draft response includes the draft's message id — deep-link it: https://mail.google.com/mail/u/0/#drafts?compose=<message id>; only if no id came back, fall back to https://mail.google.com/mail/#drafts), a video, a doc, a page — ALSO add \`link: <that url>\` to the frontmatter; the dashboard will send the user there directly instead of to this note.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud to the user by text-to-speech. Make it ONE conversational sentence (under 200 characters) that directly answers the ask or states the outcome — no markdown, no file paths in it. After that line, end with: SAVED ${deliverable}`;
  },
};
