// MUST be the first import of every test file.
//
// Pins every environment value the library reads at module load, so a test
// process (a) never touches the real vault, (b) never spends API money or
// shells out to `claude`, (c) never boots the runner daemon, and (d) never
// reads ~/.claude/.env — HOME is pointed at an empty fixture directory, which
// is what makes the suite hermetic on any machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_ROOT = path.join(os.tmpdir(), `jarvis-golden-${process.pid}`);
export const FIXTURE_HOME = path.join(FIXTURE_ROOT, "home");

/** The instant every test runs at: 2026-09-09 10:30 CDT (Wednesday morning). */
export const FROZEN_NOW_ISO = "2026-09-09T15:30:00.000Z";
export const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);
export const TODAY = "2026-09-09"; // in HUD_TZ
export const TOMORROW = "2026-09-10";
export const HUD_TZ = "America/Chicago";

fs.mkdirSync(FIXTURE_HOME, { recursive: true });

const pinned: Record<string, string> = {
  HOME: FIXTURE_HOME,
  USERPROFILE: FIXTURE_HOME,
  VAULT_ROOT: FIXTURE_ROOT,
  HUD_TZ,
  HUD_USER_NAME: "User",
  VOICE_ROUTER: "rules",
  VOICE_NO_WARMUP: "1",
  RUNNER_NO_BOOT: "1",
  VOICE_SERVER_URL: "http://127.0.0.1:1",
  NEXT_PUBLIC_VOICE_WS: "ws://127.0.0.1:1/events",
  OLLAMA_URL: "http://127.0.0.1:1",
  CLAUDE_BIN: "/nonexistent/claude",
};
for (const [k, v] of Object.entries(pinned)) process.env[k] = v;
for (const k of ["ANTHROPIC_API_KEY", "AGENTIC_OS_MODEL", "VOICE_CLI_MODEL", "VOICE_ROUTER_MODEL", "KOKORO_VOICE"]) {
  delete process.env[k];
}
