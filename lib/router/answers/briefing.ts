import { HUD_TZ } from "../../config";
import { readMorningReport, type Metric, type VaultState } from "../../vault";
import { spokenNum, spokenMoney, spokenTime, weekDelta, metric, listOut } from "../format";
import type { Reveal } from "../types";

// The daily rundown — the one answer that reads the whole vault at once and
// speaks it as a paragraph, plus the offer sentence it ends on.
//
// briefingOffer() is load-bearing beyond its wording: the sentence it
// produces is parsed back out of conversation memory verbatim when the user
// answers "yes", so it is bound to OFFER_SKILLS and the pattern in
// pendingOffer() (see ./offer.ts). Move one, move all three.


export function localHour(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: HUD_TZ,
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
    10
  );
}

// `## Headlines` mining lives in lib/vault.ts (readMorningReport) — shared
// with the AI Wire panel; the briefing speaks the top two

export function nextScheduleItem(state: VaultState): { time: string; item: string } | null {
  const d = state.daily;
  if (!d?.isToday || d.schedule.length === 0) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    d.schedule.find((s) => {
      const m = s.time.match(/^(\d{1,2}):(\d{2})$/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) > nowMin : false;
    }) ?? null
  );
}

// parentheticals read terribly out loud — "(PTT loop + barge-in on camera)"
export function stripParens(s: string): string {
  return s.replace(/\s*\([^)]*\)/g, "").trim();
}

// one headline, parentheticals stripped, cut at a CLAUSE boundary — a dangling
// "beating X by 10%+ on some." reads worse than stopping a clause early
export function trimHead(h: string): string {
  let s = stripParens(h);
  if (s.length > 120) {
    const head = s.slice(0, 120);
    const clause = Math.max(head.lastIndexOf(","), head.lastIndexOf(" — "), head.lastIndexOf("; "));
    s = clause > 60 ? head.slice(0, clause) : head.slice(0, head.lastIndexOf(" "));
    s = s.replace(/[,;:—–-]\s*$/, "").trim();
  }
  return s;
}

// "wave-top" headline — first clause only, the kind of thing you'd expand on
// if asked ("Claude released Fable"), not the whole paragraph
export function waveTop(h: string): string {
  const s = stripParens(h);
  const dash = s.indexOf(" — ");
  const comma = s.indexOf(", ");
  const cuts = [dash, comma].filter((i) => i > 25);
  const cut = cuts.length > 0 ? Math.min(...cuts) : -1;
  return (cut > 0 ? s.slice(0, cut) : trimHead(s)).slice(0, 90);
}

// Morning-kickoff template — the shape, not a script. Every slot fills from
// live state at ask-time:
//   audience pulse (all platforms) → latest-video momentum → ONE wave-top AI
//   headline → today's mission → "where do you want me to start?"
// Wave tops only; everything is one follow-up question away. ~55 words.
export function briefing(state: VaultState): {
  text: string;
  deliverable?: string;
  reveals: Reveal[];
} {
  const parts: string[] = [];
  const reveals: Reveal[] = [];
  // char offset where the NEXT sentence will start — reveals fire when the
  // voice reaches their sentence
  const mark = () => parts.join(" ").length + (parts.length > 0 ? 1 : 0);
  const d = state.daily;

  // total audience, summed live across platforms
  const reachMetrics = [
    metric(state, "youtube", "subscribers"),
    metric(state, "instagram", "followers"),
    metric(state, "tiktok", "followers"),
  ].filter((m): m is Metric => m !== null && m.status !== "mock");
  const reach = reachMetrics.reduce((s, m) => s + m.value, 0);
  const reachDelta = reachMetrics.reduce((s, m) => s + (m.deltaWeek ?? 0), 0);

  const h = localHour();
  const opener =
    h < 5 ? "Burning the midnight oil." : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening.";
  if (reach > 0) {
    parts.push(
      `${opener} You're sitting at about ${spokenNum(reach)} followers across all platforms${
        reachDelta > 0 ? ` — up about ${spokenNum(reachDelta)} this week` : ""
      }.`
    );
  } else {
    parts.push(opener);
  }

  const v = state.latestVideo;
  if (v) {
    if (v.url) reveals.push({ kind: "link", target: v.url, label: "latest deploy", at: mark() });
    const days = Math.max((Date.now() - Date.parse(v.published_at)) / 86_400_000, 0.25);
    parts.push(
      `The latest video's pulling about ${spokenNum(v.views / days)} views a day — ${spokenNum(v.views)} so far.`
    );
  }

  const report = readMorningReport(2);
  const heads = report?.heads ?? [];
  if (heads[0]) {
    if (report?.rel) reveals.push({ kind: "doc", target: report.rel, label: "morning report", at: mark() });
    const src = report?.links?.[0];
    if (src) reveals.push({ kind: "link", target: src, label: "source", at: mark() });
    parts.push(`Big story in AI today: ${waveTop(heads[0])}.`);
  }

  // real revenue only — mock numbers stay off the spoken brief
  const mrr = metric(state, "stripe", "mrr");
  if (mrr && mrr.status !== "mock") parts.push(`Revenue's at ${spokenMoney(mrr.value)} monthly.`);

  if (d?.isToday) {
    const open = d.top3.filter((p) => !p.done);
    if (open.length > 0) {
      parts.push(`Biggest thing on today's board: ${stripParens(open[0].text).slice(0, 80)}.`);
    } else if (d.top3.length > 0) {
      parts.push("The board's clear — all three goals done.");
    }
  } else {
    parts.push("No daily note yet — say plan today and I'll set one up.");
  }

  const r = state.runner;
  if (r && !r.alive) parts.push("Heads-up — the background runner looks offline.");

  // hand the mic back with a CONCRETE offer — "yes" dispatches it (see
  // pendingOffer / AFFIRM_RE). Phrasing must match OFFER_SKILLS keys.
  const offer = briefingOffer(state, heads.length > 0);
  if (/inbox audit/.test(offer)) {
    reveals.push({ kind: "link", target: "https://mail.google.com", label: "inbox", at: mark() });
  }
  parts.push(offer);

  // safety cap — drop whole sentences, never chop mid-word
  let text = parts.join(" ");
  if (text.length > 750) {
    text = text.slice(0, 750);
    const cut = text.lastIndexOf(". ");
    if (cut > 200) text = text.slice(0, cut + 1);
  }
  return {
    text,
    deliverable: report?.rel,
    reveals: reveals.filter((r) => r.at < text.length),
  };
}

// state-picked closing offer — wording is load-bearing: pendingOffer() parses
// it back out of convo memory when the user answers "yes"
export function briefingOffer(state: VaultState, hasReport: boolean): string {
  // the offer phrase must stay verbatim-matchable by pendingOffer()'s regex;
  // the open-ended tail rides AFTER it and never reaches the capture group
  const TAIL = ", or do you have anything else in mind?";
  const h = localHour();
  if (!hasReport && h < 16) return `Want me to run the morning report${TAIL}`;
  return `Want me to run the daily inbox audit${TAIL}`;
}
