import { appendFileSync, writeFileSync } from "node:fs";
import { RUNNER_LOG, STATUS_FILE } from "./config.js";

// The two things this daemon says about itself.
//
// The heartbeat is the HUD's only way to know the runner is alive: it writes
// STATUS_FILE every 15s and the HUD calls anything older than two minutes
// dead. Both writes are best-effort — a runner that cannot log is still a
// runner that should keep working.

export function writeHeartbeat(snapshot) {
  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          pid: process.pid,
          version: "1.0.1",
          busy: snapshot.active > 0,
          active: snapshot.active,
          max_concurrent: snapshot.maxConcurrent,
          pending: snapshot.pending,
          in_flight: snapshot.inFlight,
        },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* ignore */
  }
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(RUNNER_LOG, line, "utf8");
  } catch {
    /* ignore */
  }
  console.log(line.trimEnd());
}
