// HUD pure helpers + static tables (components/HUD.tsx test seams) and the
// report overlay's markdown renderer. These move into their own modules in
// the refactor; the goldens must not.
process.env.TZ = "America/Chicago"; // noteAgeDays parses a local-time string
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FROZEN_NOW_MS, TODAY } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

type Hud = typeof import("@/components/HUD");
type Overlay = typeof import("@/components/ReportOverlay");
let hud: Hud;
let overlay: Overlay;

before(async () => {
  buildFixtureVault();
  freezeClock();
  hud = await import("@/components/HUD");
  overlay = await import("@/components/ReportOverlay");
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(FROZEN_NOW_MS - ms).toISOString();

test("fmt / fmtFull compact number formatting", () => {
  const inputs = [0, 1, 999, 999.4, 999.6, 1000, 1049, 1050, 1500, 9999, 10_000, 10_499, 10_500, 15_400, 99_999, 999_999, 1_000_000, 1_234_567, 2_345_678, -1500, -12_000, -2_000_000, 1234.5, 0.4, 0.5];
  expectGolden("hud/fmt", inputs.map((n) => [n, hud.fmt(n), hud.fmtFull(n)]));
});

test("fmtAge labels and the 13h stale threshold", () => {
  const cases: [string, string | null][] = [
    ["null", null],
    ["invalid", "not a date"],
    ["now", ago(0)],
    ["30s", ago(30_000)],
    ["59s", ago(59_999)],
    ["1m", ago(MIN)],
    ["59m", ago(59 * MIN)],
    ["60m", ago(60 * MIN)],
    ["5h", ago(5 * HOUR)],
    ["12h59m", ago(13 * HOUR - MIN)],
    ["13h exactly", ago(13 * HOUR)],
    ["13h+1ms", ago(13 * HOUR + 1)],
    ["47h", ago(47 * HOUR)],
    ["48h", ago(48 * HOUR)],
    ["3d", ago(72 * HOUR)],
    ["10d", ago(240 * HOUR)],
    ["future 5m", ago(-5 * MIN)],
  ];
  expectGolden("hud/fmtAge", cases.map(([name, ts]) => [name, ts, hud.fmtAge(ts)]));
});

test("fmtDur / fmtClock / noteAgeDays / parseHHMM", () => {
  expectGolden("hud/fmtDur", [0, 1, 59, 60, 99, 100, 125, 600, 3661].map((s) => [s, hud.fmtDur(s), hud.fmtClock(s)]));
  expectGolden(
    "hud/noteAgeDays",
    [TODAY, "2026-09-08", "2026-09-07", "2026-09-01", "2026-08-01", "2026-09-10", "2026-12-25", "not-a-date"].map((d) => [d, hud.noteAgeDays(d)])
  );
  expectGolden(
    "hud/parseHHMM",
    ["09:00", "9:05", "00:00", "23:59", "24:00", "12:60", "7", "abc", "", "13:30:15", " 08:15"].map((t) => [t, hud.parseHHMM(t)])
  );
});

test("findMetric", async () => {
  const { readVaultState } = await import("@/lib/vault");
  const s = readVaultState();
  const yt = hud.findMetric(s.metrics, "youtube", "subscribers");
  assert.equal(yt?.value, 50405);
  assert.equal(hud.findMetric(s.metrics, "youtube", "nope"), null);
  assert.equal(hud.findMetric([], "youtube", "subscribers"), null);
});

test("runAnnouncement — spoken line for a finished run", () => {
  const cases: [string, string, string, string | null | undefined][] = [
    ["morning-report", "ok", "Morning briefing is ready — five headlines. SAVED inbox/reports/morning/x.md", null],
    ["morning-report", "ok", "", null],
    ["morning-report", "ok", "Done.", null],
    ["plan-today", "ok", "complete", null],
    ["plan-today", "ok", "All done!", null],
    ["plan-today", "ok", "ok", null],
    ["inbox-brief", "ok", "Three urgent threads, two warm replies (headless run).", null],
    ["voice-ask", "ok", "Fable 5 shipped this morning with a 1M-token context window and $200M in launch-week revenue (headless).", "fable five launch"],
    ["voice-ask", "ok", "", "fable five launch"],
    ["voice-ask", "ok", "x".repeat(300), "long one"],
    ["morning-report", "ok", "y".repeat(300), null],
    ["morning-report", "error", "[runner: hard timeout 20m — killed]", null],
    ["inbox-brief", "error", "spawn error: ENOENT", null],
    ["voice-ask", "error", "bad intent json after 5 retries: empty", "weather"],
    ["vault-cleanup", "error", "", null],
    ["vault-cleanup", "error", "**Markdown** failure `text` (headless) that is quite long ".repeat(4), null],
    ["voice-ask", "running", "still going", "weather"],
    ["plan-tomorrow", "ok", "Tomorrow's note drafted at daily-notes/2026-09-10.md", undefined],
  ];
  expectGolden(
    "hud/runAnnouncement",
    cases.map(([skill, status, summary, label]) => ({ skill, status, summary, label, spoken: hud.runAnnouncement(skill, status, summary, label) }))
  );
});

test("milestone ladders and static tables", () => {
  expectGolden("hud/nextMilestone", [0, 1, 99_999, 100_000, 100_001, 249_999, 250_000, 999_999, 1_000_000, 1_999_999, 2_000_000, 2_500_000, 5_000_000].map((n) => [n, hud.nextMilestone(n)]));
  expectGolden("hud/nextMrrMilestone", [0, 9_999, 10_000, 24_056, 25_000, 99_999, 100_000, 499_999, 500_000, 600_000, 1_250_000].map((n) => [n, hud.nextMrrMilestone(n)]));
  expectGolden("hud/tables", {
    MILESTONES: hud.MILESTONES,
    MRR_MILESTONES: hud.MRR_MILESTONES,
    LIVE_DEPLOY_H: hud.LIVE_DEPLOY_H,
    WAVE_BARS: hud.WAVE_BARS,
    MODE_KEYS: hud.MODE_KEYS,
    DECK_SKILLS: hud.DECK_SKILLS,
    SOCIAL_DEFS: hud.SOCIAL_DEFS,
  });
});

test("ReportOverlay markdown renderer", () => {
  const md = [
    "# Title one",
    "## Two",
    "### Three",
    "#### Four",
    "##### Five is capped",
    "",
    "Plain paragraph with **bold**, *italic*, `code`, and a [link](https://example.com/a?b=1&c=2).",
    "Unsafe <script>alert(1)</script> & ampersand > gt.",
    "",
    "- bullet one",
    "- bullet **two**",
    "* star bullet",
    "  - indented bullet",
    "text right after a list",
    "---",
    "***",
    "-- not a rule",
    "[not a link](ftp://x)",
    "**unclosed bold",
    "trailing spaces   ",
    "",
    "",
    "last line",
  ].join("\n");
  expectGolden("hud/mdToHtml", overlay.mdToHtml(md));
  expectGolden("hud/mdToHtml-crlf", overlay.mdToHtml("# A\r\n- b\r\n\r\npara\r\n"));
  expectGolden("hud/mdToHtml-empty", [overlay.mdToHtml(""), overlay.mdToHtml("\n\n"), overlay.mdToHtml("- only")]);
  expectGolden(
    "hud/mdInline",
    ["a **b** c", "*i* and `c`", "[t](https://u) [t2](http://u2) [x](notaurl)", "<b>&</b>", "**a *b* c**", "`x` `y`"].map((s) => [s, overlay.mdInline(s), overlay.escapeHtml(s)])
  );
});
