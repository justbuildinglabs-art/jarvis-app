import { allExchanges, clearMemory } from "@/lib/voiceMemory";
import { ok } from "@/lib/http/respond";
import type { Exchange } from "@/lib/voiceMemory";

// GET /api/transcript — the voice conversation so far, composed as markdown
// for the report overlay. Source is system/voice/memory.jsonl, so it survives
// restarts and shows exchanges from before the page was opened.
//
// DELETE /api/transcript — wipe the ring. This also resets the router's
// short-term memory and any pending offer, since both read the same file.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

/** The synthetic path the overlay uses to recognise this as not-a-vault-note
 *  (no Obsidian deep link, and a reset button instead). */
const TRANSCRIPT_PATH = "system/voice/transcript";

function hhmm(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function toMarkdown(exchanges: Exchange[]): string {
  const lines: string[] = ["# Voice Transcript", ""];
  if (exchanges.length === 0) {
    lines.push("*No exchanges yet — hold Space and say something.*");
  }
  let lastDay = "";
  for (const e of exchanges) {
    const day = e.ts.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      lines.push(`## ${day}`, "");
    }
    const skill = e.skill ? ` *(dispatched ${e.skill})*` : "";
    lines.push(`**${hhmm(e.ts)} — You:** ${e.you}`, "");
    lines.push(`**Jarvis:** ${e.jarvis}${skill}`, "");
  }
  return lines.join("\n");
}

export async function GET() {
  return ok({ path: TRANSCRIPT_PATH, content: toMarkdown(allExchanges()) });
}

export async function DELETE() {
  clearMemory();
  return ok({ ok: true });
}
