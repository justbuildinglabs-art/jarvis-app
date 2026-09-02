#!/usr/bin/env node
// One-command setup for a fresh machine.
//
//   node scripts/setup.mjs              deps, env file, config marker
//   node scripts/setup.mjs --voice      also the voice stack (~353MB download)
//   node scripts/setup.mjs --all        everything, no prompts
//   node scripts/setup.mjs --dry-run    show what would happen
//
// Safe to re-run. Every step checks first and skips if already done, and
// nothing that could hold a secret or user data is ever overwritten.
//
// Platform differences are handled here rather than in documentation, because
// the README's install line is Windows/CUDA-specific and silently wrong
// everywhere else: on Apple Silicon the nvidia-* packages do not exist, and
// installing plain onnxruntime is required rather than optional.

import { existsSync, mkdirSync, writeFileSync, chmodSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_ENV_DIR = join(homedir(), ".claude");
const HOME_ENV = join(HOME_ENV_DIR, ".env");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const WANT_VOICE = args.has("--voice") || args.has("--all");
const PLATFORM = platform();
const IS_WIN = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";

let stepNo = 0;
const done = [];
const skipped = [];
const manual = [];

function step(msg) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${msg}`);
}
function ok(msg) {
  console.log(`    ok   ${msg}`);
  done.push(msg);
}
function skip(msg) {
  console.log(`    --   ${msg}`);
  skipped.push(msg);
}
function todo(msg) {
  console.log(`    >>   ${msg}`);
  manual.push(msg);
}
function fail(msg) {
  console.log(`    !!   ${msg}`);
}

function run(cmd, cmdArgs, opts = {}) {
  if (DRY) {
    console.log(`    (dry-run) ${cmd} ${cmdArgs.join(" ")}`);
    return { status: 0, stdout: "" };
  }
  return spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", stdio: "inherit", ...opts });
}

function which(bin) {
  try {
    return execFileSync(IS_WIN ? "where" : "which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")[0]
      .trim();
  } catch {
    return null;
  }
}

/**
 * Pick a Python for the voice venv.
 *
 * Newest is not best: the audio stack depends on compiled wheels (onnxruntime,
 * numpy, soundfile) and the newest Python release routinely lacks them for
 * weeks. Prefer versions with settled wheel coverage and fall back outward.
 */
function pickPython() {
  for (const candidate of ["python3.12", "python3.13", "python3.11", "python3.10", "python3", "python"]) {
    const p = which(candidate);
    if (!p) continue;
    try {
      const v = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim();
      const m = v.match(/(\d+)\.(\d+)/);
      if (m && Number(m[1]) === 3 && Number(m[2]) >= 10) return { bin: candidate, version: v };
    } catch {}
  }
  return null;
}

/** Is there an NVIDIA GPU worth installing the CUDA stack for? */
function hasNvidia() {
  if (IS_MAC) return false; // no CUDA on Apple Silicon, ever
  return Boolean(which("nvidia-smi"));
}

console.log(`Jarvis App setup — ${PLATFORM}/${arch()}${DRY ? "  (dry run)" : ""}`);

// --- 1. runtime prerequisites ------------------------------------------------

step("Checking prerequisites");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  fail(`Node ${process.versions.node} is too old; need 20+. Stopping.`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

if (which("claude")) {
  ok("claude CLI found");
} else {
  todo("claude CLI not on PATH — install Claude Code and sign in. The runner needs it to execute jobs.");
}

// --- 2. node dependencies ----------------------------------------------------

step("Installing Node dependencies");
if (existsSync(join(ROOT, "node_modules"))) {
  skip("node_modules already present");
} else {
  const r = run("npm", ["install"]);
  if (r.status === 0) ok("npm install complete");
  else fail("npm install failed — see output above");
}

// --- 3. key/config file ------------------------------------------------------

step("Setting up ~/.claude/.env");
if (existsSync(HOME_ENV)) {
  // Never rewrite this file: it holds the user's keys.
  skip(`${HOME_ENV} already exists — leaving it untouched`);
} else if (DRY) {
  console.log(`    (dry-run) would create ${HOME_ENV}`);
} else {
  mkdirSync(HOME_ENV_DIR, { recursive: true });
  writeFileSync(
    HOME_ENV,
    `# Jarvis App keys and settings.
# Read by the HUD (lib/homeEnv.ts) and the runner daemon (runner/runner.js).
#
# Parser rules — stricter than a normal .env:
#   KEY=value       uppercase, digits and underscore only
#   no "export" prefix, no spaces around =
#   quotes are stripped
#   a real shell environment variable WINS over this file
#
# Read once per process: restart the HUD and runner after editing.

# Optional. Routing fallthrough via the Anthropic API (~1s instead of ~11s).
# https://console.anthropic.com/settings/keys
# Billed separately from a Claude Code subscription.
ANTHROPIC_API_KEY=

# Point this at your own notes directory. Defaults to the bundled starter-vault.
# VAULT_ROOT=

# HUD_TZ must match between the HUD and the runner or "today" splits in two.
# HUD_TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
# HUD_USER_NAME=

# Router engine: auto | haiku | local | cli | rules
# VOICE_ROUTER=auto
# VOICE_ROUTER_MODEL=qwen2.5:3b     # when using Ollama

# KOKORO_VOICE=bm_george
${IS_MAC ? "WAKE_WORD=off   # needs portaudio + mic permission on macOS\n" : "# WAKE_WORD=off\n"}`,
    "utf8"
  );
  chmodSync(HOME_ENV, 0o600);
  ok(`created ${HOME_ENV} (mode 600)`);
  todo(`Add your key: open ${HOME_ENV} and set ANTHROPIC_API_KEY=  (optional — see the summary)`);
}

// --- 4. voice stack ----------------------------------------------------------

const VOICE_DIR = join(ROOT, "voice-server");
const VENV = join(VOICE_DIR, ".venv");
const venvBin = (name) => join(VENV, IS_WIN ? "Scripts" : "bin", IS_WIN ? `${name}.exe` : name);

const WEIGHTS = [
  { file: "kokoro-v1.0.onnx", minBytes: 300 * 1024 * 1024 },
  { file: "voices-v1.0.bin", minBytes: 20 * 1024 * 1024 },
];
const WEIGHTS_BASE =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";

if (!WANT_VOICE) {
  step("Voice stack");
  skip("skipped — re-run with --voice to install it (~353MB download)");
} else {
  step("Creating the voice virtualenv");
  const py = pickPython();
  if (!py) {
    fail("No suitable Python 3.10+ found. Install Python and re-run with --voice.");
  } else {
    ok(`using ${py.bin} (${py.version})`);
    if (existsSync(VENV)) {
      skip(".venv already exists");
    } else {
      const r = run(py.bin, ["-m", "venv", VENV]);
      if (r.status === 0) ok("virtualenv created");
      else fail("venv creation failed");
    }

    step("Installing the voice packages");
    const gpu = hasNvidia();
    const packages = [
      "kokoro-onnx",
      "fastapi",
      "uvicorn",
      "soundfile",
      "faster-whisper",
      ...(gpu
        ? [
            "onnxruntime-gpu",
            "nvidia-cudnn-cu12",
            "nvidia-cublas-cu12",
            "nvidia-cufft-cu12",
            "nvidia-cuda-runtime-cu12",
            "nvidia-curand-cu12",
          ]
        : ["onnxruntime"]),
    ];
    ok(gpu ? "NVIDIA GPU detected — installing the CUDA build" : "no NVIDIA GPU — installing the CPU build");
    const r = run(venvBin("pip"), ["install", "--quiet", ...packages]);
    if (r.status === 0) ok(`installed: ${packages.join(", ")}`);
    else fail("pip install failed — see output above");

    step("Downloading the Kokoro model weights (~353MB)");
    for (const { file, minBytes } of WEIGHTS) {
      const target = join(VOICE_DIR, file);
      if (existsSync(target) && statSync(target).size >= minBytes) {
        skip(`${file} already present (${(statSync(target).size / 1048576).toFixed(0)}MB)`);
        continue;
      }
      if (existsSync(target)) {
        // A short file is a failed download, not a model. Remove it — leaving
        // it causes a confusing failure deep inside onnxruntime later.
        unlinkSync(target);
        console.log(`    removed a truncated ${file}`);
      }
      if (DRY) {
        console.log(`    (dry-run) would download ${file}`);
        continue;
      }
      console.log(`    downloading ${file} ...`);
      const partial = `${target}.part`;
      const r2 = run("curl", ["-L", "--fail", "--progress-bar", "-o", partial, `${WEIGHTS_BASE}/${file}`]);
      if (r2.status === 0 && existsSync(partial) && statSync(partial).size >= minBytes) {
        renameSync(partial, target);
        ok(`${file} (${(statSync(target).size / 1048576).toFixed(0)}MB)`);
      } else {
        if (existsSync(partial)) unlinkSync(partial);
        fail(`${file} download failed or was truncated`);
      }
    }

    if (IS_MAC) {
      todo(
        "Wake word is off by default on macOS (set in ~/.claude/.env). Enabling it needs " +
          "`brew install portaudio`, the openwakeword packages, and mic permission."
      );
    }
  }
}

// --- 5. mark onboarded -------------------------------------------------------

step("Recording setup state");
const marker = join(ROOT, ".jarvis-config.json");
if (existsSync(marker)) {
  skip(".jarvis-config.json already present");
} else if (DRY) {
  console.log("    (dry-run) would write .jarvis-config.json");
} else {
  writeFileSync(
    marker,
    JSON.stringify(
      {
        setupVersion: 1,
        setupAt: new Date().toISOString(),
        platform: `${PLATFORM}/${arch()}`,
        node: process.versions.node,
        voiceInstalled: WANT_VOICE,
        // Never record the key itself — only whether one is configured.
        notes: "Written by scripts/setup.mjs. Delete to re-run onboarding.",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  ok("wrote .jarvis-config.json");
}

// --- summary -----------------------------------------------------------------

console.log(`\n${"-".repeat(64)}`);
console.log(`Setup finished — ${done.length} done, ${skipped.length} already in place.`);

if (manual.length) {
  console.log("\nNeeds you:");
  for (const m of manual) console.log(`  - ${m}`);
}

console.log(`
Start everything:
  ${IS_WIN ? "start-hud.vbs" : "npx next build && npx next start -p 4870"}
  node runner/runner.js${WANT_VOICE ? `\n  ${venvBin("python")} voice-server/server.py` : ""}

Then open http://localhost:4870 and hold Space to talk.
(The first sound needs one click in the tab — browser autoplay policy.)

Check anything: node scripts/doctor.mjs
`);

if (!DRY) {
  console.log("Running the doctor now:\n");
  spawnSync(process.execPath, [join(ROOT, "scripts", "doctor.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
}
