import { spawn } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LONG_SKILLS } from "../../skills/index.js";
import { CLAUDE_BIN, CLAUDE_MODEL, HUD_TZ, QUEUE_DIR, RUNS_DIR, VAULT_ROOT, modelFor } from "./config.js";
import { readJson, writeJson, slugify, todayDate, tomorrowDate } from "./files.js";
import { log } from "./log.js";
import { buildPrompt, deliverablePathFor } from "./skills.js";

// Running one intent, start to finish: read it, claim a run id, write the
// "running" record, shell out to `claude -p`, stream the output into the run
// log, and write the terminal record.
//
// Every exit path writes a run record. A run that vanished without one is
// indistinguishable from a run that never started, and the HUD would show a
// task spinning forever.

export async function processOne(fileName) {
  const queuePath = join(QUEUE_DIR, fileName);
  if (!existsSync(queuePath)) return;

  let intent;
  let lastErr = null;
  // Retry with backoff — covers the race where the intent file exists but
  // hasn't flushed content yet.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      intent = readJson(queuePath);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr || !intent) {
    const runId = basename(fileName, ".json");
    const ts = new Date().toISOString();
    writeJson(join(RUNS_DIR, `${runId}.json`), {
      id: runId,
      skill: "(unknown)",
      args: {},
      ts_queued: ts,
      ts_started: ts,
      ts_completed: ts,
      status: "error",
      exit_code: -3,
      summary: `bad intent json after 5 retries: ${lastErr?.message || "empty"}`.slice(0, 200),
      md_path: `system/runs/${runId}.md`,
      log_path: `system/runs/${runId}.md`,
      deliverable_path: null,
    });
    log(`${runId}: bad json — wrote error run record: ${lastErr?.message}`);
    try {
      unlinkSync(queuePath);
    } catch {
      /* ignore */
    }
    return;
  }

  const runId = intent.id || basename(fileName, ".json");
  const runJsonPath = join(RUNS_DIR, `${runId}.json`);
  const runMdPath = join(RUNS_DIR, `${runId}.md`);
  const deliverable = deliverablePathFor({ ...intent, id: runId });

  const tsStarted = new Date().toISOString();
  const status = {
    id: runId,
    skill: intent.skill,
    args: intent.args || {},
    ts_queued: intent.ts || tsStarted,
    ts_started: tsStarted,
    ts_completed: null,
    status: "running",
    exit_code: null,
    summary: "",
    md_path: `system/runs/${runId}.md`,
    log_path: `system/runs/${runId}.md`,
    deliverable_path: deliverable,
  };
  writeJson(runJsonPath, status);

  const prompt = buildPrompt({ ...intent, id: runId }, deliverable);
  if (!prompt) {
    status.status = "error";
    status.exit_code = -1;
    status.summary = `unknown or invalid intent: ${intent.skill}`;
    status.ts_completed = new Date().toISOString();
    writeJson(runJsonPath, status);
    try {
      unlinkSync(queuePath);
    } catch {
      /* ignore */
    }
    log(`${runId}: rejected — ${status.summary}`);
    return;
  }

  const runModel = modelFor(intent);
  log(
    `${runId}: running skill=${intent.skill}` +
      (runModel !== CLAUDE_MODEL ? ` model=${runModel} (per-ask override)` : "")
  );

  // Markdown run log with frontmatter so it renders as a note in the vault.
  const argsJson = JSON.stringify(intent.args || {});
  writeFileSync(
    runMdPath,
    `---
run_id: ${runId}
skill: ${intent.skill}
status: running
ts_queued: ${intent.ts || tsStarted}
ts_started: ${tsStarted}
args: ${argsJson}
---

# ${intent.skill} run

> in progress — output streams below.

\`\`\`
`,
    "utf8"
  );

  const out = [];
  await new Promise((resolve) => {
    // --dangerously-skip-permissions: headless `claude -p` runs non-interactive,
    // so the default permission mode DENIES file writes (the deliverable never
    // lands) with no prompt to approve. A fresh install has no
    // permissions.defaultMode override, so this flag is required for ANY skill
    // to write its report. The runner only executes self-contained, dev-authored
    // skill prompts (and the user's own installed skills) against the user's own
    // vault on localhost — the same trust boundary as running the skill by hand.
    const proc = spawn(
      CLAUDE_BIN,
      ["-p", prompt, "--model", runModel, "--dangerously-skip-permissions"],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: VAULT_ROOT,
      }
    );

    proc.stdout.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });
    proc.stderr.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });

    const HARD_TIMEOUT_MIN = LONG_SKILLS.has(intent.skill) ? 20 : 10;
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      out.push(`\n[runner: hard timeout ${HARD_TIMEOUT_MIN}m — killed]\n`);
    }, 1000 * 60 * HARD_TIMEOUT_MIN);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const tsCompleted = new Date().toISOString();
      const joined = out.join("").trim();
      const lines = joined.split(/\r?\n/);
      const firstLine =
        lines.find(
          (l) =>
            l.trim().length > 0 &&
            !l.startsWith("Warning:") &&
            !l.startsWith("warning:")
        ) ||
        lines.find((l) => l.trim().length > 0) ||
        "(no output)";
      status.status = code === 0 ? "ok" : "error";
      status.exit_code = code ?? -1;
      status.ts_completed = tsCompleted;
      status.summary = firstLine.slice(0, 200);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(
          runMdPath,
          `\n\`\`\`\n\n---\n*exit code=${code} · status=${status.status} · completed ${tsCompleted}*\n`
        );
      } catch {
        /* ignore */
      }
      log(`${runId}: completed exit=${code} status=${status.status}`);
      resolve();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      status.status = "error";
      status.exit_code = -2;
      status.ts_completed = new Date().toISOString();
      status.summary = `spawn error: ${err.message}`.slice(0, 200);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(runMdPath, `\n\`\`\`\n\n[runner spawn error] ${err.message}\n`);
      } catch {
        /* ignore */
      }
      log(`${runId}: spawn error ${err.message}`);
      resolve();
    });
  });

  try {
    unlinkSync(queuePath);
  } catch {
    /* ignore */
  }
}
