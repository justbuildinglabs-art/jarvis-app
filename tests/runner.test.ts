// Characterization tests for runner/runner.js.
//
// Pins the daemon's pure helpers (prompt builders, deliverable paths, local
// dates, model selection, constants), the queue scheduler
// (enqueueNew/pickNext/peekSkill), the heartbeat and log formats, env
// precedence (via child processes), and the full processOne job lifecycle
// driven against a FAKE `claude` placed on PATH — which also pins the exact
// CLI contract the runner sends (argv + cwd). loop()/watchLoop() are never
// started (RUNNER_NO_BOOT=1 comes from env.ts).
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FIXTURE_ROOT, FIXTURE_HOME } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

// RUNNER_LOG is read at module load — set it before the runner is imported so
// the suite never appends to the live daemon log (runner/runner.log).
const RUNNER_LOG = path.join(FIXTURE_ROOT, "runner.log");
process.env.RUNNER_LOG = RUNNER_LOG;

const REPO_ROOT = process.cwd();
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, "runner", "runner.js")).href;
const BIN_DIR = path.join(FIXTURE_ROOT, "bin");
const EMPTY_BIN_DIR = path.join(FIXTURE_ROOT, "bin-empty");
const ARGV_FILE = path.join(FIXTURE_ROOT, "claude-argv.txt");
const EXIT_FILE = path.join(FIXTURE_ROOT, "claude-exit.txt");
const STDOUT_FILE = path.join(FIXTURE_ROOT, "claude-stdout.txt");
const STDERR_FILE = path.join(FIXTURE_ROOT, "claude-stderr.txt");
const ORIGINAL_PATH = process.env.PATH ?? "";

// macOS tmp lives under /var → /private/var; `pwd` in the fake prints the
// physical path, so both spellings are masked to <VAULT>.
let REAL_ROOT = FIXTURE_ROOT;

async function loadRunner() {
  return await import("../runner/runner.js");
}
type Runner = Awaited<ReturnType<typeof loadRunner>>;

function mask(s: string): string {
  return s.split(REAL_ROOT).join("<VAULT>").split(FIXTURE_ROOT).join("<VAULT>").split(REPO_ROOT).join("<REPO>");
}

function throwsWith(fn: () => unknown): string {
  try {
    fn();
    return "no throw";
  } catch (e) {
    return `throws ${(e as Error).constructor.name}`;
  }
}

/** A `claude` stand-in: records cwd + argv, plays a canned reply, exits with
 *  the code in claude-exit.txt. stdout is flushed before stderr so the run
 *  log interleaves deterministically. */
function installFakeClaude(): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(EMPTY_BIN_DIR, { recursive: true });
  const script = `#!/bin/bash
ROOT='${FIXTURE_ROOT}'
{
  echo "pwd: $(pwd)"
  for a in "$@"; do
    echo '<<ARG>>'
    printf '%s\\n' "$a"
  done
  echo '<<END>>'
} >> "$ROOT/claude-argv.txt"
if [ -f "$ROOT/claude-stdout.txt" ]; then
  cat "$ROOT/claude-stdout.txt"
else
  printf 'Warning: first line is a warning\\nHere is the spoken line.\\nSAVED inbox/reports/fake-deliverable.md\\n'
fi
sleep 0.2
if [ -f "$ROOT/claude-stderr.txt" ]; then
  cat "$ROOT/claude-stderr.txt" >&2
else
  echo 'claude: fake stderr noise' >&2
fi
code=0
if [ -f "$ROOT/claude-exit.txt" ]; then code="$(cat "$ROOT/claude-exit.txt")"; fi
exit "$code"
`;
  const bin = path.join(BIN_DIR, "claude");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
}

function resetJobFixtures(): void {
  for (const f of [ARGV_FILE, EXIT_FILE, STDOUT_FILE, STDERR_FILE]) fs.rmSync(f, { force: true });
  fs.writeFileSync(RUNNER_LOG, "", "utf-8");
}

function writeQueueFile(r: Runner, name: string, body: unknown): string {
  fs.mkdirSync(r.QUEUE_DIR, { recursive: true });
  const p = path.join(r.QUEUE_DIR, name);
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n", "utf-8");
  return p;
}

function readRunJson(r: Runner, id: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(r.RUNS_DIR, `${id}.json`), "utf-8"));
}
function readRunMd(r: Runner, id: string): string {
  return mask(fs.readFileSync(path.join(r.RUNS_DIR, `${id}.md`), "utf-8"));
}
function runMdExists(r: Runner, id: string): boolean {
  return fs.existsSync(path.join(r.RUNS_DIR, `${id}.md`));
}
function readLog(): string {
  return mask(fs.readFileSync(RUNNER_LOG, "utf-8"));
}
function readArgvRaw(): string {
  return mask(fs.readFileSync(ARGV_FILE, "utf-8"));
}
/** One entry per fake-claude invocation: { pwd, argv } (prompt newlines intact). */
function parseArgv(): { pwd: string; argv: string[] }[] {
  return readArgvRaw()
    .split("<<END>>\n")
    .filter((b) => b.length > 0)
    .map((block) => {
      const parts = block.split("<<ARG>>\n");
      return {
        pwd: parts[0].replace(/^pwd: /, "").replace(/\n$/, ""),
        argv: parts.slice(1).map((a) => a.replace(/\n$/, "")),
      };
    });
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function resetScheduler(r: Runner): void {
  r.pending.length = 0;
  r.inFlight.clear();
  r.processing.clear();
}
function seedQueue(r: Runner, files: Record<string, unknown>): void {
  fs.rmSync(r.QUEUE_DIR, { recursive: true, force: true });
  fs.mkdirSync(r.QUEUE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeQueueFile(r, name, body);
}

/** Import the runner in a child process with an explicit env, print the
 *  values that are fixed at module load. */
function runnerInChild(env: Record<string, string>): { model: string; vault: string } {
  const script = `import(${JSON.stringify(RUNNER_URL)}).then((m) => process.stdout.write(JSON.stringify({ model: m.CLAUDE_MODEL, vault: m.VAULT_ROOT })))`;
  const out = execFileSync(process.execPath, ["-e", script], {
    env: {
      RUNNER_NO_BOOT: "1",
      RUNNER_LOG: "/dev/null",
      HOME: FIXTURE_HOME,
      USERPROFILE: FIXTURE_HOME,
      PATH: ORIGINAL_PATH,
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    encoding: "utf-8",
    timeout: 30_000,
  });
  const parsed = JSON.parse(out) as { model: string; vault: string };
  return { model: parsed.model, vault: mask(parsed.vault) };
}

before(() => {
  buildFixtureVault();
  freezeClock();
  REAL_ROOT = fs.realpathSync(FIXTURE_ROOT);
  installFakeClaude();
});
after(() => {
  process.env.PATH = ORIGINAL_PATH;
  thawClock();
  destroyFixtureVault();
});

// ---------------------------------------------------------------------------
// 1. buildPrompt
// ---------------------------------------------------------------------------

const FIXED_SKILLS = ["plan-today", "plan-tomorrow", "morning-report", "inbox-brief", "vault-cleanup"] as const;

test("buildPrompt: every fixed skill's prompt verbatim, deliverable from deliverablePathFor", async () => {
  const r = await loadRunner();
  for (const skill of FIXED_SKILLS) {
    const intent = { id: "aabbccdd-fixed-id", skill, args: {} };
    const deliverable = r.deliverablePathFor(intent);
    const prompt = r.buildPrompt(intent, deliverable);
    assert.ok(prompt?.startsWith(r.AUTONOMOUS_PREFIX), `${skill} prompt starts with AUTONOMOUS_PREFIX`);
    expectGolden(`runner/prompt-${skill}`, prompt);
  }
});

test("buildPrompt: voice-ask JSON-quotes the trimmed ask, adds a context block only when context is non-blank, ignores args.model", async () => {
  const r = await loadRunner();
  const base = { id: "aabbccdd-voice", skill: "voice-ask" };
  const plainIntent = { ...base, args: { prompt: "  Draft a reply to the sponsor email  " } };
  const plain = r.buildPrompt(plainIntent, r.deliverablePathFor(plainIntent));
  expectGolden("runner/prompt-voice-ask-plain", plain);

  const ctxIntent = {
    ...base,
    args: { prompt: "and send it", context: "\nUser: any news on fable\nJarvis: Working on it.\n\n" },
  };
  expectGolden("runner/prompt-voice-ask-with-context", r.buildPrompt(ctxIntent, r.deliverablePathFor(ctxIntent)));

  const escIntent = {
    ...base,
    args: { prompt: 'say "hi"\nthen a\tnew line \\ backslash', context: "   " },
  };
  expectGolden("runner/prompt-voice-ask-escaped", r.buildPrompt(escIntent, r.deliverablePathFor(escIntent)));

  const modelIntent = { ...base, args: { prompt: "  Draft a reply to the sponsor email  ", model: "claude-sonnet-4-6" } };
  assert.equal(r.buildPrompt(modelIntent, r.deliverablePathFor(modelIntent)), plain, "args.model never reaches the prompt");
});

test("buildPrompt: empty/whitespace ask, missing args/prompt, unknown or missing skill all yield null", async () => {
  const r = await loadRunner();
  const d = "inbox/voice/2026-09-09-ask-aabbccdd.md";
  const planPlain = r.buildPrompt({ id: "aabbccdd-x", skill: "plan-today", args: {} }, "daily-notes/2026-09-09.md");
  expectGolden("runner/prompt-null-cases", {
    voiceAskEmptyPrompt: r.buildPrompt({ id: "aabbccdd-x", skill: "voice-ask", args: { prompt: "" } }, d),
    voiceAskWhitespacePrompt: r.buildPrompt({ id: "aabbccdd-x", skill: "voice-ask", args: { prompt: " \t\n " } }, d),
    voiceAskArgsMissing: r.buildPrompt({ id: "aabbccdd-x", skill: "voice-ask" }, d),
    voiceAskPromptMissing: r.buildPrompt({ id: "aabbccdd-x", skill: "voice-ask", args: { context: "hi" } }, d),
    unknownSkill: r.buildPrompt({ id: "aabbccdd-x", skill: "make-coffee", args: {} }, "x.md"),
    skillMissing: r.buildPrompt({ id: "aabbccdd-x", args: {} }, "x.md"),
    planTodayArgsMissingEqualsWithArgs:
      r.buildPrompt({ id: "aabbccdd-x", skill: "plan-today" }, "daily-notes/2026-09-09.md") === planPlain,
    nullDeliverableIsInterpolatedVerbatim:
      r.buildPrompt({ id: "aabbccdd-x", skill: "vault-cleanup", args: {} }, null)?.includes("report at exactly null."),
  });
});

// ---------------------------------------------------------------------------
// 2. deliverablePathFor
// ---------------------------------------------------------------------------

test("deliverablePathFor: per-skill paths, id8 slicing, prompt slug, null for unknown skills", async () => {
  const r = await loadRunner();
  const LONG = "abcdef1234567890-long-id";
  const at = (skill: string) => r.deliverablePathFor({ id: LONG, skill, args: {} });
  const voice = (args: unknown) => r.deliverablePathFor({ id: LONG, skill: "voice-ask", args });
  const longPrompt = "Please summarize everything that happened this week across all my channels and projects in detail";
  const longSlug = voice({ prompt: longPrompt });
  expectGolden("runner/deliverable-paths", {
    "plan-today": at("plan-today"),
    "plan-tomorrow": at("plan-tomorrow"),
    "morning-report": at("morning-report"),
    "inbox-brief": at("inbox-brief"),
    "vault-cleanup": at("vault-cleanup"),
    "voice-ask": voice({ prompt: "Summarize my week in three bullets" }),
    "unknown-skill": at("make-coffee"),
    "skill-missing": r.deliverablePathFor({ id: LONG }),
    idVariants: {
      shortId: r.deliverablePathFor({ id: "ab", skill: "inbox-brief" }),
      exactlyEight: r.deliverablePathFor({ id: "12345678", skill: "inbox-brief" }),
      missingId: r.deliverablePathFor({ skill: "inbox-brief" }),
      emptyId: r.deliverablePathFor({ id: "", skill: "inbox-brief" }),
      numericId: throwsWith(() => r.deliverablePathFor({ id: 12345678, skill: "inbox-brief" })),
      planTodayIgnoresId: r.deliverablePathFor({ skill: "plan-today" }),
    },
    voiceAskPromptVariants: {
      long: longSlug,
      longSlugLength: longSlug?.split("/").pop()?.replace(/^2026-09-09-/, "").replace(/-abcdef12\.md$/, "").length,
      unicode: voice({ prompt: "Héllo Wörld — café ☕ naïve" }),
      punctuation: voice({ prompt: "What's the weather?! (today) [now] #1 & done." }),
      missingPrompt: voice({}),
      argsMissing: r.deliverablePathFor({ id: LONG, skill: "voice-ask" }),
      emptyPrompt: voice({ prompt: "" }),
      whitespacePrompt: voice({ prompt: "   " }),
      onlyPunctuation: voice({ prompt: "?!?" }),
    },
  });
});

// ---------------------------------------------------------------------------
// 3. slugify
// ---------------------------------------------------------------------------

test("slugify: lowercases, strips non [a-z0-9 -], collapses whitespace, truncates to max, falls back to 'untitled'", async () => {
  const r = await loadRunner();
  const cases: { label: string; input: unknown; max?: number }[] = [
    { label: "simple", input: "Hello World" },
    { label: "leading/trailing spaces", input: "  leading and trailing  " },
    { label: "tabs and newlines", input: "multiple   spaces\tand\nnewlines" },
    { label: "unicode stripped", input: "Héllo Wörld — café" },
    { label: "apostrophe and punctuation", input: "what's the weather?!" },
    { label: "hyphens and digits kept", input: "keep-hyphens-and-123" },
    { label: "only hyphens", input: "---" },
    { label: "hyphen padded", input: " - a - " },
    { label: "uppercase", input: "UPPER" },
    { label: "slashes and dots", input: "a/b\\c.d" },
    { label: "emoji", input: "😀 emoji only" },
    { label: "empty", input: "" },
    { label: "whitespace only", input: "   " },
    { label: "only punctuation", input: "?!?" },
    { label: "null", input: null },
    { label: "undefined", input: undefined },
    { label: "60 chars, default max 48", input: "abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefgh" },
    { label: "max 5", input: "hello world", max: 5 },
    { label: "max cuts on a dash", input: "aaaa bbbb", max: 5 },
    { label: "max 0", input: "hello", max: 0 },
    { label: "max 1", input: "hello", max: 1 },
    { label: "negative max", input: "hello world", max: -3 },
  ];
  const out: Record<string, unknown> = {};
  for (const c of cases) {
    out[c.label] = c.max === undefined ? r.slugify(c.input) : r.slugify(c.input, c.max);
  }
  out["number input"] = throwsWith(() => r.slugify(123));
  expectGolden("runner/slugify-matrix", out);
});

// ---------------------------------------------------------------------------
// 4. todayDate / tomorrowDate
// ---------------------------------------------------------------------------

test("todayDate/tomorrowDate are HUD_TZ-local across the UTC boundary, month end, year end, February", async () => {
  const r = await loadRunner();
  const instants: Record<string, string> = {
    "2026-09-09T15:30:00Z = 10:30 CDT Wed": "2026-09-09T15:30:00Z",
    "2026-09-10T04:30:00Z = 23:30 CDT Sep 9 (UTC already Sep 10)": "2026-09-10T04:30:00Z",
    "2026-09-09T05:30:00Z = 00:30 CDT Sep 9": "2026-09-09T05:30:00Z",
    "2026-10-01T03:00:00Z = 22:00 CDT Sep 30 (month end)": "2026-10-01T03:00:00Z",
    "2027-01-01T02:00:00Z = 20:00 CST Dec 31 2026 (year end)": "2027-01-01T02:00:00Z",
    "2026-03-01T05:00:00Z = 23:00 CST Feb 28 2026": "2026-03-01T05:00:00Z",
  };
  const out: Record<string, { today: string; tomorrow: string }> = {};
  try {
    for (const [label, iso] of Object.entries(instants)) {
      thawClock();
      freezeClock(Date.parse(iso));
      out[label] = { today: r.todayDate(), tomorrow: r.tomorrowDate() };
    }
  } finally {
    thawClock();
    freezeClock();
  }
  expectGolden("runner/dates-by-instant", out);
});

// ---------------------------------------------------------------------------
// 5. modelFor + constants
// ---------------------------------------------------------------------------

test("modelFor: allowlisted args.model wins, anything else (or no args) is CLAUDE_MODEL", async () => {
  const r = await loadRunner();
  const out: Record<string, unknown> = {};
  for (const m of [...r.MODEL_ALLOWLIST].sort()) out[`allowlisted:${m}`] = r.modelFor({ args: { model: m } });
  out["disallowed:gpt-5"] = r.modelFor({ args: { model: "gpt-5" } });
  out["disallowed:claude-opus-4-1"] = r.modelFor({ args: { model: "claude-opus-4-1" } });
  out["case-sensitive:Claude-Opus-5"] = r.modelFor({ args: { model: "Claude-Opus-5" } });
  out["padded:' claude-opus-5 '"] = r.modelFor({ args: { model: " claude-opus-5 " } });
  out["non-string:number"] = r.modelFor({ args: { model: 42 } });
  out["non-string:null"] = r.modelFor({ args: { model: null } });
  out["non-string:object"] = r.modelFor({ args: { model: { name: "claude-opus-5" } } });
  out["model missing"] = r.modelFor({ args: {} });
  out["args missing"] = r.modelFor({ skill: "voice-ask" });
  out["intent undefined"] = r.modelFor(undefined);
  out["intent null"] = r.modelFor(null);
  expectGolden("runner/model-for", out);
});

test("constants: model default + allowlist, concurrency sets, HUD_TZ, and paths resolved under the fixture vault", async () => {
  const r = await loadRunner();
  assert.equal(r.VAULT_ROOT, FIXTURE_ROOT);
  expectGolden("runner/constants", {
    CLAUDE_MODEL: r.CLAUDE_MODEL,
    MODEL_ALLOWLIST: [...r.MODEL_ALLOWLIST].sort(),
    MAX_CONCURRENT: r.MAX_CONCURRENT,
    SERIAL_SKILLS: [...r.SERIAL_SKILLS].sort(),
    DEDUPE_SKILLS: [...r.DEDUPE_SKILLS].sort(),
    LONG_SKILLS: [...r.LONG_SKILLS].sort(),
    HUD_TZ: r.HUD_TZ,
    VAULT_ROOT: r.VAULT_ROOT,
    QUEUE_DIR: r.QUEUE_DIR,
    RUNS_DIR: r.RUNS_DIR,
    STATUS_FILE: r.STATUS_FILE,
    RUNNER_LOG: r.RUNNER_LOG,
  });
  expectGolden("runner/autonomous-prefix", r.AUTONOMOUS_PREFIX);
});

// ---------------------------------------------------------------------------
// 6. writeHeartbeat / log / ensureDirs
// ---------------------------------------------------------------------------

function readHeartbeat(r: Runner): unknown {
  const hb = JSON.parse(fs.readFileSync(r.STATUS_FILE, "utf-8")) as Record<string, unknown>;
  assert.equal(hb.pid, process.pid);
  hb.pid = "<PID>";
  return hb;
}

test("writeHeartbeat: STATUS_FILE shape when idle and when pending/inFlight are seeded (busy tracks active, not inFlight)", async () => {
  const r = await loadRunner();
  resetScheduler(r);
  r.writeHeartbeat();
  const rawIdle = fs.readFileSync(r.STATUS_FILE, "utf-8");
  assert.ok(rawIdle.endsWith("}\n"), "pretty JSON with trailing newline");
  expectGolden("runner/heartbeat-idle", readHeartbeat(r));

  r.pending.push("zz-later.json", "aa-earlier.json");
  r.inFlight.add("inbox-brief");
  r.inFlight.add("voice-ask");
  r.writeHeartbeat();
  expectGolden("runner/heartbeat-seeded", readHeartbeat(r));
  resetScheduler(r);
});

test("log: appends '[<iso>] <msg>' to RUNNER_LOG", async () => {
  const r = await loadRunner();
  fs.writeFileSync(RUNNER_LOG, "", "utf-8");
  r.log("hello from the suite");
  r.log("");
  expectGolden("runner/log-lines", readLog());
});

test("ensureDirs: creates system/queue and system/runs when missing, idempotent when present", async () => {
  const r = await loadRunner();
  fs.rmSync(r.QUEUE_DIR, { recursive: true, force: true });
  assert.equal(fs.existsSync(r.QUEUE_DIR), false);
  r.ensureDirs();
  assert.ok(fs.existsSync(r.QUEUE_DIR));
  assert.ok(fs.existsSync(r.RUNS_DIR));
  r.ensureDirs();
  assert.ok(fs.existsSync(r.QUEUE_DIR));
});

// ---------------------------------------------------------------------------
// 7. Env precedence at module load (child processes)
// ---------------------------------------------------------------------------

test("env: AGENTIC_OS_MODEL overrides CLAUDE_MODEL unchecked; VAULT_ROOT > AGENTIC_OS_VAULT > ../starter-vault; ~/.claude/.env is a fallback", () => {
  const envFile = path.join(FIXTURE_HOME, ".claude", ".env");
  const out: Record<string, unknown> = {};
  try {
    out.sonnet = runnerInChild({ VAULT_ROOT: FIXTURE_ROOT, AGENTIC_OS_MODEL: "claude-sonnet-4-6" });
    out.bogusModel = runnerInChild({ VAULT_ROOT: FIXTURE_ROOT, AGENTIC_OS_MODEL: "not-a-real-model" });
    out.emptyModel = runnerInChild({ VAULT_ROOT: FIXTURE_ROOT, AGENTIC_OS_MODEL: "" });
    out.unset = runnerInChild({ VAULT_ROOT: FIXTURE_ROOT });
    out.agenticOsVaultFallback = runnerInChild({ AGENTIC_OS_VAULT: path.join(FIXTURE_ROOT, "alt-vault") });
    out.vaultRootWinsOverAgenticOsVault = runnerInChild({
      VAULT_ROOT: FIXTURE_ROOT,
      AGENTIC_OS_VAULT: path.join(FIXTURE_ROOT, "alt-vault"),
    });
    out.neitherSetUsesStarterVault = runnerInChild({});

    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(
      envFile,
      [
        "# comment line",
        "",
        "not-a-pair",
        'AGENTIC_OS_MODEL="claude-haiku-4-5-20251001"',
        `VAULT_ROOT='${path.join(FIXTURE_ROOT, "env-file-vault")}'`,
        "HUD_TZ = Europe/London ",
        "",
      ].join("\n"),
      "utf-8"
    );
    out.envFileRead = runnerInChild({});
    out.processEnvBeatsEnvFile = runnerInChild({ AGENTIC_OS_MODEL: "claude-opus-4-8" });
  } finally {
    fs.rmSync(path.join(FIXTURE_HOME, ".claude"), { recursive: true, force: true });
  }
  expectGolden("runner/env-precedence", out);
});

// ---------------------------------------------------------------------------
// 8. processOne lifecycle against the fake claude
// ---------------------------------------------------------------------------

test("processOne: inbox-brief ok — run record, run log, CLI contract (argv + cwd), queue file unlinked", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    const qp = writeQueueFile(r, "job-inbox-ok.json", {
      id: "aabbccdd-inbox-ok",
      skill: "inbox-brief",
      args: {},
      ts: "2026-09-09T15:29:00.000Z",
      source: "vault-hud",
    });
    const ret = await r.processOne("job-inbox-ok.json");
    assert.equal(ret, undefined);
    assert.equal(fs.existsSync(qp), false, "queue file is unlinked after the run");
    expectGolden("runner/job-inbox-ok-run", readRunJson(r, "aabbccdd-inbox-ok"));
    expectGolden("runner/job-inbox-ok-md", readRunMd(r, "aabbccdd-inbox-ok"));
    expectGolden("runner/job-inbox-ok-argv", readArgvRaw());
    expectGolden("runner/job-inbox-ok-log", readLog());
    const [call] = parseArgv();
    assert.equal(call.pwd, "<VAULT>", "claude runs with cwd = VAULT_ROOT");
    assert.deepEqual(
      [call.argv[0], call.argv[2], call.argv[3], call.argv[4], call.argv.length],
      ["-p", "--model", "claude-opus-5", "--dangerously-skip-permissions", 5]
    );
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: non-zero exit → status error, exit_code echoed, summary still the first non-warning line", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  fs.writeFileSync(EXIT_FILE, "1\n");
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    writeQueueFile(r, "job-exit1.json", {
      id: "aabbccdd-exit1",
      skill: "vault-cleanup",
      args: {},
      ts: "2026-09-09T15:29:30.000Z",
      source: "vault-hud",
    });
    await r.processOne("job-exit1.json");
    expectGolden("runner/job-exit1-run", readRunJson(r, "aabbccdd-exit1"));
    expectGolden("runner/job-exit1-md-footer", readRunMd(r, "aabbccdd-exit1").split("\n---\n").pop());
    expectGolden("runner/job-exit1-log", readLog());
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: output that is only Warning: lines → summary falls back to the first non-empty line", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  fs.writeFileSync(STDOUT_FILE, "\n\nWarning: only warnings here\nwarning: lowercase too\n");
  fs.writeFileSync(STDERR_FILE, "");
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    writeQueueFile(r, "job-warnings.json", { id: "aabbccdd-warnings", skill: "morning-report", args: {}, ts: "2026-09-09T15:29:40.000Z" });
    await r.processOne("job-warnings.json");
    expectGolden("runner/job-warnings-only-run", readRunJson(r, "aabbccdd-warnings"));

    // Indented "Warning:" does not match the prefix test — it wins as the spoken line.
    resetJobFixtures();
    fs.writeFileSync(STDOUT_FILE, "Warning: real warning\n   Warning: indented\nSAVED x.md\n");
    fs.writeFileSync(STDERR_FILE, "");
    writeQueueFile(r, "job-warnings-2.json", { id: "aabbccdd-warnings2", skill: "morning-report", args: {}, ts: "2026-09-09T15:29:41.000Z" });
    await r.processOne("job-warnings-2.json");
    expectGolden("runner/job-warnings-indented-run", readRunJson(r, "aabbccdd-warnings2"));
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: empty output → '(no output)'; intent without id/ts → runId from file name, ts_queued = ts_started", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  fs.writeFileSync(STDOUT_FILE, "");
  fs.writeFileSync(STDERR_FILE, "");
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    writeQueueFile(r, "job-empty-output.json", { skill: "plan-tomorrow", args: { note: "no id, no ts" } });
    await r.processOne("job-empty-output.json");
    expectGolden("runner/job-empty-output-run", readRunJson(r, "job-empty-output"));
    expectGolden("runner/job-empty-output-md", readRunMd(r, "job-empty-output"));
    expectGolden("runner/job-empty-output-log", readLog());
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: voice-ask args.model in the allowlist reaches --model; a disallowed one falls back to the default", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    writeQueueFile(r, "job-voice-allowed.json", {
      id: "aabbccdd-voice-allowed",
      skill: "voice-ask",
      args: { prompt: "Draft a reply to the sponsor email", model: "claude-sonnet-4-6" },
      ts: "2026-09-09T15:29:50.000Z",
      source: "voice-ptt",
    });
    await r.processOne("job-voice-allowed.json");
    writeQueueFile(r, "job-voice-disallowed.json", {
      id: "aabbccdd-voice-disallowed",
      skill: "voice-ask",
      args: { prompt: "Draft a reply to the sponsor email", model: "gpt-5" },
      ts: "2026-09-09T15:29:51.000Z",
      source: "voice-ptt",
    });
    await r.processOne("job-voice-disallowed.json");
    const [allowed, disallowed] = parseArgv();
    expectGolden("runner/job-voice-model-argv", { allowed, disallowed });
    expectGolden("runner/job-voice-model-runs", {
      allowed: readRunJson(r, "aabbccdd-voice-allowed"),
      disallowed: readRunJson(r, "aabbccdd-voice-disallowed"),
    });
    expectGolden("runner/job-voice-model-log", readLog());
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: unparseable queue file → 5 retries, error record exit_code -3 with skill '(unknown)', no md, queue file removed", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    const qp1 = writeQueueFile(r, "job-bad-json.json", "{not json");
    const t0 = Date.now(); // frozen — proves nothing about elapsed time; wall clock below
    const wall0 = process.hrtime.bigint();
    await r.processOne("job-bad-json.json");
    const elapsedMs = Number(process.hrtime.bigint() - wall0) / 1e6;
    assert.ok(elapsedMs >= 2000, `retry backoff is ~2.25s of real time (got ${elapsedMs.toFixed(0)}ms)`);
    assert.equal(Date.now(), t0);
    assert.equal(fs.existsSync(qp1), false);
    assert.equal(runMdExists(r, "job-bad-json"), false);
    expectGolden("runner/job-bad-json-run", readRunJson(r, "job-bad-json"));

    const qp2 = writeQueueFile(r, "job-empty-file.json", "");
    await r.processOne("job-empty-file.json");
    assert.equal(fs.existsSync(qp2), false);
    expectGolden("runner/job-empty-file-run", readRunJson(r, "job-empty-file"));
    expectGolden("runner/job-bad-json-log", readLog());
    assert.equal(fs.existsSync(ARGV_FILE), false, "claude is never spawned for a bad intent");
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: unknown skill (and voice-ask with a blank ask) → rejected record exit_code -1, no md, queue file removed, claude not spawned", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH}`;
  try {
    const qp = writeQueueFile(r, "job-unknown.json", {
      id: "aabbccdd-unknown",
      skill: "make-coffee",
      args: { size: "large" },
      ts: "2026-09-09T15:29:55.000Z",
      source: "vault-hud",
    });
    await r.processOne("job-unknown.json");
    assert.equal(fs.existsSync(qp), false);
    assert.equal(runMdExists(r, "aabbccdd-unknown"), false);
    expectGolden("runner/job-unknown-skill-run", readRunJson(r, "aabbccdd-unknown"));

    const qp2 = writeQueueFile(r, "job-blank-ask.json", {
      id: "aabbccdd-blank-ask",
      skill: "voice-ask",
      args: { prompt: "   " },
      ts: "2026-09-09T15:29:56.000Z",
      source: "voice-ptt",
    });
    await r.processOne("job-blank-ask.json");
    assert.equal(fs.existsSync(qp2), false);
    assert.equal(runMdExists(r, "aabbccdd-blank-ask"), false);
    expectGolden("runner/job-blank-ask-run", readRunJson(r, "aabbccdd-blank-ask"));
    expectGolden("runner/job-rejected-log", readLog());
    assert.equal(fs.existsSync(ARGV_FILE), false, "claude is never spawned for a rejected intent");
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: claude missing from PATH → spawn error record (exit_code -2), then the close(-2) event rewrites it", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  process.env.PATH = EMPTY_BIN_DIR;
  try {
    const qp = writeQueueFile(r, "job-spawn-error.json", {
      id: "aabbccdd-spawn-error",
      skill: "plan-today",
      args: {},
      ts: "2026-09-09T15:29:58.000Z",
      source: "vault-hud",
    });
    await r.processOne("job-spawn-error.json");
    // processOne resolves from the 'error' handler (nextTick); the record at
    // this instant is the spawn-error one.
    const immediate = readRunJson(r, "aabbccdd-spawn-error");
    assert.equal(fs.existsSync(qp), false);
    await sleep(300);
    // Node also emits 'close' with code -2 for ENOENT; the close handler then
    // overwrites summary/exit_code and appends a second footer.
    const settled = readRunJson(r, "aabbccdd-spawn-error");
    expectGolden("runner/job-spawn-error-run-immediate", immediate);
    expectGolden("runner/job-spawn-error-run-settled", settled);
    expectGolden("runner/job-spawn-error-md-settled", readRunMd(r, "aabbccdd-spawn-error"));
    expectGolden("runner/job-spawn-error-log", readLog());
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("processOne: a queue file that does not exist is a no-op", async () => {
  const r = await loadRunner();
  resetJobFixtures();
  const runsBefore = fs.readdirSync(r.RUNS_DIR).sort();
  const ret = await r.processOne("does-not-exist.json");
  assert.equal(ret, undefined);
  assert.deepEqual(fs.readdirSync(r.RUNS_DIR).sort(), runsBefore);
  assert.equal(fs.readFileSync(RUNNER_LOG, "utf-8"), "");
});

// ---------------------------------------------------------------------------
// 9. Queue scheduler: enqueueNew / peekSkill / pickNext
// ---------------------------------------------------------------------------

const QUEUE_SEED: Record<string, unknown> = {
  "01-plan-today.json": { id: "q01", skill: "plan-today", args: {} },
  "02-plan-tomorrow.json": { id: "q02", skill: "plan-tomorrow", args: {} },
  "03-morning-report.json": { id: "q03", skill: "morning-report", args: {} },
  "04-inbox-brief.json": { id: "q04", skill: "inbox-brief", args: {} },
  "05-voice-ask.json": { id: "q05", skill: "voice-ask", args: { prompt: "hi" } },
  "06-no-skill.json": { id: "q06", args: {} },
  "07-empty-skill.json": { id: "q07", skill: "", args: {} },
  "08-bad.json": "{not json",
  "notes.txt": "not a queue file",
  "09-unknown-skill.json": { id: "q09", skill: "make-coffee", args: {} },
};

test("enqueueNew: adds every *.json in readdir order, never duplicates, skips names in processing, tolerates a missing dir", async () => {
  const r = await loadRunner();
  resetScheduler(r);
  seedQueue(r, QUEUE_SEED);
  r.enqueueNew();
  const first = [...r.pending];
  assert.deepEqual(
    first,
    fs.readdirSync(r.QUEUE_DIR).filter((f) => f.endsWith(".json")),
    "pending mirrors readdir order (no sort of its own)"
  );
  r.enqueueNew();
  const second = [...r.pending];

  resetScheduler(r);
  r.processing.add("03-morning-report.json");
  r.pending.push("zz-already-pending.json");
  r.enqueueNew();
  const withGuards = [...r.pending];

  resetScheduler(r);
  fs.rmSync(r.QUEUE_DIR, { recursive: true, force: true });
  r.enqueueNew();
  const missingDir = [...r.pending];
  r.ensureDirs();

  expectGolden("runner/queue-enqueue", {
    firstSorted: [...first].sort(),
    secondCallIsIdentical: JSON.stringify(second) === JSON.stringify(first),
    withProcessingGuardSorted: [...withGuards].sort(),
    missingDir,
  });
  resetScheduler(r);
});

test("peekSkill: skill string from a readable intent, null for missing/empty skill, bad JSON, or a missing file", async () => {
  const r = await loadRunner();
  seedQueue(r, QUEUE_SEED);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(QUEUE_SEED)) out[name] = r.peekSkill(name);
  out["does-not-exist.json"] = r.peekSkill("does-not-exist.json");
  expectGolden("runner/queue-peek-skill", out);
});

test("pickNext: first runnable index; serial skills share one slot, dedupe skills refuse a duplicate, unreadable files are skipped, -1 when nothing runs", async () => {
  const r = await loadRunner();
  seedQueue(r, QUEUE_SEED);
  const scenarios: { label: string; pending: string[]; inFlight: string[] }[] = [
    { label: "nothing in flight, full queue", pending: Object.keys(QUEUE_SEED).filter((f) => f.endsWith(".json")), inFlight: [] },
    { label: "plan-today pending while plan-tomorrow in flight (serial) → skips to morning-report", pending: ["01-plan-today.json", "03-morning-report.json"], inFlight: ["plan-tomorrow"] },
    { label: "plan-tomorrow pending while plan-today in flight (serial)", pending: ["02-plan-tomorrow.json", "05-voice-ask.json"], inFlight: ["plan-today"] },
    { label: "plan-today pending while plan-today in flight (serial, same skill)", pending: ["01-plan-today.json"], inFlight: ["plan-today"] },
    { label: "morning-report pending while morning-report in flight (dedupe) → inbox-brief", pending: ["03-morning-report.json", "04-inbox-brief.json"], inFlight: ["morning-report"] },
    { label: "inbox-brief pending while inbox-brief in flight (dedupe) → voice-ask", pending: ["04-inbox-brief.json", "05-voice-ask.json"], inFlight: ["inbox-brief"] },
    { label: "morning-report pending while inbox-brief in flight (different dedupe skill) → runs", pending: ["03-morning-report.json"], inFlight: ["inbox-brief"] },
    { label: "voice-ask pending while voice-ask in flight (neither set) → runs", pending: ["05-voice-ask.json"], inFlight: ["voice-ask"] },
    { label: "serial busy + dedupe busy → -1", pending: ["01-plan-today.json", "03-morning-report.json"], inFlight: ["plan-tomorrow", "morning-report"] },
    { label: "only unreadable / skill-less files → -1", pending: ["08-bad.json", "06-no-skill.json", "07-empty-skill.json", "missing.json"], inFlight: [] },
    { label: "unreadable first, runnable second → 1", pending: ["08-bad.json", "05-voice-ask.json"], inFlight: [] },
    { label: "unknown skill name is still picked (validation happens in processOne)", pending: ["09-unknown-skill.json"], inFlight: [] },
    { label: "empty pending → -1", pending: [], inFlight: [] },
    { label: "pending order decides, not file name order", pending: ["05-voice-ask.json", "01-plan-today.json"], inFlight: [] },
  ];
  const out: Record<string, number> = {};
  for (const s of scenarios) {
    resetScheduler(r);
    r.pending.push(...s.pending);
    for (const skill of s.inFlight) r.inFlight.add(skill);
    out[s.label] = r.pickNext();
  }
  resetScheduler(r);
  expectGolden("runner/queue-pick-next", out);
});
