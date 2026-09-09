import { readJson, vaultPath } from "./storage";
import type { RunnerStatus } from "./types";

// The runner daemon's heartbeat. It rewrites this file every 15s, so the
// file's age IS the liveness signal — two minutes without one and the HUD
// says the runner is down, which is the difference between "queued" and
// "queued and nothing will pick it up".

export function readRunnerStatus(): RunnerStatus | null {
  const j = readJson<Record<string, unknown>>(vaultPath("system", "runner-status.json"));
  if (!j) return null;
  const ts = String(j.ts ?? "");
  let age: number | null = null;
  const parsed = Date.parse(ts);
  if (!Number.isNaN(parsed)) age = Math.round((Date.now() - parsed) / 1000);
  return {
    ts,
    pid: Number(j.pid ?? 0),
    version: String(j.version ?? "?"),
    busy: Boolean(j.busy),
    active: Number(j.active ?? 0),
    max_concurrent: Number(j.max_concurrent ?? 0),
    pending: Number(j.pending ?? 0),
    heartbeat_age_s: age,
    alive: age !== null && age < 120, // heartbeat every ~30s; 2min = dead
  };
}
