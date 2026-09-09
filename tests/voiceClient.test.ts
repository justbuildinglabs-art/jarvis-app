// Characterization tests for the browser-side voice client
// (lib/voice/client.ts, re-exported as lib/voiceClient.ts) — the voice
// singleton (`voice`). Every browser API the class touches (window, fetch,
// WebSocket, Audio, AudioContext + node graph, navigator.mediaDevices,
// MediaRecorder, Blob, performance.now, setTimeout) is replaced by a fake
// that records into ONE ordered call log. Tests drive the class, fire the
// fakes' events explicitly (logged as ">> …"), advance mocked timers
// explicitly (logged as "tick …"), and pin the resulting log — plus return
// values — as goldens. Quirks are captured as they are, not judged.
//
// The singleton is constructed at import and most of its state is sticky
// (inited, unlocked, disabled, cached mic stream), so the tests on `voice`
// are ORDER-DEPENDENT and run serially in declaration order. Branches that a
// sticky flag makes unreachable on the singleton (init-probe outcomes, the
// playback-time 503) are pinned on fresh module instances obtained through a
// cache-busting `?fresh=N` import.
import "./_util/env";
import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FROZEN_NOW_MS } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, IDS, PATHS } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";
import type { Reveal } from "@/lib/voiceClient";

type VoiceModule = typeof import("@/lib/voiceClient");
type Voice = VoiceModule["voice"];

// ---------------------------------------------------------------------------
// The ordered call log every fake and every listener writes into.
// ---------------------------------------------------------------------------
const LOG: string[] = [];
const log = (line: string): void => {
  LOG.push(line);
};
const mark = (label: string): void => log(`-- ${label} --`);

/** advance the mocked clock/timers, recording the amount */
function tick(ms: number): void {
  log(`tick ${ms}ms`);
  mock.timers.tick(ms);
}

/** let every pending microtask settle (setImmediate is NOT mocked) */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
type Listener = (ev: unknown) => void;

class FakeEmitter {
  private listeners = new Map<string, { fn: Listener; once: boolean }[]>();
  constructor(readonly tag: string) {}
  addEventListener(type: string, fn: Listener, opts?: boolean | { once?: boolean }): void {
    const once = typeof opts === "object" && opts !== null && opts.once === true;
    log(`${this.tag}.addEventListener(${type}${once ? ", once" : ""})`);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const i = list.findIndex((l) => l.fn === fn);
    log(`${this.tag}.removeEventListener(${type}) → ${i >= 0 ? "removed" : "not registered"}`);
    if (i >= 0) list.splice(i, 1);
  }
  /** test hook: fire an event; `detail` only decorates the log line */
  emit(type: string, ev: unknown = {}, detail = ""): void {
    const list = this.listeners.get(type) ?? [];
    log(`>> ${this.tag} '${type}'${detail} → ${list.length} listener(s)`);
    for (const l of [...list]) {
      if (l.once) {
        const idx = list.indexOf(l);
        if (idx >= 0) list.splice(idx, 1);
      }
      l.fn(ev);
    }
  }
}

class FakeAudio extends FakeEmitter {
  static seq = 0;
  static last: FakeAudio | null = null;
  static playImpl: () => Promise<void> = () => Promise.resolve();
  readonly src: string;
  private preloadValue = "";
  constructor(src: string) {
    super(`audio#${++FakeAudio.seq}`);
    this.src = src;
    log(`Audio.new(${src}) → ${this.tag}`);
    FakeAudio.last = this;
  }
  get preload(): string {
    return this.preloadValue;
  }
  set preload(v: string) {
    this.preloadValue = v;
    log(`${this.tag}.preload=${v}`);
  }
  play(): Promise<void> {
    log(`${this.tag}.play()`);
    return FakeAudio.playImpl();
  }
  pause(): void {
    log(`${this.tag}.pause()`);
  }
  removeAttribute(name: string): void {
    log(`${this.tag}.removeAttribute(${name})`);
  }
}

class FakeParam {
  private v = 0;
  constructor(private owner: string, private name: string) {}
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    this.v = x;
    log(`${this.owner}.${this.name}.value=${x}`);
  }
}

class FakeNode {
  constructor(readonly tag: string) {}
  connect(target: { tag: string }): void {
    log(`${this.tag}.connect(${target.tag})`);
  }
  disconnect(): void {
    log(`${this.tag}.disconnect()`);
  }
}

class FakeBiquad extends FakeNode {
  private t = "lowpass";
  frequency = new FakeParam(this.tag, "frequency");
  gain = new FakeParam(this.tag, "gain");
  Q = new FakeParam(this.tag, "Q");
  get type(): string {
    return this.t;
  }
  set type(v: string) {
    this.t = v;
    log(`${this.tag}.type=${v}`);
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(this.tag, "gain");
}

class FakeAudioBuffer {
  constructor(
    readonly tag: string,
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {}
  getChannelData(ch: number): Float32Array {
    log(`${this.tag}.getChannelData(${ch}) → Float32Array(${this.length})`);
    return new Float32Array(this.length);
  }
}

class FakeConvolver extends FakeNode {
  private b: FakeAudioBuffer | null = null;
  get buffer(): FakeAudioBuffer | null {
    return this.b;
  }
  set buffer(b: FakeAudioBuffer | null) {
    this.b = b;
    log(`${this.tag}.buffer=${b ? `${b.tag}(ch=${b.numberOfChannels}, len=${b.length}, rate=${b.sampleRate})` : "null"}`);
  }
}

/** what the analyser "hears": per-sample byte value, 128 = silence */
let analyserPattern: (i: number) => number = () => 128;

class FakeAnalyser extends FakeNode {
  private fft = 2048;
  private smooth = 0.8;
  get fftSize(): number {
    return this.fft;
  }
  set fftSize(v: number) {
    this.fft = v;
    log(`${this.tag}.fftSize=${v}`);
  }
  get smoothingTimeConstant(): number {
    return this.smooth;
  }
  set smoothingTimeConstant(v: number) {
    this.smooth = v;
    log(`${this.tag}.smoothingTimeConstant=${v}`);
  }
  getByteTimeDomainData(arr: Uint8Array): void {
    log(`${this.tag}.getByteTimeDomainData(len=${arr.length})`);
    for (let i = 0; i < arr.length; i++) arr[i] = analyserPattern(i);
  }
}

class FakeMediaElementSource extends FakeNode {}

class FakeAudioContext {
  static seq = 0;
  static last: FakeAudioContext | null = null;
  private counters: Record<string, number> = {};
  readonly tag: string;
  readonly sampleRate = 48000;
  readonly destination = { tag: "destination" };
  constructor() {
    this.tag = `ctx#${++FakeAudioContext.seq}`;
    log(`AudioContext.new() → ${this.tag} (sampleRate=${this.sampleRate})`);
    FakeAudioContext.last = this;
  }
  private next(kind: string): string {
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;
    return `${kind}#${this.counters[kind]}`;
  }
  /** the graph is built once per client; only media sources are per-utterance */
  resetMediaSourceCounter(): void {
    this.counters.mediaSrc = 0;
  }
  createAnalyser(): FakeAnalyser {
    const t = this.next("analyser");
    log(`${this.tag}.createAnalyser() → ${t}`);
    return new FakeAnalyser(t);
  }
  createBiquadFilter(): FakeBiquad {
    const t = this.next("biquad");
    log(`${this.tag}.createBiquadFilter() → ${t}`);
    return new FakeBiquad(t);
  }
  createGain(): FakeGain {
    const t = this.next("gain");
    log(`${this.tag}.createGain() → ${t}`);
    return new FakeGain(t);
  }
  createConvolver(): FakeConvolver {
    const t = this.next("convolver");
    log(`${this.tag}.createConvolver() → ${t}`);
    return new FakeConvolver(t);
  }
  createBuffer(ch: number, len: number, rate: number): FakeAudioBuffer {
    const t = this.next("buffer");
    log(`${this.tag}.createBuffer(${ch}, ${len}, ${rate}) → ${t}`);
    return new FakeAudioBuffer(t, ch, len, rate);
  }
  createMediaElementSource(el: FakeAudio): FakeMediaElementSource {
    const t = this.next("mediaSrc");
    log(`${this.tag}.createMediaElementSource(${el.tag}) → ${t}`);
    return new FakeMediaElementSource(t);
  }
  resume(): Promise<void> {
    log(`${this.tag}.resume()`);
    return Promise.resolve();
  }
}

type WsHandler = ((ev: unknown) => void) | null;

class FakeWebSocket {
  static seq = 0;
  static last: FakeWebSocket | null = null;
  static throwNext = false;
  readonly tag: string;
  onopen: WsHandler = null;
  onmessage: WsHandler = null;
  onclose: WsHandler = null;
  onerror: WsHandler = null;
  constructor(readonly url: string) {
    if (FakeWebSocket.throwNext) {
      FakeWebSocket.throwNext = false;
      log(`WebSocket.new(${url}) THROWS`);
      throw new DOMException(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, "SyntaxError");
    }
    this.tag = `ws#${++FakeWebSocket.seq}`;
    log(`WebSocket.new(${url}) → ${this.tag}`);
    FakeWebSocket.last = this;
  }
  close(): void {
    log(`${this.tag}.close()`);
  }
  /** test hook: fire open/close/error on the class's handler (close does NOT
   *  auto-fire on close() — tests fire it explicitly, like a real socket
   *  closing asynchronously) */
  fire(ev: "open" | "close" | "error"): void {
    log(`>> ${this.tag} ${ev}`);
    const key = `on${ev}` as "onopen" | "onclose" | "onerror";
    this[key]?.({});
  }
  message(raw: string): void {
    log(`>> ${this.tag} message ${raw}`);
    this.onmessage?.({ data: raw });
  }
}

class FakeMediaRecorder extends FakeEmitter {
  static seq = 0;
  static last: FakeMediaRecorder | null = null;
  static mimeType = "audio/webm;codecs=opus";
  readonly mimeType: string;
  constructor(stream: { tag: string }) {
    super(`recorder#${++FakeMediaRecorder.seq}`);
    this.mimeType = FakeMediaRecorder.mimeType;
    log(`MediaRecorder.new(${stream.tag}) → ${this.tag} mimeType=${JSON.stringify(this.mimeType)}`);
    FakeMediaRecorder.last = this;
  }
  start(...args: unknown[]): void {
    log(`${this.tag}.start(${args.map(String).join(", ")})`);
  }
  stop(): void {
    log(`${this.tag}.stop()`);
  }
}

const RealBlob = globalThis.Blob;
class FakeBlob extends RealBlob {
  constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
    super(parts, opts);
    log(`Blob.new(parts=${parts?.length ?? 0}, type=${JSON.stringify(opts?.type ?? "")}) → size=${this.size} type=${JSON.stringify(this.type)}`);
  }
}
/** raw recorder chunk (built with the real Blob so it does not log) */
const chunk = (bytes: number): Blob => new RealBlob([new Uint8Array(bytes)], { type: "audio/webm" });

interface FakeResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}
const BAD_JSON = Symbol("bad-json");
function mkRes(status: number, body?: unknown): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      log(`res(${status}).json()`);
      if (body === BAD_JSON) throw new SyntaxError(`Unexpected token '<', "<html>" is not valid JSON`);
      return body;
    },
  };
}
type Route = () => FakeResponse | Promise<FakeResponse>;
const routes: Record<string, Route> = {};
function defaultRoutes(): void {
  routes["/api/speak"] = () => mkRes(200, { engine: "kokoro-test", voice: "bm_george" });
  routes["/api/voice/text"] = () => mkRes(200, {});
  routes["/api/voice"] = () => mkRes(200, {});
}
function describeInit(init: RequestInit): string {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(init)) {
    o[k] = v instanceof RealBlob ? `<Blob size=${v.size} type=${v.type}>` : v;
  }
  return JSON.stringify(o);
}
const fakeFetch = async (input: unknown, init?: RequestInit): Promise<FakeResponse> => {
  const url = String(input);
  log(`fetch ${init?.method ?? "GET"} ${url}${init ? " " + describeInit(init) : ""}`);
  const route = routes[url];
  if (!route) throw new Error(`no fake route for ${url}`);
  return route();
};

const micStream = { tag: "micStream#1" };
let gumImpl: () => Promise<{ tag: string }> = () => Promise.resolve(micStream);
const fakeNavigator = {
  mediaDevices: {
    getUserMedia: (constraints: unknown) => {
      log(`navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)})`);
      return gumImpl();
    },
  },
};

let perfNow = 1000;
function advancePerf(ms: number): void {
  perfNow += ms;
  log(`perf +${ms}ms`);
}

const windowA = new FakeEmitter("window");
const originals = {
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  Blob: globalThis.Blob,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  perfNow: Object.getOwnPropertyDescriptor(globalThis.performance, "now"),
};
const g = globalThis as unknown as Record<string, unknown>;

function installFakes(): void {
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  g.WebSocket = FakeWebSocket;
  g.Audio = FakeAudio;
  g.AudioContext = FakeAudioContext;
  g.MediaRecorder = FakeMediaRecorder;
  g.Blob = FakeBlob;
  Object.defineProperty(globalThis, "navigator", { value: fakeNavigator, configurable: true, writable: true });
  Object.defineProperty(globalThis.performance, "now", {
    value: () => {
      log(`performance.now() → ${perfNow}`);
      return perfNow;
    },
    configurable: true,
    writable: true,
  });
  // NOTE: `window` is deliberately NOT installed here — the first test pins
  // the no-window guard in init(); it is installed right after.
}

function restoreGlobals(): void {
  globalThis.fetch = originals.fetch;
  g.WebSocket = originals.WebSocket;
  g.Blob = originals.Blob;
  delete g.Audio;
  delete g.AudioContext;
  delete g.MediaRecorder;
  delete g.window;
  if (originals.navigator) Object.defineProperty(globalThis, "navigator", originals.navigator);
  if (originals.perfNow) Object.defineProperty(globalThis.performance, "now", originals.perfNow);
  else delete (globalThis.performance as unknown as Record<string, unknown>).now;
}

/** log every timer the class asks for (delay in ms) on top of the mock */
function wrapTimers(): void {
  const st = globalThis.setTimeout;
  const ct = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    log(`setTimeout(${ms}ms)`);
    return st(fn, ms, ...args);
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    log("clearTimeout()");
    return ct(id as never);
  }) as unknown as typeof clearTimeout;
}

function wire(v: Voice): void {
  v.onLog((cls, text) => log(`onLog[${cls}] ${text}`));
  v.onSpeaking((on) => log(`onSpeaking(${on})`));
  v.onPanels((p) => log(`onPanels(${JSON.stringify(p)})`));
  v.onDeliverable((p, l) => log(`onDeliverable(${p}, ${l})`));
  v.onOpenDoc((p, l) => log(`onOpenDoc(${p}, ${l})`));
  v.onReveal((r) => log(`onReveal(${JSON.stringify(r)})`));
  v.onListening((on) => log(`onListening(${on})`));
}

let freshSeq = 0;
/** a brand-new VoiceClient (fresh module instance) with its own fake window */
async function freshVoice(): Promise<Voice> {
  const n = ++freshSeq;
  // Cache-bust the module that actually BUILDS the singleton. @/lib/voiceClient
  // is now a re-export shim (the client moved to lib/voice/client.ts when it
  // was split), and busting the shim would hand back the same cached instance.
  const mod = (await import(`@/lib/voice/client?fresh=${n}`)) as VoiceModule;
  Object.defineProperty(globalThis, "window", { value: new FakeEmitter(`window'${n}`), configurable: true, writable: true });
  wire(mod.voice);
  return mod.voice;
}

const ws = (): FakeWebSocket => {
  const s = FakeWebSocket.last;
  assert.ok(s, "no fake WebSocket has been constructed");
  return s;
};
const audio = (): FakeAudio => {
  const a = FakeAudio.last;
  assert.ok(a, "no fake Audio has been constructed");
  return a;
};
const transcript = (text: unknown): string => JSON.stringify({ type: "transcript", text });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let voice: Voice;

before(async () => {
  buildFixtureVault();
  freezeClock();
  installFakes();
  const mod = await import("@/lib/voiceClient"); // singleton is built here
  voice = mod.voice;
  wire(voice);
});

after(() => {
  thawClock();
  restoreGlobals();
  destroyFixtureVault();
});

beforeEach(() => {
  LOG.length = 0;
  FakeAudio.seq = 0;
  FakeAudio.last = null;
  FakeAudio.playImpl = () => Promise.resolve();
  FakeAudioContext.seq = 0;
  FakeAudioContext.last?.resetMediaSourceCounter();
  FakeMediaRecorder.seq = 0;
  FakeMediaRecorder.mimeType = "audio/webm;codecs=opus";
  FakeWebSocket.throwNext = false;
  defaultRoutes();
  gumImpl = () => Promise.resolve(micStream);
  analyserPattern = () => 128;
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: FROZEN_NOW_MS });
  wrapTimers();
});

afterEach(() => {
  mock.timers.reset(); // drops any pending mocked timer
  freezeClock();
});

// ---------------------------------------------------------------------------
// 1. init()
// ---------------------------------------------------------------------------
test("init() without a window is a no-op that leaves init() re-callable", () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  voice.init();
  expectGolden("voiceClient/init-no-window", { log: LOG });
});

test("init() registers unlock listeners, probes /api/speak, opens the wake WS; a second init() is a no-op", async () => {
  Object.defineProperty(globalThis, "window", { value: windowA, configurable: true, writable: true });
  voice.init();
  mark("sync part done");
  await flush();
  mark("init() again");
  voice.init();
  await flush();
  mark("ws open");
  ws().fire("open"); // armed/disarmed log waits for the server's hello
  expectGolden("voiceClient/init", { wsUrl: ws().url, log: LOG });
});

// ---------------------------------------------------------------------------
// 2. wake-word WS events
// ---------------------------------------------------------------------------
test("hello event: wake:true arms, wake:false / missing wake reports push-to-talk only", () => {
  ws().message(JSON.stringify({ type: "hello", wake: true }));
  ws().message(JSON.stringify({ type: "hello", wake: false }));
  ws().message(JSON.stringify({ type: "hello" }));
  expectGolden("voiceClient/ws-hello", { log: LOG });
});

test("malformed, unknown and empty-transcript wake events are ignored", () => {
  ws().message("not json");
  ws().message("{}");
  ws().message(JSON.stringify({ type: "nope", text: "hello" }));
  ws().message(JSON.stringify({ type: "transcript" }));
  ws().message(JSON.stringify({ type: "transcript", text: "   " }));
  ws().message(JSON.stringify({ type: "transcript", text: null }));
  expectGolden("voiceClient/ws-ignored-events", { log: LOG });
});

test("wake / wake_timeout / wake_error while idle", () => {
  ws().message(JSON.stringify({ type: "wake" }));
  ws().message(JSON.stringify({ type: "wake_timeout" }));
  ws().message(JSON.stringify({ type: "wake_error" }));
  expectGolden("voiceClient/ws-wake-idle", { log: LOG });
});

test("DISMISS_RE: post-wake transcripts that just mean 'never mind' are dropped; everything else is POSTed to /api/voice/text", async () => {
  const phrases = [
    "stop", "Stop!", "stop.  ", "stop the music",
    "cancel", "cancel that",
    "never mind", "Never Mind!!", "nevermind", "never  mind",
    "nothing", "nothing.", "nothing much",
    "no", "No.", "no, ", "  no  ", "no thanks",
    "nope", "NOPE...",
    "shut up", "shutup",
    "quiet", "quiet!?", "quiet, ",
    "what's in the queue",
  ];
  const table: Record<string, string> = {};
  for (const p of phrases) {
    const start = LOG.length;
    ws().message(transcript(p));
    await flush();
    const slice = LOG.slice(start);
    table[JSON.stringify(p)] = slice.some((l) => l.endsWith("— dismissed"))
      ? "dismissed"
      : slice.some((l) => l.startsWith("fetch POST /api/voice/text"))
        ? "dispatched"
        : "ignored";
  }
  expectGolden("voiceClient/dismiss-table", { table, log: LOG });
});

// ---------------------------------------------------------------------------
// 3. speak() before/after the autoplay unlock
// ---------------------------------------------------------------------------
test("speak() before unlock queues silently after one 'voice queued' announcement; stop() clears the locked queue", () => {
  voice.speak("Hello there.");
  voice.speak("Second one");
  mark("stop()");
  const stopped = voice.stop();
  mark("speak after stop");
  voice.speak("Third after stop");
  voice.speak(""); // sanitizes to nothing — never queued
  expectGolden("voiceClient/speak-locked", { stopReturned: stopped, log: LOG });
});

test("first keydown unlocks: removes both listeners, builds the sheen graph, resumes the context and drains the queue", async () => {
  windowA.emit("keydown");
  mark("ended");
  audio().emit("ended");
  await flush();
  mark("gestures after unlock");
  windowA.emit("pointerdown");
  windowA.emit("keydown");
  expectGolden("voiceClient/unlock-drain", { log: LOG });
});

test("getLevel(): null when idle, RMS × 3.2 clamped to 1 while an utterance plays", async () => {
  const idle = voice.getLevel();
  voice.speak("Level check");
  analyserPattern = () => 128;
  const quiet = voice.getLevel();
  analyserPattern = (i) => (i % 2 === 0 ? 160 : 96);
  const mid = voice.getLevel();
  analyserPattern = () => 255;
  const loud = voice.getLevel();
  audio().emit("ended");
  await flush();
  const afterEnded = voice.getLevel();
  expectGolden("voiceClient/get-level", { idle, quiet, mid, loud, afterEnded, log: LOG });
});

test("sanitize(): markdown noise, urls and whitespace are stripped and the text capped at 800 chars before it reaches /api/speak", async () => {
  const cases: { name: string; input: string }[] = [
    { name: "markdown", input: "**Bold** _under_ `code` # heading > quote | pipe" },
    { name: "urls", input: "See https://example.com/a-b?c=d#e and http://x.y/z now." },
    { name: "whitespace", input: "  lots   of\n\twhitespace  " },
    { name: "punctuation", input: "Plain text with 'quotes' & ampersand? yes!" },
    { name: "unicode", input: "Émigré café — naïve ü" },
    { name: "900x", input: "x".repeat(900) },
    { name: "empty", input: "" },
    { name: "blank", input: "   " },
    { name: "url-only", input: "https://only.url/here" },
    { name: "markdown-only", input: "*_`#>|" },
  ];
  const table: Record<string, unknown> = {};
  for (const c of cases) {
    FakeAudio.last = null;
    voice.speak(c.input);
    const a = FakeAudio.last as FakeAudio | null;
    if (a) {
      const clean = decodeURIComponent(a.src.slice("/api/speak?text=".length));
      table[c.name] = { src: a.src, clean, cleanLength: clean.length };
      voice.stop();
      await flush();
    } else {
      table[c.name] = null; // nothing queued, nothing played
    }
  }
  expectGolden("voiceClient/sanitize-table", { table });
});

test("speak() while speaking queues; utterances play in order; onSpeaking unsubscribe works; stop() when idle is false", async () => {
  const off = voice.onSpeaking((on) => log(`extraSpeaking(${on})`));
  voice.speak("First");
  voice.speak("Second");
  voice.speak("Third");
  mark("First ended");
  audio().emit("ended");
  await flush();
  mark("unsubscribe extra listener");
  off();
  mark("Second ended");
  audio().emit("ended");
  await flush();
  mark("Third ended");
  audio().emit("ended");
  await flush();
  const stopWhenIdle = voice.stop();
  expectGolden("voiceClient/speak-queue", { stopWhenIdle, log: LOG });
});

// ---------------------------------------------------------------------------
// 4. sequenced reveals
// ---------------------------------------------------------------------------
const REVEALS: Reveal[] = [
  { kind: "doc", target: PATHS.morningToday, label: "morning report", at: 13 },
  { kind: "link", target: "https://example.com/anthropic-profit", label: "Anthropic profit", at: 26 },
  { kind: "doc", target: PATHS.dailyToday, label: "today's note", at: 130 },
];

test("reveals are scheduled at at/13 s once 'playing' fires; 'ended' flushes the unfired ones immediately", async () => {
  voice.speak("Sequenced reply with three callouts.", REVEALS);
  mark("playing");
  audio().emit("playing");
  tick(999);
  tick(1);
  tick(1000);
  mark("playing again (once)");
  audio().emit("playing");
  mark("ended");
  audio().emit("ended");
  await flush();
  tick(20000);
  expectGolden("voiceClient/reveals-timing", { log: LOG });
});

test("stop() mid-speech drops unfired reveals, pauses and unloads the audio, and resolves the utterance", async () => {
  voice.speak("Interrupted reply.", REVEALS.slice(0, 2));
  audio().emit("playing");
  tick(1000);
  mark("stop()");
  const stopped = voice.stop();
  await flush();
  tick(5000);
  expectGolden("voiceClient/stop-mid-speech", { stopReturned: stopped, log: LOG });
});

test("stop() then an immediate speak(): the new utterance starts only after the stopped one resolves", async () => {
  voice.speak("Old");
  mark("stop() + speak() back to back");
  voice.stop();
  voice.speak("New");
  mark("microtasks settle");
  await flush();
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/stop-then-speak", { log: LOG });
});

test("reveals never fire when 'playing' never fires; an empty reveals array registers no 'playing' listener", async () => {
  voice.speak("Ends before it plays.", REVEALS);
  mark("ended without playing");
  audio().emit("ended");
  await flush();
  mark("empty reveals");
  voice.speak("No callouts.", []);
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/reveals-without-playing", { log: LOG });
});

// ---------------------------------------------------------------------------
// 5. playback failures
// ---------------------------------------------------------------------------
test("audio 'error' event: re-probes /api/speak, logs 'voice playback failed', and the queue continues", async () => {
  voice.speak("Broken one");
  voice.speak("Next one");
  mark("error");
  audio().emit("error");
  await flush();
  mark("Next one ended");
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/audio-error-event", { log: LOG });
});

test("play() rejection (autoplay) with the re-probe itself failing: logged as playback failure, not offline", async () => {
  FakeAudio.playImpl = () =>
    Promise.reject(new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError"));
  routes["/api/speak"] = () => Promise.reject(new TypeError("Failed to fetch"));
  voice.speak("Blocked");
  await flush();
  expectGolden("voiceClient/play-rejected", { log: LOG });
});

// ---------------------------------------------------------------------------
// 6. wake-word barge-in and transcript dispatch
// ---------------------------------------------------------------------------
test("wake event while speaking: full barge-in (stop + 'wake — interrupted') then listening", async () => {
  voice.speak("Long briefing in progress.");
  mark("wake");
  ws().message(JSON.stringify({ type: "wake" }));
  await flush();
  mark("wake_timeout");
  ws().message(JSON.stringify({ type: "wake_timeout" }));
  expectGolden("voiceClient/wake-barge-in", { log: LOG });
});

test("transcript event while speaking does not interrupt — the reply queues behind the current utterance", async () => {
  voice.speak("Still talking.");
  routes["/api/voice/text"] = () => mkRes(200, { transcript: "and the queue?", tier: 2, skill: null, queued: null, reply: "Two items queued." });
  mark("transcript");
  ws().message(transcript("and the queue?"));
  await flush();
  mark("first ended");
  audio().emit("ended");
  await flush();
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/transcript-while-speaking", { log: LOG });
});

test("transcript dispatch: POST /api/voice/text; the reply payload drives logs, panels, the deliverable chip and speech", async () => {
  routes["/api/voice/text"] = () =>
    mkRes(200, {
      transcript: "what's in the queue",
      tier: 2,
      skill: null,
      queued: null,
      reply: "Two things waiting: the inbox brief and a voice ask.",
      panels: ["queue", "runs"],
      deliverable: PATHS.inboxBriefPending,
    });
  ws().message(transcript("what's in the queue"));
  await flush();
  mark("ended");
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/transcript-dispatch-full", { log: LOG });
});

// reply-payload variants, one golden each
async function replyCase(name: string, payload: Record<string, unknown>, opts: { sequenced?: boolean } = {}): Promise<void> {
  LOG.length = 0;
  FakeAudio.last = null;
  routes["/api/voice/text"] = () => mkRes(200, payload);
  ws().message(transcript("variant"));
  await flush();
  const a = FakeAudio.last as FakeAudio | null;
  if (a) {
    if (opts.sequenced) {
      mark("playing");
      a.emit("playing");
      tick(0);
      tick(2000);
    }
    mark("ended");
    a.emit("ended");
    await flush();
  }
  expectGolden(`voiceClient/reply-${name}`, { spoke: a !== null, log: LOG });
}

const SEQ: Reveal[] = [
  { kind: "doc", target: PATHS.morningToday, label: "morning report", at: 0 },
  { kind: "link", target: "https://example.com/anthropic-profit", label: "Anthropic profit", at: 26 },
];

test("reply payload: queued + skill logs 'intent queued → skill'", async () => {
  await replyCase("queued-with-skill", {
    transcript: "run the morning report",
    tier: 1,
    skill: "morning-report",
    queued: IDS.queueInbox,
    reply: "On it — morning report coming up.",
  });
});

test("reply payload: queued without a skill logs no queued line", async () => {
  await replyCase("queued-without-skill", { transcript: "do the thing", tier: 1, skill: null, queued: IDS.queueInbox, reply: "Queued." });
});

test("reply payload: empty panels array fires no onPanels", async () => {
  await replyCase("panels-empty", { transcript: "x", tier: 2, skill: null, queued: null, reply: "Nothing to show.", panels: [] });
});

test("reply payload: deliverable + reveal:'open' opens the doc on screen (label 'document'), no chip", async () => {
  await replyCase("deliverable-open", {
    transcript: "bring up the report",
    tier: 2,
    skill: null,
    queued: null,
    reply: "Here it is.",
    deliverable: PATHS.morningToday,
    reveal: "open",
  });
});

test("reply payload: deliverable + sequenced reveals skips the chip and hands the reveals to speak()", async () => {
  await replyCase(
    "deliverable-sequenced",
    {
      transcript: "give me the rundown",
      tier: 2,
      skill: null,
      queued: null,
      reply: "Good morning. Anthropic posts its first profit.",
      deliverable: PATHS.morningToday,
      reveals: SEQ,
    },
    { sequenced: true }
  );
});

test("reply payload: reveal:'open' wins over sequenced reveals (doc opens AND reveals still fire)", async () => {
  await replyCase(
    "deliverable-open-sequenced",
    {
      transcript: "open it and walk me through",
      tier: 2,
      skill: null,
      queued: null,
      reply: "Opening. Anthropic posts its first profit.",
      deliverable: PATHS.morningToday,
      reveal: "open",
      reveals: SEQ,
    },
    { sequenced: true }
  );
});

test("reply payload: an empty reveals array is not sequenced — the chip fires", async () => {
  await replyCase("deliverable-empty-reveals", {
    transcript: "x",
    tier: 2,
    skill: null,
    queued: null,
    reply: "Report is ready.",
    deliverable: PATHS.morningToday,
    reveals: [],
  });
});

test("reply payload: reveal:'open' without a deliverable does nothing", async () => {
  await replyCase("reveal-open-without-deliverable", { transcript: "x", tier: 2, skill: null, queued: null, reply: "Nothing to open.", reveal: "open", deliverable: null });
});

test("reply payload: empty reply is neither logged nor spoken", async () => {
  await replyCase("empty-reply", { transcript: "silence please", tier: 2, skill: null, queued: null, reply: "", panels: ["daily"] });
});

test("reply payload: missing transcript logs no 'you ·' line", async () => {
  await replyCase("no-transcript", { transcript: "", tier: 2, skill: null, queued: null, reply: "Heard nothing, but here I am." });
});

test("reply payload: the log shows the raw reply while the spoken text is sanitized", async () => {
  await replyCase("markdown-reply", {
    transcript: "x",
    tier: 3,
    skill: "voice-ask",
    queued: null,
    reply: "**Fable 5** shipped — see https://example.com/fable `1M-token` context.",
  });
});

// ---------------------------------------------------------------------------
// 7. voice response errors
// ---------------------------------------------------------------------------
async function errorCase(name: string, route: Route): Promise<void> {
  LOG.length = 0;
  routes["/api/voice/text"] = route;
  ws().message(transcript("trigger"));
  await flush();
  expectGolden(`voiceClient/response-${name}`, { log: LOG });
}

test("response 500 with a JSON error field → 'voice command failed: <error>'", async () => {
  await errorCase("500-json-error", () => mkRes(500, { error: "router exploded" }));
});

test("response 500 without JSON → the status code stands in for the error", async () => {
  await errorCase("500-no-json", () => mkRes(500, BAD_JSON));
});

test("response 400 with JSON lacking an error field → the status code", async () => {
  await errorCase("400-no-error-field", () => mkRes(400, { message: "nope" }));
});

test("response error text is cut at 120 characters", async () => {
  await errorCase("error-truncated", () => mkRes(500, { error: "E".repeat(200) }));
});

test("fetch rejection → 'voice command failed: TypeError: …'", async () => {
  await errorCase("fetch-reject", () => Promise.reject(new TypeError("Failed to fetch")));
});

test("response 200 with an unparseable body → the SyntaxError surfaces as a failed command", async () => {
  await errorCase("ok-bad-json", () => mkRes(200, BAD_JSON));
});

// ---------------------------------------------------------------------------
// 8. push-to-talk capture
// ---------------------------------------------------------------------------
test("startCapture(): getUserMedia rejection → false + 'microphone access denied'", async () => {
  gumImpl = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  const ok = await voice.startCapture();
  expectGolden("voiceClient/capture-gum-denied", { returned: ok, log: LOG });
});

test("startCapture(): acquires the mic with {audio:true}, starts a MediaRecorder; a second call while recording is a bare true", async () => {
  const first = await voice.startCapture();
  mark("second call");
  const second = await voice.startCapture();
  const levelWhileCapturing = voice.getLevel();
  expectGolden("voiceClient/capture-start", { first, second, levelWhileCapturing, log: LOG });
});

test("finishCapture(): a tap under 350 ms stops the recorder, builds the blob, then discards it; finishCapture() with no recorder is a no-op", async () => {
  advancePerf(200);
  const rec = FakeMediaRecorder.last!;
  const p = voice.finishCapture();
  rec.emit("dataavailable", { data: chunk(1500) }, "(size=1500)");
  rec.emit("stop");
  await p;
  mark("finishCapture() again");
  await voice.finishCapture();
  expectGolden("voiceClient/capture-tap", { log: LOG });
});

test("finishCapture(): held long enough but the clip is under 1000 bytes → discarded; zero-size chunks are ignored", async () => {
  const started = await voice.startCapture(); // mic stream is cached — no getUserMedia
  advancePerf(800);
  const rec = FakeMediaRecorder.last!;
  const p = voice.finishCapture();
  rec.emit("dataavailable", { data: chunk(0) }, "(size=0)");
  rec.emit("dataavailable", { data: chunk(500) }, "(size=500)");
  rec.emit("stop");
  await p;
  expectGolden("voiceClient/capture-tiny-clip", { started, log: LOG });
});

test("finishCapture(): POSTs the clip to /api/voice with the recorder's mime type and speaks the reply", async () => {
  routes["/api/voice"] = () =>
    mkRes(200, {
      transcript: "give me the rundown",
      tier: 2,
      skill: null,
      queued: null,
      reply: "Good morning. Two of three goals still open.",
      panels: ["daily"],
    });
  await voice.startCapture();
  advancePerf(1200);
  const rec = FakeMediaRecorder.last!;
  const p = voice.finishCapture();
  rec.emit("dataavailable", { data: chunk(1500) }, "(size=1500)");
  rec.emit("dataavailable", { data: chunk(0) }, "(size=0)");
  rec.emit("dataavailable", { data: chunk(600) }, "(size=600)");
  rec.emit("stop");
  await p;
  await flush();
  mark("ended");
  audio().emit("ended");
  await flush();
  expectGolden("voiceClient/capture-post", { log: LOG });
});

test("finishCapture(): an empty recorder mimeType falls back to audio/webm", async () => {
  FakeMediaRecorder.mimeType = "";
  await voice.startCapture();
  advancePerf(500);
  const rec = FakeMediaRecorder.last!;
  const p = voice.finishCapture();
  rec.emit("dataavailable", { data: chunk(1200) }, "(size=1200)");
  rec.emit("stop");
  await p;
  await flush();
  expectGolden("voiceClient/capture-mime-fallback", { log: LOG });
});

test("startCapture() while speaking barges in (stop) before opening the recorder", async () => {
  voice.speak("Talking over you.");
  mark("startCapture()");
  const ok = await voice.startCapture();
  await flush();
  mark("quick tap to close");
  advancePerf(100);
  const rec = FakeMediaRecorder.last!;
  const p = voice.finishCapture();
  rec.emit("stop");
  await p;
  expectGolden("voiceClient/capture-barge-in", { returned: ok, log: LOG });
});

// ---------------------------------------------------------------------------
// 9. WS reconnect backoff
// ---------------------------------------------------------------------------
test("WS close after open: 'link lost' + onListening(false) + reconnect after 5000 ms; close before open retries silently; onerror closes", () => {
  const first = ws();
  first.fire("close");
  tick(4999);
  tick(1);
  const second = ws();
  assert.notEqual(second, first);
  mark("close before open");
  second.fire("close");
  tick(5000);
  const third = ws();
  mark("error");
  third.fire("error");
  expectGolden("voiceClient/ws-reconnect", { sockets: [first.tag, second.tag, third.tag], log: LOG });
});

test("WS constructor throwing on reconnect → retry after 10000 ms", () => {
  const third = ws();
  third.fire("close");
  FakeWebSocket.throwNext = true;
  tick(5000);
  tick(9999);
  tick(1);
  const fourth = ws();
  assert.notEqual(fourth, third);
  fourth.fire("open");
  expectGolden("voiceClient/ws-ctor-throw", { log: LOG });
});

// ---------------------------------------------------------------------------
// 10. 503 on a voice command disables the client for good
// ---------------------------------------------------------------------------
test("503 from a voice command: 'TTS key missing'; afterwards speak() is silent, startCapture() refuses, but transcripts are still dispatched", async () => {
  routes["/api/voice/text"] = () => mkRes(503, { error: "no key" });
  ws().message(transcript("hello?"));
  await flush();
  mark("speak() while disabled");
  voice.speak("Still there?");
  mark("startCapture() while disabled");
  const cap = await voice.startCapture();
  const stopped = voice.stop();
  mark("another transcript while disabled");
  ws().message(transcript("hello again"));
  await flush();
  expectGolden("voiceClient/disabled-after-503", { startCapture: cap, stop: stopped, log: LOG });
});

// ---------------------------------------------------------------------------
// 11. fresh instances — branches the sticky singleton flags make unreachable
// ---------------------------------------------------------------------------
test("fresh: init() probe 503 disables voice up front (no json read); speak() and startCapture() stay dead", async () => {
  routes["/api/speak"] = () => mkRes(503, { error: "no key" });
  const v = await freshVoice();
  v.init();
  await flush();
  mark("speak()");
  v.speak("Anyone home?");
  mark("startCapture()");
  const cap = await v.startCapture();
  expectGolden("voiceClient/fresh-init-probe-503", { startCapture: cap, log: LOG });
});

test("fresh: init() probe 500 logs nothing and does not disable", async () => {
  routes["/api/speak"] = () => mkRes(500, { error: "boom" });
  const v = await freshVoice();
  v.init();
  await flush();
  mark("speak() (locked, not disabled)");
  v.speak("Queued, not dropped.");
  expectGolden("voiceClient/fresh-init-probe-500", { log: LOG });
});

test("fresh: init() probe with an unparseable body falls back to engine 'kokoro'", async () => {
  routes["/api/speak"] = () => mkRes(200, BAD_JSON);
  const v = await freshVoice();
  v.init();
  await flush();
  expectGolden("voiceClient/fresh-init-probe-bad-json", { log: LOG });
});

test("fresh: init() probe fetch rejection is swallowed", async () => {
  routes["/api/speak"] = () => Promise.reject(new TypeError("Failed to fetch"));
  const v = await freshVoice();
  v.init();
  await flush();
  expectGolden("voiceClient/fresh-init-probe-reject", { log: LOG });
});

test("fresh: WebSocket constructor throwing at init → first retry after 10000 ms", async () => {
  FakeWebSocket.throwNext = true;
  const v = await freshVoice();
  v.init();
  await flush();
  tick(9999);
  tick(1);
  expectGolden("voiceClient/fresh-init-ws-ctor-throw", { log: LOG });
});

test("fresh: playback failure when /api/speak now answers 503 → 'TTS unavailable', queue dropped, client disabled", async () => {
  const v = await freshVoice();
  v.init();
  await flush();
  const win = (globalThis as unknown as { window: FakeEmitter }).window;
  mark("unlock");
  win.emit("keydown");
  await flush();
  v.speak("First");
  v.speak("Second (never plays)");
  routes["/api/speak"] = () => mkRes(503, { error: "no key" });
  mark("error");
  audio().emit("error");
  await flush();
  mark("speak() after");
  v.speak("Third");
  const stopped = v.stop();
  expectGolden("voiceClient/fresh-playback-503", { stopAfter: stopped, log: LOG });
});
