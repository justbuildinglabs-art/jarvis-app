// Every shape the vault hands out. Types only — no fs, no clock — so a
// consumer can be typed against the vault without pulling the readers in.

export interface MetricPoint {
  timestamp: string;
  value: number;
  status: string;
}

export interface Metric {
  source: string;
  metric: string;
  value: number;
  status: string; // ok | stale | error | mock
  timestamp: string;
  history: MetricPoint[]; // oldest → newest, capped
  delta: number | null; // vs previous reading
  deltaWeek: number | null; // vs oldest point in history window (~6 days at 6h pulls)
}

export interface RunEntry {
  id: string;
  skill: string;
  /** topic tag for voice-asks ("fable 5 news") — null for named skills */
  label: string | null;
  /** external URL when the run's REAL output lives elsewhere (Gmail draft,
   *  video) — parsed from `link:` in the deliverable's frontmatter */
  link: string | null;
  status: string;
  summary: string;
  ts_completed: string | null;
  ts_started: string | null;
  duration_s: number | null;
  deliverable_path: string | null; // vault-relative md the run produced
}

export interface QueueEntry {
  id: string;
  skill: string;
  label: string | null;
  ts: string;
}

export interface RunnerStatus {
  ts: string;
  pid: number;
  version: string;
  busy: boolean;
  active: number;
  max_concurrent: number;
  pending: number;
  heartbeat_age_s: number | null;
  alive: boolean;
}

export interface LatestVideo {
  title: string;
  url: string;
  video_id: string;
  views: number;
  likes: number;
  comments: number;
  published_at: string;
  status: string;
}

export interface DailyNote {
  date: string;
  isToday: boolean;
  top3: { text: string; done: boolean }[];
  schedule: { time: string; item: string }[];
  focus: string;
}

export interface VaultState {
  generated_at: string;
  vault_root: string;
  metrics: Metric[];
  runner: RunnerStatus | null;
  latestVideo: LatestVideo | null;
  daily: DailyNote | null;
  runs: RunEntry[];
  queue: QueueEntry[];
  morning: MorningReport | null;
  etas: Record<string, number>; // skill → median duration_s of past ok runs
}

export interface MorningReport {
  rel: string;
  heads: string[];
  /** first source URL per headline (parallel to heads; null = no link) */
  links: (string | null)[];
}
