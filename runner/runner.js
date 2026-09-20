#!/usr/bin/env node
/**
 * Jarvis App Runner — the background skill executor.
 *
 * Watches `<vault>/system/queue/<uuid>.json`, runs each intent through
 * `claude -p`, and writes `system/runs/<uuid>.json` + `<uuid>.md` back. The
 * HUD writes intents (buttons and voice); this daemon does the work. That
 * split is the whole architecture: the web app never blocks on a model, and
 * the daemon never needs to know a browser exists — they meet at the queue.
 *
 * Run it: `node runner/runner.js` (or start-runner.cmd, hidden, at login).
 * No dependencies beyond Node 20+ and the skill registry.
 *
 * ADDING A SKILL: write one file in skills/definitions/ and register it in
 * skills/index.js. The runner, the queue API, the Ops Board and the voice
 * aliases all read that registry, so there is nothing to add here.
 *
 * The pieces live in runner/lib/:
 *   config.js   env resolution and the paths everything else derives
 *   files.js    fs chores and HUD_TZ date derivation
 *   log.js      the run log and the heartbeat the HUD reads
 *   skills.js   registry adapter — prompt and deliverable for an intent
 *   pool.js     admission rules: concurrency, serial and dedupe categories
 *   execute.js  running one intent end to end
 *
 * This file is the daemon itself: the loops, the singleton lock, and boot.
 */

import { watch } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_MODEL, QUEUE_DIR, RUNNER_DIR, VAULT_ROOT } from "./lib/config.js";
import { ensureDirs } from "./lib/files.js";
import { log, writeHeartbeat as writeStatus } from "./lib/log.js";
import { MAX_CONCURRENT, enqueueNew, peekSkill, pickNext, state } from "./lib/pool.js";
import { processOne } from "./lib/execute.js";

/** Heartbeat payload — the pool's live counters, snapshotted. */
function poolSnapshot() {
  return {
    active: state.active,
    maxConcurrent: MAX_CONCURRENT,
    pending: state.pending.length,
    inFlight: [...state.inFlight],
  };
}

/**
 * The scheduler. Greedily fills every free slot each pass, then sleeps.
 *
 * The 1.5s poll is a backstop, not the primary trigger — watchLoop() reacts
 * to a new queue file within milliseconds. The poll covers what a filesystem
 * watcher misses: a watcher that died, a file written before it attached, or
 * a platform where fs.watch is unreliable.
 */
async function loop() {
  while (true) {
    enqueueNew();

    let progress = true;
    while (progress && state.active < MAX_CONCURRENT && state.pending.length > 0) {
      const idx = pickNext();
      if (idx < 0) {
        // nothing runnable right now — everything left is blocked by a serial
        // or dedupe rule, so stop trying until something finishes
        progress = false;
        break;
      }
      const next = state.pending.splice(idx, 1)[0];
      const skill = peekSkill(next);
      state.active++;
      if (skill) state.inFlight.add(skill);
      state.processing.add(next);
      processOne(next)
        .catch((e) => log(`processOne crashed: ${e.message}`))
        .finally(() => {
          state.active--;
          if (skill) state.inFlight.delete(skill);
          state.processing.delete(next);
        });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** React to queue writes immediately; fall back to polling if the watch dies. */
async function watchLoop() {
  try {
    const watcher = watch(QUEUE_DIR, { persistent: true });
    for await (const ev of watcher) {
      if (ev.filename && ev.filename.endsWith(".json")) enqueueNew();
    }
  } catch (e) {
    log(`watcher error: ${e.message} — falling back to polling`);
  }
}

process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack || err.message}`);
});

// --- Singleton lock ----------------------------------------------------------
// Two runners on one vault would each pick up the same intents and run every
// skill twice. The pidfile makes a second boot a no-op instead.
const PIDFILE = join(RUNNER_DIR, "runner.pid");

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = liveness check, throws if dead
    return true;
  } catch {
    return false;
  }
}

function claimSingletonLock() {
  if (existsSync(PIDFILE)) {
    try {
      const otherPid = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
      if (Number.isInteger(otherPid) && otherPid !== process.pid && pidAlive(otherPid)) {
        log(`another runner alive at pid ${otherPid} — exiting this one (pid ${process.pid})`);
        return false;
      }
    } catch {
      /* stale pidfile — overwrite */
    }
  }
  writeFileSync(PIDFILE, String(process.pid), "utf8");
  process.on("exit", () => {
    try {
      // only clear the lock if it is still ours
      const cur = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
      if (cur === process.pid) unlinkSync(PIDFILE);
    } catch {
      /* ignore */
    }
  });
  return true;
}

function boot() {
  if (!claimSingletonLock()) process.exit(0);
  ensureDirs();
  log(`runner booted (pid ${process.pid}) vault=${VAULT_ROOT} model=${CLAUDE_MODEL}`);
  writeStatus(poolSnapshot());
  setInterval(() => writeStatus(poolSnapshot()), 15_000);
  watchLoop();
  loop();
}

// RUNNER_NO_BOOT=1 lets the test suite import the modules below without
// starting a daemon (no pidfile, no loops, no heartbeat).
if (process.env.RUNNER_NO_BOOT !== "1") boot();

/** Heartbeat with the live pool snapshot. */
export function writeHeartbeat() {
  return writeStatus(poolSnapshot());
}

// --- test seams ---------------------------------------------------------------
// Re-exported so the golden suite keeps one import site for the runner's
// surface even though the implementation now lives in ./lib/.
export { processOne } from "./lib/execute.js";
export { buildPrompt, deliverablePathFor } from "./lib/skills.js";
export { ensureDirs, readJson, writeJson, slugify, todayDate, tomorrowDate } from "./lib/files.js";
export { log } from "./lib/log.js";
export {
  MAX_CONCURRENT,
  enqueueNew,
  peekSkill,
  pickNext,
  state,
  pending,
  inFlight,
  processing,
} from "./lib/pool.js";
export {
  CLAUDE_MODEL,
  CLAUDE_BIN,
  HUD_TZ,
  MODEL_ALLOWLIST,
  QUEUE_DIR,
  RUNS_DIR,
  RUNNER_LOG,
  STATUS_FILE,
  VAULT_ROOT,
  modelFor,
} from "./lib/config.js";
export { AUTONOMOUS_PREFIX, SERIAL_SKILLS, DEDUPE_SKILLS, LONG_SKILLS } from "../skills/index.js";
