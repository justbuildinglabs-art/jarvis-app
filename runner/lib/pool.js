import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEDUPE_SKILLS, SERIAL_SKILLS } from "../../skills/index.js";
import { QUEUE_DIR } from "./config.js";
import { readJson } from "./files.js";

// The worker pool's admission rules — which queued intent may start next.
//
// Three constraints, and each exists because of a specific way parallel runs
// go wrong: MAX_CONCURRENT keeps three `claude -p` subprocesses from becoming
// thirty; SERIAL skills share one slot because they write the same file (the
// daily note) and would race; DEDUPE skills refuse a duplicate already in
// flight, so a double-tap on the Ops Board doesn't produce two reports.
//
// The mutable counters live in `state` so the loop and the heartbeat can both
// see them without a circular import.

export const MAX_CONCURRENT = 3;

export const state = {
  active: 0,
  /** intent.skill values currently running */
  inFlight: new Set(),
  /** queue filenames awaiting a slot */
  pending: [],
  /** queue filenames currently being processed */
  processing: new Set(),
};

// Named aliases for the three collections. They are the SAME objects as
// state.pending / state.inFlight / state.processing, not copies, so a caller
// holding one of these sees and makes the same mutations the scheduler does.
// `active` has no alias: it is a number, and a number cannot be shared by
// reference — read it through `state.active`.
export const pending = state.pending;
export const inFlight = state.inFlight;
export const processing = state.processing;

export function enqueueNew() {
  if (!existsSync(QUEUE_DIR)) return;
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    // processing guard — the queue file stays on disk until processOne
    // unlinks it at the end of the run; without this every poll re-adds
    // in-flight intents and the scheduler spawns DUPLICATE claude sessions
    if (!state.pending.includes(f) && !state.processing.has(f)) state.pending.push(f);
  }
}

export function peekSkill(fileName) {
  try {
    const intent = readJson(join(QUEUE_DIR, fileName));
    return intent.skill || null;
  } catch {
    return null;
  }
}

export function pickNext() {
  const serialBusy = [...state.inFlight].some((s) => SERIAL_SKILLS.has(s));
  for (let i = 0; i < state.pending.length; i++) {
    const skill = peekSkill(state.pending[i]);
    if (!skill) continue; // unreadable yet (write race) — try later
    if (DEDUPE_SKILLS.has(skill) && state.inFlight.has(skill)) continue;
    if (SERIAL_SKILLS.has(skill) && serialBusy) continue;
    return i;
  }
  return -1;
}
