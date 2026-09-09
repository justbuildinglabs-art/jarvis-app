import { join } from "path";
import { listDir, readText, vaultPath } from "./storage";
import { todayInVaultTz } from "./today";
import type { MorningReport } from "./types";

// Today's morning-report headlines — the "## Headlines" bullets with the
// markdown stripped, feeding the Signal Scan panel and the spoken briefing.
// Only TODAY's report counts: yesterday's headlines read as news, and stale
// news is worse than none.

// `## Headlines` bullets, markdown stripped — feeds the AI Wire panel and the
// spoken briefing (lib/router.ts). rel = vault-relative path for the overlay.
export function readMorningReport(max = 4): MorningReport | null {
  try {
    const dir = vaultPath("inbox", "reports", "morning");
    const prefix = todayInVaultTz();
    // several reports can share a date (the skill is re-runnable); the last
    // by name is the newest, since the name carries the date then the run id
    const file = listDir(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .sort()
      .pop();
    if (!file) return null;
    // null = unreadable; "" = an empty report, which still has a rel worth
    // returning (the panel shows nothing, the overlay can still open it)
    const raw = readText(join(dir, file));
    if (raw === null) return null;
    const heads: string[] = [];
    const links: (string | null)[] = [];
    let inHeads = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^##\s/.test(line)) {
        if (inHeads) break;
        inHeads = /^##\s+Headlines/i.test(line);
        continue;
      }
      if (inHeads && /^[-*]\s+/.test(line)) {
        // first http(s) URL on the bullet — markdown link or bare
        const url = line.match(/https?:\/\/[^\s)\]"']+/)?.[0] ?? null;
        const clean = line
          .replace(/^[-*]\s+/, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
          .replace(/https?:\/\/[^\s)\]"']+/g, "")
          .replace(/[*_`]/g, "")
          .trim();
        if (clean) {
          heads.push(clean.slice(0, 160));
          links.push(url);
        }
        if (heads.length >= max) break;
      }
    }
    return { rel: `inbox/reports/morning/${file}`, heads, links };
  } catch {
    return null;
  }
}
