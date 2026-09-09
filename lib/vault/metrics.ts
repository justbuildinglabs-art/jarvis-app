import { readText, vaultPath } from "./storage";
import type { Metric, MetricPoint } from "./types";

// metrics.csv → one Metric per source:metric pair, with a bounded history
// window and the deltas the Telemetry panel draws.
//
// The file is append-only and written by whatever scripts the user wires up,
// so every row is treated as suspect: short rows, unparseable values and the
// header are skipped rather than throwing.

const HISTORY_CAP = 24;

// schema: timestamp,source,metric,value,status,error  (append-only)
export function readMetrics(): Metric[] {
  const raw = readText(vaultPath("system", "metrics", "metrics.csv"));
  if (!raw) return [];

  const byKey = new Map<string, { source: string; metric: string; points: MetricPoint[] }>();

  const lines = raw.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 5) continue;
    const [timestamp, source, metric, valueStr, status] = cols;
    const value = parseFloat(valueStr);
    if (Number.isNaN(value)) continue;
    const key = `${source}:${metric}`;
    if (!byKey.has(key)) byKey.set(key, { source, metric, points: [] });
    const bucket = byKey.get(key)!;
    bucket.points.push({ timestamp, value, status });
    if (bucket.points.length > HISTORY_CAP * 4) bucket.points.splice(0, bucket.points.length - HISTORY_CAP * 4);
  }

  const out: Metric[] = [];
  for (const { source, metric, points } of byKey.values()) {
    const history = points.slice(-HISTORY_CAP);
    const latest = history[history.length - 1];
    const prev = history.length > 1 ? history[history.length - 2] : null;
    // weekly delta needs enough window to mean something (≥6 pulls ≈ 1.5 days)
    const oldest = history.length >= 6 ? history[0] : null;
    out.push({
      source,
      metric,
      value: latest.value,
      status: latest.status,
      timestamp: latest.timestamp,
      history,
      delta: prev ? latest.value - prev.value : null,
      deltaWeek: oldest ? latest.value - oldest.value : null,
    });
  }
  return out;
}
