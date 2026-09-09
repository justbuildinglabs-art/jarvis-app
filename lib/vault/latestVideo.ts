import { readJson, vaultPath } from "./storage";
import type { LatestVideo } from "./types";

// latest-video.json, written by the user's own metrics script. Every field is
// coerced rather than trusted — this is somebody's cron job's output.

export function readLatestVideo(): LatestVideo | null {
  const j = readJson<Record<string, unknown>>(vaultPath("system", "metrics", "latest-video.json"));
  if (!j) return null;
  return {
    title: String(j.title ?? ""),
    url: String(j.url ?? ""),
    video_id: String(j.video_id ?? ""),
    views: Number(j.views ?? 0),
    likes: Number(j.likes ?? 0),
    comments: Number(j.comments ?? 0),
    published_at: String(j.published_at ?? ""),
    status: String(j.status ?? "?"),
  };
}
