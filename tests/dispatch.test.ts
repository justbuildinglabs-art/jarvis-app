// Characterization of the voice dispatch layer: transcript → route → queue
// intent → conversation memory, plus the pure helpers it leans on
// (modelOverride, spokenText, skills). Every golden here pins the behavior
// of the code as it stood before the refactor — quirks included, on purpose.
//
// Layout: lib/voiceDispatch.ts (dispatchTranscript), lib/voiceMemory.ts
// (rememberExchange / recentExchanges / allExchanges / conversationContext /
// clearMemory), lib/modelOverride.ts (extractModelOverride), lib/spokenText.ts
// (normalizeForSpeech / scrubRunSummary / humanizeFailure), lib/skills.ts
// (ALLOWED_SKILLS / writeIntent).
//
// The fixture vault is rebuilt before EVERY test: dispatch writes queue
// intents and memory lines, and the router's in-flight guard reads the queue
// back, so a stale intent from one case would change the next case's route.
import "./_util/env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_ROOT, FROZEN_NOW_ISO, FROZEN_NOW_MS } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, FIXTURE_IDS, IDS, PATHS, iso } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const abs = (rel: string) => path.join(FIXTURE_ROOT, rel);
const MEMORY_ABS = abs(PATHS.memory);
const VOICE_DIR = abs("system/voice");
const QUEUE_DIR = abs("system/queue");
const RUNS_DIR = abs("system/runs");

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

// --- helpers ------------------------------------------------------------------

function setMtime(absPath: string, ms: number): void {
  const t = new Date(ms);
  fs.utimesSync(absPath, t, t);
}

function writeFile(rel: string, content: string, mtimeMs: number): void {
  const p = abs(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  setMtime(p, mtimeMs);
}

function writeRunJson(name: string, obj: Record<string, unknown>, mtimeMs: number): void {
  writeFile(`system/runs/${name}.json`, JSON.stringify(obj, null, 2) + "\n", mtimeMs);
}

function memoryLines(): string[] {
  try {
    return fs
      .readFileSync(MEMORY_ABS, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function lastMemoryLine(): unknown {
  const ls = memoryLines();
  return ls.length ? JSON.parse(ls[ls.length - 1]) : null;
}

/** queue files that are NOT part of the fixture — i.e. written by the test */
function newIntents(): Array<{ file: string; intent: Record<string, unknown> }> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(QUEUE_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json") && !FIXTURE_IDS.has(f.replace(/\.json$/, "").toLowerCase()))
    .sort()
    .map((f) => ({
      file: f,
      intent: JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, f), "utf-8")) as Record<string, unknown>,
    }));
}

function seedMemory(entries: Array<Record<string, unknown>>): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_ABS, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** Dispatch one transcript and golden {payload, the intent it wrote (if
 *  any), the memory line it appended}. Intent ids are fresh UUIDs and are
 *  masked by the golden normalizer; ts is the frozen clock. */
async function pinDispatch(name: string, transcript: string, source = "voice-ptt") {
  const { dispatchTranscript } = await import("@/lib/voiceDispatch");
  const payload = await dispatchTranscript(transcript, source);
  const intents = newIntents();
  assert.ok(intents.length <= 1, `expected at most one new intent, got ${intents.length}`);
  const intent = intents[0] ?? null;
  expectGolden(`dispatch/${name}`, {
    payload,
    intent: intent ? { file: intent.file, ...intent.intent } : null,
    memory: lastMemoryLine(),
  });
  return payload;
}

// =============================================================================
// 1. dispatchTranscript matrix
// =============================================================================

// --- tier 1: bare aliases ------------------------------------------------------

test("tier-1 'morning report' queues morning-report and remembers the ack", async () => {
  const p = await pinDispatch("tier1-morning-report", "morning report");
  assert.equal(p.tier, 1);
  assert.equal(p.skill, "morning-report");
  assert.ok(p.queued);
});

test("tier-1 'inbox brief' is caught by the in-flight guard (fixture has inbox-brief queued AND running) — no intent", async () => {
  const p = await pinDispatch("tier1-inbox-brief-in-flight-guard", "inbox brief");
  assert.equal(p.tier, 2);
  assert.equal(p.queued, null);
  assert.equal(newIntents().length, 0);
});

test("tier-1 'inbox again' bypasses the in-flight guard via RERUN_RE and queues inbox-brief", async () => {
  const p = await pinDispatch("tier1-inbox-brief-again-rerun", "inbox again");
  assert.equal(p.tier, 1);
  assert.equal(p.skill, "inbox-brief");
});

test("tier-1 'vault cleanup' queues vault-cleanup", async () => {
  const p = await pinDispatch("tier1-vault-cleanup", "vault cleanup");
  assert.equal(p.skill, "vault-cleanup");
});

test("tier-1 'plan today' queues plan-today (an errored plan-today run does not count as in flight)", async () => {
  const p = await pinDispatch("tier1-plan-today", "plan today");
  assert.equal(p.skill, "plan-today");
});

test("tier-1 'plan tomorrow' queues plan-tomorrow", async () => {
  const p = await pinDispatch("tier1-plan-tomorrow", "plan tomorrow");
  assert.equal(p.skill, "plan-tomorrow");
});

// --- tier 2: questions answered from the snapshot -----------------------------

test("tier-2 'what's in the queue' answers from state, writes no intent, memory line has no skill", async () => {
  const p = await pinDispatch("tier2-queue-question", "what's in the queue");
  assert.equal(p.tier, 2);
  assert.equal(p.queued, null);
  assert.equal(newIntents().length, 0);
});

test("tier-2 'how many subscribers do I have' answers vitals", async () => {
  await pinDispatch("tier2-subscribers-question", "how many subscribers do I have");
});

test("tier-2 'show me the morning report' resolves a deliverable with reveal=open", async () => {
  const p = await pinDispatch("tier2-open-doc-reveal", "show me the morning report");
  assert.equal(p.reveal, "open");
  assert.ok(p.deliverable);
});

test("tier-2 'give me the rundown' returns the briefing with reveals and deliverable", async () => {
  const p = await pinDispatch("tier2-briefing-rundown", "give me the rundown");
  assert.equal(p.tier, 2);
  assert.ok(p.reveals.length > 0);
});

test("'yes' to the fixture's standing inbox-audit offer routes tier 1 then hits the in-flight guard → tier 2, no intent", async () => {
  const p = await pinDispatch("tier2-offer-yes-in-flight", "yes");
  assert.equal(p.tier, 2);
  assert.equal(newIntents().length, 0);
});

test("'no' to the standing offer is 'Standing by.'", async () => {
  await pinDispatch("tier2-offer-no", "no");
});

// --- tier 3: open-ended asks --------------------------------------------------

test("tier-3 six-word ask queues voice-ask with {prompt, context} from conversationContext()", async () => {
  const p = await pinDispatch("tier3-six-words", "summarize my week in three bullets");
  assert.equal(p.tier, 3);
  assert.equal(p.skill, "voice-ask");
  const [i] = newIntents();
  assert.deepEqual(Object.keys(i.intent.args as object), ["prompt", "context"]);
});

test("tier-3 exactly three words still queues voice-ask (word guard is >= 3)", async () => {
  const p = await pinDispatch("tier3-three-words-boundary", "fable five launch");
  assert.equal(p.skill, "voice-ask");
  assert.ok(p.queued);
});

test("tier-3 two words: no intent, reply 'I didn't catch enough to act on.', skill null, memory has no skill", async () => {
  const p = await pinDispatch("tier3-two-words-no-intent", "fable five");
  assert.equal(p.tier, 3);
  assert.equal(p.queued, null);
  assert.equal(p.skill, null);
  assert.equal(p.reply, "I didn't catch enough to act on.");
});

test("tier-3 one word: no intent", async () => {
  await pinDispatch("tier3-one-word-no-intent", "thermodynamics");
});

test("empty transcript: router says 'I didn't catch that.' but the spoken reply is the not-enough line", async () => {
  const p = await pinDispatch("tier3-empty-transcript", "");
  assert.equal(p.reply, "I didn't catch enough to act on.");
});

test("QUIRK: padded two-word transcript splits to four tokens and DOES queue voice-ask with the padded prompt", async () => {
  const p = await pinDispatch("tier3-padded-two-words-counts-as-four", "  fable five  ");
  assert.equal(p.skill, "voice-ask");
  const [i] = newIntents();
  assert.equal((i.intent.args as { prompt: string }).prompt, "  fable five  ");
});

test("tier-3 with empty conversation context omits the context key entirely", async () => {
  fs.rmSync(VOICE_DIR, { recursive: true, force: true });
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  await pinDispatch("tier3-no-context-key-when-convo-empty", "summarize my week in three bullets");
  const [i] = newIntents();
  assert.deepEqual(Object.keys(i.intent.args as object), ["prompt"]);
});

// --- model override -----------------------------------------------------------

test("'use opus …' strips the phrase, sets args.model, and speaks the Opus 5 ack; memory keeps the raw transcript", async () => {
  const p = await pinDispatch("override-opus", "use opus tell me about the fable five launch");
  assert.equal(p.reply, "On it — running this one on Opus 5. I'll speak up when it lands.");
  const [i] = newIntents();
  const args = i.intent.args as { prompt: string; model: string; context: string };
  assert.equal(args.prompt, "tell me about the fable five launch");
  assert.equal(args.model, "claude-opus-5");
  assert.equal(p.transcript, "use opus tell me about the fable five launch");
});

test("'use fable …' → claude-fable-5, spoken 'Fable'", async () => {
  await pinDispatch("override-fable", "use fable summarize my week in three bullets");
});

test("'use sonnet …' → claude-sonnet-4-6, spoken 'Sonnet'", async () => {
  await pinDispatch("override-sonnet", "use sonnet summarize my week in three bullets");
});

test("'use haiku …' → claude-haiku-4-5-20251001, spoken 'Haiku'", async () => {
  await pinDispatch("override-haiku", "use haiku summarize my week in three bullets");
});

test("QUIRK: override on a tier-1 alias is silently dropped — intent has no model, ack is the plain one", async () => {
  const p = await pinDispatch("override-on-tier1-alias", "use opus morning report");
  assert.equal(p.tier, 1);
  const [i] = newIntents();
  assert.deepEqual(i.intent.args, {});
  assert.equal(p.reply, "On it — morning report coming up.");
});

test("override on a tier-2 question is ignored; the stripped ask is what gets routed", async () => {
  const p = await pinDispatch("override-on-tier2-question", "use opus what's in the queue");
  assert.equal(p.tier, 2);
});

test("override with a two-word ask: word guard wins, nothing queued, override ack NOT spoken", async () => {
  const p = await pinDispatch("override-with-two-word-ask", "use opus fable five");
  assert.equal(p.queued, null);
  assert.equal(p.reply, "I didn't catch enough to act on.");
});

// --- source propagation -------------------------------------------------------

test("source 'voice-ptt' lands verbatim in the intent file", async () => {
  await pinDispatch("source-voice-ptt", "summarize my week in three bullets", "voice-ptt");
  assert.equal(newIntents()[0].intent.source, "voice-ptt");
});

test("source 'voice-wake' lands verbatim in the intent file", async () => {
  await pinDispatch("source-voice-wake", "summarize my week in three bullets", "voice-wake");
  assert.equal(newIntents()[0].intent.source, "voice-wake");
});

test("an arbitrary source string is not validated — written as-is", async () => {
  await pinDispatch("source-custom", "morning report", "anything goes");
  assert.equal(newIntents()[0].intent.source, "anything goes");
});

// --- memory feeds the next ask ------------------------------------------------

test("a second ask's context includes the first exchange (memory round-trips within one process)", async () => {
  const { dispatchTranscript } = await import("@/lib/voiceDispatch");
  await dispatchTranscript("summarize my week in three bullets", "voice-ptt");
  await dispatchTranscript("make it shorter please", "voice-ptt");
  const intents = newIntents();
  assert.equal(intents.length, 2);
  // order by which one references the other: the follow-up's context names the first prompt
  const followup = intents.find((i) => (i.intent.args as { prompt: string }).prompt === "make it shorter please")!;
  const first = intents.find((i) => i !== followup)!;
  expectGolden("dispatch/followup-context-includes-prior-exchange", {
    first: { file: first.file, ...first.intent },
    followup: { file: followup.file, ...followup.intent },
    memoryTail: memoryLines().slice(-2).map((l) => JSON.parse(l)),
  });
});

// =============================================================================
// 2. voiceMemory
// =============================================================================

test("rememberExchange stamps the frozen clock as ts (ts is the first key)", async () => {
  const { rememberExchange } = await import("@/lib/voiceMemory");
  rememberExchange({ you: "ping", jarvis: "pong", tier: 2 });
  rememberExchange({ you: "run it", jarvis: "On it.", tier: 1, skill: "plan-today" });
  const tail = memoryLines().slice(-2);
  assert.match(tail[0], new RegExp(`^\\{"ts":"${FROZEN_NOW_ISO}"`));
  expectGolden("dispatch/memory-remember-stamps-frozen-ts", tail.map((l) => JSON.parse(l)));
});

test("rememberExchange rewrites the whole file and KEEPS malformed lines (pruning is by line, not by validity)", async () => {
  const { rememberExchange } = await import("@/lib/voiceMemory");
  rememberExchange({ you: "ping", jarvis: "pong", tier: 2 });
  expectGolden("dispatch/memory-after-remember-keeps-malformed", fs.readFileSync(MEMORY_ABS, "utf-8"));
});

test("memory prunes to 40 lines: 45 seeded + 1 new keeps the last 40 (seed 7 is now first)", async () => {
  const { rememberExchange } = await import("@/lib/voiceMemory");
  const seed = Array.from({ length: 45 }, (_, k) => ({
    ts: iso(-(46 - (k + 1)) * 1000),
    you: `seed ${k + 1}`,
    jarvis: `reply ${k + 1}`,
    tier: 2,
  }));
  seedMemory(seed);
  rememberExchange({ you: "new", jarvis: "newest", tier: 2 });
  const lines = memoryLines();
  assert.equal(lines.length, 40);
  expectGolden("dispatch/memory-prune-to-40", {
    count: lines.length,
    first: JSON.parse(lines[0]),
    last: JSON.parse(lines[lines.length - 1]),
    endsWithNewline: fs.readFileSync(MEMORY_ABS, "utf-8").endsWith("\n"),
  });
});

test("recentExchanges 10-minute window is strict: exactly -10:00 is OUT, -9:59.999 is in, -10:01 is out", async () => {
  const { recentExchanges } = await import("@/lib/voiceMemory");
  seedMemory([
    { ts: iso(-10 * MIN - 1000), you: "minus ten oh one", jarvis: "x", tier: 2 },
    { ts: iso(-10 * MIN), you: "exactly minus ten", jarvis: "x", tier: 2 },
    { ts: iso(-10 * MIN + 1), you: "minus nine fifty-nine point nine nine nine", jarvis: "x", tier: 2 },
    { ts: iso(-9 * MIN - 59_000), you: "minus nine fifty-nine", jarvis: "x", tier: 2 },
    { ts: iso(0), you: "now", jarvis: "x", tier: 2 },
    { ts: iso(+5 * MIN), you: "future", jarvis: "x", tier: 2 },
    { ts: "not a date", you: "unparseable ts", jarvis: "x", tier: 2 },
  ]);
  expectGolden("dispatch/memory-window-boundary", recentExchanges());
});

test("recentExchanges maxN: default 6 = last six; 2 = last two; QUIRK 0 = everything (slice(-0))", async () => {
  const { recentExchanges } = await import("@/lib/voiceMemory");
  seedMemory(
    Array.from({ length: 8 }, (_, k) => ({ ts: iso(-(8 - k) * 1000), you: `e${k + 1}`, jarvis: "x", tier: 2 }))
  );
  const you = (xs: Array<{ you: string }>) => xs.map((e) => e.you);
  expectGolden("dispatch/memory-maxn", {
    default: you(recentExchanges()),
    two: you(recentExchanges(2)),
    zero: you(recentExchanges(0)),
    hundred: you(recentExchanges(100)),
  });
});

test("allExchanges: no window, malformed lines skipped, order kept (fixture)", async () => {
  const { allExchanges } = await import("@/lib/voiceMemory");
  const all = allExchanges();
  assert.equal(all.length, 4);
  expectGolden("dispatch/memory-all-exchanges", all);
});

test("allExchanges tolerates CRLF and blank lines; a JSON scalar line survives as an entry", async () => {
  const { allExchanges } = await import("@/lib/voiceMemory");
  fs.writeFileSync(
    MEMORY_ABS,
    [
      JSON.stringify({ ts: iso(-DAY), you: "old", jarvis: "x", tier: 2 }),
      "",
      "   ",
      "42",
      '"a string"',
      JSON.stringify({ ts: iso(-1000), you: "new", jarvis: "y", tier: 3, skill: "voice-ask" }),
    ].join("\r\n") + "\r\n",
    "utf-8"
  );
  expectGolden("dispatch/memory-all-exchanges-crlf", allExchanges());
});

test("allExchanges / recentExchanges return [] when the memory file is missing", async () => {
  const { allExchanges, recentExchanges } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  assert.deepEqual(allExchanges(), []);
  assert.deepEqual(recentExchanges(), []);
});

// --- conversationContext ------------------------------------------------------

test("conversationContext on the fixture: 3 in-window exchanges + 2 ok runs (newest first) + 1 running run", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  expectGolden("dispatch/context-fixture", conversationContext());
});

test("conversationContext with no memory file: run sections only", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  expectGolden("dispatch/context-no-memory-file", conversationContext());
});

test("conversationContext with system/voice missing: same as no file; rememberExchange then recreates dir+file", async () => {
  const { conversationContext, rememberExchange } = await import("@/lib/voiceMemory");
  fs.rmSync(VOICE_DIR, { recursive: true, force: true });
  expectGolden("dispatch/context-memory-dir-missing", conversationContext());
  rememberExchange({ you: "first after wipe", jarvis: "hi", tier: 2 });
  assert.ok(fs.existsSync(MEMORY_ABS));
  expectGolden("dispatch/context-memory-dir-recreated", {
    file: fs.readFileSync(MEMORY_ABS, "utf-8"),
    context: conversationContext(),
  });
});

test("conversationContext with system/runs missing: exchanges only (readdir failure swallowed)", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  expectGolden("dispatch/context-runs-dir-missing", conversationContext());
});

test("conversationContext with only a running run (memory cleared): just the in-progress block", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.startsWith(IDS.runInboxRunning)) fs.rmSync(path.join(RUNS_DIR, f));
  }
  expectGolden("dispatch/context-only-running-runs", conversationContext());
});

test("runs older than 45 min by mtime drop out — INCLUDING a still-running one (same window)", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  for (const f of fs.readdirSync(RUNS_DIR)) setMtime(path.join(RUNS_DIR, f), FROZEN_NOW_MS - 46 * MIN);
  expectGolden("dispatch/context-runs-older-than-45min", conversationContext());
});

test("the run window checks file MTIME, not the JSON timestamps: new mtime + 3-day-old ts_completed IS included", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  writeRunJson(
    "zz-mtime-new-ts-old",
    {
      id: "zz-mtime-new-ts-old",
      skill: "vault-cleanup",
      args: {},
      ts_queued: iso(-3 * DAY),
      ts_started: iso(-3 * DAY),
      ts_completed: iso(-3 * DAY + 60_000),
      status: "ok",
      exit_code: 0,
      summary: "Ancient by timestamp, fresh by mtime.",
      deliverable_path: "inbox/reports/vault-cleanup/2026-09-06-ancient.md",
    },
    FROZEN_NOW_MS - 1 * MIN
  );
  const ctx = conversationContext();
  assert.match(ctx, /Ancient by timestamp/);
  expectGolden("dispatch/context-mtime-new-ts-old", ctx);
});

test("…and old mtime + brand-new ts_completed is EXCLUDED (mtime is the only thing checked)", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  writeRunJson(
    "zz-mtime-old-ts-new",
    {
      id: "zz-mtime-old-ts-new",
      skill: "vault-cleanup",
      args: {},
      ts_queued: iso(-2000),
      ts_started: iso(-1000),
      ts_completed: iso(0),
      status: "ok",
      exit_code: 0,
      summary: "Fresh by timestamp, ancient by mtime.",
      deliverable_path: null,
    },
    FROZEN_NOW_MS - 50 * MIN
  );
  const ctx = conversationContext();
  assert.doesNotMatch(ctx, /Fresh by timestamp/);
  expectGolden("dispatch/context-mtime-old-ts-new", ctx);
});

test("running run with a >90-char prompt and no ts_started: prompt truncated to 90, no minutes suffix", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  for (const f of fs.readdirSync(RUNS_DIR)) fs.rmSync(path.join(RUNS_DIR, f));
  const longPrompt =
    "write me a very long and detailed essay about the history of voice assistants from eliza through siri to whatever comes next please";
  writeRunJson(
    "zz-running-long",
    { id: "zz-running-long", skill: "voice-ask", args: { prompt: longPrompt }, ts_started: null, status: "running", summary: "" },
    FROZEN_NOW_MS - 30_000
  );
  expectGolden("dispatch/context-running-long-prompt-no-ts", conversationContext());
});

test("ok run with a >140-char summary and no deliverable: summary truncated to 140, no (doc:) suffix; missing summary reads as empty", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(MEMORY_ABS, { force: true });
  for (const f of fs.readdirSync(RUNS_DIR)) fs.rmSync(path.join(RUNS_DIR, f));
  const longSummary =
    "This summary is deliberately long so that it runs well past the one hundred and forty character limit that the context builder applies to each run result line, and then some.";
  writeRunJson(
    "zz-ok-long",
    { id: "zz-ok-long", skill: "voice-ask", status: "ok", summary: longSummary, deliverable_path: null },
    FROZEN_NOW_MS - 2 * MIN
  );
  writeRunJson("zz-ok-nosummary", { id: "zz-ok-nosummary", skill: "plan-today", status: "ok" }, FROZEN_NOW_MS - 3 * MIN);
  writeRunJson("zz-error-recent", { id: "zz-error-recent", skill: "inbox-brief", status: "error", summary: "boom" }, FROZEN_NOW_MS - 1 * MIN);
  writeFile("system/runs/zz-bad.json", "{not json", FROZEN_NOW_MS - 1 * MIN);
  writeFile("system/runs/zz-not-a-run.md", "# ignored", FROZEN_NOW_MS - 1 * MIN);
  expectGolden("dispatch/context-ok-long-summary-no-deliverable", conversationContext());
});

test("conversationContext is the empty string when memory and runs are both absent", async () => {
  const { conversationContext } = await import("@/lib/voiceMemory");
  fs.rmSync(VOICE_DIR, { recursive: true, force: true });
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  assert.equal(conversationContext(), "");
  expectGolden("dispatch/context-empty-when-nothing", JSON.stringify(conversationContext()));
});

// --- clearMemory --------------------------------------------------------------

test("clearMemory empties an existing file, creates an empty one when only the dir exists, and does nothing when the dir is missing", async () => {
  const { clearMemory, allExchanges } = await import("@/lib/voiceMemory");
  clearMemory();
  const afterClearWithFile = { exists: fs.existsSync(MEMORY_ABS), content: fs.readFileSync(MEMORY_ABS, "utf-8"), all: allExchanges() };

  fs.rmSync(MEMORY_ABS, { force: true });
  clearMemory();
  const afterClearWithoutFile = { exists: fs.existsSync(MEMORY_ABS), content: fs.readFileSync(MEMORY_ABS, "utf-8") };

  fs.rmSync(VOICE_DIR, { recursive: true, force: true });
  assert.doesNotThrow(() => clearMemory());
  const afterClearWithoutDir = { dirExists: fs.existsSync(VOICE_DIR), fileExists: fs.existsSync(MEMORY_ABS) };

  expectGolden("dispatch/memory-clear", { afterClearWithFile, afterClearWithoutFile, afterClearWithoutDir });
});

// =============================================================================
// 3. modelOverride.extractModelOverride corpus
// =============================================================================

test("extractModelOverride corpus: exact 'use <model>' bigram only, first occurrence stripped, connective cleanup quirks", async () => {
  const { extractModelOverride } = await import("@/lib/modelOverride");
  const corpus = [
    // each model, plain
    "use opus tell me about the fable five launch",
    "use fable summarize my week",
    "use sonnet summarize my week",
    "use haiku summarize my week",
    // case variants
    "Use Opus tell me about X",
    "USE FABLE summarize my week",
    "uSe SoNnEt summarize my week",
    "USE OPUS",
    // guard: not the literal bigram
    "useful summarize my week",
    "user table opus",
    "opus",
    "opus summarize my week",
    "reuse opus summarize my week",
    "use opus5 summarize",
    "use opusy summarize",
    "use claude opus summarize",
    "use the opus model summarize",
    "muse opus summarize",
    "use  opus   summarize",
    // dangling connectives / punctuation
    "use opus, summarize x",
    "summarize x, and use opus",
    "summarize x; then use haiku",
    "summarize x use opus then",
    "summarize x use opus and please",
    "and then use fable please",
    "summarize x and then use fable please",
    "please use sonnet, summarize my inbox",
    "Use Fable please summarize x",
    "hey jarvis use fable what's the weather like",
    "use opus and",
    "and use opus",
    "use opus,",
    // phrase at the end with trailing punctuation
    "summarize x. use opus.",
    "summarize x, use opus!",
    "Use opus.",
    "Use haiku? summarize x",
    // double phrases — only the FIRST match is stripped
    "use opus use fable summarize",
    "use fable summarize x and use opus",
    "use opus and use opus summarize x",
    // alone
    "use haiku",
    "use opus ",
    " use opus",
  ];
  assert.ok(corpus.length >= 25);
  expectGolden(
    "dispatch/model-override-corpus",
    Object.fromEntries(corpus.map((s) => [s, extractModelOverride(s)]))
  );
});

// =============================================================================
// 4. spokenText
// =============================================================================

test("normalizeForSpeech corpus: money, suffixes, bare counts, commas, years, decimals, negatives", async () => {
  const { normalizeForSpeech } = await import("@/lib/spokenText");
  const corpus = [
    // money with suffix
    "$200M",
    "$1.5B",
    "$10k",
    "$10K",
    "$2T",
    "$3 million",
    "$4.2 billion",
    "$1 trillion",
    "$100 Million",
    "$100 MILLION",
    "$5m",
    "$5b",
    "$1M",
    "$1B",
    "$0.5M",
    "$12.5M",
    "$5 K",
    "$1,000k",
    "~$100B",
    "$1T+ IPO",
    "$559M operating profit on $10.9B quarterly revenue",
    // money without suffix (rounded, cents dropped)
    "$4,200",
    "$4200.50",
    "$1",
    "$1.99",
    "$1.5",
    "$0.99",
    "$0",
    "$12",
    "$20",
    "$100",
    "$121",
    "$999",
    "$1000",
    "$1,000,000",
    "$1,437,000",
    "$1,234,567,890",
    "$ 500",
    "$19.99 each",
    "-$500",
    "$-5",
    "$4,200 and $200M",
    // bare counts with suffix
    "200M users",
    "1.5B",
    "1B monthly users",
    "3T",
    "12.5M",
    "10k",
    "5K",
    // commas and 4+ digit counts
    "14,166 views",
    "1,437,000 views",
    "14606 views",
    "1437.5",
    "1437.5 views",
    "1.5",
    "999",
    "1000",
    "1500",
    "2500 subscribers",
    "12345678",
    "1234567890",
    "1,23",
    "1,2345",
    // years
    "1899",
    "1900",
    "1999",
    "2026",
    "2099",
    "2100",
    "2026.5",
    "in 2026, 1,437,000 views",
    // negatives / mixed sentences
    "-1500",
    "minus 5000",
    "Reply to the sponsor email — $4,200 offer",
    "Freeform, not parsed — 1,437,000 views and $200M mentioned to trip nothing.",
    "Anthropic posts its first profit — $559M operating profit on $10.9B quarterly revenue.",
    "Version 2.0",
    "no numbers here",
    "",
  ];
  assert.ok(corpus.length >= 40);
  expectGolden(
    "dispatch/normalize-for-speech-corpus",
    Object.fromEntries(corpus.map((s) => [s, normalizeForSpeech(s)]))
  );
});

test("scrubRunSummary corpus: SAVED tails, jargon parentheticals, bare jargon, markdown chrome, file paths, spacing", async () => {
  const { scrubRunSummary } = await import("@/lib/spokenText");
  const corpus = [
    // SAVED tails
    "Morning briefing is ready — five headlines, Anthropic profit leads. SAVED inbox/reports/morning/2026-09-09-morning-report-deadbeef.md",
    "Done. SAVED path/to/file.md ",
    "SAVED inbox/x.md",
    "SAVED path.md then more",
    "saved lowercase/tail.md",
    // parentheticals with each jargon word
    "Fable 5 shipped this morning (headless).",
    "Ran it (autonomous run) fine.",
    "Finished (exit code 0) ok",
    "Finished (run id abc123) ok",
    "Finished (run_id: abc123) ok",
    "Finished (run-id abc123) ok",
    "Finished (runid abc123) ok",
    "Wrote it (deliverable: inbox/x.md)",
    "Report (see the deliverable in inbox/x.md)",
    "(headless) at start",
    "(no jargon here) stays",
    // bare jargon
    "Ran headless.",
    "Ran headlessly and autonomously.",
    "Autonomous run complete.",
    "Headless mode was used",
    "The headlessness of it",
    // markdown chrome
    "**Bold** and `code` and # heading and _under_",
    "## Title\n- item",
    // file paths, each extension, backslashes
    "inbox/reports/x.md is ready",
    "see system/runs/abc.json",
    "see docs/architecture.html",
    "see system/metrics/metrics.csv",
    "see C:\\Users\\me\\vault\\report.md",
    "see notes.md",
    "see inbox/x.txt",
    "see inbox/x.md.bak",
    "the file 2026-09-09/report.md was saved",
    "Path with-dash/and.dots/file.json here",
    "/abs/path/file.md",
    // spacing and punctuation
    "Double  spaces   here",
    "Spaced , punctuation ; here !",
    "  padded  ",
    "Nothing to scrub.",
    "",
  ];
  assert.ok(corpus.length >= 20);
  expectGolden(
    "dispatch/scrub-run-summary-corpus",
    Object.fromEntries(corpus.map((s) => [s, scrubRunSummary(s)]))
  );
});

test("humanizeFailure corpus: known shapes, unknown with [runner: …], plain text", async () => {
  const { humanizeFailure } = await import("@/lib/spokenText");
  const corpus = [
    "[runner: hard timeout 10m — killed]",
    "Hard Timeout",
    "hard timeout but also spawn error",
    "spawn error: ENOENT",
    "[runner: spawn error: EACCES]",
    "bad intent json",
    "unknown or invalid intent: foo",
    "Unknown Or Invalid Intent",
    "[runner: something weird happened] with (headless) extra",
    "[runner: exit 1]",
    "[RUNNER: uppercase] leftover",
    "[runner: a] and [runner: b] both",
    "[runner: unclosed bracket",
    "plain text failure",
    "Claude said no. SAVED x/y.md",
    "timeout without the word hard",
    "",
  ];
  expectGolden(
    "dispatch/humanize-failure-corpus",
    Object.fromEntries(corpus.map((s) => [s, humanizeFailure(s)]))
  );
});

// =============================================================================
// 5. skills
// =============================================================================

test("ALLOWED_SKILLS is a Set of exactly these six skills", async () => {
  const { ALLOWED_SKILLS } = await import("@/lib/skills");
  assert.ok(ALLOWED_SKILLS instanceof Set);
  expectGolden("dispatch/allowed-skills", [...ALLOWED_SKILLS].sort());
});

test("writeIntent file shape: {id, skill, args, ts, source} pretty-printed with no trailing newline; returns the id that names the file", async () => {
  const { writeIntent } = await import("@/lib/skills");
  const id = writeIntent("plan-today", "vault-hud", { prompt: "x", nested: { b: [1, 2] }, n: null });
  const file = path.join(QUEUE_DIR, `${id}.json`);
  assert.ok(fs.existsSync(file));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const raw = fs.readFileSync(file, "utf-8");
  expectGolden("dispatch/write-intent-shape", {
    returnedId: id,
    raw,
    parsed: JSON.parse(raw),
    tsIsFrozen: (JSON.parse(raw) as { ts: string }).ts === FROZEN_NOW_ISO,
  });
});

test("writeIntent default args is {} and unknown skills are NOT rejected here (runner re-validates)", async () => {
  const { writeIntent } = await import("@/lib/skills");
  const id = writeIntent("not-a-real-skill", "voice-wake");
  expectGolden("dispatch/write-intent-default-args", JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, `${id}.json`), "utf-8")));
});

test("writeIntent creates system/queue when it is missing", async () => {
  const { writeIntent } = await import("@/lib/skills");
  fs.rmSync(QUEUE_DIR, { recursive: true, force: true });
  assert.equal(fs.existsSync(QUEUE_DIR), false);
  const id = writeIntent("morning-report", "voice-ptt");
  assert.ok(fs.existsSync(QUEUE_DIR));
  expectGolden("dispatch/write-intent-creates-queue-dir", {
    files: fs.readdirSync(QUEUE_DIR),
    intent: JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, `${id}.json`), "utf-8")),
  });
});
