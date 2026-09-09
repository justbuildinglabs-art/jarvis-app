import { ALLOWED_SKILLS } from "../../skills";
import type { VaultState } from "../../vault";
import { PANEL_IDS } from "../types";

// The system prompt every model engine sends. One builder, three engines:
// Haiku over HTTP, Ollama locally, and the logged-in CLI all classify against
// the same instructions and the same vault snapshot, so a change in routing
// policy lands everywhere at once instead of drifting per transport.


export function stateSummary(state: VaultState): string {
  const lines: string[] = [];
  for (const m of state.metrics) {
    lines.push(`${m.source}.${m.metric} = ${m.value} (${m.status}${m.deltaWeek !== null ? `, week delta ${m.deltaWeek}` : ""})`);
  }
  const r = state.runner;
  lines.push(r ? `runner: ${r.alive ? "alive" : "down"}, busy=${r.busy}, pending=${r.pending}` : "runner: no status");
  if (state.latestVideo) lines.push(`latest video: "${state.latestVideo.title}" views=${state.latestVideo.views}`);
  if (state.daily) {
    lines.push(`top3: ${state.daily.top3.map((p) => `${p.done ? "[x]" : "[ ]"} ${p.text}`).join("; ")}`);
    lines.push(`schedule: ${state.daily.schedule.map((s) => `${s.time} ${s.item}`).join("; ")}`);
    if (state.daily.focus) lines.push(`focus: ${state.daily.focus}`);
  }
  if (state.queue.length) lines.push(`queue: ${state.queue.map((q) => q.label ?? q.skill).join(", ")}`);
  // summaries included — without them the model can't answer "what did the
  // trending report find?" and conflates reports with each other
  if (state.runs.length) {
    lines.push("recent runs (newest first):");
    for (const x of state.runs.slice(0, 6)) {
      const name = x.label ? `${x.skill} "${x.label}"` : x.skill;
      const sum = x.summary ? ` — ${x.summary.slice(0, 140)}` : "";
      lines.push(`  ${name} [${x.status}]${sum}`);
    }
  }
  return lines.join("\n");
}

export function routerSystem(state: VaultState, convo: string): string {
  return `You are the intent router for a voice-controlled personal dashboard. Classify the user's utterance and reply in strict JSON only:
{"tier": 1|2|3, "skill": "<skill-name or omit>", "reply": "<short spoken response, max 2 sentences, plain text>", "panels": ["<dashboard panels the reply references, from: ${PANEL_IDS.join(", ")}>"]}

Tier 1: user wants to RUN one of these skills: ${[...ALLOWED_SKILLS].join(", ")}. Set "skill". Reply = brief ack. ONLY when they want it run or refreshed — asking what's IN a report / what it said / its highlights is tier 2: answer from the recent-runs summaries in the snapshot, do NOT re-run the skill.
Tier 2: user asks about dashboard state. Answer ONLY from the snapshot below — NEVER invent specifics that aren't in it. If they ask for detail beyond what the snapshot holds (e.g. "which three sponsor emails?" when only a count is listed), that is tier 3: the background session can read the full report. If they ask for the daily briefing / "what's going on today", compose a tight rundown: open directives, next schedule item, focus, latest video, MRR.
Tier 3: anything needing real reasoning, outside data, or report contents beyond the snapshot summaries. It will be dispatched to a background Claude session automatically. Reply = a brief "working on it" style ack.

Greetings and chitchat ("hey", "what's up", "how are you", "thanks", "can you hear me") are tier 2 — reply conversationally in one or two short sentences, optionally flavored with the snapshot. NEVER send chitchat to tier 3; a background session for a greeting wastes half a minute.

Dashboard snapshot:
${stateSummary(state)}${
    convo
      ? `

Recent conversation (use it to resolve follow-ups and pronouns — "that", "the second one", "make it shorter" refer to this):
${convo}`
      : ""
  }`;
}
