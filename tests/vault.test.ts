// Characterization goldens for lib/vault.ts — the plain-file readers that
// /api/state, the router and the runner callouts all consume, plus the one
// writer (toggleTop3). Pins CURRENT behavior, quirks included; nothing here
// judges it. Every test rebuilds the fixture vault (beforeEach), so a test
// may mutate the vault freely.
import "./_util/env";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_ROOT, FROZEN_NOW_MS, TODAY } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, removeTodayNote, IDS, PATHS, iso } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const vault = () => import("@/lib/vault");

// ---- fixture helpers (write into FIXTURE_ROOT only) -------------------------
const abs = (rel: string) => path.join(FIXTURE_ROOT, rel);
function put(rel: string, content: string, mtimeMs: number = FROZEN_NOW_MS - MIN): void {
  const p = abs(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}
const putJson = (rel: string, obj: unknown, mtimeMs?: number) =>
  put(rel, JSON.stringify(obj, null, 2) + "\n", mtimeMs);
const drop = (rel: string) => fs.rmSync(abs(rel), { recursive: true, force: true });
const touch = (rel: string, mtimeMs: number) => fs.utimesSync(abs(rel), new Date(mtimeMs), new Date(mtimeMs));
const readRaw = (rel: string) => fs.readFileSync(abs(rel), "utf-8");
/** mtime that puts entry i FIRST in a newest-first listing (i=0 newest), newer than every fixture file. */
const rank = (i: number) => FROZEN_NOW_MS + HOUR - i * SEC;
/** A run JSON in the runner's shape; `extra` may override any field (including id). */
function putRun(id: string, fields: Record<string, unknown>, mtimeMs: number): void {
  putJson(`system/runs/${id}.json`, { id, args: {}, summary: "", ...fields }, mtimeMs);
}
function timedRun(
  id: string,
  skill: string,
  status: string,
  startOffsetMs: number,
  durationMs: number | null,
  mtimeMs: number,
  extra: Record<string, unknown> = {}
): void {
  putRun(
    id,
    {
      skill,
      status,
      ts_started: iso(startOffsetMs),
      ts_completed: durationMs === null ? null : iso(startOffsetMs + durationMs),
      ...extra,
    },
    mtimeMs
  );
}
const linkedMd = (url: string) => `---\ndate: ${TODAY}\nskill: voice-ask\nlink: ${url}\ntags: [voice]\n---\n\n# body\n`;
const csv = (rows: string[]) => "timestamp,source,metric,value,status,error\n" + rows.join("\n") + "\n";

before(() => {
  freezeClock();
});
beforeEach(() => {
  buildFixtureVault();
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

// =============================================================================
// readVaultState
// =============================================================================
test("readVaultState: full snapshot of the default fixture", async () => {
  const { readVaultState } = await vault();
  expectGolden("vault/state-default", readVaultState());
});

test("readVaultState: a vault with no files at all yields the empty/null shape", async () => {
  const { readVaultState } = await vault();
  drop("daily-notes");
  drop("inbox");
  drop("system");
  expectGolden("vault/state-empty-vault", readVaultState());
});

// =============================================================================
// every exported reader on the default fixture
// =============================================================================
test("readMetrics: default fixture", async () => {
  const { readMetrics } = await vault();
  expectGolden("vault/metrics-default", readMetrics());
});
test("readRunnerStatus: default fixture (heartbeat 20s old → alive)", async () => {
  const { readRunnerStatus } = await vault();
  expectGolden("vault/runner-status-default", readRunnerStatus());
});
test("readLatestVideo: default fixture", async () => {
  const { readLatestVideo } = await vault();
  expectGolden("vault/latest-video-default", readLatestVideo());
});
test("readDailyNote: default fixture (today's note)", async () => {
  const { readDailyNote } = await vault();
  expectGolden("vault/daily-note-default", readDailyNote());
});
test("readRecentRuns: default fixture, default limit 8 (7 entries — bad.json is counted then skipped)", async () => {
  const { readRecentRuns } = await vault();
  expectGolden("vault/recent-runs-default", readRecentRuns());
});
test("readQueue: default fixture (mtime ascending)", async () => {
  const { readQueue } = await vault();
  expectGolden("vault/queue-default", readQueue());
});
test("readMorningReport: default fixture, default max 4", async () => {
  const { readMorningReport } = await vault();
  expectGolden("vault/morning-report-default", readMorningReport());
});
test("readSkillEtas: default fixture (even count picks the upper-middle value)", async () => {
  const { readSkillEtas } = await vault();
  expectGolden("vault/skill-etas-default", readSkillEtas());
});

// =============================================================================
// readDailyNote — fallback rules
// =============================================================================
test("readDailyNote: today's note removed → most recent dated note, isToday=false", async () => {
  const { readDailyNote } = await vault();
  removeTodayNote();
  expectGolden("vault/daily-note-fallback-older", readDailyNote());
});

test("readDailyNote: fallback picks the lexicographically LAST filename, even a future date, ignoring mtime", async () => {
  const { readDailyNote } = await vault();
  removeTodayNote();
  put("daily-notes/2026-09-05.md", "## Current Focus\n\nfrom 09-05\n", FROZEN_NOW_MS - 10 * MIN); // newest mtime
  put("daily-notes/2026-09-10.md", "## Current Focus\n\nfrom 09-10 (tomorrow)\n", FROZEN_NOW_MS - 30 * DAY); // oldest mtime
  expectGolden("vault/daily-note-fallback-picks-last-name", readDailyNote());
});

test("readDailyNote: fallback ignores files that are not YYYY-MM-DD.md", async () => {
  const { readDailyNote } = await vault();
  removeTodayNote();
  drop(PATHS.dailyOlder);
  put("daily-notes/notes.md", "## Current Focus\n\nnot dated\n");
  put("daily-notes/2026-9-1.md", "## Current Focus\n\nsingle digit\n");
  put("daily-notes/2026-09-01 copy.md", "## Current Focus\n\ncopy\n");
  put("daily-notes/2026-09-02.txt", "## Current Focus\n\ntxt\n");
  expectGolden("vault/daily-note-fallback-no-dated-files", readDailyNote());
});

test("readDailyNote: daily-notes/ missing → null", async () => {
  const { readDailyNote } = await vault();
  drop("daily-notes");
  expectGolden("vault/daily-note-missing-dir", readDailyNote());
});

test("readDailyNote: today's note is an EMPTY file → null (no fallback attempted)", async () => {
  const { readDailyNote } = await vault();
  put(PATHS.dailyToday, "");
  expectGolden("vault/daily-note-empty-file", readDailyNote());
});

test("readDailyNote: today's note is whitespace only → parsed as empty note", async () => {
  const { readDailyNote } = await vault();
  put(PATHS.dailyToday, " \n");
  expectGolden("vault/daily-note-whitespace-file", readDailyNote());
});

// =============================================================================
// readDailyNote — parser quirks
// =============================================================================
test("readDailyNote: numbered-checkbox regex variants (10., 007., uppercase X, bullets, spacing)", async () => {
  const { readDailyNote } = await vault();
  put(
    PATHS.dailyToday,
    [
      "---",
      `date: ${TODAY}`,
      "---",
      "",
      "## Top 3 Priorities",
      "",
      "1. [x] one done",
      "2. [ ] two open",
      "3. [x]   three with extra spaces   ",
      "10. [x] ten double digit",
      "007. [ ] zero padded",
      "1.[x] no space after number",
      "1. [X] uppercase X",
      "1. [x]no space after box",
      " 1. [ ] leading space",
      "- [ ] dash bullet",
      "* [x] star bullet",
      "1) [ ] paren number",
      "1. [ ] ",
      "1. [ ]",
      "1. [-] dash box",
      "1. [ x] misplaced x",
      "1. [ ] **bold text** and `code` kept verbatim",
      "1. [x] [x] double box",
      "",
    ].join("\n")
  );
  expectGolden("vault/daily-parse-checkbox-variants", readDailyNote());
});

test("readDailyNote: schedule dash variants (— – - -- mixed, no spaces, star bullet, am suffix, 3-digit hour)", async () => {
  const { readDailyNote } = await vault();
  put(
    PATHS.dailyToday,
    [
      "## Schedule",
      "",
      "- 09:00 — em dash",
      "- 13:00 – en dash",
      "- 16:30 - hyphen",
      "- 17:00 -- double hyphen",
      "- 18:00 —– mixed dashes",
      "- 19:00—no spaces",
      "- 9:05 — single digit hour",
      "- 20:00 no dash at all",
      "* 21:00 — star bullet",
      "- 22:00 — ",
      "- 9:00am — am suffix",
      "-  23:00   —   extra whitespace   ",
      "- 24:99 — nonsense time still matches",
      "- 123:00 — three digit hour",
      "  - 07:00 — indented",
      "- 08:00 — text (with parens) — and a second dash",
      "- 08:15 — [ ] checkbox inside schedule",
      "",
    ].join("\n")
  );
  expectGolden("vault/daily-parse-schedule-dashes", readDailyNote());
});

test("readDailyNote: Current Focus is the first non-blank line, verbatim, later lines ignored", async () => {
  const { readDailyNote } = await vault();
  put(
    PATHS.dailyToday,
    [
      "## Current Focus",
      "",
      "",
      "   ",
      "- first non-empty is a bullet, kept verbatim   ",
      "Second line is ignored.",
      "",
      "## Notes",
      "",
      "Notes line is not focus.",
      "",
    ].join("\n")
  );
  expectGolden("vault/daily-parse-focus-first-nonempty", readDailyNote());
});

test("readDailyNote: sections out of order still parse; content before the first ## is ignored", async () => {
  const { readDailyNote } = await vault();
  put(
    PATHS.dailyToday,
    [
      "---",
      `date: ${TODAY}`,
      "---",
      "",
      `# ${TODAY}`,
      "",
      "1. [x] before any section — ignored",
      "- 06:00 — before any section — ignored",
      "",
      "## Current Focus",
      "",
      "Focus came first.",
      "",
      "## Schedule",
      "",
      "- 11:00 — schedule second",
      "",
      "## Top 3 Priorities",
      "",
      "1. [ ] top3 last",
      "",
      "## Notes",
      "",
      "2. [x] under Notes — ignored",
      "- 12:00 — under Notes — ignored",
      "",
    ].join("\n")
  );
  expectGolden("vault/daily-parse-sections-out-of-order", readDailyNote());
});

test("readDailyNote: section header quirks (case-sensitive, ### is not a header, ##X not a header, duplicates accumulate, frontmatter focus ignored)", async () => {
  const { readDailyNote } = await vault();
  put(
    PATHS.dailyToday,
    [
      "---",
      `date: ${TODAY}`,
      'focus: "frontmatter focus is NOT the focus"',
      "---",
      "",
      "## Top 3 Priorities",
      "",
      "1. [ ] first section item",
      "",
      "### Sub-heading does not end the section",
      "",
      "2. [x] still counted after h3",
      "",
      "## top 3 priorities",
      "",
      "3. [ ] lowercase section is ignored",
      "",
      "##Top 3 Priorities",
      "",
      "4. [ ] no-space header is not a header (still in the lowercase section)",
      "",
      "## Top 3 Priorities   ",
      "",
      "5. [x] duplicate section accumulates",
      "",
      "## Schedule",
      "",
      "- 10:00 — first schedule",
      "",
      "## Schedule",
      "",
      "- 11:00 — second schedule section also accumulates",
      "",
    ].join("\n")
  );
  expectGolden("vault/daily-parse-header-quirks", readDailyNote());
});

test("readDailyNote: CRLF note parses identically to LF", async () => {
  const { readDailyNote } = await vault();
  const lf = readRaw(PATHS.dailyToday);
  put(PATHS.dailyToday, lf.replace(/\n/g, "\r\n"), FROZEN_NOW_MS - 2 * HOUR);
  const parsed = readDailyNote();
  expectGolden("vault/daily-parse-crlf", parsed);
  buildFixtureVault();
  assert.deepEqual(parsed, readDailyNote());
});

// =============================================================================
// toggleTop3 — the only writer
// =============================================================================
for (const index of [0, 1, 2]) {
  for (const done of [true, false]) {
    test(`toggleTop3(${index}, ${done}): returns true and rewrites today's note`, async () => {
      const { toggleTop3 } = await vault();
      const returned = toggleTop3(index, done);
      expectGolden(`vault/toggle-top3-idx${index}-${done ? "done" : "open"}`, {
        returned,
        note: readRaw(PATHS.dailyToday),
      });
    });
  }
}

test("toggleTop3(-1): false, note untouched", async () => {
  const { toggleTop3 } = await vault();
  const before = readRaw(PATHS.dailyToday);
  const returned = toggleTop3(-1, true);
  expectGolden("vault/toggle-top3-idx-neg1", { returned, note: readRaw(PATHS.dailyToday) });
  assert.equal(readRaw(PATHS.dailyToday), before);
});

test("toggleTop3(3): false (only three checkboxes), note untouched", async () => {
  const { toggleTop3 } = await vault();
  const returned = toggleTop3(3, true);
  expectGolden("vault/toggle-top3-idx3", { returned, note: readRaw(PATHS.dailyToday) });
});

test("toggleTop3: today's note missing → false; does NOT fall back to an older note", async () => {
  const { toggleTop3 } = await vault();
  removeTodayNote();
  const olderBefore = readRaw(PATHS.dailyOlder);
  const returned = toggleTop3(0, false);
  expectGolden("vault/toggle-top3-note-missing", {
    returned,
    todayExists: fs.existsSync(abs(PATHS.dailyToday)),
    olderUnchanged: readRaw(PATHS.dailyOlder) === olderBefore,
    older: readRaw(PATHS.dailyOlder),
  });
});

test("toggleTop3: CRLF note keeps CRLF line endings", async () => {
  const { toggleTop3 } = await vault();
  put(PATHS.dailyToday, readRaw(PATHS.dailyToday).replace(/\n/g, "\r\n"));
  const returned = toggleTop3(1, true);
  const note = readRaw(PATHS.dailyToday);
  assert.ok(!/(^|[^\r])\n/.test(note), "every LF is preceded by CR");
  expectGolden("vault/toggle-top3-crlf-preserved", { returned, note });
});

test("toggleTop3: a note with mixed line endings is rewritten entirely as CRLF", async () => {
  const { toggleTop3 } = await vault();
  put(PATHS.dailyToday, readRaw(PATHS.dailyToday).replace("\n", "\r\n")); // only the first EOL is CRLF
  const returned = toggleTop3(2, true);
  expectGolden("vault/toggle-top3-mixed-eol", { returned, note: readRaw(PATHS.dailyToday) });
});

test("toggleTop3: only the nth checkbox under Top 3 is touched; checkbox-looking lines elsewhere are skipped", async () => {
  const { toggleTop3 } = await vault();
  put(
    PATHS.dailyToday,
    [
      "## Schedule",
      "",
      "1. [ ] not a priority",
      "",
      "## Top 3 Priorities",
      "",
      "- [ ] bullet style is not counted",
      "1. [ ] first",
      "text between",
      "2. [ ] second",
      "",
      "## Notes",
      "",
      "3. [ ] not a priority either",
      "",
    ].join("\n")
  );
  const first = toggleTop3(1, true);
  const second = toggleTop3(2, true);
  expectGolden("vault/toggle-top3-section-scoped", { first, second, note: readRaw(PATHS.dailyToday) });
});

// =============================================================================
// readVaultMarkdown — allow/deny matrix
// =============================================================================
test("readVaultMarkdown: allow/deny matrix (prefix, extension, traversal, separators, absolute, empty)", async () => {
  const { readVaultMarkdown } = await vault();
  const morningFile = path.basename(PATHS.morningToday);
  const inputs = [
    PATHS.morningToday,
    `system/runs/${IDS.runMorningToday}.md`,
    `inbox//reports/morning/${morningFile}`,
    `inbox/./reports/morning/${morningFile}`,
    PATHS.morningToday.replace(/\//g, "\\"),
    PATHS.dailyToday,
    `inbox/../${PATHS.dailyToday}`,
    `inbox\\..\\${PATHS.dailyToday.replace(/\//g, "\\")}`,
    "inbox/../../outside.md",
    "../inbox/x.md",
    "./inbox/x.md",
    "inbox/notes.txt",
    `${PATHS.morningToday.slice(0, -3)}.MD`,
    "system/runs/x.json",
    "system/runner-status.json",
    "system/metrics/metrics.csv",
    "INBOX/x.md",
    path.join(FIXTURE_ROOT, PATHS.morningToday),
    "/etc/passwd.md",
    "",
    "inbox/",
    "inbox/.md",
    "inbox/missing.md",
    "inbox/reports/morning",
    "inbox/reports/morning/",
  ];
  put("inbox/notes.txt", "plain text deliverable\n");
  put("inbox/outside-probe.md", "probe\n");
  const out: Record<string, string | null> = {};
  for (const i of inputs) out[i] = readVaultMarkdown(i);
  expectGolden("vault/read-markdown-matrix", out);
});

// =============================================================================
// readMorningReport
// =============================================================================
for (const max of [0, 1, 2, 3, 4, 5, 6]) {
  test(`readMorningReport(max=${max}) on the six-bullet fixture report`, async () => {
    const { readMorningReport } = await vault();
    expectGolden(`vault/morning-max-${max}`, readMorningReport(max));
  });
}

test("readMorningReport: no '## Headlines' section → empty heads/links with rel", async () => {
  const { readMorningReport } = await vault();
  put(PATHS.morningToday, "---\ndate: x\n---\n\n# Morning Report\n\n## Web\n\n- Not a headline\n\n## Top Headlines\n\n- Prefixed word does not match\n");
  expectGolden("vault/morning-no-headlines-section", readMorningReport(10));
});

test("readMorningReport: '## headlines' is matched case-insensitively and as a prefix", async () => {
  const { readMorningReport } = await vault();
  const out: Record<string, unknown> = {};
  put(PATHS.morningToday, "## headlines\n\n- lowercase header\n");
  out.lowercase = readMorningReport(10);
  put(PATHS.morningToday, "## HEADLINES\n\n- uppercase header\n");
  out.uppercase = readMorningReport(10);
  put(PATHS.morningToday, "## Headlines of the day\n\n- suffix after Headlines\n");
  out.suffix = readMorningReport(10);
  put(PATHS.morningToday, "## Headline\n\n- singular does not match\n");
  out.singular = readMorningReport(10);
  put(PATHS.morningToday, "##  Headlines\n\n- two spaces after ##\n");
  out.twoSpaces = readMorningReport(10);
  expectGolden("vault/morning-headlines-header-variants", out);
});

test("readMorningReport: star bullets are headlines; indented, numbered and dash-without-space lines are not", async () => {
  const { readMorningReport } = await vault();
  put(
    PATHS.morningToday,
    [
      "## Headlines",
      "",
      "* First star bullet [s](https://example.com/1)",
      "* Second star bullet",
      "  - indented sub-bullet is skipped",
      "  * indented star is skipped",
      "-no space after dash",
      "*no space after star",
      "1. numbered is not a bullet",
      "- Third, dash bullet",
      "Plain text is ignored",
      "",
    ].join("\n")
  );
  expectGolden("vault/morning-star-bullets", readMorningReport(10));
});

test("readMorningReport: link extraction and markdown stripping across link shapes", async () => {
  const { readMorningReport } = await vault();
  put(
    PATHS.morningToday,
    [
      "## Headlines",
      "",
      "- Markdown link only: [source](https://example.com/a)",
      "- Bare URL then markdown: https://example.com/bare then [src](https://example.com/md)",
      "- Markdown then bare: [src](https://example.com/md2) then https://example.com/bare2",
      "- Parenthesised (see https://example.com/paren) end",
      "- Trailing period https://example.com/dot.",
      "- Quoted \"https://example.com/quoted\" here",
      "- Link with title [t](https://example.com/title \"Title\") tail",
      "- [source](https://example.com/only-link)",
      "- https://example.com/only-url",
      "- **bold** _under_ `code` snake_case a*b",
      "- No link at all",
      "- Empty link text [](https://example.com/empty)",
      "- Nested [a [b] c](https://example.com/nested)",
      "- Relative link [rel](/local/path) and bare http://example.com/http",
      "- ftp://example.com/ftp is not a link",
      "- Two spaces  after  words   ",
      "- HTTPS://EXAMPLE.COM/UPPER is case-sensitive",
      "- Angle <https://example.com/angle> brackets",
      "",
    ].join("\n")
  );
  expectGolden("vault/morning-link-shapes", readMorningReport(50));
});

test("readMorningReport: headlines are truncated to 160 chars after stripping; the link survives", async () => {
  const { readMorningReport } = await vault();
  put(
    PATHS.morningToday,
    [
      "## Headlines",
      "",
      `- ${"x".repeat(200)}`,
      `- ${"y".repeat(170)} [source](https://example.com/long)`,
      `- ${"z".repeat(159)} [source](https://example.com/exact)`,
      "",
    ].join("\n")
  );
  const r = readMorningReport(10);
  assert.deepEqual(
    r?.heads.map((h) => h.length),
    [160, 160, 160]
  );
  expectGolden("vault/morning-truncation-160", r);
});

test("readMorningReport: section boundaries — h3 does not close Headlines, Headlines need not be first, second Headlines never reached", async () => {
  const { readMorningReport } = await vault();
  put(
    PATHS.morningToday,
    [
      "---",
      `date: ${TODAY}`,
      "---",
      "",
      "# Morning Report",
      "",
      "## Web — News",
      "",
      "- Body bullet before Headlines is not a headline",
      "",
      "## Headlines",
      "",
      "- First headline",
      "### An h3 inside Headlines does not close the section",
      "- Second headline, after the h3",
      "Plain text line in Headlines is ignored",
      "",
      "- Third headline",
      "",
      "## Headlines",
      "",
      "- Second Headlines section is never reached",
      "",
    ].join("\n")
  );
  expectGolden("vault/morning-section-boundaries", readMorningReport(10));
});

test("readMorningReport: bullets that strip to empty are dropped and do not count toward max", async () => {
  const { readMorningReport } = await vault();
  put(
    PATHS.morningToday,
    [
      "## Headlines",
      "",
      "- https://example.com/only-url",
      "- ***",
      "- `   `",
      "- ",
      "- Real one",
      "- Real two",
      "",
    ].join("\n")
  );
  expectGolden("vault/morning-empty-bullets-dropped", readMorningReport(2));
});

test("readMorningReport: only an older-dated report exists → null", async () => {
  const { readMorningReport } = await vault();
  drop(PATHS.morningToday);
  expectGolden("vault/morning-no-today", readMorningReport());
});

test("readMorningReport: reports dir missing → null", async () => {
  const { readMorningReport } = await vault();
  drop("inbox/reports/morning");
  expectGolden("vault/morning-dir-missing", readMorningReport());
});

test("readMorningReport: two same-day files → sort().pop() picks the last filename, not the newest mtime; non-.md ignored", async () => {
  const { readMorningReport } = await vault();
  put(`inbox/reports/morning/${TODAY}-morning-report-ffffffff.md`, "## Headlines\n\n- From the ffffffff file\n", FROZEN_NOW_MS - 5 * HOUR);
  put(`inbox/reports/morning/${TODAY}-morning-report-00000000.md`, "## Headlines\n\n- From the 00000000 file\n", FROZEN_NOW_MS - 1 * MIN);
  put(`inbox/reports/morning/${TODAY}-morning-report-zzzzzzzz.json`, "{}\n", FROZEN_NOW_MS);
  put(`inbox/reports/morning/${TODAY}-morning-report-zzzzzzzz.txt`, "## Headlines\n\n- txt\n", FROZEN_NOW_MS);
  expectGolden("vault/morning-same-day-pick", readMorningReport());
});

test("readMorningReport: today's file empty → empty heads with rel", async () => {
  const { readMorningReport } = await vault();
  put(PATHS.morningToday, "");
  expectGolden("vault/morning-empty-file", readMorningReport());
});

test("readMorningReport: CRLF report parses identically to LF", async () => {
  const { readMorningReport } = await vault();
  const lf = readRaw(PATHS.morningToday);
  put(PATHS.morningToday, lf.replace(/\n/g, "\r\n"));
  const parsed = readMorningReport();
  expectGolden("vault/morning-crlf", parsed);
  buildFixtureVault();
  assert.deepEqual(parsed, readMorningReport());
});

// =============================================================================
// readRecentRuns
// =============================================================================
for (const limit of [1, 3, 50]) {
  test(`readRecentRuns(limit=${limit})`, async () => {
    const { readRecentRuns } = await vault();
    expectGolden(`vault/runs-limit-${limit}`, readRecentRuns(limit));
  });
}

test("readRecentRuns: limit applies to files BEFORE parsing — an unparseable newest file eats a slot", async () => {
  const { readRecentRuns } = await vault();
  touch("system/runs/bad.json", FROZEN_NOW_MS + SEC);
  expectGolden("vault/runs-bad-json-eats-limit", { limit_1: readRecentRuns(1), limit_2: readRecentRuns(2) });
});

test("readRecentRuns: ordered by JSON mtime, newest first", async () => {
  const { readRecentRuns } = await vault();
  touch(`system/runs/${IDS.runVoiceAskOld}.json`, FROZEN_NOW_MS + SEC);
  touch(`system/runs/${IDS.runMorningToday}.json`, FROZEN_NOW_MS - 5 * DAY);
  expectGolden("vault/runs-mtime-reorder", readRecentRuns());
});

test("readRecentRuns: the .md sidecar's mtime does not affect ordering", async () => {
  const { readRecentRuns } = await vault();
  const before = readRecentRuns().map((r) => r.id);
  touch(`system/runs/${IDS.runCleanupOld}.md`, FROZEN_NOW_MS + SEC);
  const after = readRecentRuns().map((r) => r.id);
  assert.deepEqual(after, before);
  expectGolden("vault/runs-md-mtime-ignored", after);
});

test("readRecentRuns: runs dir missing → []", async () => {
  const { readRecentRuns } = await vault();
  drop("system/runs");
  expectGolden("vault/runs-dir-missing", readRecentRuns());
});

test("readRecentRuns: minimal / falsy / scalar JSON shapes and their defaults", async () => {
  const { readRecentRuns } = await vault();
  drop("system/runs");
  put("system/runs/empty-object.json", "{}\n", rank(0));
  putJson(
    "system/runs/falsy-fields.json",
    { id: 0, skill: "", status: "", summary: null, ts_started: "", ts_completed: 0, deliverable_path: "", args: null },
    rank(1)
  );
  putJson(
    "system/runs/typed-fields.json",
    { id: 123, skill: 5, status: true, summary: ["a", "b"], ts_started: 1700000000000, ts_completed: { x: 1 }, deliverable_path: 7 },
    rank(2)
  );
  put("system/runs/number.json", "42\n", rank(3));
  put("system/runs/string.json", '"str"\n', rank(4));
  put("system/runs/array.json", "[]\n", rank(5));
  put("system/runs/null.json", "null\n", rank(6));
  put("system/runs/zero.json", "0\n", rank(7));
  put("system/runs/false.json", "false\n", rank(8));
  put("system/runs/bad.json", "{\n", rank(9));
  put("system/runs/blank.json", "", rank(10));
  put("system/runs/not-json.md", "{}\n", rank(11));
  expectGolden("vault/runs-minimal-and-scalar-shapes", readRecentRuns(50));
});

test("readRecentRuns: duration_s rounding, negative clamp, unparseable and missing timestamps", async () => {
  const { readRecentRuns } = await vault();
  drop("system/runs");
  const T0 = -HOUR;
  timedRun("d-0ms", "x", "ok", T0, 0, rank(0));
  timedRun("d-499ms", "x", "ok", T0, 499, rank(1));
  timedRun("d-500ms", "x", "ok", T0, 500, rank(2));
  timedRun("d-1499ms", "x", "ok", T0, 1499, rank(3));
  timedRun("d-1500ms", "x", "ok", T0, 1500, rank(4));
  timedRun("d-2500ms", "x", "ok", T0, 2500, rank(5));
  timedRun("d-negative", "x", "ok", T0, -5000, rank(6));
  timedRun("d-unparseable-completed", "x", "ok", T0, null, rank(7), { ts_completed: "soon" });
  timedRun("d-unparseable-started", "x", "ok", T0, 1000, rank(8), { ts_started: "earlier" });
  timedRun("d-no-completed", "x", "running", T0, null, rank(9));
  putRun("d-no-started", { skill: "x", status: "ok", ts_completed: iso(T0) }, rank(10));
  putRun("d-date-only", { skill: "x", status: "ok", ts_started: "2026-09-09", ts_completed: "2026-09-10" }, rank(11));
  expectGolden("vault/runs-duration-rounding", readRecentRuns(50));
});

test("readRecentRuns: link only when status is exactly 'ok' and deliverable is under a readable prefix (traversal inside the vault allowed, extension not checked)", async () => {
  const { readRecentRuns } = await vault();
  drop("system/runs");
  // give today's daily note a link: line so the prefix denial is what blocks it
  put(PATHS.dailyToday, readRaw(PATHS.dailyToday).replace("schema_version: 1", "schema_version: 1\nlink: https://example.com/from-daily-note"));
  put("system/link-probe.md", linkedMd("https://example.com/traversal"));
  put("inbox/link-probe.txt", linkedMd("https://example.com/txt-deliverable"));
  const T0 = -HOUR;
  const dl = PATHS.voiceAskLinked;
  timedRun("lk-ok-linked", "voice-ask", "ok", T0, 5000, rank(0), { deliverable_path: dl });
  timedRun("lk-error-linked", "voice-ask", "error", T0, 5000, rank(1), { deliverable_path: dl });
  timedRun("lk-running-linked", "voice-ask", "running", T0, null, rank(2), { deliverable_path: dl });
  timedRun("lk-upper-OK", "voice-ask", "OK", T0, 5000, rank(3), { deliverable_path: dl });
  timedRun("lk-status-missing", "voice-ask", "ok", T0, 5000, rank(4), { status: undefined, deliverable_path: dl });
  timedRun("lk-daily-note-denied", "plan-today", "ok", T0, 5000, rank(5), { deliverable_path: PATHS.dailyToday });
  timedRun("lk-traversal-inside", "voice-ask", "ok", T0, 5000, rank(6), { deliverable_path: "inbox/../system/link-probe.md" });
  timedRun("lk-traversal-outside", "voice-ask", "ok", T0, 5000, rank(7), { deliverable_path: "inbox/../../link-probe.md" });
  timedRun("lk-backslashes", "voice-ask", "ok", T0, 5000, rank(8), { deliverable_path: dl.replace(/\//g, "\\") });
  timedRun("lk-missing-file", "voice-ask", "ok", T0, 5000, rank(9), { deliverable_path: "inbox/nope.md" });
  timedRun("lk-number", "voice-ask", "ok", T0, 5000, rank(10), { deliverable_path: 5 });
  timedRun("lk-empty", "voice-ask", "ok", T0, 5000, rank(11), { deliverable_path: "" });
  timedRun("lk-txt-extension", "voice-ask", "ok", T0, 5000, rank(12), { deliverable_path: "inbox/link-probe.txt" });
  timedRun("lk-absolute", "voice-ask", "ok", T0, 5000, rank(13), { deliverable_path: abs(dl) });
  timedRun("lk-system-runs-md", "voice-ask", "ok", T0, 5000, rank(14), { deliverable_path: `system/runs/${IDS.runVoiceAskLinked}.md` });
  expectGolden("vault/runs-link-gating", readRecentRuns(50));
});

test("readRecentRuns: deliverable frontmatter forms accepted/rejected by the link: parser", async () => {
  const { readRecentRuns } = await vault();
  drop("system/runs");
  const forms: Record<string, string> = {
    "leading-blank-line": "\n---\nlink: https://e.com/a\n---\n",
    "bom": "\uFEFF---\nlink: https://e.com/b\n---\n",
    "in-body-after-fm": "---\ndate: x\n---\n\nlink: https://e.com/c\n",
    "double-quoted": '---\nlink: "https://e.com/d"\n---\n',
    "single-quoted": "---\nlink: 'https://e.com/e'\n---\n",
    "no-space-after-colon": "---\nlink:https://e.com/f\n---\n",
    "trailing-spaces": "---\nlink: https://e.com/g   \n---\n",
    "uppercase-key": "---\nLink: https://e.com/h\n---\n",
    "http-scheme": "---\nlink: http://e.com/i\n---\n",
    "ftp-scheme": "---\nlink: ftp://e.com/j\n---\n",
    "beyond-800-bytes": `---\npad: ${"x".repeat(900)}\nlink: https://e.com/k\n---\n`,
    "within-800-bytes": `---\npad: ${"x".repeat(700)}\nlink: https://e.com/k2\n---\n`,
    "crlf": "---\r\nlink: https://e.com/l\r\n---\r\n",
    "space-in-url": "---\nlink: https://e.com/m n\n---\n",
    "angle-brackets": "---\nlink: <https://e.com/n>\n---\n",
    "two-link-lines": "---\nlink: https://e.com/first\nlink: https://e.com/second\n---\n",
    "unclosed-frontmatter": "---\nlink: https://e.com/o\n",
    "mismatched-quote": '---\nlink: "https://e.com/p\n---\n',
    "indented-key": "---\n  link: https://e.com/q\n---\n",
    "dashes-then-text": "---\nlink: https://e.com/r\n--- trailing\n",
    "no-frontmatter": "# Title\n\nlink: https://e.com/s\n",
    "fragment-and-query": "---\nlink: https://mail.google.com/mail/u/0/#drafts?compose=abc&x=1\n---\n",
    "empty-value": "---\nlink:\n---\n",
    "link-key-in-word": "---\nbacklink: https://e.com/t\n---\n",
  };
  let i = 0;
  for (const [name, body] of Object.entries(forms)) {
    put(`inbox/fm/${name}.md`, body);
    timedRun(`fm-${name}`, "voice-ask", "ok", -HOUR, 5000, rank(i++), { deliverable_path: `inbox/fm/${name}.md` });
  }
  expectGolden("vault/runs-link-frontmatter-forms", readRecentRuns(50));
});

// =============================================================================
// askLabel (via readQueue — same helper feeds readRecentRuns)
// =============================================================================
test("askLabel corpus: first three non-stopword tokens of the prompt, via readQueue", async () => {
  const { readQueue } = await vault();
  drop("system/queue");
  const corpus: Array<[string, string, unknown]> = [
    ["fixture", "voice-ask", { prompt: "hey jarvis can you tell me about the fable five launch please" }],
    ["all-stopwords", "voice-ask", { prompt: "please just tell me" }],
    ["empty", "voice-ask", { prompt: "" }],
    ["spaces-only", "voice-ask", { prompt: "   " }],
    ["punct-only", "voice-ask", { prompt: "!!! ??? ..." }],
    ["apostrophe", "voice-ask", { prompt: "What's the weather?!" }],
    ["contractions", "voice-ask", { prompt: "don't forget it's due" }],
    ["three-words", "voice-ask", { prompt: "fix login bug" }],
    ["two-words", "voice-ask", { prompt: "fix bug" }],
    ["one-word", "voice-ask", { prompt: "status" }],
    ["many-words", "voice-ask", { prompt: "Summarize my week in three bullets and email it" }],
    ["upper", "voice-ask", { prompt: "EMAIL JOHN ABOUT Q3" }],
    ["email-addr", "voice-ask", { prompt: "email john@example.com about the Q3-plan" }],
    ["unicode", "voice-ask", { prompt: "café résumé naïve" }],
    ["digits", "voice-ask", { prompt: "1 2 3 4" }],
    ["dupes", "voice-ask", { prompt: "the the the a" }],
    ["whitespace-kinds", "voice-ask", { prompt: "first\nsecond\tthird fourth" }],
    ["stopword-substring", "voice-ask", { prompt: "runner running runs" }],
    ["prompt-number", "voice-ask", { prompt: 5 }],
    ["prompt-null", "voice-ask", { prompt: null }],
    ["prompt-missing", "voice-ask", {}],
    ["args-null", "voice-ask", null],
    ["args-string", "voice-ask", "fix bug"],
    ["args-array", "voice-ask", ["fix bug"]],
    ["args-missing", "voice-ask", undefined],
    ["other-skill", "inbox-brief", { prompt: "fix login bug" }],
    ["skill-case", "Voice-Ask", { prompt: "fix login bug" }],
  ];
  corpus.forEach(([name, skill, args], i) => {
    const entry: Record<string, unknown> = { id: `ask-${name}`, skill, ts: iso(-DAY + i * SEC), source: "test" };
    if (args !== undefined) entry.args = args;
    putJson(`system/queue/ask-${name}.json`, entry, FROZEN_NOW_MS - DAY + i * SEC);
  });
  expectGolden("vault/ask-label-corpus", readQueue());
});

// =============================================================================
// readSkillEtas
// =============================================================================
test("readSkillEtas: median index floor(n/2) — odd picks the middle, even picks the upper-middle", async () => {
  const { readSkillEtas } = await vault();
  drop("system/runs");
  const odd = [30, 10, 20];
  const even = [40, 10, 30, 20];
  const five = [50, 10, 40, 20, 30];
  const six = [60, 10, 50, 20, 40, 30];
  let i = 0;
  for (const [skill, ds] of Object.entries({ odd, even, five, six })) {
    for (const d of ds) timedRun(`${skill}-${d}`, skill, "ok", -HOUR, d * SEC, rank(i++));
  }
  expectGolden("vault/etas-median-even-odd", readSkillEtas());
});

test("readSkillEtas: only status==='ok' runs with both parseable timestamps count; duration clamps to ≥1", async () => {
  const { readSkillEtas } = await vault();
  drop("system/runs");
  const T0 = -HOUR;
  timedRun("e-clamp-zero", "clamp-zero", "ok", T0, 0, rank(0));
  timedRun("e-clamp-neg", "clamp-negative", "ok", T0, -30_000, rank(1));
  timedRun("e-round-1499", "round-1499ms", "ok", T0, 1499, rank(2));
  timedRun("e-round-1500", "round-1500ms", "ok", T0, 1500, rank(3));
  timedRun("e-round-400", "round-400ms", "ok", T0, 400, rank(4));
  timedRun("e-error", "excluded-error", "error", T0, 600_000, rank(5));
  timedRun("e-running", "excluded-running", "running", T0, null, rank(6));
  timedRun("e-upper", "excluded-upper-OK", "OK", T0, 5000, rank(7));
  timedRun("e-no-completed", "excluded-no-completed", "ok", T0, null, rank(8));
  timedRun("e-bad-ts", "excluded-bad-ts", "ok", T0, 5000, rank(9), { ts_completed: "soon" });
  putRun("e-no-started", { skill: "excluded-no-started", status: "ok", ts_completed: iso(T0) }, rank(10));
  timedRun("e-no-skill", "unused", "ok", T0, 7000, rank(11), { skill: undefined });
  timedRun("e-status-missing", "excluded-status-missing", "ok", T0, 7000, rank(12), { status: undefined });
  put("system/runs/e-bad.json", "{oops\n", rank(13));
  expectGolden("vault/etas-eligibility", readSkillEtas());
});

test("readSkillEtas: only the 200 newest run files (by mtime) are considered", async () => {
  const { readSkillEtas } = await vault();
  // 205 ok runs newer than every fixture run: the 5 OLDEST carry a 10000s
  // duration; the newest 200 carry 1..200s. With the cap the median is 101;
  // without it the median would be 103 and the fixture skills would appear.
  for (let i = 0; i < 205; i++) {
    const durS = i < 5 ? 10_000 : i - 4;
    timedRun(`cap-${String(i).padStart(3, "0")}`, "cap", "ok", -DAY, durS * SEC, FROZEN_NOW_MS + (i + 1) * SEC);
  }
  expectGolden("vault/etas-file-cap-200", readSkillEtas());
});

test("readSkillEtas: runs dir missing → {}", async () => {
  const { readSkillEtas } = await vault();
  drop("system/runs");
  expectGolden("vault/etas-dir-missing", readSkillEtas());
});

// =============================================================================
// readQueue
// =============================================================================
test("readQueue: ordered by mtime ascending (oldest first)", async () => {
  const { readQueue } = await vault();
  touch(`system/queue/${IDS.queueInbox}.json`, FROZEN_NOW_MS + SEC); // now the newest → last
  expectGolden("vault/queue-mtime-reorder", readQueue());
});

test("readQueue: bad JSON skipped, non-.json ignored, minimal/scalar shapes get defaults", async () => {
  const { readQueue } = await vault();
  drop("system/queue");
  const at = (i: number) => FROZEN_NOW_MS - HOUR + i * SEC;
  put("system/queue/empty-object.json", "{}\n", at(0));
  put("system/queue/bad.json", "{oops\n", at(1));
  put("system/queue/note.txt", '{"id":"txt","skill":"voice-ask"}\n', at(2));
  putJson("system/queue/ts-number.json", { ts: 123 }, at(3));
  putJson("system/queue/voice-ask-no-args.json", { skill: "voice-ask" }, at(4));
  putJson("system/queue/id-null.json", { id: null, skill: "x", ts: "t" }, at(5));
  putJson("system/queue/id-number.json", { id: 7, skill: "x", ts: null }, at(6));
  put("system/queue/scalar.json", "7\n", at(7));
  put("system/queue/array.json", "[]\n", at(8));
  put("system/queue/string.json", '"s"\n', at(9));
  put("system/queue/null.json", "null\n", at(10));
  put("system/queue/blank.json", "", at(11));
  expectGolden("vault/queue-bad-and-minimal", readQueue());
});

test("readQueue: queue dir missing → []", async () => {
  const { readQueue } = await vault();
  drop("system/queue");
  expectGolden("vault/queue-dir-missing", readQueue());
});

// =============================================================================
// readMetrics
// =============================================================================
test("readMetrics: history is capped at the newest 24 points (40-point series)", async () => {
  const { readMetrics } = await vault();
  const rows: string[] = [];
  for (let k = 0; k < 40; k++) rows.push(`${iso(-(40 - k) * HOUR)},yt,subs,${1000 + k},ok,`);
  put("system/metrics/metrics.csv", csv(rows));
  const m = readMetrics();
  assert.equal(m[0].history.length, 24);
  expectGolden("vault/metrics-history-cap-24", m);
});

test("readMetrics: 100-point series — the 4×cap bucket splice is unobservable; output is still the newest 24", async () => {
  const { readMetrics } = await vault();
  const rows: string[] = [];
  for (let k = 0; k < 100; k++) rows.push(`${iso(-(100 - k) * HOUR)},yt,subs,${1000 + k},ok,`);
  put("system/metrics/metrics.csv", csv(rows));
  expectGolden("vault/metrics-100-points", readMetrics());
});

test("readMetrics: deltaWeek needs ≥6 points (5 → null, 6 → value); delta needs ≥2", async () => {
  const { readMetrics } = await vault();
  const rows: string[] = [];
  const series = (name: string, n: number) => {
    for (let k = 0; k < n; k++) rows.push(`${iso(-(n - k) * HOUR)},t,${name},${100 + k * 10},ok,`);
  };
  series("one", 1);
  series("two", 2);
  series("five", 5);
  series("six", 6);
  put("system/metrics/metrics.csv", csv(rows));
  expectGolden("vault/metrics-deltaweek-threshold", readMetrics());
});

test("readMetrics: row parsing — first line always skipped, NaN/short rows skipped, partial parseFloat, untrimmed columns, Infinity", async () => {
  const { readMetrics } = await vault();
  const t = iso(-HOUR);
  put(
    "system/metrics/metrics.csv",
    [
      `${t},youtube,subscribers,999,ok,`, // line 1 is ALWAYS treated as the header
      `${t},youtube,subscribers,100,ok,`,
      `${t},youtube,subscribers,notanumber,ok,`,
      "short,row",
      "four,cols,only,4",
      `${t},youtube,subscribers,12abc,ok,`,
      `${t},youtube,subscribers,1e3,ok,`,
      `${t},youtube,subscribers, 42,ok,`,
      `${t},youtube,subscribers,Infinity,ok,`,
      `${t},youtube,subscribers,-5.5,stale,`,
      `${t},youtube, views,7,ok,`,
      `${t},stripe,mrr,10,error,"failed, with comma"`,
      `${t},stripe,mrr,11`,
      `${t},stripe,mrr,12,`,
      `${t},stripe,mrr,0x10,ok,`,
      `${t},stripe,mrr,.5,ok,`,
      `${t},stripe,mrr,,ok,`,
      ",,,,,",
      "   ",
      `  ${t},stripe,mrr,13,ok,  `,
      `${t},stripe,mrr,14,ok,extra,columns,here`,
      "",
    ].join("\n")
  );
  expectGolden("vault/metrics-row-parsing", readMetrics());
});

test("readMetrics: CRLF csv parses identically to LF", async () => {
  const { readMetrics } = await vault();
  const lf = readRaw("system/metrics/metrics.csv");
  put("system/metrics/metrics.csv", lf.replace(/\n/g, "\r\n"), FROZEN_NOW_MS - 3 * HOUR);
  const parsed = readMetrics();
  expectGolden("vault/metrics-crlf", parsed);
  buildFixtureVault();
  assert.deepEqual(parsed, readMetrics());
});

test("readMetrics: empty file, header-only file, missing file → []", async () => {
  const { readMetrics } = await vault();
  const out: Record<string, unknown> = {};
  put("system/metrics/metrics.csv", "");
  out.empty = readMetrics();
  put("system/metrics/metrics.csv", "timestamp,source,metric,value,status,error\n");
  out.headerOnly = readMetrics();
  put("system/metrics/metrics.csv", "\n\n");
  out.blankLines = readMetrics();
  drop("system/metrics/metrics.csv");
  out.missing = readMetrics();
  expectGolden("vault/metrics-empty-variants", out);
});

// =============================================================================
// readRunnerStatus
// =============================================================================
test("readRunnerStatus: alive flips at heartbeat age 120s (119 alive; 120 and 121 dead)", async () => {
  const { readRunnerStatus } = await vault();
  const out: Record<string, unknown> = {};
  try {
    for (const age of [119, 120, 121]) {
      thawClock();
      freezeClock(FROZEN_NOW_MS + (age - 20) * SEC); // fixture heartbeat is 20s old at FROZEN_NOW
      out[`age_${age}s`] = readRunnerStatus();
    }
  } finally {
    thawClock();
    freezeClock();
  }
  expectGolden("vault/runner-alive-threshold", out);
});

test("readRunnerStatus: ts variants — missing, empty, null, invalid, numeric, date-only, future, sub-second rounding", async () => {
  const { readRunnerStatus } = await vault();
  const cases: Record<string, unknown> = {
    missing: { pid: 1 },
    empty: { ts: "" },
    null: { ts: null },
    invalid: { ts: "yesterday" },
    numeric_epoch_ms: { ts: FROZEN_NOW_MS - 30 * SEC },
    numeric_year: { ts: 2026 },
    date_only: { ts: "2026-09-09" },
    future_60s: { ts: iso(60 * SEC) },
    age_500ms: { ts: iso(-500) },
    age_1499ms: { ts: iso(-1499) },
    age_1500ms: { ts: iso(-1500) },
    age_119999ms: { ts: iso(-119_999) },
    age_120499ms: { ts: iso(-120_499) },
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cases)) {
    putJson("system/runner-status.json", v);
    out[k] = readRunnerStatus();
  }
  expectGolden("vault/runner-ts-variants", out);
});

test("readRunnerStatus: field coercion (String/Number/Boolean on odd types), {} and [] defaults", async () => {
  const { readRunnerStatus } = await vault();
  const cases: Record<string, unknown> = {
    strings_and_odd_types: {
      ts: iso(-20 * SEC),
      pid: "4242",
      version: 1.5,
      busy: "false",
      active: "2",
      max_concurrent: null,
      pending: "x",
    },
    busy_zero: { ts: iso(-20 * SEC), busy: 0, pid: null, version: null },
    busy_string_empty: { ts: iso(-20 * SEC), busy: "" },
    empty_object: {},
    empty_array: [],
    nested: { ts: iso(-20 * SEC), pid: { n: 1 }, version: ["1", "2"], active: [3] },
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cases)) {
    putJson("system/runner-status.json", v);
    out[k] = readRunnerStatus();
  }
  expectGolden("vault/runner-field-coercion", out);
});

// =============================================================================
// safeJson (not exported — observed through readRunnerStatus / readLatestVideo)
// =============================================================================
test("safeJson: invalid, empty, whitespace, and falsy/scalar JSON documents (via readRunnerStatus + readLatestVideo)", async () => {
  const { readRunnerStatus, readLatestVideo } = await vault();
  const raws: Record<string, string> = {
    invalid: "{not json",
    empty: "",
    whitespace: "   \n",
    trailing_comma: '{"ts": "x",}',
    json_null: "null",
    json_zero: "0",
    json_false: "false",
    json_true: "true",
    json_string: '"hi"',
    json_number: "42",
    json_array: "[1]",
    bom_prefixed: '\uFEFF{"ts":"x"}',
    two_documents: '{"ts":"a"}\n{"ts":"b"}',
  };
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(raws)) {
    put("system/runner-status.json", raw);
    put("system/metrics/latest-video.json", raw);
    out[k] = { runner: readRunnerStatus(), video: readLatestVideo() };
  }
  drop("system/runner-status.json");
  drop("system/metrics/latest-video.json");
  out.missing_file = { runner: readRunnerStatus(), video: readLatestVideo() };
  expectGolden("vault/safejson-variants", out);
});

// =============================================================================
// readLatestVideo
// =============================================================================
test("readLatestVideo: defaults for missing fields and coercion of odd types", async () => {
  const { readLatestVideo } = await vault();
  const cases: Record<string, unknown> = {
    empty_object: {},
    strings_for_numbers: { views: "18400", likes: "lots", comments: null, title: 42, status: null, url: false },
    nulls: { title: null, url: null, video_id: null, views: null, likes: null, comments: null, published_at: null, status: null },
    extra_fields_ignored: { title: "t", error: "boom", ts: "x", views: 1.75, likes: -3, comments: "0" },
    array_document: [],
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cases)) {
    putJson("system/metrics/latest-video.json", v);
    out[k] = readLatestVideo();
  }
  expectGolden("vault/latest-video-coercion", out);
});
