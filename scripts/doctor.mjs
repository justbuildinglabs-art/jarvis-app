#!/usr/bin/env node
// Diagnose what is and isn't set up. Read-only — changes nothing.
//
//   node scripts/doctor.mjs
//   node scripts/doctor.mjs --json     (machine-readable, for Claude to act on)
//
// Written because every "it's slow" or "nothing happens" question this project
// produces has turned out to be a missing piece rather than a bug: no deps
// installed, no env file, no model weights, no routing fallthrough. This says
// which one, in one command.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch, cpus } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = process.argv.includes("--json");
const HOME_ENV = join(homedir(), ".claude", ".env");

const checks = [];

function check(name, { ok, detail, fix = null, severity = "required" }) {
  checks.push({ name, ok, detail, fix, severity });
}

function which(bin) {
  try {
    return execFileSync(platform() === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")[0]
      .trim();
  } catch {
    return null;
  }
}

function homeEnvValue(key) {
  // Mirrors lib/homeEnv.ts: uppercase keys, no export prefix, quotes stripped,
  // and a real environment variable takes precedence over the file.
  if (process.env[key]) return process.env[key];
  if (!existsSync(HOME_ENV)) return undefined;
  for (const line of readFileSync(HOME_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) {
      const v = m[2].replace(/^["']|["']$/g, "").trim();
      return v === "" ? undefined : v;
    }
  }
  return undefined;
}

async function portOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.status > 0;
  } catch (e) {
    // A refused connection means nothing is listening; anything else (a 404, a
    // redirect) still proves something answered.
    return !/ECONNREFUSED|fetch failed/i.test(String(e));
  }
}

// --- runtime -----------------------------------------------------------------

const nodeMajor = Number(process.versions.node.split(".")[0]);
check("Node.js", {
  ok: nodeMajor >= 20,
  detail: `v${process.versions.node} on ${platform()}/${arch()}, ${cpus().length} cores`,
  fix: "Install Node 20 or newer.",
});

const claudeBin = which("claude");
check("claude CLI", {
  ok: Boolean(claudeBin),
  detail: claudeBin ?? "not on PATH",
  fix: "Install Claude Code and sign in. The runner and the CLI router both need it.",
});

// --- project -----------------------------------------------------------------

check("dependencies installed", {
  ok: existsSync(join(ROOT, "node_modules")),
  detail: existsSync(join(ROOT, "node_modules")) ? "node_modules present" : "node_modules missing",
  fix: "npm install",
});

check("production build", {
  ok: existsSync(join(ROOT, ".next")),
  detail: existsSync(join(ROOT, ".next")) ? ".next present" : "not built",
  fix: "npx next build",
  severity: "optional",
});

check("onboarding marker", {
  ok: existsSync(join(ROOT, ".jarvis-config.json")),
  detail: existsSync(join(ROOT, ".jarvis-config.json")) ? "onboarded" : "not onboarded yet",
  fix: "node scripts/setup.mjs",
  severity: "optional",
});

// --- config ------------------------------------------------------------------

check("~/.claude/.env", {
  ok: existsSync(HOME_ENV),
  detail: existsSync(HOME_ENV) ? HOME_ENV : "missing",
  fix: "node scripts/setup.mjs  (creates it with a commented template)",
});

const vaultRoot = homeEnvValue("VAULT_ROOT") ?? join(ROOT, "starter-vault");
check("vault", {
  ok: existsSync(vaultRoot),
  detail: `${vaultRoot}${homeEnvValue("VAULT_ROOT") ? "" : "  (default starter-vault)"}`,
  fix: "Set VAULT_ROOT in ~/.claude/.env to your own notes directory.",
});

// --- routing -----------------------------------------------------------------
// The single biggest driver of perceived speed. Without a fallthrough engine,
// every unrecognised sentence becomes a background Opus run.

const hasKey = Boolean(homeEnvValue("ANTHROPIC_API_KEY"));
let ollamaUp = false;
try {
  ollamaUp = (
    await fetch(`${homeEnvValue("OLLAMA_URL") ?? "http://127.0.0.1:11434"}/api/tags`, {
      signal: AbortSignal.timeout(1200),
    })
  ).ok;
} catch {
  ollamaUp = false;
}

const routing = hasKey
  ? { ok: true, detail: "Anthropic API key set — fallthrough ~1s", severity: "required" }
  : ollamaUp
    ? { ok: true, detail: "Ollama reachable — fallthrough ~1-2s", severity: "required" }
    : claudeBin
      ? {
          ok: true,
          detail: "no key and no Ollama — using the CLI engine, ~11s",
          severity: "optional",
          fix: "For ~1s: set ANTHROPIC_API_KEY in ~/.claude/.env, or run Ollama (free, local).",
        }
      : {
          ok: false,
          detail: "no key, no Ollama, and no claude CLI — unrecognised speech cannot be answered",
          fix: "Install the claude CLI, or set ANTHROPIC_API_KEY, or run Ollama.",
        };
check("routing fallthrough", routing);

// --- voice -------------------------------------------------------------------

const venv = join(ROOT, "voice-server", ".venv");
check("voice venv", {
  ok: existsSync(venv),
  detail: existsSync(venv) ? venv : "not created",
  fix: "node scripts/setup.mjs --voice",
  severity: "optional",
});

const weights = [
  ["kokoro-v1.0.onnx", 300 * 1024 * 1024],
  ["voices-v1.0.bin", 20 * 1024 * 1024],
];
for (const [file, minBytes] of weights) {
  const p = join(ROOT, "voice-server", file);
  const size = existsSync(p) ? statSync(p).size : 0;
  check(`voice model ${file}`, {
    // A truncated download is worse than a missing one: the server fails deep
    // inside onnxruntime with an unhelpful error.
    ok: size >= minBytes,
    detail: size === 0 ? "missing" : `${(size / 1048576).toFixed(0)}MB${size < minBytes ? " — TRUNCATED" : ""}`,
    fix: "node scripts/setup.mjs --voice",
    severity: "optional",
  });
}

// --- services ----------------------------------------------------------------

for (const [label, port, sev] of [
  ["HUD", 4870, "optional"],
  ["voice server", 4871, "optional"],
]) {
  const up = await portOpen(port);
  check(`${label} (:${port})`, {
    ok: up,
    detail: up ? "listening" : "not running",
    fix: label === "HUD" ? "npx next start -p 4870" : "voice-server/.venv/bin/python voice-server/server.py",
    severity: sev,
  });
}

const statusFile = join(vaultRoot, "system", "runner-status.json");
let runnerDetail = "no heartbeat file";
let runnerOk = false;
if (existsSync(statusFile)) {
  try {
    const s = JSON.parse(readFileSync(statusFile, "utf8"));
    const ageS = (Date.now() - Date.parse(s.ts)) / 1000;
    runnerOk = ageS < 120;
    runnerDetail = runnerOk
      ? `alive (pid ${s.pid}, ${s.active ?? 0} active)`
      : `stale heartbeat (${ageS.toFixed(0)}s old) — daemon not running`;
  } catch {
    runnerDetail = "unreadable heartbeat file";
  }
}
check("runner daemon", {
  ok: runnerOk,
  detail: runnerDetail,
  fix: "node runner/runner.js",
  severity: "optional",
});

// --- report ------------------------------------------------------------------

const blocking = checks.filter((c) => !c.ok && c.severity === "required");

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: blocking.length === 0, checks }, null, 2));
  process.exit(blocking.length === 0 ? 0 : 1);
}

const pad = Math.max(...checks.map((c) => c.name.length));
console.log("\nJarvis App — setup check\n");
for (const c of checks) {
  const mark = c.ok ? "ok  " : c.severity === "required" ? "FAIL" : "--  ";
  console.log(`  ${mark}  ${c.name.padEnd(pad)}  ${c.detail}`);
}

const actionable = checks.filter((c) => !c.ok && c.fix);
if (actionable.length) {
  console.log("\nTo fix:\n");
  for (const c of actionable) console.log(`  ${c.name}\n    ${c.fix}\n`);
}

console.log(
  blocking.length === 0
    ? "Nothing blocking.\n"
    : `${blocking.length} blocking issue(s).\n`
);
process.exit(blocking.length === 0 ? 0 : 1);
