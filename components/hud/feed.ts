import { humanizeFailure, scrubRunSummary } from "@/lib/spokenText";

// The event feed's line shape, and the sentence a finished run is announced
// with.
//
// runAnnouncement() is the last filter before the speakers: a run summary is
// line 1 of a model's reply, and models occasionally ignore the spoken-summary
// contract and leak "(headless)" or a SAVED path into it. The prompt is the
// real fix; this is the safety net.

export interface FeedLine {
  ts: string;
  cls: string;
  text: string;
}

export function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

// spoken line for a finished run — short, no markdown, summary clamped.
// Summaries pass through scrubRunSummary so prompt-contract violations
// ("(headless)", SAVED-path tails) never reach the speakers.
export function runAnnouncement(skill: string, status: string, summary: string, label?: string | null): string {
  const name = label ? `${label} ask` : skill.replace(/-/g, " ");
  if (status !== "ok") {
    const why = summary ? humanizeFailure(summary) : "";
    return `${name} hit a snag${why ? ` — ${why.slice(0, 120)}` : "."}`;
  }
  const clean = scrubRunSummary(summary);
  // voice-ask runs put the spoken answer in line 1 of output (= summary) —
  // speak it directly instead of "voice ask complete"
  if (skill === "voice-ask" && clean) {
    return clean.slice(0, 220);
  }
  // "plan today is done. Done." — a summary that only says done adds nothing
  const redundant = /^(done|complete|completed|finished|all done|ok)[.!]?$/i.test(clean);
  return `${name} is done.${clean && !redundant ? ` ${clean.slice(0, 160)}` : ""}`;
}

// ---------------------------------------------------------------------------
// panels (memoized — only re-render when their slice of state changes)
// ---------------------------------------------------------------------------
