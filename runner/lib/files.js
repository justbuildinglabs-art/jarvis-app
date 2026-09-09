import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { HUD_TZ, QUEUE_DIR, RUNS_DIR } from "./config.js";

// Filesystem chores and date derivation.
//
// todayDate() must agree with the HUD's own idea of today — same HUD_TZ, same
// Intl call — or a note written here lands on a date the dashboard is not
// looking at.

export function ensureDirs() {
  for (const d of [QUEUE_DIR, RUNS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function slugify(s, max = 48) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max) || "untitled";
}

export function todayDate() {
  // Local (HUD_TZ) YYYY-MM-DD. toISOString() returns UTC, which flips to
  // tomorrow's date in the evening for western timezones — wrong for "today".
  return new Intl.DateTimeFormat("en-CA", { timeZone: HUD_TZ }).format(new Date());
}

export function tomorrowDate() {
  const todayLocal = todayDate();
  const [y, m, d] = todayLocal.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}

/**
 * Where a run's user-facing artifact lands, vault-relative. The paths
 * themselves live with their skills in skills/definitions/; this only
 * assembles the values they interpolate. Null = a skill this runner does
 * not know, which processOne() rejects.
 */
