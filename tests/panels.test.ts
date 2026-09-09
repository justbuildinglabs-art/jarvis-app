// HUD panel rendering — the biggest hole the ssr goldens leave open.
//
// The prerendered pages carry `state === null`, so every state-gated panel
// (Vitals, Priorities, Documents, Wire, Schedule, Objective, TopBar,
// CommandDeck) renders empty in .next/server/app/index.html and no ssr
// golden observes its markup. This file renders each panel to static HTML
// against the fixture vault and pins that, so the HUD refactor — splitting
// the 1,300-line component into panel modules — cannot silently change what
// the user actually sees.
//
// renderToStaticMarkup is deliberate: no hydration ids, no comment
// separators, just the DOM each panel produces.
//
// createElement rather than JSX: the repo tsconfig sets jsx:"preserve" for
// Next, and the test loader would need a second, divergent JSX setting just
// for this file. Every call here renders a single element anyway.
process.env.TZ = "America/Chicago"; // Schedule and TopBar read the wall clock
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FROZEN_NOW_MS } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, removeTodayNote } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";
import type { VaultState } from "@/lib/vault";

type Hud = typeof import("@/components/HUD");
let hud: Hud;
let readVaultState: () => VaultState;

before(async () => {
  buildFixtureVault();
  freezeClock();
  hud = await import("@/components/HUD");
  ({ readVaultState } = await import("@/lib/vault"));
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

/** One tag per line, so a golden diff points at the element that moved
 *  instead of at one enormous line. */
function render(el: ReactElement): string {
  return renderToStaticMarkup(el)
    .replace(/></g, ">\n<")
    .replace(/(<\/[a-z]+>)(?=[^<\n])/g, "$1\n");
}

const clone = (s: VaultState): VaultState => JSON.parse(JSON.stringify(s)) as VaultState;
const noop = () => {};
const HOUR = 3_600_000;

test("Vitals — row kinds, stale flags, SIM tags, sparklines", () => {
  const s = readVaultState();
  expectGolden("panels/vitals-default", render(h(hud.Vitals, { state: s })));
  expectGolden("panels/vitals-hot", render(h(hud.Vitals, { state: s, hot: true })));

  const empty = clone(s);
  empty.metrics = [];
  empty.latestVideo = null;
  expectGolden("panels/vitals-empty", render(h(hud.Vitals, { state: empty })));

  const deltas = clone(s);
  deltas.metrics.find((m) => m.source === "youtube" && m.metric === "subscribers")!.deltaWeek = -1200;
  deltas.metrics.find((m) => m.source === "instagram")!.deltaWeek = 0;
  expectGolden("panels/vitals-negative-and-zero-delta", render(h(hud.Vitals, { state: deltas })));

  const stale = clone(s);
  stale.metrics.forEach((m) => {
    m.timestamp = new Date(FROZEN_NOW_MS - 20 * HOUR).toISOString();
  });
  expectGolden("panels/vitals-stale", render(h(hud.Vitals, { state: stale })));

  // the Latest Video row needs BOTH latestVideo and youtube.latest_video_views
  const withVid = clone(s);
  withVid.metrics.push({
    source: "youtube",
    metric: "latest_video_views",
    value: 18400,
    status: "ok",
    timestamp: new Date(FROZEN_NOW_MS - 3 * HOUR).toISOString(),
    history: [
      { timestamp: new Date(FROZEN_NOW_MS - 9 * HOUR).toISOString(), value: 12000, status: "ok" },
      { timestamp: new Date(FROZEN_NOW_MS - 3 * HOUR).toISOString(), value: 18400, status: "ok" },
    ],
    delta: 6400,
    deltaWeek: 6400,
  });
  expectGolden("panels/vitals-latest-video-row", render(h(hud.Vitals, { state: withVid })));
});

test("Priorities — today, carried over, very stale, missing note", () => {
  const s = readVaultState();
  expectGolden("panels/priorities-today", render(h(hud.Priorities, { state: s, onToggle: noop })));
  expectGolden("panels/priorities-hot", render(h(hud.Priorities, { state: s, hot: true, onToggle: noop })));

  const carried = clone(s);
  carried.daily!.isToday = false;
  carried.daily!.date = "2026-09-08"; // 1d → banner without `err`
  expectGolden("panels/priorities-carried-1d", render(h(hud.Priorities, { state: carried, onToggle: noop })));

  const veryStale = clone(s);
  veryStale.daily!.isToday = false;
  veryStale.daily!.date = "2026-09-01"; // >2d → banner gets `err`
  expectGolden("panels/priorities-carried-stale", render(h(hud.Priorities, { state: veryStale, onToggle: noop })));

  const none = clone(s);
  none.daily = null;
  expectGolden("panels/priorities-no-note", render(h(hud.Priorities, { state: none, onToggle: noop })));

  const allDone = clone(s);
  allDone.daily!.top3.forEach((p) => (p.done = true));
  expectGolden("panels/priorities-all-done", render(h(hud.Priorities, { state: allDone, onToggle: noop })));
});

test("Priorities — only today's note is interactive", () => {
  const s = readVaultState();
  const html = render(h(hud.Priorities, { state: s, onToggle: noop }));
  assert.equal((html.match(/role="button"/g) ?? []).length, 3);
  assert.match(html, /class="prio done clickable"/);
  assert.match(html, /title="mark open"/);

  const carried = clone(s);
  carried.daily!.isToday = false;
  const carriedHtml = render(h(hud.Priorities, { state: carried, onToggle: noop }));
  assert.equal(carriedHtml.includes('role="button"'), false, "stale notes are read-only");
});

test("Documents — dedupe, five-cap, ok-only, label fallback", () => {
  const s = readVaultState();
  expectGolden("panels/documents-default", render(h(hud.Documents, { state: s, onOpen: noop })));

  expectGolden("panels/documents-filtering", {
    rendered: render(h(hud.Documents, { state: s, onOpen: noop })),
    runsConsidered: s.runs.map((r) => ({
      skill: r.skill,
      status: r.status,
      deliverable: r.deliverable_path,
      included: r.status === "ok" && !!r.deliverable_path,
    })),
  });

  const dupes = clone(s);
  dupes.runs = [dupes.runs[1], { ...dupes.runs[1], id: "dupe" }, dupes.runs[2]];
  expectGolden("panels/documents-dedupe", render(h(hud.Documents, { state: dupes, onOpen: noop })));

  const many = clone(s);
  many.runs = Array.from({ length: 8 }, (_, i) => ({
    ...many.runs[2],
    id: `run${i}`,
    status: "ok",
    deliverable_path: `inbox/reports/morning/2026-09-0${i + 1}-r${i}.md`,
    ts_completed: new Date(FROZEN_NOW_MS - (i + 1) * HOUR).toISOString(),
  }));
  expectGolden("panels/documents-five-cap", render(h(hud.Documents, { state: many, onOpen: noop })));

  const none = clone(s);
  none.runs = [];
  assert.equal(render(h(hud.Documents, { state: none, onOpen: noop })), "");
});

test("Wire — three-headline cap and the null branches", () => {
  const s = readVaultState();
  expectGolden("panels/wire-default", render(h(hud.Wire, { state: s, onOpen: noop })));

  const none = clone(s);
  none.morning = null;
  assert.equal(render(h(hud.Wire, { state: none, onOpen: noop })), "");

  const empty = clone(s);
  empty.morning = { rel: "inbox/reports/morning/x.md", heads: [], links: [] };
  assert.equal(render(h(hud.Wire, { state: empty, onOpen: noop })), "");

  const one = clone(s);
  one.morning = { rel: "inbox/reports/morning/x.md", heads: ["Only headline"], links: [null] };
  expectGolden("panels/wire-single", render(h(hud.Wire, { state: one, onOpen: noop })));
});

test("Schedule — NOW marker, past rows, stale note, focus line", () => {
  const s = readVaultState();
  // frozen at 10:30 local: 09:00 has started, 13:00 has not → currentIdx 0
  expectGolden("panels/schedule-morning", render(h(hud.Schedule, { state: s })));
  expectGolden("panels/schedule-hot", render(h(hud.Schedule, { state: s, hot: true })));

  const noFocus = clone(s);
  noFocus.daily!.focus = "";
  expectGolden("panels/schedule-no-focus", render(h(hud.Schedule, { state: noFocus })));

  const carried = clone(s);
  carried.daily!.isToday = false;
  carried.daily!.date = "2026-09-05";
  expectGolden("panels/schedule-carried", render(h(hud.Schedule, { state: carried })));

  const none = clone(s);
  none.daily = null;
  assert.equal(render(h(hud.Schedule, { state: none })), "");

  const noItems = clone(s);
  noItems.daily!.schedule = [];
  assert.equal(render(h(hud.Schedule, { state: noItems })), "");
});

test("Schedule — the NOW row tracks the clock through the day", () => {
  const at = (localHour: number, min: number) => {
    thawClock();
    freezeClock(Date.UTC(2026, 8, 9, localHour + 5, min, 0)); // CDT = UTC-5
    return render(h(hud.Schedule, { state: readVaultState() }));
  };
  const shots = {
    "08:00 before everything": at(8, 0),
    "09:00 exactly": at(9, 0),
    "12:59 still the 09:00 block": at(12, 59),
    "13:00 second block": at(13, 0),
    "20:00 last block": at(20, 0),
    "23:59 last block holds": at(23, 59),
  };
  thawClock();
  freezeClock();
  expectGolden(
    "panels/schedule-now-through-day",
    Object.fromEntries(
      Object.entries(shots).map(([k, html]) => [k, (html.match(/<div class="sched-row[^"]*"/g) ?? []).join("\n")])
    )
  );
});

test("Objective — the three mutually exclusive branches", () => {
  const s = readVaultState();
  // the fixture has stripe.mrr, so the revenue ladder wins
  expectGolden("panels/objective-mrr", render(h(hud.Objective, { state: s })));
  expectGolden("panels/objective-mrr-hot", render(h(hud.Objective, { state: s, hot: true })));

  const live = clone(s);
  live.metrics = live.metrics.filter((m) => m.source !== "stripe");
  live.latestVideo!.published_at = new Date(FROZEN_NOW_MS - 6 * HOUR).toISOString();
  expectGolden("panels/objective-live-deploy", render(h(hud.Objective, { state: live })));

  const subs = clone(s);
  subs.metrics = subs.metrics.filter((m) => m.source !== "stripe");
  subs.latestVideo!.published_at = new Date(FROZEN_NOW_MS - 5 * 24 * HOUR).toISOString();
  expectGolden("panels/objective-subscribers", render(h(hud.Objective, { state: subs })));

  const flat = clone(subs);
  flat.metrics.forEach((m) => (m.deltaWeek = 0));
  expectGolden("panels/objective-no-eta", render(h(hud.Objective, { state: flat })));

  const bare = clone(s);
  bare.metrics = [];
  bare.latestVideo = null;
  expectGolden("panels/objective-bare", render(h(hud.Objective, { state: bare })));

  const rich = clone(s);
  rich.metrics.find((m) => m.source === "stripe")!.value = 640_000;
  expectGolden("panels/objective-mrr-past-ladder", render(h(hud.Objective, { state: rich })));
});

test("TopBar — clock, mode chips, link and runner status", () => {
  const s = readVaultState();
  const modes = ["idle", "working", "listening", "speaking", "error"] as const;
  expectGolden(
    "panels/topbar-modes",
    Object.fromEntries(modes.map((m) => [m, render(h(hud.TopBar, { state: s, online: true, mode: m }))]))
  );
  expectGolden("panels/topbar-offline", render(h(hud.TopBar, { state: s, online: false, mode: "error" })));

  const dead = clone(s);
  dead.runner!.alive = false;
  expectGolden("panels/topbar-runner-down", render(h(hud.TopBar, { state: dead, online: true, mode: "idle" })));
  expectGolden("panels/topbar-null-state", render(h(hud.TopBar, { state: null, online: true, mode: "idle" })));
});

test("CommandDeck — runner tick, queue list, offline branch", () => {
  const s = readVaultState();
  expectGolden("panels/deck-default", render(h(hud.CommandDeck, { state: s, onQueued: noop })));
  expectGolden("panels/deck-hot", render(h(hud.CommandDeck, { state: s, hot: true, onQueued: noop })));

  const idle = clone(s);
  idle.runner!.busy = false;
  idle.runner!.active = 0;
  idle.runner!.pending = 0;
  idle.queue = [];
  expectGolden("panels/deck-idle-empty-queue", render(h(hud.CommandDeck, { state: idle, onQueued: noop })));

  const noRunner = clone(s);
  noRunner.runner = null;
  expectGolden("panels/deck-runner-offline", render(h(hud.CommandDeck, { state: noRunner, onQueued: noop })));

  const busy = clone(s);
  busy.queue = Array.from({ length: 6 }, (_, i) => ({
    id: `q${i}`,
    skill: "voice-ask",
    label: `ask ${i}`,
    ts: new Date(FROZEN_NOW_MS - i * 1000).toISOString(),
  }));
  expectGolden("panels/deck-queue-overflow", render(h(hud.CommandDeck, { state: busy, onQueued: noop })));
  expectGolden("panels/deck-null-state", render(h(hud.CommandDeck, { state: null, onQueued: noop })));
});

test("small components — CountUp, Sparkline, SectionTitle, VoiceWave", () => {
  expectGolden(
    "panels/countup",
    [0, 42, 1234, 50405, 1_437_000].map((v) => ({
      value: v,
      compact: render(h(hud.CountUp, { value: v })),
      full: render(h(hud.CountUp, { value: v, full: true })),
    }))
  );
  expectGolden("panels/sparkline", {
    empty: render(h(hud.Sparkline, { points: [] })),
    single: render(h(hud.Sparkline, { points: [5] })),
    flat: render(h(hud.Sparkline, { points: [7, 7, 7, 7] })),
    rising: render(h(hud.Sparkline, { points: [1, 3, 2, 8, 5, 13] })),
    negative: render(h(hud.Sparkline, { points: [-5, 0, 5] })),
  });
  expectGolden("panels/section-title", {
    plain: render(h(hud.SectionTitle, { title: "Telemetry" })),
    tick: render(h(hud.SectionTitle, { title: "Telemetry", tick: "AUDIENCE.FEED" })),
    href: render(h(hud.SectionTitle, { title: "Timeline", tick: "TODAY", href: "https://example.com/cal" })),
  });

  const wave = render(h(hud.VoiceWave, { mode: "listening" }));
  const bars = wave.match(/<i style="[^"]*"><\/i>/g) ?? [];
  expectGolden("panels/voicewave", {
    barCount: bars.length,
    rootClass: wave.match(/class="voice-wave[^"]*"/)?.[0],
    first3: bars.slice(0, 3),
    last3: bars.slice(-3),
    idleRootClass: render(h(hud.VoiceWave, { mode: "idle" })).match(/class="voice-wave[^"]*"/)?.[0],
    speakingRootClass: render(h(hud.VoiceWave, { mode: "speaking" })).match(/class="voice-wave[^"]*"/)?.[0],
  });
});

test("CompassRing — static geometry", () => {
  expectGolden("panels/compass-ring", render(h(hud.CompassRing, null)));
});

test("panels against a vault with today's note removed", () => {
  removeTodayNote();
  const s = readVaultState();
  expectGolden("panels/fallback-note-priorities", render(h(hud.Priorities, { state: s, onToggle: noop })));
  expectGolden("panels/fallback-note-schedule", render(h(hud.Schedule, { state: s })));
  buildFixtureVault(); // restore for any later file-order dependency
});
