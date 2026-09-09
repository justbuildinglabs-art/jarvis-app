import type { Metric } from "@/lib/vault";

// Display formatting for the HUD. Pure functions — no state, no clock beyond
// Date.now() — so they read the same in a panel and in a test.
//
// The register is deliberate: the screen shows precision ("50,405"), the
// compact forms show magnitude ("50K"), and anything spoken rounds further
// still (lib/spokenText.ts). Same number, three audiences.

export function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + "K";
  if (Math.abs(n) >= 1_000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

export function fmtFull(n: number): string {
  return n.toLocaleString("en-US");
}

export function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

// relative age of an ISO timestamp; stale = older than two missed 6h pulls
export function fmtAge(ts: string | null): { label: string; stale: boolean } {
  if (!ts) return { label: "—", stale: true };
  const ms = Date.now() - Date.parse(ts);
  if (Number.isNaN(ms)) return { label: "—", stale: true };
  const stale = ms > 13 * 3600 * 1000;
  const m = Math.floor(ms / 60000);
  if (m < 1) return { label: "now", stale };
  if (m < 60) return { label: `${m}m`, stale };
  const h = Math.floor(m / 60);
  if (h < 48) return { label: `${h}h`, stale };
  return { label: `${Math.floor(h / 24)}d`, stale };
}

export function fmtDur(s: number): string {
  if (s < 100) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// task callouts speak stopwatch ("0:42") — fmtDur is for completed-run feed lines
export function fmtClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function noteAgeDays(date: string): number {
  const ms = Date.now() - Date.parse(`${date}T12:00:00`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

// animated count-up
