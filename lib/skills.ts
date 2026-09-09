import fs from "fs";
import path from "path";
import crypto from "crypto";
import { VAULT_ROOT } from "./config";
import { SKILL_IDS, isKnownSkill } from "@/skills/index.js";

// ---------------------------------------------------------------------------
// Queue intent contract — shared by /api/queue (deck buttons) and /api/voice
// (spoken commands).
//
// The roster itself lives in skills/ and is the single source the runner and
// the HUD read too, so there is no longer a list here to keep in sync with
// them: a skill exists once, in skills/definitions/, or it does not exist.
// ---------------------------------------------------------------------------

/** Skill ids the HTTP layer will queue, in roster order. */
export const ALLOWED_SKILLS: ReadonlySet<string> = new Set(SKILL_IDS);

export { isKnownSkill };

export function writeIntent(
  skill: string,
  source: string,
  args: Record<string, unknown> = {}
): string {
  const id = crypto.randomUUID();
  const intent = { id, skill, args, ts: new Date().toISOString(), source };
  const queueDir = path.join(VAULT_ROOT, "system", "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, `${id}.json`), JSON.stringify(intent, null, 2), "utf-8");
  return id;
}
