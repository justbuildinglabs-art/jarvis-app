// Gaps the adversarial review of the first suite pass identified as
// high-severity: behavior a refactor could break with every other golden
// still green. Kept in one file, with its own namespace, so it is obvious
// what these cases exist to defend.
//
//   1. pickEngine's engine preference and degradation chain. Every other
//      router golden runs under VOICE_ROUTER=rules, so route() only ever
//      walked the `pref === "rules"` line — and the engine chain is exactly
//      what the router refactor restructures.
//   2. The HUD_TZ "today" derivation in vault.ts. The fixture clock sits at
//      15:30Z, where the UTC date and the America/Chicago date agree, so no
//      golden observed the timezone actually being applied.
//   3. The identity linkage between the id dispatchTranscript returns, the
//      id inside the intent file, and the file's name — all three were
//      masked to <UUID> independently, so a refactor could return one id
//      and write another.
process.env.TZ = "America/Chicago";
import "./_util/env";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_ROOT, FROZEN_NOW_MS } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, IDS, PATHS } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

before(() => {
  buildFixtureVault();
  freezeClock();
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

// ---------------------------------------------------------------------------
// 1. pickEngine — preference and degradation
// ---------------------------------------------------------------------------
// homeEnv("VOICE_ROUTER") is read on every pickEngine() call, not at module
// load, so the preference can be flipped in-process. Neither a network nor a
// subprocess is needed to walk the whole chain: fetch is stubbed to reject
// (killing haiku and local), and CLAUDE_BIN already points at a nonexistent
// binary, so cliRoute dies on ENOENT. Every path must land on rulesRoute.

/** An utterance rulesRoute cannot answer, so it always sets fallthrough and
 *  the engine chain is actually consulted. */
const FALLTHROUGH = "what do you make of the sponsor situation this week";
/** An utterance rulesRoute answers outright — the chain must be skipped. */
const RULES_ANSWERS = "morning report";

async function routeUnder(
  pref: string,
  transcript: string,
  opts: { key?: boolean; fetchImpl?: typeof globalThis.fetch } = {}
) {
  const { route } = await import("@/lib/router");
  const prevPref = process.env.VOICE_ROUTER;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const realFetch = globalThis.fetch;

  process.env.VOICE_ROUTER = pref;
  if (opts.key) process.env.ANTHROPIC_API_KEY = "sk-ant-fixture-not-a-real-key";
  else delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = opts.fetchImpl ?? ((async () => {
    throw new Error("network disabled in tests");
  }) as unknown as typeof globalThis.fetch);

  try {
    return await route(transcript);
  } finally {
    globalThis.fetch = realFetch;
    if (prevPref === undefined) delete process.env.VOICE_ROUTER;
    else process.env.VOICE_ROUTER = prevPref;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
}

test("pickEngine — every preference degrades to the rules engine when no model answers", async () => {
  const prefs = ["auto", "rules", "haiku", "local", "cli", "AUTO", "nonsense", ""];
  const out: Record<string, unknown> = {};
  for (const pref of prefs) {
    out[`${pref || "(empty)"} · fallthrough utterance`] = await routeUnder(pref, FALLTHROUGH);
    out[`${pref || "(empty)"} · rules answers outright`] = await routeUnder(pref, RULES_ANSWERS);
  }
  expectGolden("gaps/pickengine-degradation", out);
});

test("pickEngine — auto only reaches for Haiku when a key exists", async () => {
  const calls: string[] = [];
  const spyFetch = (async (url: unknown) => {
    calls.push(String(url).replace(/\?.*$/, ""));
    throw new Error("network disabled in tests");
  }) as unknown as typeof globalThis.fetch;

  calls.length = 0;
  await routeUnder("auto", FALLTHROUGH, { key: false, fetchImpl: spyFetch });
  const withoutKey = [...calls];

  calls.length = 0;
  await routeUnder("auto", FALLTHROUGH, { key: true, fetchImpl: spyFetch });
  const withKey = [...calls];

  // Without a key the anthropic endpoint must never be contacted; with one it
  // is tried first, then the local model. (The warmup ping is suppressed by
  // VOICE_NO_WARMUP, so every call here comes from routing itself.)
  assert.equal(
    withoutKey.some((u) => u.includes("api.anthropic.com")),
    false,
    "no key must mean no Anthropic call"
  );
  assert.equal(withKey.some((u) => u.includes("api.anthropic.com")), true);
  expectGolden("gaps/pickengine-fetch-targets", { withoutKey, withKey });
});

test("pickEngine — a model engine that answers is preferred over rules", async () => {
  // A stub Ollama that returns a well-formed routing decision proves the
  // local engine's result is actually used (and validated) rather than
  // discarded in favour of the rules answer.
  // Match on the Ollama route, not the host: env.ts pins OLLAMA_URL at an
  // unreachable 127.0.0.1:1, so the real port never appears.
  const okLocal = (async (url: unknown) => {
    if (!String(url).includes("/api/chat")) throw new Error("network disabled in tests");
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            tier: 2,
            reply: "The sponsor thread is still open.",
            panels: ["documents", "not-a-real-panel"],
          }),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof globalThis.fetch;

  const answered = await routeUnder("local", FALLTHROUGH, { fetchImpl: okLocal });
  assert.equal(answered.engine, "local");

  // A tier-1 decision naming an unknown skill must be rejected by
  // validateRouted and fall back to rules.
  const badSkill = (async (url: unknown) => {
    if (!String(url).includes("/api/chat")) throw new Error("network disabled in tests");
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify({ tier: 1, skill: "not-a-skill", reply: "ok" }) } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof globalThis.fetch;
  const rejected = await routeUnder("local", FALLTHROUGH, { fetchImpl: badSkill });

  // A non-200 from Ollama is an error, not an answer.
  const http500 = (async (url: unknown) => {
    if (!String(url).includes("/api/chat")) throw new Error("network disabled in tests");
    return new Response("nope", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  const errored = await routeUnder("local", FALLTHROUGH, { fetchImpl: http500 });

  expectGolden("gaps/pickengine-local-answers", { answered, rejected, errored });
});

test("pickEngine — the in-flight guard still applies to a model engine's answer", async () => {
  // inbox-brief is running in the fixture, so a model engine dispatching it
  // must be converted to the tier-2 "already running" reply.
  const dispatchInbox = (async (url: unknown) => {
    if (!String(url).includes("/api/chat")) throw new Error("network disabled in tests");
    return new Response(
      JSON.stringify({
        message: { content: JSON.stringify({ tier: 1, skill: "inbox-brief", reply: "On it." }) },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof globalThis.fetch;
  const guarded = await routeUnder("local", "go look at my email situation", { fetchImpl: dispatchInbox });
  expectGolden("gaps/pickengine-inflight-guard", guarded);
});

// ---------------------------------------------------------------------------
// 2. HUD_TZ actually applied
// ---------------------------------------------------------------------------
// At 15:30Z the UTC date and the Chicago date are both 2026-09-09, so the
// existing goldens cannot tell Intl.DateTimeFormat(HUD_TZ) from toISOString().
// These cases move the clock to instants where the two disagree.

test("readDailyNote / readMorningReport / toggleTop3 use HUD_TZ, not UTC", async () => {
  const { readDailyNote, readMorningReport, toggleTop3 } = await import("@/lib/vault");

  const probe = (label: string, utcMs: number) => {
    thawClock();
    freezeClock(utcMs);
    const daily = readDailyNote();
    const morning = readMorningReport();
    return {
      label,
      utc: new Date(utcMs).toISOString(),
      utcDate: new Date(utcMs).toISOString().slice(0, 10),
      chicagoDate: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(utcMs)),
      dailyDate: daily?.date ?? null,
      dailyIsToday: daily?.isToday ?? null,
      morningRel: morning?.rel ?? null,
    };
  };

  const out = [
    // 20:30 CDT Sep 9 — UTC has already rolled to Sep 10. Chicago has not,
    // so today's note and today's morning report must still resolve.
    probe("2026-09-09 20:30 CDT (UTC is Sep 10)", Date.UTC(2026, 8, 10, 1, 30)),
    // 23:59 CDT Sep 9 — the last minute of the local day.
    probe("2026-09-09 23:59 CDT (UTC is Sep 10)", Date.UTC(2026, 8, 10, 4, 59)),
    // 00:30 CDT Sep 10 — the local day has rolled; the Sep 9 note is now
    // history and isToday must go false.
    probe("2026-09-10 00:30 CDT", Date.UTC(2026, 8, 10, 5, 30)),
    // 06:00 UTC Sep 9 = 01:00 CDT Sep 9 — UTC and local agree again.
    probe("2026-09-09 01:00 CDT", Date.UTC(2026, 8, 9, 6, 0)),
  ];
  expectGolden("gaps/hud-tz-today-derivation", out);

  // toggleTop3 writes only to TODAY's note, so it must follow the same
  // derivation: still writable at 20:30 CDT, refused once the local day rolls.
  thawClock();
  freezeClock(Date.UTC(2026, 8, 10, 1, 30)); // 20:30 CDT Sep 9
  const eveningWrite = toggleTop3(1, true);
  const afterEvening = fs.readFileSync(path.join(FIXTURE_ROOT, PATHS.dailyToday), "utf-8");

  thawClock();
  freezeClock(Date.UTC(2026, 8, 10, 5, 30)); // 00:30 CDT Sep 10 — no note for that date
  const nextDayWrite = toggleTop3(1, false);
  const afterNextDay = fs.readFileSync(path.join(FIXTURE_ROOT, PATHS.dailyToday), "utf-8");

  expectGolden("gaps/hud-tz-toggle-window", {
    eveningWrite,
    nextDayWrite,
    noteUnchangedAcrossRolledDay: afterEvening === afterNextDay,
    top3AfterEveningWrite: afterEvening
      .split("\n")
      .filter((l) => /^\d+\. \[/.test(l)),
  });

  thawClock();
  freezeClock();
  buildFixtureVault(); // undo the write for any later file-order dependency
});

// ---------------------------------------------------------------------------
// 3. Intent id linkage
// ---------------------------------------------------------------------------
// Each of payload.queued, the intent file's `id` field and the file's name
// was masked to <UUID> independently, so nothing proved they are the same
// value. Assert the identity directly rather than pinning three masks.

function newestIntent(): { file: string; parsed: Record<string, unknown> } {
  const dir = path.join(FIXTURE_ROOT, "system", "queue");
  const fixtureIds = new Set<string>(Object.values(IDS));
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !fixtureIds.has(f.replace(/\.json$/, "")))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  assert.ok(files.length > 0, "no new intent file was written");
  const file = files[0].f;
  return { file, parsed: JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) };
}

function clearNewIntents(): void {
  const dir = path.join(FIXTURE_ROOT, "system", "queue");
  const fixtureIds = new Set<string>(Object.values(IDS));
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json") && !fixtureIds.has(f.replace(/\.json$/, ""))) {
      fs.rmSync(path.join(dir, f));
    }
  }
}

test("the id dispatchTranscript returns is the id in the file it wrote, and names it", async () => {
  const { dispatchTranscript } = await import("@/lib/voiceDispatch");

  const cases = [
    { name: "tier-1 alias", transcript: "morning report", source: "voice-ptt" },
    { name: "tier-3 voice ask", transcript: "summarize my week in three bullets", source: "voice-wake" },
    { name: "tier-3 with model override", transcript: "use opus summarize my week in three bullets", source: "voice-ptt" },
  ];

  const shapes: Record<string, unknown> = {};
  for (const c of cases) {
    clearNewIntents();
    const payload = await dispatchTranscript(c.transcript, c.source);
    assert.ok(payload.queued, `${c.name}: expected an intent to be queued`);
    const { file, parsed } = newestIntent();

    // the three identities that were independently masked
    assert.equal(parsed.id, payload.queued, `${c.name}: file id must equal the returned id`);
    assert.equal(file, `${payload.queued}.json`, `${c.name}: file must be named by the returned id`);
    assert.match(String(payload.queued), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    shapes[c.name] = {
      fileNamedByReturnedId: file === `${payload.queued}.json`,
      fileIdMatchesReturnedId: parsed.id === payload.queued,
      skill: parsed.skill,
      source: parsed.source,
      ts: parsed.ts,
      argKeys: Object.keys((parsed.args ?? {}) as Record<string, unknown>).sort(),
    };
  }
  expectGolden("gaps/intent-id-linkage", shapes);

  // Each dispatch gets its own id. Note the skills must DIFFER: skillInFlight
  // counts anything already sitting in the queue, so asking twice for the same
  // skill is deliberately refused by the in-flight guard (pinned below).
  clearNewIntents();
  const a = await dispatchTranscript("morning report", "voice-ptt");
  const b = await dispatchTranscript("triage today", "voice-ptt");
  assert.notEqual(a.queued, b.queued, "each dispatch gets its own id");
  const dir = path.join(FIXTURE_ROOT, "system", "queue");
  assert.ok(fs.existsSync(path.join(dir, `${a.queued}.json`)));
  assert.ok(fs.existsSync(path.join(dir, `${b.queued}.json`)));
  clearNewIntents();
});

test("writeIntent's returned id is the file's id and its name", async () => {
  const { writeIntent } = await import("@/lib/skills");
  clearNewIntents();
  const id = writeIntent("vault-cleanup", "unit-test", { note: "linkage" });
  const { file, parsed } = newestIntent();
  assert.equal(file, `${id}.json`);
  assert.equal(parsed.id, id);
  expectGolden("gaps/write-intent-linkage", {
    fileNamedById: file === `${id}.json`,
    idFieldMatches: parsed.id === id,
    body: { ...parsed, id: "<SAME-AS-FILENAME>" },
  });
  clearNewIntents();
});

// ---------------------------------------------------------------------------
// 4. whisper_lock nesting (voice server)
// ---------------------------------------------------------------------------
// The Python contract suite records `with` statements and calls as flat
// lists, so moving the segment-consuming join OUT of the `with whisper_lock`
// block left every golden byte-identical. The lock is load-bearing: segments
// is a lazy generator, and decoding outside the lock races the wake thread.
// Pin the nesting textually instead.

test("whisper segments are consumed inside the whisper_lock block", () => {
  // The lock blocks moved out of server.py when the voice server became a
  // package: one in jarvis_voice/runtime.py (the wake path), one in
  // jarvis_voice/app.py (the /stt route). Scan both — what is asserted is
  // unchanged.
  const VOICE = path.resolve(process.cwd(), "voice-server", "jarvis_voice");
  const src = ["runtime.py", "app.py"]
    .map((f) => fs.readFileSync(path.join(VOICE, f), "utf-8"))
    .join("\n\n");
  const lines = src.split("\n");

  const blocks: { fn: string; lockIndent: number; body: string[] }[] = [];
  let currentFn = "(module)";
  for (let i = 0; i < lines.length; i++) {
    const fnMatch = lines[i].match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (fnMatch) currentFn = fnMatch[1];
    const lockMatch = lines[i].match(/^(\s*)with\s+whisper_lock\s*:/);
    if (!lockMatch) continue;
    const lockIndent = lockMatch[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        body.push("");
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= lockIndent) break;
      body.push(line.slice(lockIndent));
    }
    blocks.push({ fn: currentFn, lockIndent, body });
  }

  assert.equal(blocks.length, 2, "expected exactly two whisper_lock blocks");
  for (const b of blocks) {
    const joined = b.body.join("\n");
    assert.match(joined, /whisper\.transcribe\(/, `${b.fn}: transcribe must be inside the lock`);
    assert.match(
      joined,
      /" "\.join\(s\.text\.strip\(\) for s in segments\)/,
      `${b.fn}: the generator must be CONSUMED inside the lock, not merely created`
    );
  }
  expectGolden(
    "gaps/whisper-lock-blocks",
    blocks.map((b) => ({ fn: b.fn, body: b.body.map((l) => l.replace(/\s+$/, "")) }))
  );
});

test("a queued intent blocks a second dispatch of the same skill", async () => {
  // skillInFlight() counts the QUEUE, not just running runs, so the guard
  // fires on an intent the runner has not picked up yet. Worth pinning
  // explicitly: it is the difference between one morning report and two.
  const { dispatchTranscript } = await import("@/lib/voiceDispatch");
  clearNewIntents();

  const first = await dispatchTranscript("morning report", "voice-ptt");
  const second = await dispatchTranscript("morning report", "voice-ptt");
  const explicitRerun = await dispatchTranscript("run morning report again", "voice-ptt");

  assert.ok(first.queued, "the first ask queues");
  assert.equal(second.queued, null, "the second is refused while one is queued");
  assert.ok(explicitRerun.queued, "an explicit repeat is allowed through");

  expectGolden("gaps/queued-blocks-redispatch", {
    first: { tier: first.tier, skill: first.skill, queued: first.queued ? "<UUID>" : null, reply: first.reply },
    second: { tier: second.tier, skill: second.skill, queued: second.queued, reply: second.reply },
    explicitRerun: {
      tier: explicitRerun.tier,
      skill: explicitRerun.skill,
      queued: explicitRerun.queued ? "<UUID>" : null,
      reply: explicitRerun.reply,
    },
  });
  clearNewIntents();
});
