import { basename } from "path";
import { jsonFilesByMtime, readJson, vaultPath } from "./storage";
import { askLabel } from "./runs";
import type { QueueEntry } from "./types";

// system/queue/*.json — intents written but not yet picked up. Oldest first:
// that is the order the runner will take them in, so it is the order the Ops
// Board should show them in.

export function readQueue(): QueueEntry[] {
  const files = jsonFilesByMtime(vaultPath("system", "queue"), "asc");
  const out: QueueEntry[] = [];
  for (const f of files) {
    const j = readJson<Record<string, unknown>>(f);
    if (!j) continue;
    out.push({
      id: String(j.id ?? basename(f, ".json")),
      skill: String(j.skill ?? "?"),
      label: String(j.skill) === "voice-ask" ? askLabel(j.args) : null,
      ts: String(j.ts ?? ""),
    });
  }
  return out;
}
