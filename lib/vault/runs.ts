import { basename } from "path";
import { jsonFilesByMtime, readJson, readText, resolveReadable, vaultPath } from "./storage";
import type { RunEntry } from "./types";

// system/runs/*.json — what the runner has done, newest first.
//
// Two derived fields carry most of the weight in the UI: `label`, a short
// topic tag so two simultaneous voice-asks are distinguishable ("fable 5
// news" vs "gmail thing"), and `link`, which redirects a callout to where the
// run's REAL output lives when that is a URL rather than the note.

// short topic tag for a voice-ask — every ask shows as "voice ask" otherwise,
// which is useless when two are in flight ("fable 5 news" vs "gmail thing").
// First 3 content words of the prompt.
const ASK_STOP = new Set([
  "a", "an", "the", "me", "my", "i", "you", "your", "please", "jarvis", "hey",
  "ok", "okay", "can", "could", "would", "tell", "about", "like", "little",
  "bit", "more", "just", "that", "this", "what", "whats", "is", "are", "do",
  "does", "of", "for", "to", "in", "on", "and", "or", "so", "um", "uh",
  "once", "when", "after", "with", "go", "run", "really", "actually", "know",
  "want", "wanted", "give", "get", "out", "up", "some", "any", "how",
  "ahead", "also", "then", "now", "again", "came", "thing", "things", "stuff",
]);
export function askLabel(args: unknown): string | null {
  const prompt = (args as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string") return null;
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !ASK_STOP.has(w));
  return words.length ? words.slice(0, 3).join(" ") : null;
}

// peek a deliverable's frontmatter for `link: <url>` — when present, the
// run's real output lives at that URL and callouts open it instead of the md
function deliverableLink(relPath: unknown): string | null {
  if (typeof relPath !== "string" || !relPath) return null;
  // same guard as readVaultMarkdown — deliverable_path comes from runner-written
  // run JSON, and runs process untrusted content (emails, web); never follow it
  // outside the dirs runs write to
  const abs = resolveReadable(relPath);
  if (!abs) return null;
  try {
    const raw = (readText(abs) ?? "").slice(0, 800);
    if (!raw.startsWith("---")) return null;
    const fm = raw.split(/\r?\n---/)[0];
    const m = fm.match(/^link:\s*["']?(https?:\/\/\S+?)["']?\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function readRecentRuns(limit = 8): RunEntry[] {
  const files = jsonFilesByMtime(vaultPath("system", "runs")).slice(0, limit);
  const out: RunEntry[] = [];
  for (const f of files) {
    const j = readJson<Record<string, unknown>>(f);
    if (!j) continue;
    const started = j.ts_started ? Date.parse(String(j.ts_started)) : NaN;
    const completed = j.ts_completed ? Date.parse(String(j.ts_completed)) : NaN;
    const duration =
      !Number.isNaN(started) && !Number.isNaN(completed)
        ? Math.max(0, Math.round((completed - started) / 1000))
        : null;
    out.push({
      id: String(j.id ?? basename(f, ".json")),
      skill: String(j.skill ?? "?"),
      label: String(j.skill) === "voice-ask" ? askLabel(j.args) : null,
      link: String(j.status) === "ok" ? deliverableLink(j.deliverable_path) : null,
      status: String(j.status ?? "?"),
      summary: String(j.summary ?? ""),
      ts_completed: j.ts_completed ? String(j.ts_completed) : null,
      ts_started: j.ts_started ? String(j.ts_started) : null,
      duration_s: duration,
      deliverable_path: j.deliverable_path ? String(j.deliverable_path) : null,
    });
  }
  return out;
}

// median past runtime per skill — feeds the task callout's progress estimate.
// Only ok runs count (errors die early and would drag the estimate down).
export function readSkillEtas(): Record<string, number> {
  const files = jsonFilesByMtime(vaultPath("system", "runs")).slice(0, 200);
  const bySkill: Record<string, number[]> = {};
  for (const f of files) {
    const j = readJson<Record<string, unknown>>(f);
    if (!j || j.status !== "ok") continue;
    const started = j.ts_started ? Date.parse(String(j.ts_started)) : NaN;
    const completed = j.ts_completed ? Date.parse(String(j.ts_completed)) : NaN;
    if (Number.isNaN(started) || Number.isNaN(completed)) continue;
    const d = Math.max(1, Math.round((completed - started) / 1000));
    (bySkill[String(j.skill ?? "?")] ??= []).push(d);
  }
  const out: Record<string, number> = {};
  for (const [skill, ds] of Object.entries(bySkill)) {
    ds.sort((a, b) => a - b);
    out[skill] = ds[Math.floor(ds.length / 2)];
  }
  return out;
}
