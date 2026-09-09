// The vault — all application state, as plain files.
//
// There is no database and no server-side cache: the HUD polls, the readers
// hit the filesystem, and whatever is on disk is the truth. That is what
// makes the runner (a separate process) and the user's own editor equal
// participants — anything can write a file.
//
// Layout: storage.ts is the only module that touches fs; each reader owns one
// kind of file; today.ts owns the HUD_TZ date derivation they share.

import { readMetrics } from "./metrics";
import { readRunnerStatus } from "./runnerStatus";
import { readLatestVideo } from "./latestVideo";
import { readDailyNote } from "./daily";
import { readRecentRuns, readSkillEtas } from "./runs";
import { readQueue } from "./queue";
import { readMorningReport } from "./morning";
import { VAULT_ROOT } from "./storage";
import type { VaultState } from "./types";

export function readVaultState(): VaultState {
  return {
    generated_at: new Date().toISOString(),
    vault_root: VAULT_ROOT,
    metrics: readMetrics(),
    runner: readRunnerStatus(),
    latestVideo: readLatestVideo(),
    daily: readDailyNote(),
    runs: readRecentRuns(),
    queue: readQueue(),
    morning: readMorningReport(),
    etas: readSkillEtas(),
  };
}

export type {
  Metric,
  MetricPoint,
  RunEntry,
  QueueEntry,
  RunnerStatus,
  LatestVideo,
  DailyNote,
  VaultState,
  MorningReport,
} from "./types";

export { readMetrics } from "./metrics";
export { readRunnerStatus } from "./runnerStatus";
export { readLatestVideo } from "./latestVideo";
export { readRecentRuns, readSkillEtas } from "./runs";
export { readQueue } from "./queue";
export { readDailyNote, toggleTop3 } from "./daily";
export { readVaultMarkdown } from "./markdown";
export { readMorningReport } from "./morning";
export { todayInVaultTz } from "./today";
