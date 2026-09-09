// A deterministic vault built fresh for every test process, sized to
// exercise every reader path in the library: metrics with enough history for
// weekly deltas, a live runner heartbeat, today's daily note, a morning
// report with mixed link shapes, runs in all four statuses (with a
// `link:`-bearing deliverable), a two-entry queue, and conversation memory
// that ends on a standing offer.
//
// Every timestamp is relative to FROZEN_NOW_MS; every file mtime is set
// explicitly, because the readers order runs by mtime and window them by
// age. Tests must freezeClock() before reading.
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_ROOT, FROZEN_NOW_MS, TODAY } from "./env";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const iso = (offsetMs: number) => new Date(FROZEN_NOW_MS + offsetMs).toISOString();

export const IDS = {
  runMorningToday: "11111111-aaaa-4aaa-8aaa-111111111111",
  runVoiceAskLinked: "22222222-bbbb-4bbb-8bbb-222222222222",
  runInboxRunning: "33333333-cccc-4ccc-8ccc-333333333333",
  runPlanTodayError: "44444444-dddd-4ddd-8ddd-444444444444",
  runCleanupOld: "55555555-eeee-4eee-8eee-555555555555",
  runMorningYesterday: "66666666-ffff-4fff-8fff-666666666666",
  runVoiceAskOld: "77777777-0000-4000-8000-777777777777",
  queueInbox: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1",
  queueVoiceAsk: "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2",
} as const;

/** Fixture ids are kept verbatim by the golden normalizer; anything else
 *  UUID-shaped is treated as freshly generated and masked. */
export const FIXTURE_IDS: Set<string> = new Set(Object.values(IDS));

export const PATHS = {
  morningToday: `inbox/reports/morning/${TODAY}-morning-report-deadbeef.md`,
  morningYesterday: "inbox/reports/morning/2026-09-08-morning-report-cafebabe.md",
  voiceAskLinked: `inbox/voice/${TODAY}-hey-jarvis-can-you-tell-me-about-the-fable-five-22222222.md`,
  voiceAskOld: "inbox/voice/2026-09-06-whats-the-weather-77777777.md",
  inboxBriefPending: `inbox/reports/inbox-briefs/${TODAY}-33333333.md`,
  cleanupOld: "inbox/reports/vault-cleanup/2026-09-07-cleanup-55555555.md",
  dailyToday: `daily-notes/${TODAY}.md`,
  dailyOlder: "daily-notes/2026-09-01.md",
  memory: "system/voice/memory.jsonl",
} as const;

function write(rel: string, content: string, mtimeMs: number = FROZEN_NOW_MS - HOUR): void {
  const abs = path.join(FIXTURE_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  const t = new Date(mtimeMs);
  fs.utimesSync(abs, t, t);
}

function json(rel: string, obj: unknown, mtimeMs?: number): void {
  write(rel, JSON.stringify(obj, null, 2) + "\n", mtimeMs);
}

function metricsCsv(): string {
  const rows = ["timestamp,source,metric,value,status,error"];
  const base = FROZEN_NOW_MS - 3 * HOUR; // last pull three hours ago
  const series = (source: string, metric: string, n: number, start: number, step: number, status: string) => {
    for (let k = n - 1; k >= 0; k--) {
      rows.push(`${iso(-3 * HOUR - k * 6 * HOUR)},${source},${metric},${start + (n - 1 - k) * step},${status},`);
    }
  };
  void base;
  series("youtube", "subscribers", 8, 49600, 115, "ok"); // 49600 → 50405
  series("youtube", "views_28d", 8, 412050, 3550, "ok");
  series("instagram", "followers", 3, 232800, 400, "ok");
  series("tiktok", "followers", 7, 3120, 140, "ok");
  series("stripe", "mrr", 2, 4100, 100, "mock");
  series("claude_code", "tokens_5h", 1, 391022, 0, "ok");
  rows.push(`${iso(-2 * HOUR)},youtube,subscribers,notanumber,ok,`); // skipped: NaN
  rows.push("short,row"); // skipped: too few columns
  rows.push(""); // blank line
  return rows.join("\n") + "\n";
}

const DAILY_TODAY = `---
date: ${TODAY}
schema_version: 1
focus: "Ship the golden suite before the refactor lands"
---

# ${TODAY}

## Top 3 Priorities

1. [x] Pin every behavior the HUD reads
2. [ ] Rewrite the router behind the suite
3. [ ] Reply to the sponsor email — $4,200 offer

## Schedule

- 09:00 — Deep work (locked)
- 13:00 - Edit session
- 16:30 – Weekly sync (Google Meet)
- 20:00 — Stream: building in public

## Current Focus

Land the characterization suite, then start the seams.

## Notes

Freeform, not parsed — 1,437,000 views and $200M mentioned to trip nothing.
`;

const DAILY_OLDER = `---
date: 2026-09-01
schema_version: 1
focus: "Older note — only read when today's is missing"
---

# 2026-09-01

## Top 3 Priorities

1. [x] Old item one
2. [x] Old item two
3. [ ] Old item three

## Schedule

- 10:00 — Old meeting

## Current Focus

Old focus line.
`;

const MORNING_TODAY = `---
date: ${TODAY}
skill: morning-report
tags: [morning, briefing]
---

# Morning Report

**Date:** ${TODAY}

## Headlines

- **Anthropic posts its first profit** — $559M operating profit on $10.9B quarterly revenue. [source](https://example.com/anthropic-profit)
- *OpenAI eyes a $1T+ IPO* as soon as September; Nvidia lining up ~$100B. https://example.com/openai-ipo
- Google's Gemini crosses 1B monthly users and ships \`Gemini 3.7 Flash\`. [Unrot](https://example.com/gemini) and [more](https://example.com/gemini-2)
- Open-weight push continues with no source link on this one at all
- A fifth headline that the four-headline cap must drop. [source](https://example.com/fifth)
* Sixth, star-bulleted, also past the cap. [source](https://example.com/sixth)

## Web — News & Articles

- Body bullet that is NOT a headline. [source](https://example.com/body)

## Sources

- https://example.com/anthropic-profit
`;

const MORNING_YESTERDAY = `---
date: 2026-09-08
skill: morning-report
tags: [morning, briefing]
---

# Morning Report

## Headlines

- Yesterday's headline, never surfaced today. [source](https://example.com/yesterday)
`;

const VOICE_ASK_LINKED = `---
date: ${TODAY}
skill: voice-ask
prompt: "hey jarvis can you tell me about the fable five launch please"
link: https://mail.google.com/mail/u/0/#drafts?compose=abc123
tags: [voice]
---

# Fable 5 launch

Fable 5 shipped this morning with a 1M-token context window.
`;

const VOICE_ASK_OLD = `---
date: 2026-09-06
skill: voice-ask
prompt: "what's the weather"
tags: [voice]
---

Sunny, 78°F, light wind.
`;

const CLEANUP_OLD = `---
date: 2026-09-07
skill: vault-cleanup
tags: [cleanup, ops]
---

# Vault cleanup

Archived 4 stale files.
`;

function runMd(id: string, skill: string, status: string): string {
  return `---
run_id: ${id}
skill: ${skill}
status: ${status}
---

# ${skill} run

\`\`\`
output for ${id}
\`\`\`
`;
}

function run(
  id: string,
  skill: string,
  status: "ok" | "error" | "running",
  startedOffset: number,
  durationS: number | null,
  summary: string,
  deliverable: string | null,
  args: Record<string, unknown> = {},
  exitCode: number | null = status === "ok" ? 0 : status === "error" ? -1 : null
): void {
  const started = iso(startedOffset);
  const completed = durationS === null ? null : iso(startedOffset + durationS * 1000);
  const mtime = FROZEN_NOW_MS + (durationS === null ? startedOffset : startedOffset + durationS * 1000);
  json(
    `system/runs/${id}.json`,
    {
      id,
      skill,
      args,
      ts_queued: iso(startedOffset - 2000),
      ts_started: started,
      ts_completed: completed,
      status,
      exit_code: exitCode,
      summary,
      md_path: `system/runs/${id}.md`,
      log_path: `system/runs/${id}.md`,
      deliverable_path: deliverable,
    },
    mtime
  );
  write(`system/runs/${id}.md`, runMd(id, skill, status), mtime);
}

function memoryJsonl(): string {
  const lines = [
    JSON.stringify({ ts: iso(-30 * MIN), you: "any news on fable", jarvis: "Working on it — I'll speak up when it lands.", tier: 3, skill: "voice-ask" }),
    "{oops not json",
    JSON.stringify({ ts: iso(-9 * MIN), you: "what's in the queue", jarvis: "Two things waiting: the inbox brief and a voice ask.", tier: 2 }),
    JSON.stringify({ ts: iso(-5 * MIN), you: "run the morning report", jarvis: "On it — morning report coming up.", tier: 1, skill: "morning-report" }),
    JSON.stringify({ ts: iso(-1 * MIN), you: "give me the rundown", jarvis: "Good morning. Two of three goals still open. Want me to run the inbox audit?", tier: 2 }),
  ];
  return lines.join("\n") + "\n";
}

export function buildFixtureVault(): string {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, "home"), { recursive: true });

  write("system/metrics/metrics.csv", metricsCsv(), FROZEN_NOW_MS - 3 * HOUR);
  json(
    "system/metrics/latest-video.json",
    {
      comments: 12,
      error: "",
      likes: 231,
      published_at: "2026-09-07T18:00:00Z",
      status: "ok",
      title: "Fixture Upload — golden vault",
      ts: iso(-3 * HOUR),
      url: "https://www.youtube.com/watch?v=fixture01",
      video_id: "fixture01",
      views: 18400,
    },
    FROZEN_NOW_MS - 3 * HOUR
  );
  json(
    "system/runner-status.json",
    {
      ts: iso(-20_000),
      pid: 4242,
      version: "1.0.1",
      busy: true,
      active: 1,
      max_concurrent: 3,
      pending: 1,
      in_flight: ["inbox-brief"],
    },
    FROZEN_NOW_MS - 20_000
  );

  write(PATHS.dailyToday, DAILY_TODAY, FROZEN_NOW_MS - 2 * HOUR);
  write(PATHS.dailyOlder, DAILY_OLDER, FROZEN_NOW_MS - 8 * DAY);
  write(PATHS.morningToday, MORNING_TODAY, FROZEN_NOW_MS - 32 * MIN);
  write(PATHS.morningYesterday, MORNING_YESTERDAY, FROZEN_NOW_MS - DAY);
  write(PATHS.voiceAskLinked, VOICE_ASK_LINKED, FROZEN_NOW_MS - 11 * MIN);
  write(PATHS.voiceAskOld, VOICE_ASK_OLD, FROZEN_NOW_MS - 3 * DAY);
  write(PATHS.cleanupOld, CLEANUP_OLD, FROZEN_NOW_MS - 2 * DAY);

  run(IDS.runMorningToday, "morning-report", "ok", -35 * MIN, 180,
    `Morning briefing is ready — five headlines, Anthropic profit leads. SAVED ${PATHS.morningToday}`,
    PATHS.morningToday);
  run(IDS.runVoiceAskLinked, "voice-ask", "ok", -12 * MIN, 58,
    "Fable 5 shipped this morning with a 1M-token context window and $200M in launch-week revenue (headless).",
    PATHS.voiceAskLinked,
    { prompt: "hey jarvis can you tell me about the fable five launch please", context: "User: any news on fable\nJarvis: Working on it." });
  run(IDS.runInboxRunning, "inbox-brief", "running", -2 * MIN, null, "", PATHS.inboxBriefPending);
  run(IDS.runPlanTodayError, "plan-today", "error", -70 * MIN, 600,
    "[runner: hard timeout 10m — killed]", PATHS.dailyToday, {}, -1);
  run(IDS.runCleanupOld, "vault-cleanup", "ok", -2 * DAY, 95,
    "Archived 4 stale files; nothing else moved.", PATHS.cleanupOld);
  run(IDS.runMorningYesterday, "morning-report", "ok", -DAY - 20 * MIN, 300,
    "Morning briefing is ready.", PATHS.morningYesterday);
  run(IDS.runVoiceAskOld, "voice-ask", "ok", -3 * DAY, 40,
    "Sunny and seventy-eight degrees.", PATHS.voiceAskOld, { prompt: "what's the weather" });
  write("system/runs/bad.json", "{not json", FROZEN_NOW_MS - 4 * DAY);

  json(`system/queue/${IDS.queueInbox}.json`,
    { id: IDS.queueInbox, skill: "inbox-brief", args: {}, ts: iso(-1 * MIN), source: "vault-hud" },
    FROZEN_NOW_MS - 1 * MIN);
  json(`system/queue/${IDS.queueVoiceAsk}.json`,
    { id: IDS.queueVoiceAsk, skill: "voice-ask", args: { prompt: "summarize my week in three bullets" }, ts: iso(-30_000), source: "voice-ptt" },
    FROZEN_NOW_MS - 30_000);

  write(PATHS.memory, memoryJsonl(), FROZEN_NOW_MS - 1 * MIN);
  return FIXTURE_ROOT;
}

export function destroyFixtureVault(): void {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
}

/** Remove today's daily note so readers fall back to the most recent one. */
export function removeTodayNote(): void {
  fs.rmSync(path.join(FIXTURE_ROOT, PATHS.dailyToday), { force: true });
}

export function readFixtureFile(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf-8");
}

export function listFixtureDir(rel: string): string[] {
  try {
    return fs.readdirSync(path.join(FIXTURE_ROOT, rel)).sort();
  } catch {
    return [];
  }
}
