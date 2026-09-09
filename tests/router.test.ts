// Characterization of lib/router.ts — the rules engine (rulesRoute), the
// runtime composition (route + inFlightGuard), the spoken briefing, and the
// model-engine prompt builders. Every golden here pins the behavior as it
// stood BEFORE the refactor; nothing in this file judges it. Quirks are
// captured as-is (see the notes beside each corpus group).
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_ROOT, FROZEN_NOW_MS } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, IDS, PATHS, removeTodayNote } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";
import type { RouteResult } from "@/lib/router";
import type { VaultState } from "@/lib/vault";

// nextScheduleItem() (the "schedule" lane) compares against process-LOCAL
// getHours(), not HUD_TZ. Pin the process zone so the golden is identical on
// any machine; the harness only pins HUD_TZ.
process.env.TZ = "America/Chicago";

const MIN = 60_000;
const HOUR = 60 * MIN;
const AT = {
  morning: FROZEN_NOW_MS, // 10:30 CDT, Wednesday
  afternoon: Date.parse("2026-09-09T19:00:00.000Z"), // 14:00 CDT
  evening: Date.parse("2026-09-10T00:30:00.000Z"), // 19:30 CDT (still Sep 9 in CT)
  lateNight: Date.parse("2026-09-09T05:30:00.000Z"), // 00:30 CDT
} as const;

// --- network tripwire — the rules path must never reach fetch ----------------
let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

before(() => {
  buildFixtureVault();
  freezeClock();
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls.push(String(args[0]));
    return Promise.reject(new Error(`network forbidden in golden suite: ${String(args[0])}`));
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  thawClock();
  destroyFixtureVault();
});

// --- helpers -------------------------------------------------------------------
const abs = (rel: string) => path.join(FIXTURE_ROOT, rel);
const iso = (offsetMs: number) => new Date(FROZEN_NOW_MS + offsetMs).toISOString();
const rm = (rel: string) => fs.rmSync(abs(rel), { recursive: true, force: true });

function setClock(ms: number): void {
  thawClock();
  freezeClock(ms);
}
async function withClock<T>(ms: number, fn: () => Promise<T> | T): Promise<T> {
  setClock(ms);
  try {
    return await fn();
  } finally {
    setClock(FROZEN_NOW_MS);
  }
}
/** mutate the fixture, run, then rebuild it pristine */
async function withVault<T>(mutate: () => void, fn: () => Promise<T> | T): Promise<T> {
  mutate();
  try {
    return await fn();
  } finally {
    buildFixtureVault();
  }
}
function writeRunnerStatus(tsOffsetMs: number, patch: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    abs("system/runner-status.json"),
    JSON.stringify(
      {
        ts: iso(tsOffsetMs),
        pid: 4242,
        version: "1.0.1",
        busy: true,
        active: 1,
        max_concurrent: 3,
        pending: 1,
        in_flight: ["inbox-brief"],
        ...patch,
      },
      null,
      2
    ) + "\n"
  );
}
function writeMemory(lines: (string | object)[]): void {
  fs.mkdirSync(abs("system/voice"), { recursive: true });
  fs.writeFileSync(
    abs(PATHS.memory),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"
  );
}
function rewriteFile(rel: string, edit: (raw: string) => string): void {
  fs.writeFileSync(abs(rel), edit(fs.readFileSync(abs(rel), "utf-8")));
}

const router = () => import("@/lib/router");
async function snapshot(): Promise<VaultState> {
  const { readVaultState } = await import("@/lib/vault");
  return readVaultState();
}

type RulesRoute = Awaited<ReturnType<typeof router>>["rulesRoute"];
type Sweep = { transcript: string; result: RouteResult }[];
function sweep(rulesRoute: RulesRoute, state: VaultState, utterances: readonly string[]): Sweep {
  return utterances.map((transcript) => ({ transcript, result: rulesRoute(transcript, state) }));
}

// --- corpus --------------------------------------------------------------------
// Grouped by the branch each utterance is meant to walk. In the DEFAULT
// fixture the standing offer ("Want me to run the inbox audit?") is live, the
// runner is alive+busy, inbox-brief is both queued and running, and today's
// note has two of three goals open.
const CORPUS: readonly string[] = [
  // skill aliases — old wording, bare / polite / short (≤5 words) → dispatch
  "morning report",
  "am report",
  "run the morning report",
  "the morning report please",
  "morning report please jarvis",
  "pull the am report",
  "jarvis run the morning report",
  "inbox",
  "inbox brief",
  "inbox audit",
  "run the inbox brief",
  "check my inbox",
  "the inbox brief please",
  "please run the inbox brief",
  "cleanup",
  "clean up",
  "vault clean",
  "vault cleanup",
  "run the cleanup",
  "clean up the vault",
  "plan today",
  "plan the day",
  "plan my day",
  "run plan today",
  "plan tomorrow",
  // Ops Board button wording, as printed and as spoken
  "AM Report",
  "Morning Report",
  "Inbox Summary",
  "inbox summary",
  "Triage Today",
  "triage today",
  "Triage Tomorrow",
  "triage tomorrow",
  "triage tmrw",
  "AI Clean",
  "ai clean",
  "MORNING REPORT!!!",
  // long forms (>5 words) — rules never dispatch these
  "hey jarvis run the morning report",
  "can you run the morning report",
  "hey jarvis could you please run the inbox brief",
  "jarvis go ahead and run the vault cleanup now",
  "please run the inbox brief now",
  "run the inbox brief now please",
  "i think we should triage tomorrow now",
  // alias shadowing / substring quirks (no word boundaries in SKILL_ALIASES)
  "inbox cleanup",
  "clean up the inbox",
  "spam report",
  "steam report",
  "plan for tomorrow",
  "trend scan",
  "github trending",
  "ünïcödé report",
  // question forms — every QUESTION_START word, plus trailing "?"
  "what morning report",
  "how is the inbox brief",
  "is the cleanup done",
  "are the inbox briefs done",
  "was the morning report run",
  "did plan today finish",
  "when did the morning report run",
  "who ran the cleanup",
  "where is the inbox brief",
  "why did plan today fail",
  "any inbox brief",
  "do i have a morning report",
  "does the inbox brief run",
  "tell me about the am report",
  "inbox brief?",
  "Morning report?",
  "cleanup?",
  "whatever inbox brief",
  "isn't the inbox brief done",
  "how's the inbox brief",
  "run the inbox brief what",
  // BRIEFING_RE — every alternation, with/without hey/jarvis/please/today
  "rundown",
  "briefing",
  "the rundown",
  "my briefing",
  "give me the rundown",
  "read me the briefing",
  "run the briefing",
  "daily rundown",
  "morning briefing",
  "full rundown",
  "give me the daily briefing",
  "what's the rundown",
  "whats the rundown",
  "what's my briefing",
  "brief me",
  "catch me up",
  "good morning",
  "morning jarvis",
  "morning, jarvis",
  "hey jarvis give me the rundown",
  "ok jarvis brief me",
  "okay jarvis, catch me up",
  "so jarvis, good morning",
  "jarvis brief me",
  "jarvis, brief me",
  "brief me please",
  "give me the rundown for today",
  "rundown on today",
  "brief me today",
  "brief me today please",
  "brief me, jarvis",
  "give me the rundown please jarvis",
  "good morning jarvis",
  "hey good morning",
  "can you give me the rundown",
  "could you read me the morning briefing please",
  "hey hey jarvis brief me",
  "Give me the rundown!",
  // briefing near-misses
  "give me a rundown",
  "what's going on today",
  "brief me on the inbox",
  "give me the rundown and the inbox brief",
  "the rundown for tomorrow",
  // smalltalk through the rules engine (stateAnswer lanes run FIRST)
  "hey",
  "hi",
  "hello",
  "yo",
  "sup",
  "hey there",
  "hey jarvis",
  "hey what's up",
  "what's up jarvis",
  "wassup",
  "good afternoon",
  "good evening",
  "how are you",
  "how's it going",
  "you good",
  "can you hear me",
  "are you there",
  "mic check",
  "testing testing",
  "thanks",
  "thank you jarvis",
  "appreciate it",
  "good night",
  "goodnight",
  "i'm off",
  "heading to bed",
  "signing off",
  "see you tomorrow",
  "ok",
  "okay cool",
  "nice one jarvis",
  "got it",
  "great",
  "perfect",
  "alright",
  "sweet",
  "cool cool cool",
  "one man",
  "then",
  "jarvis",
  "ok ok ok ok ok",
  "thanks for the queue update",
  "ok thanks",
  "no thanks",
  // stateAnswer lanes
  "what's the mrr",
  "mrr",
  "m r r",
  "m r are",
  "M.R.R.",
  "how's revenue",
  "recurring revenue",
  "how much money are we making",
  "what's the mrr?",
  "is the runner alive",
  "how's the daemon",
  "runner status",
  "runner queue",
  "how many subscribers",
  "subscriber count",
  "subs",
  "youtube subs",
  "substantial",
  "subscribers and tiktok",
  "youtube views",
  "views on youtube",
  "28 day views",
  "how many views over 28 days",
  "views",
  "instagram",
  "how's instagram doing",
  "instagram followers",
  "tiktok",
  "how is tiktok",
  "how's the latest video",
  "last video",
  "how's the video doing",
  "latest video stats",
  "tokens",
  "claude usage",
  "how many tokens have i used",
  "token count",
  "revenue tokens",
  "what's in the queue",
  "queue",
  "queue status",
  "what's queued",
  "top 3",
  "top three",
  "priorities",
  "what are my priorities",
  "directives",
  "goals",
  "how are my goals",
  "what's my top priority",
  "what are today's goals",
  "schedule",
  "what's on the schedule",
  "what's next today",
  "whats next",
  "what's next",
  "next up",
  "what's next on the schedule",
  "focus",
  "what's my focus",
  "what should i focus on",
  "last run",
  "what was the last run",
  "last fail",
  "recent run",
  "recent runs",
  "what did the last run say",
  "morning headlines",
  "what are the headlines",
  "what's in the morning report",
  "what did the morning report say",
  "where's that inbox brief",
  "where's the fable five thing",
  "is the inbox brief done yet",
  "what's the run status",
  "documents",
  "open the documents",
  "what documents do i have",
  // open-verb — deliverable lookup
  "show me the morning report",
  "open the inbox brief",
  "bring up that",
  "pull up the html",
  "show me the cleanup",
  "open the fable five doc",
  "show me the weather",
  "display the trend scan",
  "show me",
  "open it",
  "show me the report",
  "show me the morning",
  "pull up the results",
  "open the rundown",
  "show me the briefing",
  "show me this morning's report",
  "put up the last one",
  "show us the vault cleanup report",
  "open that again",
  "bring up the explainer",
  "open my daily note",
  "show me the inbox report",
  // affirm / decline — offer live in the default fixture
  "yes",
  "yeah",
  "yep",
  "sure",
  "absolutely",
  "go ahead",
  "do it",
  "let's do it",
  "lets do it",
  "please do",
  "yes please",
  "go for it",
  "sounds good",
  "yes please jarvis",
  "yes, jarvis",
  "sure please",
  "Yes!",
  "  yes  ",
  "no",
  "nope",
  "nah",
  "not now",
  "not right now",
  "not yet",
  "later",
  "maybe later",
  "hold off",
  "skip it",
  "no thank you",
  "nope, jarvis",
  "no thanks jarvis",
  "yes run it",
  "yes do the inbox",
  "yes yes",
  "yeah go ahead",
  // empty / whitespace / punctuation-only / unicode
  "",
  "   ",
  "\n\t",
  "?",
  "!!!",
  "...",
  "—",
  "🎉",
  "こんにちは",
  "¿qué?",
  "$",
  "ok!",
  // generic fallthrough
  "tell me a joke",
  "what's the weather like in austin",
  "write me a haiku about the vault",
  "once you're done with that inbox brief tell me about fable five",
];

/** the slice re-run against each state variant */
const SUBSET: readonly string[] = [
  "morning report",
  "inbox brief",
  "Inbox Summary",
  "plan today",
  "yes",
  "sounds good",
  "no",
  "no thanks",
  "brief me",
  "good morning",
  "hey",
  "what's up",
  "thanks",
  "ok",
  "is the runner alive",
  "what's in the queue",
  "top 3",
  "schedule",
  "what's next today",
  "focus",
  "last run",
  "how many subscribers",
  "what's the mrr",
  "how's the latest video",
  "show me that",
  "show me the morning report",
  "open the cleanup",
  "tell me a joke",
  "",
];

const SMALLTALK: readonly string[] = [
  "can you hear me",
  "hey can you hear me",
  "are you there",
  "you there",
  "you up",
  "mic check",
  "testing testing",
  "test test",
  "test",
  "thank you",
  "thanks",
  "thanks jarvis",
  "thank you so much",
  "appreciate it",
  "appreciate you",
  "good night",
  "goodnight",
  "i'm off",
  "im off",
  "heading to bed",
  "signing off",
  "see you tomorrow",
  "ok",
  "okay",
  "okay cool",
  "nice one jarvis",
  "got it",
  "sounds good",
  "great",
  "perfect",
  "alright",
  "sweet",
  "cool cool cool",
  "ok ok ok ok",
  "ok ok ok ok ok",
  "one man",
  "then",
  "jarvis",
  "how are you",
  "how's it going",
  "hows it going",
  "how you doing",
  "you good",
  "you doing ok",
  "what's up",
  "whats up",
  "wassup",
  "what is up",
  "hey what's up jarvis",
  "hey",
  "hi",
  "hello",
  "yo",
  "sup",
  "hey there",
  "hey jarvis",
  "hello there jarvis",
  "hey there buddy",
  "yo yo",
  "good morning",
  "good afternoon",
  "good evening",
  "good morning jarvis",
  "ok thanks",
  "thanks good night",
  "no thanks",
  "yes",
  "brief me",
  "",
];

// =============================================================================
// 6. constants + pure matchers
// =============================================================================

test("PANEL_IDS is the fixed panel vocabulary", async () => {
  const { PANEL_IDS } = await router();
  expectGolden("router/panel-ids", [...PANEL_IDS]);
});

test("matchSkill maps alias substrings to skills, case-sensitively, first alias wins", async () => {
  const { matchSkill } = await router();
  const inputs = [
    "morning report",
    "am report",
    "the am reporter",
    "spam report",
    "inbox",
    "inbox brief",
    "inbox cleanup",
    "cleanup",
    "clean up",
    "clean  up",
    "ai clean",
    "aiclean",
    "vault clean",
    "vault cleanup",
    "plan today",
    "plan the day",
    "plan my day",
    "triage today",
    "plan tomorrow",
    "triage tomorrow",
    "triage tmrw",
    "plan for tomorrow",
    "Morning Report",
    "MORNING REPORT",
    "morning  report",
    "trend scan",
    "voice ask",
    "github trending",
    "report",
    "morning",
    "",
    "run the inbox brief and then the morning report",
  ];
  expectGolden(
    "router/match-skill",
    inputs.map((input) => ({ input, skill: matchSkill(input) }))
  );
});

// =============================================================================
// 1. rulesRoute corpus — default fixture (offer live, runner alive, inbox in flight)
// =============================================================================

test("rulesRoute: full corpus against the default fixture", async () => {
  assert.ok(CORPUS.length >= 150, `corpus has ${CORPUS.length} utterances`);
  assert.equal(new Set(CORPUS).size, CORPUS.length, "corpus has duplicates");
  const { rulesRoute, pendingOffer } = await router();
  const state = await snapshot();
  assert.equal(pendingOffer(), "inbox-brief"); // precondition: the offer is live
  expectGolden("router/rules-default", sweep(rulesRoute, state, CORPUS));
});

test("rulesRoute: offer expired — clock 4 min later, state captured while runner was alive", async () => {
  const { rulesRoute, pendingOffer } = await router();
  const state = await snapshot();
  await withClock(AT.morning + 4 * MIN, () => {
    assert.equal(pendingOffer(), null);
    expectGolden("router/rules-offer-expired-4min", sweep(rulesRoute, state, SUBSET));
  });
});

test("rulesRoute: offer expired — clock 4 min later, state re-read (runner heartbeat now stale too)", async () => {
  const { rulesRoute } = await router();
  await withClock(AT.morning + 4 * MIN, async () => {
    const state = await snapshot();
    assert.equal(state.runner?.alive, false);
    expectGolden("router/rules-offer-expired-4min-fresh-state", sweep(rulesRoute, state, SUBSET));
  });
});

test("rulesRoute: offer outside the 10-min memory window — clock 11 min later", async () => {
  const { rulesRoute, pendingOffer } = await router();
  const state = await snapshot();
  await withClock(AT.morning + 11 * MIN, () => {
    assert.equal(pendingOffer(), null);
    expectGolden(
      "router/rules-offer-expired-11min",
      sweep(rulesRoute, state, ["yes", "sounds good", "no", "no thanks", "yes please jarvis"])
    );
  });
});

test("rulesRoute: no memory file at all", async () => {
  const { rulesRoute, pendingOffer } = await router();
  await withVault(
    () => rm("system/voice"),
    async () => {
      const state = await snapshot();
      assert.equal(pendingOffer(), null);
      expectGolden("router/rules-no-memory", sweep(rulesRoute, state, SUBSET));
    }
  );
});

test("rulesRoute: offer superseded by a later exchange", async () => {
  const { rulesRoute, pendingOffer } = await router();
  await withVault(
    () =>
      writeMemory([
        { ts: iso(-2 * MIN), you: "give me the rundown", jarvis: "Good morning. Want me to run the inbox audit?", tier: 2 },
        { ts: iso(-1 * MIN), you: "ok", jarvis: "Standing by.", tier: 2 },
      ]),
    async () => {
      const state = await snapshot();
      assert.equal(pendingOffer(), null);
      expectGolden(
        "router/rules-offer-superseded",
        sweep(rulesRoute, state, ["yes", "no", "sounds good", "no thanks"])
      );
    }
  );
});

test("rulesRoute: morning-report offer live — affirm dispatches morning-report", async () => {
  const { rulesRoute, pendingOffer } = await router();
  await withVault(
    () =>
      writeMemory([
        {
          ts: iso(-1 * MIN),
          you: "brief me",
          jarvis: "Good morning. Want me to run the morning report, or do you have anything else in mind?",
          tier: 2,
        },
      ]),
    async () => {
      const state = await snapshot();
      assert.equal(pendingOffer(), "morning-report");
      expectGolden(
        "router/rules-offer-morning-report",
        sweep(rulesRoute, state, ["yes", "yeah go ahead", "go ahead", "no", "later", "morning report"])
      );
    }
  );
});

test("rulesRoute: runner down (stale heartbeat) — dispatch, fallthrough, offer replies, questions", async () => {
  const { rulesRoute, route } = await router();
  await withVault(
    () => writeRunnerStatus(-5 * MIN),
    async () => {
      const state = await snapshot();
      assert.equal(state.runner?.alive, false);
      expectGolden("router/rules-runner-down", sweep(rulesRoute, state, SUBSET));
      expectGolden("router/route-runner-down", [
        { transcript: "yes", result: await route("yes") },
        { transcript: "morning report", result: await route("morning report") },
        { transcript: "inbox brief", result: await route("inbox brief") },
        { transcript: "tell me a joke", result: await route("tell me a joke") },
      ]);
    }
  );
});

test("rulesRoute: runner status file missing", async () => {
  const { rulesRoute } = await router();
  await withVault(
    () => rm("system/runner-status.json"),
    async () => {
      const state = await snapshot();
      assert.equal(state.runner, null);
      expectGolden("router/rules-runner-missing", sweep(rulesRoute, state, SUBSET));
    }
  );
});

test("rulesRoute: runner lane + greeting across heartbeat shapes", async () => {
  const { rulesRoute } = await router();
  const shapes: [string, Record<string, unknown>][] = [
    ["idle", { busy: false, active: 0, pending: 0 }],
    ["idle-with-pending", { busy: false, active: 0, pending: 2 }],
    ["busy-2-active", { busy: true, active: 2, pending: 0 }],
    ["busy-3-active-4-pending", { busy: true, active: 3, pending: 4 }],
    ["stale-but-busy", { busy: true, active: 1, pending: 1, ts: iso(-10 * MIN) }],
    ["bad-ts", { ts: "not-a-date" }],
    ["future-heartbeat", { ts: iso(+5 * MIN) }],
    ["missing-fields", { busy: undefined, active: undefined, pending: undefined, pid: undefined, version: undefined }],
  ];
  const out: { shape: string; runner: VaultState["runner"]; answers: Sweep }[] = [];
  for (const [name, patch] of shapes) {
    await withVault(
      () => writeRunnerStatus(-20_000, patch),
      async () => {
        const state = await snapshot();
        out.push({
          shape: name,
          runner: state.runner,
          answers: sweep(rulesRoute, state, ["is the runner alive", "hey", "morning report", "tell me a joke"]),
        });
      }
    );
  }
  expectGolden("router/rules-runner-shapes", out);
});

test("rulesRoute: no runs on disk — open verbs, last-run lane, in-flight via queue only", async () => {
  const { rulesRoute, openDocAnswer, route } = await router();
  await withVault(
    () => rm("system/runs"),
    async () => {
      const state = await snapshot();
      assert.equal(state.runs.length, 0);
      const asks = [
        "show me that",
        "open it",
        "show me the morning report",
        "bring up this morning's report",
        "open the morning one",
        "show me the cleanup",
        "pull up the html",
        "show me",
        "last run",
        "recent runs",
        "inbox brief",
        "where's that inbox brief",
      ];
      expectGolden("router/rules-no-runs", sweep(rulesRoute, state, asks));
      expectGolden(
        "router/open-doc-no-runs",
        ["show me that", "show me the morning report", "open the cleanup", "open the morning"].map((ask) => ({
          ask,
          answer: openDocAnswer(ask, state),
        }))
      );
      // inbox-brief is still queued, so route() still guards it
      expectGolden("router/route-no-runs", [
        { transcript: "inbox brief", result: await route("inbox brief") },
        { transcript: "voice ask", result: await route("voice ask") },
      ]);
    }
  );
});

test("rulesRoute: queue empty — queue lane, and in-flight via running run only", async () => {
  const { rulesRoute, route } = await router();
  await withVault(
    () => rm("system/queue"),
    async () => {
      const state = await snapshot();
      assert.equal(state.queue.length, 0);
      expectGolden(
        "router/rules-no-queue",
        sweep(rulesRoute, state, ["what's in the queue", "queue", "is the runner alive", "brief me"])
      );
      expectGolden("router/route-no-queue", [
        { transcript: "inbox brief", result: await route("inbox brief") },
        { transcript: "inbox brief again", result: await route("inbox brief again") },
        { transcript: "morning report", result: await route("morning report") },
      ]);
    }
  );
});

test("rulesRoute: nothing in flight — queue and runs both gone", async () => {
  const { route } = await router();
  await withVault(
    () => {
      rm("system/queue");
      rm("system/runs");
    },
    async () => {
      expectGolden("router/route-nothing-in-flight", [
        { transcript: "inbox brief", result: await route("inbox brief") },
        { transcript: "yes", result: await route("yes") },
        { transcript: "inbox brief fable five launch", result: await route("inbox brief fable five launch") },
      ]);
    }
  );
});

// =============================================================================
// 2. route() — pickEngine's rules path composed with inFlightGuard
// =============================================================================

test("route: rules engine composed with the in-flight guard on the default fixture", async () => {
  const { route } = await router();
  const utterances = [
    "inbox brief",
    "Inbox Summary",
    "inbox audit",
    "run the inbox brief again",
    "inbox brief fable five launch",
    "inbox brief fable five",
    "inbox brief please jarvis",
    "morning report",
    "plan today",
    "yes",
    "sounds good",
    "no thanks",
    "brief me",
    "what's in the queue",
    "hey",
    "",
    "show me that",
    "tell me a joke",
    "once you're done with that inbox brief tell me about fable five",
    "voice ask",
  ];
  const out: { transcript: string; convo?: string; result: RouteResult }[] = [];
  for (const transcript of utterances) out.push({ transcript, result: await route(transcript) });
  // convo is ignored by the rules engine
  const convo = "User: any news on fable\nJarvis: Working on it.";
  out.push({ transcript: "inbox brief", convo, result: await route("inbox brief", convo) });
  out.push({ transcript: "tell me a joke", convo, result: await route("tell me a joke", convo) });
  expectGolden("router/route-default", out);
});

test("inFlightGuard: rerun words, residue counting, alias stripping, state shapes", async () => {
  const { inFlightGuard } = await router();
  const s = await snapshot();
  const tier1 = (skill: string, engine: RouteResult["engine"] = "haiku"): RouteResult => ({
    tier: 1,
    skill,
    reply: `On it — ${skill.replace(/-/g, " ")} coming up.`,
    engine,
    panels: ["pipeline"],
  });
  const states: Record<string, VaultState> = {
    default: s,
    "queued-only": { ...s, runs: s.runs.filter((r) => r.status !== "running") },
    "running-only": { ...s, queue: [] },
    neither: { ...s, queue: [], runs: s.runs.filter((r) => r.status !== "running") },
    "plan-today-running": {
      ...s,
      runs: s.runs.map((r) => (r.skill === "plan-today" ? { ...r, status: "running" } : r)),
    },
  };
  const cases: [string, RouteResult, string?][] = [
    ["inbox brief", tier1("inbox-brief")],
    ["once you're done with that inbox brief, tell me about Fable 5", tier1("inbox-brief")],
    ["run the inbox brief again", tier1("inbox-brief")],
    ["another inbox brief", tier1("inbox-brief")],
    ["re-run the inbox brief", tier1("inbox-brief")],
    ["rerun inbox brief", tier1("inbox-brief")],
    ["one more inbox brief", tier1("inbox-brief")],
    ["fresh inbox brief", tier1("inbox-brief")],
    ["a new one for the inbox brief", tier1("inbox-brief")],
    ["Inbox Brief AGAIN", tier1("inbox-brief")],
    ["inbox brief fable five", tier1("inbox-brief")],
    ["inbox brief fable five launch", tier1("inbox-brief")],
    ["hey jarvis can you please run the inbox brief when you're done", tier1("inbox-brief")],
    ["inbox brief — $$$ 100% done!!!", tier1("inbox-brief")],
    ["clean up the inbox", tier1("inbox-brief")],
    ["inbox brief vault cleanup morning report", tier1("inbox-brief")],
    ["voice ask", tier1("voice-ask")],
    ["summarize my week in three bullets", tier1("voice-ask")],
    ["morning report", tier1("morning-report")],
    ["inbox brief", { tier: 2, skill: "inbox-brief", reply: "x", engine: "rules" }],
    ["inbox brief", { tier: 1, reply: "x", engine: "rules" }],
    ["inbox brief", tier1("inbox-brief", "cli")],
    ["inbox brief", tier1("inbox-brief", "local")],
    ["inbox brief", tier1("inbox-brief", "rules")],
    ["inbox brief", tier1("inbox-brief"), "queued-only"],
    ["inbox brief", tier1("inbox-brief"), "running-only"],
    ["inbox brief", tier1("inbox-brief"), "neither"],
    ["plan today", tier1("plan-today")],
    ["plan today", tier1("plan-today"), "plan-today-running"],
    ["plan today again", tier1("plan-today"), "plan-today-running"],
    ["plan today for the sponsor pitch deck", tier1("plan-today"), "plan-today-running"],
  ];
  expectGolden(
    "router/inflight-guard-direct",
    cases.map(([transcript, input, stateName = "default"]) => ({
      transcript,
      state: stateName,
      input,
      result: inFlightGuard(input, transcript, states[stateName]),
    }))
  );
});

// =============================================================================
// 3. briefing / briefingOffer across the clock and vault shapes
// =============================================================================

test("briefing: four times of day, fresh state vs state captured at 10:30", async () => {
  const { briefing, briefingOffer, rulesRoute } = await router();
  const captured = await snapshot();
  for (const [name, ms] of Object.entries(AT)) {
    await withClock(ms, async () => {
      const fresh = await snapshot();
      expectGolden(`router/briefing-${name}-fresh`, {
        now: new Date().toISOString(),
        runnerAlive: fresh.runner?.alive ?? null,
        dailyIsToday: fresh.daily?.isToday ?? null,
        briefing: briefing(fresh),
        rules: rulesRoute("brief me", fresh),
      });
      expectGolden(`router/briefing-${name}-captured-state`, {
        now: new Date().toISOString(),
        briefing: briefing(captured),
      });
      expectGolden(`router/briefing-offer-${name}`, {
        withReport: briefingOffer(fresh, true),
        withoutReport: briefingOffer(fresh, false),
      });
    });
  }
});

test("briefing: vault shape variants at 10:30", async () => {
  const { briefing, briefingOffer, rulesRoute } = await router();
  const variants: [string, () => void][] = [
    ["no-today-note", () => removeTodayNote()],
    ["no-daily-notes-dir", () => rm("daily-notes")],
    ["all-top3-done", () => rewriteFile(PATHS.dailyToday, (r) => r.replace(/\[ \]/g, "[x]"))],
    ["top3-section-empty", () => rewriteFile(PATHS.dailyToday, (r) => r.replace(/^\d+\. \[.\] .*$/gm, ""))],
    ["no-morning-report-today", () => rm(PATHS.morningToday)],
    ["no-morning-dir", () => rm("inbox/reports/morning")],
    [
      "morning-first-headline-unlinked",
      () =>
        rewriteFile(PATHS.morningToday, (r) =>
          r.replace(
            "- **Anthropic posts its first profit** — $559M operating profit on $10.9B quarterly revenue. [source](https://example.com/anthropic-profit)",
            "- A short unlinked lead headline"
          )
        ),
    ],
    [
      "morning-long-headline",
      () =>
        rewriteFile(PATHS.morningToday, (r) =>
          r.replace(
            "- **Anthropic posts its first profit** — $559M operating profit on $10.9B quarterly revenue. [source](https://example.com/anthropic-profit)",
            "- Anthropic (the lab behind Claude) reports a record quarter with profit and revenue both up sharply across every segment and region while headcount stayed flat; analysts expect more, [source](https://example.com/long)"
          )
        ),
    ],
    ["runner-down", () => writeRunnerStatus(-5 * MIN)],
    ["runner-missing", () => rm("system/runner-status.json")],
    ["empty-queue", () => rm("system/queue")],
    ["no-latest-video", () => rm("system/metrics/latest-video.json")],
    ["video-published-just-now", () => rewriteFile("system/metrics/latest-video.json", (r) => r.replace("2026-09-07T18:00:00Z", iso(-HOUR)))],
    ["no-metrics", () => rm("system/metrics/metrics.csv")],
    ["all-metrics-mock", () => rewriteFile("system/metrics/metrics.csv", (r) => r.replace(/,ok,/g, ",mock,"))],
    ["mrr-real", () => rewriteFile("system/metrics/metrics.csv", (r) => r.replace(/,mock,/g, ",ok,"))],
    [
      "everything-missing",
      () => {
        rm("daily-notes");
        rm("inbox");
        rm("system/runs");
        rm("system/queue");
        rm("system/metrics");
        rm("system/runner-status.json");
      },
    ],
  ];
  for (const [name, mutate] of variants) {
    await withVault(mutate, async () => {
      const state = await snapshot();
      expectGolden(`router/briefing-variant-${name}`, {
        briefing: briefing(state),
        offerWithReport: briefingOffer(state, true),
        offerWithoutReport: briefingOffer(state, false),
        rules: rulesRoute("give me the rundown", state),
      });
    });
  }
});

// =============================================================================
// 4. model-engine prompt builders
// =============================================================================

const CONVO = [
  "User: any news on fable",
  "Jarvis: Working on it — I'll speak up when it lands.",
  "User: what's in the queue",
  "Jarvis: Two things waiting: the inbox brief and a voice ask.",
  "",
  'Background results recently delivered (these are what "that"/"it" may refer to):',
  "[voice-ask] Fable 5 shipped this morning (doc: inbox/voice/x.md)",
].join("\n");

test("stateSummary + routerSystem on the default fixture", async () => {
  const { stateSummary, routerSystem } = await router();
  const state = await snapshot();
  expectGolden("router/state-summary-default", stateSummary(state));
  expectGolden("router/router-system-default-no-convo", routerSystem(state, ""));
  expectGolden("router/router-system-default-convo", routerSystem(state, CONVO));
});

// =============================================================================
// 5. validateRouted matrix
// =============================================================================

test("validateRouted: engine × tier × skill × panels × reply matrix", async () => {
  const { validateRouted } = await router();
  type Parsed = Parameters<typeof validateRouted>[0];
  const cases: [string, unknown][] = [
    ["tier1-valid-skill", { tier: 1, skill: "morning-report", reply: "On it", panels: ["pipeline"] }],
    ["tier1-voice-ask", { tier: 1, skill: "voice-ask", reply: "On it" }],
    ["tier1-invalid-skill", { tier: 1, skill: "github-trending", reply: "On it" }],
    ["tier1-skill-wrong-case", { tier: 1, skill: "Morning-Report", reply: "On it" }],
    ["tier1-missing-skill", { tier: 1, reply: "On it" }],
    ["tier1-empty-skill", { tier: 1, skill: "", reply: "On it" }],
    ["tier1-null-skill", { tier: 1, skill: null, reply: "On it" }],
    ["tier2-with-skill-dropped", { tier: 2, skill: "inbox-brief", reply: "Two things", panels: ["pipeline", "vitals"] }],
    ["tier2-no-panels", { tier: 2, reply: "ok" }],
    ["tier3", { tier: 3, reply: "Working on it", panels: ["diagnostics"] }],
    ["tier3-with-skill-dropped", { tier: 3, skill: "voice-ask", reply: "Working on it" }],
    ["tier-missing", { reply: "hi" }],
    ["tier-0", { tier: 0, reply: "hi" }],
    ["tier-4", { tier: 4, reply: "hi" }],
    ["tier-string-1", { tier: "1", skill: "morning-report", reply: "hi" }],
    ["tier-string-2", { tier: "2", reply: "hi" }],
    ["tier-float", { tier: 1.0, skill: "plan-today", reply: "hi" }],
    ["panels-mixed", { tier: 2, reply: "x", panels: ["vitals", "bogus", "pipeline", 42, null, "vitals"] }],
    ["panels-all-invalid", { tier: 2, reply: "x", panels: ["nope"] }],
    ["panels-empty", { tier: 2, reply: "x", panels: [] }],
    ["panels-string", { tier: 2, reply: "x", panels: "vitals" }],
    ["panels-object", { tier: 2, reply: "x", panels: { a: 1 } }],
    ["panels-null", { tier: 2, reply: "x", panels: null }],
    ["reply-missing", { tier: 2 }],
    ["reply-null", { tier: 2, reply: null }],
    ["reply-number", { tier: 2, reply: 42 }],
    ["reply-empty", { tier: 2, reply: "" }],
    ["reply-object", { tier: 3, reply: { a: 1 } }],
    ["reply-array", { tier: 3, reply: ["a", "b"] }],
    ["empty-object", {}],
  ];
  const out: Record<string, RouteResult | null> = {};
  for (const engine of ["haiku", "local", "cli"] as const) {
    for (const [name, parsed] of cases) out[`${engine}/${name}`] = validateRouted(parsed as Parsed, engine);
  }
  expectGolden("router/validate-routed-matrix", out);
});

// =============================================================================
// 6. smalltalk × states, pendingOffer matrix
// =============================================================================

test("smalltalk: corpus across runner/daily shapes", async () => {
  const { smalltalk } = await router();
  const s = await snapshot();
  const daily = s.daily!;
  const runner = s.runner!;
  const top3 = (done: boolean[]) => done.map((d, i) => ({ text: `goal ${i + 1}`, done: d }));
  const states: Record<string, VaultState> = {
    "default-busy-2-open": s,
    "idle-1-open": { ...s, runner: { ...runner, busy: false }, daily: { ...daily, top3: top3([true, true, false]) } },
    "idle-all-done": { ...s, runner: { ...runner, busy: false }, daily: { ...daily, top3: top3([true, true, true]) } },
    "busy-all-done": { ...s, runner: { ...runner, busy: true }, daily: { ...daily, top3: top3([true, true, true]) } },
    "idle-no-daily": { ...s, runner: { ...runner, busy: false }, daily: null },
    "busy-no-daily": { ...s, runner: { ...runner, busy: true }, daily: null },
    "no-runner-stale-note-2-open": { ...s, runner: null, daily: { ...daily, isToday: false } },
    "busy-empty-top3": { ...s, daily: { ...daily, top3: [] } },
    "idle-3-open": { ...s, runner: { ...runner, busy: false }, daily: { ...daily, top3: top3([false, false, false]) } },
  };
  const out: Record<string, { t: string; reply: string | null }[]> = {};
  for (const [name, state] of Object.entries(states)) {
    out[name] = SMALLTALK.map((t) => ({ t, reply: smalltalk(t, state) }));
  }
  expectGolden("router/smalltalk-matrix", out);
});

test("pendingOffer: every OFFER_SKILLS phrasing, near-misses, and the 3-minute window", async () => {
  const { pendingOffer } = await router();
  const offer = (jarvis: string, tsOffset = -MIN) => ({ ts: iso(tsOffset), you: "give me the rundown", jarvis, tier: 2 });
  const cases: [string, (string | object)[] | "FIXTURE" | "DELETE"][] = [
    ["fixture-default", "FIXTURE"],
    ["run-the-morning-report-with-tail", [offer("Want me to run the morning report, or do you have anything else in mind?")]],
    ["run-the-daily-inbox-audit-with-tail", [offer("Want me to run the daily inbox audit, or do you have anything else in mind?")]],
    ["run-the-inbox-audit", [offer("Want me to run the inbox audit?")]],
    ["pull-the-inbox-audit", [offer("Want me to pull the inbox audit?")]],
    ["pull-the-daily-morning-report", [offer("Want me to pull the daily morning report?")]],
    ["run-morning-report-no-article", [offer("Want me to run morning report now?")]],
    ["run-daily-inbox-audit-no-article", [offer("Want me to run daily inbox audit?")]],
    ["uppercase", [offer("WANT ME TO RUN THE MORNING REPORT?")]],
    ["mid-sentence", [offer("The board's clear. Want me to run the inbox audit, or do you have anything else in mind?")]],
    ["both-phrases-first-wins", [offer("Want me to run the inbox audit or run the morning report?")]],
    ["near-miss-inbox-brief", [offer("Want me to run the inbox brief?")]],
    ["near-miss-do-verb", [offer("Want me to do the inbox audit?")]],
    ["near-miss-shall-i", [offer("Shall I run the inbox audit?")]],
    ["near-miss-double-daily", [offer("Want me to run the daily daily inbox audit?")]],
    ["near-miss-run-a", [offer("Want me to run a morning report?")]],
    ["near-miss-bare-phrase", [offer("inbox audit")]],
    ["near-miss-morning-inbox-audit", [offer("Want me to run the morning inbox audit?")]],
    ["offer-superseded-by-later-exchange", [offer("Want me to run the inbox audit?", -2 * MIN), { ts: iso(-MIN), you: "ok", jarvis: "Standing by.", tier: 2 }]],
    ["offer-exactly-3-min-old", [offer("Want me to run the inbox audit?", -3 * MIN)]],
    ["offer-3-min-plus-1ms-old", [offer("Want me to run the inbox audit?", -3 * MIN - 1)]],
    ["offer-9-min-old", [offer("Want me to run the inbox audit?", -9 * MIN)]],
    ["offer-11-min-old", [offer("Want me to run the inbox audit?", -11 * MIN)]],
    ["offer-from-the-future", [offer("Want me to run the inbox audit?", +5 * MIN)]],
    ["offer-bad-ts", [{ ts: "nope", you: "x", jarvis: "Want me to run the inbox audit?", tier: 2 }]],
    ["offer-missing-ts", [{ you: "x", jarvis: "Want me to run the inbox audit?", tier: 2 }]],
    ["garbage-line-after-offer", [offer("Want me to run the inbox audit?"), "{not json"]],
    ["offer-missing-jarvis-field", [{ ts: iso(-MIN), you: "x", tier: 2 }]],
    ["empty-file", []],
    ["blank-lines-only", ["", "  ", ""]],
    ["missing-file", "DELETE"],
  ];
  const out: { name: string; offer: string | null | { threw: string } }[] = [];
  for (const [name, lines] of cases) {
    await withVault(
      () => {
        if (lines === "DELETE") rm(PATHS.memory);
        else if (lines !== "FIXTURE") writeMemory(lines);
      },
      () => {
        let result: string | null | { threw: string };
        try {
          result = pendingOffer();
        } catch (e) {
          result = { threw: (e as Error).name };
        }
        out.push({ name, offer: result });
      }
    );
  }
  expectGolden("router/pending-offer-matrix", out);
});

// =============================================================================
// stateAnswer / openDocAnswer seams (normalized input, default fixture)
// =============================================================================

test("stateAnswer + openDocAnswer sub-answers on the default fixture", async () => {
  const { stateAnswer, openDocAnswer } = await router();
  const state = await snapshot();
  const asks = [
    "brief me",
    "give me the rundown",
    "mrr",
    "m r are",
    "revenue",
    "money",
    "runner",
    "daemon",
    "subscriber",
    "subs",
    "youtube views",
    "views youtube",
    "28 day",
    "instagram",
    "tiktok",
    "latest video",
    "last video",
    "video doing",
    "token",
    "claude usage",
    "queue",
    "top 3",
    "top three",
    "priorit",
    "directive",
    "goal",
    "schedule",
    "next today",
    "whats next",
    "what s next",
    "next up",
    "focus",
    "last run",
    "last fail",
    "recent run",
    "show me that",
    "open the cleanup",
    "nothing here",
    "hey",
    "",
  ];
  expectGolden(
    "router/state-answer-direct",
    asks.map((ask) => ({ ask, answer: stateAnswer(ask, state) }))
  );
  const opens = [
    "show me that",
    "open it",
    "bring up the html",
    "pull up the results",
    "show me the morning report",
    "open the inbox brief",
    "show me the cleanup",
    "open the fable five doc",
    "show me the weather",
    "display the trend scan",
    "show me",
    "open the rundown",
    "show me the briefing",
    "put up the last one",
    "show us the vault cleanup report",
    "open that again",
    "bring up the explainer",
    "open my daily note",
    "show me the inbox report",
    "display",
    "open",
    "open the plan today note",
    "show me the voice ask",
    "show me the weather one from the other day",
    "open the morning report from yesterday",
  ];
  expectGolden(
    "router/open-doc-direct",
    opens.map((ask) => ({ ask, answer: openDocAnswer(ask, state) }))
  );
});

// =============================================================================
// 7. empty-vault variant (metrics + runner-status kept)
// =============================================================================

test("empty vault: no notes, inbox, runs, queue, or memory — corpus subset, briefing, prompts", async () => {
  const { rulesRoute, route, briefing, briefingOffer, stateSummary, routerSystem, openDocAnswer, smalltalk, pendingOffer } =
    await router();
  await withVault(
    () => {
      rm("daily-notes");
      rm("inbox");
      rm("system/runs");
      rm("system/queue");
      rm("system/voice");
    },
    async () => {
      const state = await snapshot();
      assert.equal(state.daily, null);
      assert.equal(state.morning, null);
      assert.equal(state.runs.length, 0);
      assert.equal(state.queue.length, 0);
      assert.equal(pendingOffer(), null);
      expectGolden("router/rules-empty-vault", sweep(rulesRoute, state, SUBSET));
      expectGolden("router/briefing-empty-vault", {
        briefing: briefing(state),
        offerWithReport: briefingOffer(state, true),
        offerWithoutReport: briefingOffer(state, false),
      });
      expectGolden("router/state-summary-empty-vault", stateSummary(state));
      expectGolden("router/router-system-empty-vault-no-convo", routerSystem(state, ""));
      expectGolden("router/router-system-empty-vault-convo", routerSystem(state, CONVO));
      expectGolden("router/open-doc-empty-vault", {
        "show me that": openDocAnswer("show me that", state),
        "show me the morning report": openDocAnswer("show me the morning report", state),
      });
      expectGolden("router/smalltalk-empty-vault", {
        hey: smalltalk("hey", state),
        "what's up": smalltalk("what's up", state),
      });
      expectGolden("router/route-empty-vault", [
        { transcript: "inbox brief", result: await route("inbox brief") },
        { transcript: "yes", result: await route("yes") },
        { transcript: "brief me", result: await route("brief me") },
        { transcript: "show me that", result: await route("show me that") },
      ]);
    }
  );
});

// =============================================================================
// harness sanity — the fixture rebuilds identically and nothing hit the network
// =============================================================================

test("fixture rebuild is faithful (run order + offer live again) and fetch was never called", async () => {
  const { pendingOffer } = await router();
  const s = await snapshot();
  assert.deepEqual(
    s.runs.map((r) => r.id),
    [
      IDS.runInboxRunning,
      IDS.runVoiceAskLinked,
      IDS.runMorningToday,
      IDS.runPlanTodayError,
      IDS.runMorningYesterday,
      IDS.runCleanupOld,
      IDS.runVoiceAskOld,
    ]
  );
  assert.equal(s.runner?.alive, true);
  assert.equal(pendingOffer(), "inbox-brief");
  assert.equal(new Date().toISOString(), "2026-09-09T15:30:00.000Z");
  assert.deepEqual(fetchCalls, []);
});
