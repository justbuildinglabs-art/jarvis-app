// Characterization suite for the eight Next route handlers under app/api/**.
// Every handler is invoked directly (no HTTP server) with a WHATWG Request and
// the full response — status, the three headers the HUD client reads, and the
// parsed body — is pinned as a golden, plus every side effect on the vault
// (intent files, memory lines, the mutated daily note).
//
// Namespace: api/. Run: node --import tsx --test tests/api.test.ts
//
// Ordering matters in the last two describe blocks: lib/tts.ts and lib/stt.ts
// each keep a module-level health-probe cache keyed off Date.now() (dead
// servers are re-probed after 5 s, live ones after 30 s). Date is frozen, so
// those caches never expire on their own — the tests tick the clock
// explicitly and assert the offset they expect to run at, so a reordering
// fails loudly instead of silently changing which calls re-probe.
import "./_util/env"; // FIRST — pins HOME/VAULT_ROOT/VOICE_* before any lib loads
import fs from "node:fs";
import path from "node:path";
import { test, describe, before, after, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_ROOT, FROZEN_NOW_MS, TODAY } from "./_util/env";
import { freezeClock, thawClock, tickClock } from "./_util/clock";
import {
  buildFixtureVault,
  destroyFixtureVault,
  removeTodayNote,
  readFixtureFile,
  listFixtureDir,
  FIXTURE_IDS,
  IDS,
  PATHS,
} from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

// hhmm() in app/api/transcript/route.ts formats with toLocaleTimeString in the
// PROCESS timezone (not HUD_TZ), so the transcript golden depends on TZ. Pin
// it to the HUD's zone. This is the first statement of the module body; the
// imports above are hoisted anyway and none of them formats a local time at
// load, so the assignment is effectively "before anything else".
process.env.TZ = "America/Chicago";

before(() => {
  buildFixtureVault();
  freezeClock();
});
// every test starts from a pristine vault — handlers mutate it (queue writes,
// memory lines, the daily note) and the goldens pin each mutation in isolation
beforeEach(() => {
  buildFixtureVault();
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

// --- request / response helpers -----------------------------------------------

const BASE = "http://localhost";

interface Snap {
  status: number;
  headers: { "content-type": string | null; "cache-control": string | null; "x-voice-engine": string | null };
  body: unknown;
}

/** status + the three headers the client reads + body (JSON parsed when the
 *  content-type says so, else the raw text — audio streams are fake bytes). */
async function snap(res: Response): Promise<Snap> {
  const ct = res.headers.get("content-type");
  const text = await res.text();
  let body: unknown = text;
  if (ct && /json/.test(ct)) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    headers: {
      "content-type": ct,
      "cache-control": res.headers.get("cache-control"),
      "x-voice-engine": res.headers.get("x-voice-engine"),
    },
    body,
  };
}

function jsonReq(p: string, body: unknown, method = "POST"): Request {
  return new Request(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawReq(p: string, body: string, method = "POST"): Request {
  return new Request(`${BASE}${p}`, { method, headers: { "content-type": "application/json" }, body });
}

function get(p: string): Request {
  return new Request(`${BASE}${p}`);
}

// explicit ArrayBuffer backing so the typed array satisfies BodyInit under TS 5.7+
const clip = (bytes: number): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(bytes)).fill(7);

function audioReq(bytes: Uint8Array<ArrayBuffer>, contentType?: string): Request {
  return new Request(`${BASE}/api/voice`, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body: bytes,
  });
}

// --- vault side-effect helpers --------------------------------------------------

/** intent files that were not part of the fixture (i.e. written by the call) */
function newIntents(): { file: string; intent: unknown }[] {
  return listFixtureDir("system/queue")
    .filter((f) => !FIXTURE_IDS.has(f.replace(/\.json$/, "")))
    .map((f) => ({ file: f, intent: JSON.parse(readFixtureFile(`system/queue/${f}`)) as unknown }));
}

/** memory.jsonl as it sits on disk, each line parsed when it is JSON */
function memoryLines(): unknown[] {
  const abs = path.join(FIXTURE_ROOT, PATHS.memory);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return `<unparseable> ${l}`;
      }
    });
}

function writeFixture(rel: string, content: string): void {
  const abs = path.join(FIXTURE_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

// --- fetch stubbing (the only network the handlers ever touch) --------------------

type Handler = () => Response;
interface FakeVoiceServer {
  health?: Handler;
  speak?: Handler;
  stt?: Handler;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** byte length of a binary body, or null */
  bodyBytes: number | null;
  signal: boolean;
  /** decoded ?text= of a /speak call — the normalizeForSpeech'd utterance */
  speakText?: string | null;
}

function describeCall(args: unknown[]): FetchCall {
  const [input, init] = args as [RequestInfo | URL, RequestInit | undefined];
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
  const body = init?.body;
  const call: FetchCall = {
    url,
    method: init?.method ?? "GET",
    headers,
    bodyBytes: body instanceof Uint8Array ? body.byteLength : null,
    signal: Boolean(init?.signal),
  };
  if (url.includes("/speak?")) call.speakText = new URL(url).searchParams.get("text");
  return call;
}

interface FetchSpy {
  calls: () => FetchCall[];
  count: () => number;
}

/** Replace global fetch with a fake voice-server. Paths without a handler
 *  reject the way undici does on ECONNREFUSED (TypeError: fetch failed).
 *  Restored automatically when the test ends (t.mock). */
function stubFetch(t: TestContext, fake: FakeVoiceServer): FetchSpy {
  const m = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const table: Record<string, Handler | undefined> = {
      "/health": fake.health,
      "/speak": fake.speak,
      "/stt": fake.stt,
    };
    const h = table[url.pathname];
    if (!h) throw new TypeError("fetch failed");
    return h();
  });
  return { calls: () => m.mock.calls.map((c) => describeCall(c.arguments as unknown[])), count: () => m.mock.callCount() };
}

/** Pass-through spy — the REAL fetch runs (against the pinned unreachable
 *  VOICE_SERVER_URL, http://127.0.0.1:1) and the calls are recorded. */
function spyFetch(t: TestContext): FetchSpy {
  const m = t.mock.method(globalThis, "fetch");
  return { calls: () => m.mock.calls.map((c) => describeCall(c.arguments as unknown[])), count: () => m.mock.callCount() };
}

const DOWN: FakeVoiceServer = {}; // every path rejects
const WAV = "RIFF-fake-wav-bytes";
const liveHealth: Handler = () => Response.json({ ok: true, tts: { ok: true }, stt: { ok: true } });
const liveSpeak: Handler = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(WAV));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "audio/wav" } }
  );
const sttSays =
  (text: string): Handler =>
  () =>
    Response.json({ text });
const LIVE: FakeVoiceServer = { health: liveHealth, speak: liveSpeak };

/** The cache-sensitive sections are order-dependent — fail loudly on drift. */
function atOffset(ms: number): void {
  assert.equal(
    Date.now(),
    FROZEN_NOW_MS + ms,
    `expected the frozen clock at T0+${ms}ms — the voice-server tests depend on their order (tts/stt probe caches)`
  );
}

// =============================================================================
// /api/state
// =============================================================================

describe("/api/state", () => {
  test("GET returns the whole vault snapshot as JSON with Cache-Control: no-store", async () => {
    const { GET } = await import("@/app/api/state/route");
    const res = await snap(await GET());
    assert.equal(res.status, 200);
    expectGolden("api/state-get", res);
  });
});

// =============================================================================
// /api/daily — flip a Top 3 checkbox in today's note
// =============================================================================

describe("/api/daily", () => {
  async function post(body: unknown): Promise<Snap> {
    const { POST } = await import("@/app/api/daily/route");
    const req = typeof body === "string" ? rawReq("/api/daily", body) : jsonReq("/api/daily", body);
    return snap(await POST(req));
  }
  const note = () => readFixtureFile(PATHS.dailyToday);

  test("invalid JSON body → 400 bad body", async () => {
    expectGolden("api/daily-bad-json", await post("{not json"));
  });

  test("fractional index → 400", async () => {
    expectGolden("api/daily-index-fraction", await post({ index: 1.5, done: true }));
  });

  test("index -1 → 400", async () => {
    expectGolden("api/daily-index-negative", await post({ index: -1, done: true }));
  });

  test("index 3 → 400 (only three checkboxes are recognized)", async () => {
    expectGolden("api/daily-index-out-of-range", await post({ index: 3, done: true }));
  });

  test("done that is not a boolean → 400", async () => {
    expectGolden("api/daily-done-string", await post({ index: 1, done: "true" }));
  });

  test("index missing → 400 (Number(undefined) is NaN)", async () => {
    expectGolden("api/daily-index-missing", await post({ done: true }));
  });

  test("valid body but today's note removed → 404, the older note is left alone", async () => {
    removeTodayNote();
    expectGolden("api/daily-no-today-note", await post({ index: 0, done: true }));
    expectGolden("api/daily-no-today-note-older-untouched", readFixtureFile(PATHS.dailyOlder));
  });

  test("valid {index:1, done:true} → 200 {ok:true} and the second checkbox flips to [x]", async () => {
    expectGolden("api/daily-toggle-1-done", await post({ index: 1, done: true }));
    expectGolden("api/daily-toggle-1-done-note", note());
  });

  test("valid {index:0, done:false} un-checks the first item", async () => {
    expectGolden("api/daily-toggle-0-undone", await post({ index: 0, done: false }));
    expectGolden("api/daily-toggle-0-undone-note", note());
  });

  test("re-marking an already-done item still rewrites the note and returns 200", async () => {
    const before = note();
    expectGolden("api/daily-toggle-0-done-again", await post({ index: 0, done: true }));
    assert.equal(note(), before);
  });

  test("quirk: a string index (\"2\") is coerced by Number() and accepted", async () => {
    expectGolden("api/daily-index-string", await post({ index: "2", done: true }));
    expectGolden("api/daily-index-string-note", note());
  });

  test("quirk: index null coerces to 0 and flips the FIRST checkbox", async () => {
    expectGolden("api/daily-index-null", await post({ index: null, done: false }));
    expectGolden("api/daily-index-null-note", note());
  });

  test("a CRLF note keeps CRLF line endings after the flip", async () => {
    writeFixture(PATHS.dailyToday, note().replace(/\n/g, "\r\n"));
    const res = await post({ index: 2, done: true });
    const raw = note();
    expectGolden("api/daily-crlf", {
      response: res,
      hasCrlf: raw.includes("\r\n"),
      hasBareLf: /[^\r]\n/.test(raw),
      lines: raw.split("\r\n"),
    });
  });
});

// =============================================================================
// /api/queue — drop an intent for the runner
// =============================================================================

const SKILLS = ["morning-report", "inbox-brief", "plan-today", "plan-tomorrow", "vault-cleanup", "voice-ask"];

describe("/api/queue", () => {
  async function post(body: unknown): Promise<Snap> {
    const { POST } = await import("@/app/api/queue/route");
    const req = typeof body === "string" ? rawReq("/api/queue", body) : jsonReq("/api/queue", body);
    return snap(await POST(req));
  }

  test("ALLOWED_SKILLS is exactly the six skills this suite enumerates", async () => {
    const { ALLOWED_SKILLS } = await import("@/lib/skills");
    assert.deepEqual([...ALLOWED_SKILLS], SKILLS);
    expectGolden("api/queue-allowed-skills", [...ALLOWED_SKILLS]);
  });

  test("invalid JSON → 400 bad json, nothing queued", async () => {
    expectGolden("api/queue-bad-json", await post("{nope"));
    assert.deepEqual(newIntents(), []);
  });

  test("unknown skill → 400 with the skill echoed", async () => {
    expectGolden("api/queue-unknown-skill", await post({ skill: "github-trending" }));
    assert.deepEqual(newIntents(), []);
  });

  test("missing skill → 400 'unknown skill: ' (empty echo)", async () => {
    expectGolden("api/queue-missing-skill", await post({}));
    assert.deepEqual(newIntents(), []);
  });

  for (const skill of SKILLS) {
    test(`{skill:"${skill}"} → 200 {ok,id,skill} and <id>.json lands in system/queue with source vault-hud`, async () => {
      const res = await post({ skill });
      assert.equal(res.status, 200);
      const [written, ...rest] = newIntents();
      assert.equal(rest.length, 0, "exactly one intent written");
      const body = res.body as { id: string };
      assert.equal(written.file, `${body.id}.json`);
      expectGolden(`api/queue-${skill}`, {
        response: res,
        intentFile: written.file,
        intentRaw: readFixtureFile(`system/queue/${written.file}`),
        intent: written.intent,
      });
    });
  }
});

// =============================================================================
// /api/report — serve a vault markdown deliverable
// =============================================================================

describe("/api/report", () => {
  async function fetchReport(query: string): Promise<Snap> {
    const { GET } = await import("@/app/api/report/route");
    return snap(await GET(get(`/api/report${query}`)));
  }

  test("no ?path → 400 path required", async () => {
    expectGolden("api/report-missing-path", await fetchReport(""));
  });

  test("empty ?path= → 400 (same as missing)", async () => {
    expectGolden("api/report-empty-path", await fetchReport("?path="));
  });

  test("traversal (inbox/../../x.md) → 404", async () => {
    expectGolden("api/report-traversal", await fetchReport("?path=inbox/../../etc/passwd.md"));
  });

  test("non-.md under a readable prefix → 404", async () => {
    writeFixture("inbox/notes.txt", "plain text");
    expectGolden("api/report-not-md", await fetchReport("?path=inbox/notes.txt"));
  });

  test(".md outside inbox/ and system/runs/ (daily note) → 404", async () => {
    expectGolden("api/report-outside-prefix", await fetchReport(`?path=daily-notes/${TODAY}.md`));
  });

  test("missing file → 404 not found or not readable", async () => {
    expectGolden("api/report-not-found", await fetchReport("?path=inbox/reports/morning/nope.md"));
  });

  test("today's morning report → 200 {path, content}", async () => {
    expectGolden("api/report-ok-morning", await fetchReport(`?path=${PATHS.morningToday}`));
  });

  test("a run log under system/runs/ → 200", async () => {
    expectGolden("api/report-ok-run-md", await fetchReport(`?path=system/runs/${IDS.runVoiceAskLinked}.md`));
  });

  test("quirk: backslash separators are accepted and echoed back unchanged in `path`", async () => {
    const bs = PATHS.cleanupOld.replace(/\//g, "\\");
    expectGolden("api/report-backslash-path", await fetchReport(`?path=${encodeURIComponent(bs)}`));
  });

  test("quirk: an empty .md file is served as 200 with content \"\" (only null means missing)", async () => {
    writeFixture("inbox/empty.md", "");
    expectGolden("api/report-empty-file", await fetchReport("?path=inbox/empty.md"));
  });
});

// =============================================================================
// /api/transcript — memory.jsonl composed as markdown
// =============================================================================

describe("/api/transcript", () => {
  async function getTranscript(): Promise<Snap> {
    const { GET } = await import("@/app/api/transcript/route");
    return snap(await GET());
  }
  async function del(): Promise<Snap> {
    const { DELETE } = await import("@/app/api/transcript/route");
    return snap(await DELETE());
  }

  test("GET composes the fixture memory chronologically (malformed line skipped, times in process TZ)", async () => {
    const res = await getTranscript();
    expectGolden("api/transcript-fixture", res);
    expectGolden("api/transcript-fixture-content", (res.body as { content: string }).content);
  });

  test("GET with an empty memory file → placeholder line", async () => {
    writeFixture(PATHS.memory, "");
    expectGolden("api/transcript-empty-file", await getTranscript());
  });

  test("GET with no memory file at all → same placeholder", async () => {
    fs.rmSync(path.join(FIXTURE_ROOT, PATHS.memory));
    expectGolden("api/transcript-no-file", await getTranscript());
  });

  test("GET with only garbage lines → placeholder", async () => {
    writeFixture(PATHS.memory, "{nope\n\n  \nalso not json\n");
    expectGolden("api/transcript-only-garbage", await getTranscript());
  });

  test("DELETE truncates memory.jsonl to empty and a following GET shows the placeholder", async () => {
    expectGolden("api/transcript-delete", await del());
    assert.equal(readFixtureFile(PATHS.memory), "");
    expectGolden("api/transcript-after-delete", await getTranscript());
  });

  test("DELETE when system/voice/ does not exist still answers {ok:true} and creates nothing", async () => {
    fs.rmSync(path.join(FIXTURE_ROOT, "system", "voice"), { recursive: true, force: true });
    expectGolden("api/transcript-delete-no-dir", await del());
    assert.equal(fs.existsSync(path.join(FIXTURE_ROOT, "system", "voice")), false);
  });

  test("quirk: the day header is the UTC date of ts while the time is local — an evening exchange files under tomorrow", async () => {
    const lines = [
      JSON.stringify({ ts: "2026-09-08T23:45:00.000Z", you: "still the 8th here", jarvis: "6:45 PM Chicago", tier: 2 }),
      JSON.stringify({ ts: "2026-09-09T02:30:00.000Z", you: "late night ask", jarvis: "9:30 PM on the 8th locally, header says the 9th", tier: 3, skill: "voice-ask" }),
      JSON.stringify({ ts: "2026-09-09T15:00:00.000Z", you: "morning", jarvis: "10:00 AM", tier: 2 }),
    ];
    writeFixture(PATHS.memory, lines.join("\n") + "\n");
    const res = await getTranscript();
    expectGolden("api/transcript-utc-day-split", (res.body as { content: string }).content);
  });
});

// =============================================================================
// /api/voice/text — wake-word transcripts → shared dispatch
// =============================================================================

describe("/api/voice/text", () => {
  async function post(body: unknown): Promise<Snap> {
    const { POST } = await import("@/app/api/voice/text/route");
    const req = typeof body === "string" ? rawReq("/api/voice/text", body) : jsonReq("/api/voice/text", body);
    return snap(await POST(req));
  }
  /** response + every vault side effect of one dispatch */
  async function dispatch(transcript: unknown) {
    const response = await post({ transcript });
    return { response, intents: newIntents(), memory: memoryLines() };
  }

  test("invalid JSON → 400 no transcript", async () => {
    expectGolden("api/voice-text-bad-json", await post("{nope"));
    assert.deepEqual(newIntents(), []);
  });

  test("missing transcript → 400", async () => {
    expectGolden("api/voice-text-missing", await post({}));
  });

  test("whitespace-only transcript → 400 (trimmed before the check)", async () => {
    expectGolden("api/voice-text-blank", await post({ transcript: "   \n " }));
  });

  test("1001 characters → 413 transcript too long, nothing dispatched", async () => {
    const r = await dispatch("x".repeat(1001));
    expectGolden("api/voice-text-1001", r.response);
    assert.deepEqual(r.intents, []);
    assert.equal(r.memory.length, 5, "no memory line written");
  });

  test("exactly 1000 characters (after trim) is accepted and dispatched as a voice-ask", async () => {
    const t1000 = "summarize my week in detail ".repeat(40).slice(0, 1000);
    assert.equal(t1000.trim().length, 1000);
    const r = await dispatch(`  ${t1000}  `);
    assert.equal(r.response.status, 200);
    expectGolden("api/voice-text-1000", r);
  });

  test("tier 1: bare alias 'morning report' → dispatch ack, intent (source voice-wake), memory line", async () => {
    const r = await dispatch("morning report");
    assert.equal((r.response.body as { tier: number }).tier, 1);
    assert.equal(r.intents.length, 1);
    expectGolden("api/voice-text-tier1-morning-report", r);
  });

  test("tier 2: dashboard question \"what's in the queue\" answers from state, no intent", async () => {
    const r = await dispatch("what's in the queue");
    assert.equal((r.response.body as { tier: number }).tier, 2);
    assert.deepEqual(r.intents, []);
    expectGolden("api/voice-text-tier2-queue", r);
  });

  test("tier 3: a ≥3-word open ask queues voice-ask with the prompt and conversation context", async () => {
    const r = await dispatch("summarize my week in three bullets");
    assert.equal(r.intents.length, 1);
    expectGolden("api/voice-text-tier3-ask", r);
  });

  test("tier 3: a 2-word fragment queues nothing and says it didn't catch enough", async () => {
    const r = await dispatch("fable news");
    assert.deepEqual(r.intents, []);
    expectGolden("api/voice-text-tier3-two-words", r);
  });

  test("'use opus …' strips the phrase, queues voice-ask with args.model, and acks the model by name", async () => {
    const r = await dispatch("use opus summarize my week");
    assert.equal(r.intents.length, 1);
    expectGolden("api/voice-text-model-override", r);
  });

  test("'yes' to the standing inbox-audit offer is rerouted by the in-flight guard (inbox brief already queued+running)", async () => {
    const r = await dispatch("yes");
    assert.deepEqual(r.intents, []);
    expectGolden("api/voice-text-affirm-offer-in-flight", r);
  });

  test("'no' to the standing offer → Standing by", async () => {
    expectGolden("api/voice-text-decline-offer", await dispatch("no thanks"));
  });

  test("'give me the rundown' → the spoken briefing with deliverable, panels and reveals", async () => {
    const r = await dispatch("give me the rundown");
    assert.deepEqual(r.intents, []);
    expectGolden("api/voice-text-rundown", r);
  });

  test("quirk: 'show me the morning report' opens the voice-ask doc (its summary contains 'morning' and it is newer)", async () => {
    const r = await dispatch("show me the morning report");
    expectGolden("api/voice-text-open-doc", r);
  });

  test("quirk: a numeric transcript is String()-coerced and routed as a one-word fragment", async () => {
    expectGolden("api/voice-text-numeric", await dispatch(123));
  });

  test("greeting is answered as smalltalk from state (runner busy, open goals)", async () => {
    expectGolden("api/voice-text-greeting", await dispatch("hey what's up"));
  });
});

// =============================================================================
// /api/voice + /api/speak with the voice-server DOWN
// Clock timeline (T0 = FROZEN_NOW_MS): T0 → T0+5s → T0+10s. Each probe of a
// dead server is cached for 5 000 ms; the clock is frozen, so a re-probe only
// happens when the tests tick past the cache.
// =============================================================================

describe("/api/speak and /api/voice with the voice-server unreachable", () => {
  async function speakGet(query: string): Promise<Snap> {
    const { GET } = await import("@/app/api/speak/route");
    return snap(await GET(get(`/api/speak${query}`)));
  }
  async function speakPost(body: unknown): Promise<Snap> {
    const { POST } = await import("@/app/api/speak/route");
    const req = typeof body === "string" ? rawReq("/api/speak", body) : jsonReq("/api/speak", body);
    return snap(await POST(req));
  }
  async function voicePost(bytes: Uint8Array<ArrayBuffer>, contentType?: string): Promise<Snap> {
    const { POST } = await import("@/app/api/voice/route");
    return snap(await POST(audioReq(bytes, contentType)));
  }

  test("GET /api/speak (probe) → one /health fetch → 503 no TTS engine available", async (t) => {
    atOffset(0);
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-probe-down", await speakGet(""));
    expectGolden("api/speak-probe-down-fetch", f.calls());
  });

  test("GET /api/speak?text=hello within 5s of a dead probe → NO re-probe, 503 with the VoiceConfigError message", async (t) => {
    atOffset(0);
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-get-text-down", await speakGet("?text=hello%20there"));
    assert.equal(f.count(), 0, "dead-server result is cached for 5s — no fetch");
  });

  test("POST /api/speak {text} while cached dead → 503, no fetch", async (t) => {
    atOffset(0);
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-post-text-down", await speakPost({ text: "hello there" }));
    assert.equal(f.count(), 0);
  });

  test("POST /api/speak invalid JSON → 400 bad json (no probe)", async (t) => {
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-post-bad-json", await speakPost("{nope"));
    assert.equal(f.count(), 0);
  });

  test("POST /api/speak with empty / whitespace / missing text → 400 empty text (no probe)", async (t) => {
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-post-empty-text", await speakPost({ text: "" }));
    expectGolden("api/speak-post-whitespace-text", await speakPost({ text: "  \n\t " }));
    expectGolden("api/speak-post-missing-text", await speakPost({}));
    assert.equal(f.count(), 0);
  });

  test("quirk: GET /api/speak?text= (empty string) is NOT the probe — it is an empty-text 400", async (t) => {
    const f = stubFetch(t, DOWN);
    expectGolden("api/speak-get-empty-text", await speakGet("?text="));
    assert.equal(f.count(), 0);
  });

  test("POST /api/voice with 999 bytes → 400 clip too short (no STT probe)", async (t) => {
    const f = stubFetch(t, DOWN);
    expectGolden("api/voice-too-short", await voicePost(clip(999)));
    assert.equal(f.count(), 0);
  });

  test("POST /api/voice with 8MB+1 bytes → 413 clip too long (no STT probe)", async (t) => {
    const f = stubFetch(t, DOWN);
    expectGolden("api/voice-too-long", await voicePost(clip(8 * 1024 * 1024 + 1)));
    assert.equal(f.count(), 0);
  });

  test("POST /api/voice with exactly 1000 bytes → one /health fetch (stt's own cache) → 503 no STT engine", async (t) => {
    atOffset(0);
    const f = stubFetch(t, DOWN);
    expectGolden("api/voice-stt-down", await voicePost(clip(1000), "audio/webm"));
    expectGolden("api/voice-stt-down-fetch", f.calls());
    assert.deepEqual(newIntents(), []);
    assert.equal(memoryLines().length, 5, "no memory line on a config error");
  });

  test("POST /api/voice again within 5s → no re-probe, same 503", async (t) => {
    atOffset(0);
    const f = stubFetch(t, DOWN);
    const res = await voicePost(clip(1000), "audio/webm");
    assert.equal(res.status, 503);
    assert.equal(f.count(), 0, "stt dead-cache holds for 5s");
  });

  test("exactly 5000ms after a dead probe both tts and stt re-probe (one /health each)", async (t) => {
    tickClock(5_000);
    atOffset(5_000);
    const f = stubFetch(t, DOWN);
    assert.equal((await speakGet("?text=hello")).status, 503);
    assert.equal(f.count(), 1, "tts re-probed");
    assert.equal((await voicePost(clip(1000))).status, 503);
    assert.equal(f.count(), 2, "stt re-probed (separate cache)");
    expectGolden("api/voice-server-reprobe-after-5s-fetch", f.calls());
  });

  test("with the REAL fetch, the pinned VOICE_SERVER_URL (127.0.0.1:1) is what gets probed and it fails → 503", async (t) => {
    tickClock(5_000);
    atOffset(10_000);
    const f = spyFetch(t);
    expectGolden("api/voice-stt-down-real", await voicePost(clip(1000), "audio/webm"));
    expectGolden("api/speak-get-text-down-real", await speakGet("?text=hello"));
    expectGolden("api/voice-server-real-fetch-urls", f.calls());
  });
});

// =============================================================================
// /api/speak + /api/voice with a LIVE voice-server (fetch stubbed)
// Clock timeline continues: T0+15s (both dead caches expired) → T0+45s.
// A live probe is cached for 30 000 ms.
// =============================================================================

describe("/api/speak and /api/voice with a live voice-server", () => {
  async function speakGet(query: string): Promise<Snap> {
    const { GET } = await import("@/app/api/speak/route");
    return snap(await GET(get(`/api/speak${query}`)));
  }
  async function speakPost(body: unknown): Promise<Snap> {
    const { POST } = await import("@/app/api/speak/route");
    return snap(await POST(jsonReq("/api/speak", body)));
  }
  async function voicePost(bytes: Uint8Array<ArrayBuffer>, contentType?: string): Promise<Snap> {
    const { POST } = await import("@/app/api/voice/route");
    return snap(await POST(audioReq(bytes, contentType)));
  }

  test("GET /api/speak (probe) → /health ok → 200 {ok:true, engine:kokoro}", async (t) => {
    tickClock(5_000);
    atOffset(15_000);
    const f = stubFetch(t, LIVE);
    expectGolden("api/speak-probe-live", await speakGet(""));
    expectGolden("api/speak-probe-live-fetch", f.calls());
  });

  test("GET /api/speak?text within 30s of a live probe → no re-probe; /speak carries the normalized text; 200 audio/wav", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, LIVE);
    const res = await speakGet(`?text=${encodeURIComponent("$4,200 and 14,166 views by 2026")}`);
    expectGolden("api/speak-get-live", res);
    expectGolden("api/speak-get-live-fetch", f.calls());
    assert.equal(f.count(), 1, "only /speak — the live probe is cached for 30s");
  });

  test("text is trimmed then cut to 900 chars BEFORE speech normalization", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, LIVE);
    const long = `  ${"abcdefghij".repeat(100)}  `; // 1000 letters + padding
    const res = await speakGet(`?text=${encodeURIComponent(long)}`);
    assert.equal(res.status, 200);
    const [call] = f.calls();
    expectGolden("api/speak-truncation-900", {
      calls: f.calls(),
      speakTextLength: call.speakText?.length,
      head: call.speakText?.slice(0, 12),
      tail: call.speakText?.slice(-12),
    });
    // POST takes the same path
    const viaPost = await speakPost({ text: long });
    assert.equal(viaPost.status, 200);
    assert.equal(f.calls()[1].speakText?.length, 900);
  });

  test("POST /api/speak {text} live → 200 audio/wav stream", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, LIVE);
    expectGolden("api/speak-post-live", await speakPost({ text: "Revenue's at $200M — 1,437,000 views." }));
    expectGolden("api/speak-post-live-fetch", f.calls());
  });

  test("/speak returning 500 → 502 'Error: kokoro 500' and the live cache is dropped (next call re-probes)", async (t) => {
    atOffset(15_000);
    const broken = stubFetch(t, { health: liveHealth, speak: () => new Response("boom", { status: 500 }) });
    expectGolden("api/speak-generation-failed", await speakGet("?text=hello"));
    assert.equal(broken.count(), 1, "no re-probe before the failure — cache was live");
    const f = stubFetch(t, LIVE);
    assert.equal((await speakGet("?text=hello")).status, 200);
    expectGolden("api/speak-after-generation-failed-fetch", f.calls());
    assert.equal(f.count(), 2, "cache dropped → /health then /speak");
  });

  test("POST /api/voice: STT 'run the inbox brief' → 200 tier-2 (in-flight guard: inbox brief already queued+running), no intent; content-type propagates to /stt", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, { ...LIVE, stt: sttSays("run the inbox brief") });
    const res = await voicePost(clip(1000), "audio/ogg; codecs=opus");
    expectGolden("api/voice-live-inbox-brief", { response: res, intents: newIntents(), memory: memoryLines() });
    expectGolden("api/voice-live-inbox-brief-fetch", f.calls());
    assert.equal(f.count(), 2, "stt's first live probe + /stt");
  });

  test("POST /api/voice: STT 'morning report' → 200 tier-1 + intent (source voice-ptt); default mime audio/webm; probe cached", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, { ...LIVE, stt: sttSays("morning report") });
    const res = await voicePost(clip(1000));
    expectGolden("api/voice-live-morning-report", { response: res, intents: newIntents(), memory: memoryLines() });
    expectGolden("api/voice-live-morning-report-fetch", f.calls());
    assert.equal(f.count(), 1, "only /stt — the live probe is cached for 30s");
  });

  test("POST /api/voice: STT returns '' → the fixed 'I didn't catch that.' payload, no memory line, no intent", async (t) => {
    atOffset(15_000);
    const f = stubFetch(t, { ...LIVE, stt: sttSays("  ") });
    const res = await voicePost(clip(1000), "audio/webm");
    expectGolden("api/voice-live-empty-transcript", { response: res, intents: newIntents(), memory: memoryLines() });
    assert.equal(f.count(), 1);
  });

  test("POST /api/voice: /stt 500 → 502 'Error: local stt 500' and stt's cache is dropped (next call re-probes)", async (t) => {
    atOffset(15_000);
    const broken = stubFetch(t, { ...LIVE, stt: () => new Response("boom", { status: 500 }) });
    expectGolden("api/voice-stt-500", await voicePost(clip(1000), "audio/webm"));
    assert.equal(broken.count(), 1);
    const f = stubFetch(t, { ...LIVE, stt: sttSays("what's in the queue") });
    const res = await voicePost(clip(1000), "audio/webm");
    assert.equal(res.status, 200);
    expectGolden("api/voice-after-stt-500", { response: res, fetch: f.calls() });
    assert.equal(f.count(), 2, "cache dropped → /health then /stt");
  });

  test("quirk: /health 200 without stt.ok satisfies tts but not stt — probe 200, /api/voice 503 (30s live caches expire at exactly +30s)", async (t) => {
    tickClock(30_000);
    atOffset(45_000);
    const f = stubFetch(t, { health: () => Response.json({ ok: true }), speak: liveSpeak, stt: sttSays("never reached") });
    expectGolden("api/speak-probe-health-without-stt", await speakGet(""));
    expectGolden("api/voice-health-without-stt", await voicePost(clip(1000), "audio/webm"));
    expectGolden("api/voice-health-without-stt-fetch", f.calls());
    assert.equal(f.count(), 2, "both caches expired → one /health each; /stt never called");
  });
});
