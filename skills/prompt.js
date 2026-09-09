// The preamble every skill prompt opens with.
//
// Two things ride on it and both are load-bearing:
//   * AskUserQuestion is banned. Headless `claude -p` has nobody to answer,
//     so a skill that asks stalls until the runner's hard timeout kills it.
//   * The SPOKEN SUMMARY CONTRACT. The first line of the model's reply is
//     read aloud verbatim by the voice layer, so it has to be one plain
//     sentence — no markdown, no file paths.
//
// Pinned verbatim by tests/golden/runner/autonomous-prefix.
export const AUTONOMOUS_PREFIX =
"Execute the requested task autonomously in headless mode. Do not ask the user for confirmation. Do not call AskUserQuestion. Continue until the deliverable is written.\n\nSPOKEN SUMMARY CONTRACT: the FIRST line of your final reply is read aloud to the user by a voice assistant. Make it ONE conversational sentence (max ~140 chars) a calm butler would say - lead with the outcome PLUS two or three concrete highlights from what you produced (names, titles, the numbers that matter) — 'the report is done' with no specifics is useless, round big numbers to clean magnitudes (say 'about 13 thousand', never '13,206'). Never mention: headless, autonomous, task, deliverable, file paths, markdown, or process narration ('waiting for', 'running'). Every other detail belongs in the written deliverable, not the spoken line.";
