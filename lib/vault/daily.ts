import { join } from "path";
import { exists, listDir, readText, vaultPath, writeText } from "./storage";
import { todayInVaultTz } from "./today";
import type { DailyNote } from "./types";

// The daily note — today's if it exists, otherwise the most recent one.
//
// The parser follows the frozen v1 schema in the vault
// (system/schemas/daily-note.md): numbered checkboxes under
// "## Top 3 Priorities", "- HH:MM — title" under "## Schedule", and the first
// non-empty line under "## Current Focus". The planner prompts write to the
// same contract, which is why it is written down in the vault rather than
// only here.

// Today's note if present, else the most recent. Parser contract: frozen v1
// schema — `## Top 3 Priorities` numbered checkboxes + `## Schedule` bullets.
export function readDailyNote(): DailyNote | null {
  const dir = vaultPath("daily-notes");
  // local (HUD_TZ) date — toISOString() is UTC and flips to
  // tomorrow after ~7pm CT, which made evening sessions claim today's
  // note didn't exist (same fix as runner.js todayDate())
  const today = todayInVaultTz();
  let file = join(dir, `${today}.md`);
  let isToday = true;
  let date = today;

  if (!exists(file)) {
    // no note for today — fall back to the most recent one, and say so:
    // the panels dim and the header counts the days since.
    isToday = false;
    const names = listDir(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
    if (names.length === 0) return null;
    file = join(dir, names[0]);
    date = names[0].replace(".md", "");
  }

  const raw = readText(file);
  if (!raw) return null;

  const top3: { text: string; done: boolean }[] = [];
  const schedule: { time: string; item: string }[] = [];
  let focus = "";

  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section === "Top 3 Priorities") {
      const m = line.match(/^\d+\.\s+\[( |x)\]\s+(.*)/);
      if (m) top3.push({ text: m[2].trim(), done: m[1] === "x" });
    } else if (section === "Schedule") {
      const m = line.match(/^-\s+(\d{1,2}:\d{2})\s*[—–-]+\s*(.*)/);
      if (m) schedule.push({ time: m[1], item: m[2].trim() });
    } else if (section === "Current Focus") {
      if (line.trim() && !focus) focus = line.trim();
    }
  }

  return { date, isToday, top3, schedule, focus };
}

// Only today's note is writable (stale notes are history). Index = nth
// checkbox under `## Top 3 Priorities`, matching the parser above.
export function toggleTop3(index: number, done: boolean): boolean {
  const file = vaultPath("daily-notes", `${todayInVaultTz()}.md`);
  const raw = readText(file);
  if (!raw) return false;

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let section = "";
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section !== "Top 3 Priorities") continue;
    const m = lines[i].match(/^(\d+\.\s+)\[( |x)\](\s+.*)/);
    if (!m) continue;
    seen++;
    if (seen === index) {
      lines[i] = `${m[1]}[${done ? "x" : " "}]${m[3]}`;
      writeText(file, lines.join(eol));
      return true;
    }
  }
  return false;
}
