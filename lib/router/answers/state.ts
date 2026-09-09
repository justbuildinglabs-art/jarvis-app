import { readVaultMarkdown, type VaultState } from "../../vault";
import { spokenNum, spokenMoney, spokenTime, weekDelta, metric, listOut } from "../format";
import type { PanelId, Reveal } from "../types";
import { briefing, nextScheduleItem } from "./briefing";
import { BRIEFING_RE } from "../patterns";

// Tier-2 answers: everything the router can say straight from the vault
// snapshot, with no model in the loop. openDocAnswer() runs first because an
// open-verb ("show me the trend scan") means the DOCUMENT from the last run,
// not a fresh run of the skill.

export interface StateAnswer {
  text: string;
  panels: PanelId[];
  deliverable?: string;
  reveal?: "open";
  reveals?: Reveal[];
}

// "bring up the html" / "open that report" — find the deliverable a recent
// run produced and pop it on screen NOW. Without this, asking to see a doc
// burned a whole background claude session just to open a file.
const OPEN_VERB = /\b(bring up|pull up|open|show me|show us|put up|display)\b/;
const DOC_WORD = /\b(that|it|html|page|explainer|doc|document|report|file|deliverable|note|results?)\b/;
const OPEN_STOPWORDS =
  /\b(bring|pull|up|open|show|me|us|put|display|the|that|it|for|can|you|please|jarvis|again|back|one|thing|doc|document|file|note|report|reports|today|todays)\b/g;

export function openDocAnswer(t: string, state: VaultState): StateAnswer | null {
  if (!OPEN_VERB.test(t)) return null;
  // "give me the rundown"-style asks stay with the briefing
  if (/\brundown|briefing|brief me|catch me up\b/.test(t)) return null;
  const cands = state.runs.filter((r) => r.status === "ok" && r.deliverable_path);
  const words = t.replace(OPEN_STOPWORDS, " ").split(/\s+/).filter((w) => w.length > 2);
  // newest first; keyword overlap against skill + summary + filename promotes
  // an older doc only when the ask clearly names it ("the trend scan")
  let best = cands[0] ?? null;
  let bestScore = 0;
  for (const r of cands) {
    // skill + label + summary + FILENAME only — full paths poisoned scoring
    // (every inbox-brief lives under inbox/reports/, which substring-matched
    // "repo" and "report" and outscored the doc actually being asked for)
    const file = r.deliverable_path?.split("/").pop() ?? "";
    const hay = `${r.skill} ${r.label ?? ""} ${r.summary} ${file}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  // open intent needs either a generic doc word ("that"/"report"/"html") or a
  // keyword hit on an actual run ("the trend scan") — otherwise it's not ours
  if (!DOC_WORD.test(t) && bestScore === 0) return null;
  // the morning report lives outside the runs list — resolve it directly
  if (bestScore === 0 && /\bmorning\b/.test(t) && state.morning) {
    return {
      text: "Here's this morning's report. On screen now.",
      panels: ["documents"],
      deliverable: state.morning.rel,
      reveal: "open",
    };
  }
  // specific words but nothing matched — opening whatever's newest is a lie
  if (bestScore === 0 && words.length > 0) {
    return {
      text: "I don't see a recent document matching that — the Documents panel has the last five.",
      panels: ["documents"],
    };
  }
  if (!best) {
    return { text: "I don't have any documents on file yet.", panels: ["documents"] };
  }
  return {
    text: `Here it is — the ${best.skill.replace(/-/g, " ")} from earlier. On screen now.`,
    panels: ["documents"],
    deliverable: best.deliverable_path!,
    reveal: "open",
  };
}

export function stateAnswer(t: string, state: VaultState): StateAnswer | null {
  const doc = openDocAnswer(t, state);
  if (doc) return doc;
  if (BRIEFING_RE.test(t)) {
    const b = briefing(state);
    return {
      text: b.text,
      panels: b.deliverable
        ? ["priorities", "schedule", "objective", "vitals", "documents"]
        : ["priorities", "schedule", "objective", "vitals"],
      deliverable: b.deliverable,
      reveals: b.reveals,
    };
  }
  // "m r r" / "m r are" — STT splits or mishears the acronym after the
  // normalizer strips dots ("M.R.R." → "m r r")
  if (/mrr|\bm r r\b|\bm r are\b|revenue|recurring|money/.test(t)) {
    const m = metric(state, "stripe", "mrr");
    if (!m) return { text: "I don't have an MRR reading yet.", panels: ["objective"] };
    const pct = Math.round((m.value / 10_000) * 100);
    const sim = m.status === "mock" ? " Fair warning — that's still a simulated number." : "";
    return {
      text: `Revenue's sitting at ${spokenMoney(m.value)} a month — ${pct} percent of the way to ten K.${sim}`,
      panels: ["objective"],
    };
  }
  if (/runner|daemon/.test(t)) {
    const r = state.runner;
    if (!r) return { text: "The runner looks down — I'm not seeing a status file.", panels: ["diagnostics"] };
    return {
      text: r.alive
        ? `Runner's alive and ${r.busy ? `working — ${r.active} job${r.active === 1 ? "" : "s"} active` : "idle"}${r.pending > 0 ? `, ${r.pending} waiting in the queue` : ""}.`
        : "The runner's heartbeat has gone stale — it looks down.",
      panels: ["diagnostics", "pipeline"],
    };
  }
  if (/subscriber|subs\b/.test(t)) {
    const m = metric(state, "youtube", "subscribers");
    return {
      text: m
        ? `You're at ${spokenNum(m.value)} YouTube subscribers${weekDelta(m)}.`
        : "I don't have a subscriber reading.",
      panels: ["vitals"],
    };
  }
  if (/youtube.*views|views.*youtube|28 day/.test(t)) {
    const m = metric(state, "youtube", "views_28d");
    return {
      text: m
        ? `${spokenNum(m.value)} YouTube views over the last 28 days${weekDelta(m)}.`
        : "I don't have a views reading.",
      panels: ["vitals"],
    };
  }
  if (/instagram/.test(t)) {
    const m = metric(state, "instagram", "followers");
    return {
      text: m
        ? `Instagram's at ${spokenNum(m.value)} followers${weekDelta(m)}.`
        : "I don't have an Instagram reading.",
      panels: ["vitals"],
    };
  }
  if (/tiktok/.test(t)) {
    const m = metric(state, "tiktok", "followers");
    return {
      text: m
        ? `TikTok's at ${spokenNum(m.value)} followers${weekDelta(m)}.`
        : "I don't have a TikTok reading.",
      panels: ["vitals"],
    };
  }
  if (/latest video|last video|video doing/.test(t)) {
    const v = state.latestVideo;
    return {
      text: v
        ? `The latest video — ${v.title} — is at ${spokenNum(v.views)} views and ${spokenNum(v.likes)} likes.`
        : "I don't have video data yet.",
      panels: ["vitals", "objective"],
    };
  }
  if (/token|claude usage/.test(t)) {
    const m = metric(state, "claude_code", "tokens_5h");
    return {
      text: m
        ? `You've used ${spokenNum(m.value)} Claude tokens in the current five-hour window.`
        : "I don't have a token reading.",
      panels: ["vitals"],
    };
  }
  if (/queue/.test(t)) {
    if (state.queue.length === 0) return { text: "The queue's empty.", panels: ["pipeline"] };
    const names = state.queue.map((q) => q.skill.replace(/-/g, " ")).join(", ");
    return {
      text: `${state.queue.length === 1 ? "One thing" : `${state.queue.length} things`} in the queue: ${names}.`,
      panels: ["pipeline"],
    };
  }
  if (/top 3|top three|priorit|directive|goal/.test(t)) {
    const d = state.daily;
    if (!d || d.top3.length === 0) return { text: "Nothing's on the board yet.", panels: ["priorities"] };
    const open = d.top3.filter((p) => !p.done);
    return {
      text:
        open.length === 0
          ? "You've cleared all three priorities. Strong day."
          : `${open.length === 1 ? "One left" : `${open.length} still open`}: ${listOut(open.map((p) => p.text))}.`,
      panels: ["priorities"],
    };
  }
  if (/schedule|next today|what s next|whats next|next up/.test(t)) {
    const d = state.daily;
    if (!d || d.schedule.length === 0) return { text: "Nothing's on the schedule.", panels: ["schedule"] };
    const next = d.isToday ? nextScheduleItem(state) : null;
    return {
      text: next
        ? `Coming up at ${spokenTime(next.time)} — ${next.item}.`
        : d.isToday
          ? "You're clear for the rest of the day."
          : "No schedule for today yet — say plan today and I'll set one up.",
      panels: ["schedule"],
    };
  }
  if (/focus/.test(t)) {
    const d = state.daily;
    return {
      text: d?.focus ? `Today's focus is ${d.focus}.` : "No focus set for today.",
      panels: ["schedule"],
    };
  }
  if (/last run|last fail|recent run/.test(t)) {
    const r = state.runs.find((x) => x.status === "ok" || x.status === "error");
    if (!r) return { text: "No recent runs.", panels: ["pipeline"] };
    return {
      text: `The last run was ${r.skill.replace(/-/g, " ")} — it ${r.status === "ok" ? "finished fine" : "failed"}. ${r.summary.slice(0, 120)}`,
      panels: ["pipeline", "diagnostics"],
    };
  }
  return null;
}

// "A, B, and C" — spoken list with a natural and-join
