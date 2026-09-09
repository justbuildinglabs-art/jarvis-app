import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

export const RUNNER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Configuration, resolved once at import.
//
// Precedence is process.env, then ~/.claude/.env, then a default that works
// on a fresh clone. The env FILE rather than a shell variable is deliberate
// for ANTHROPIC_API_KEY in particular: exported in a shell, it silently flips
// every interactive `claude` session from subscription to API billing.

export function loadEnvFile() {
  const envPath = join(homedir(), ".claude", ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  try {
    for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

const _env = loadEnvFile();
export const env = (k) => process.env[k] || _env[k];

export const VAULT_ROOT =
  env("VAULT_ROOT") || env("AGENTIC_OS_VAULT") || join(RUNNER_DIR, "..", "starter-vault");
// MUST match HUD_TZ in lib/config.ts — "today" has to mean the same day in
// both places or daily notes split across two dates near midnight UTC.
export const HUD_TZ = env("HUD_TZ") || "America/Chicago";
export const QUEUE_DIR = join(VAULT_ROOT, "system", "queue");
export const RUNS_DIR = join(VAULT_ROOT, "system", "runs");
export const STATUS_FILE = join(VAULT_ROOT, "system", "runner-status.json");
// RUNNER_LOG override exists for the test suite, which must never append to
// the live daemon log; unset, the path is unchanged.
export const RUNNER_LOG = env("RUNNER_LOG") || join(RUNNER_DIR, "runner.log");

export const IS_WINDOWS = platform() === "win32";
export const CLAUDE_BIN = IS_WINDOWS ? "claude.exe" : "claude";
// Pin the model for ALL headless spawns — never inherit the interactive CLI
// default. Defaults to Opus 5 for the best skill output; set AGENTIC_OS_MODEL
// in ~/.claude/.env to a cheaper model (claude-opus-4-8 / claude-sonnet-4-6 /
// claude-haiku-4-5-...) to trade quality for cost. Onboarding asks which.
export const CLAUDE_MODEL = env("AGENTIC_OS_MODEL") || "claude-opus-5";
// Per-run override — voice asks may carry args.model ("use opus" spoken in
// the ask). Allowlist only; anything else falls back to CLAUDE_MODEL.
export const MODEL_ALLOWLIST = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

export function modelFor(intent) {
  const m = intent?.args?.model;
  return typeof m === "string" && MODEL_ALLOWLIST.has(m) ? m : CLAUDE_MODEL;
}
