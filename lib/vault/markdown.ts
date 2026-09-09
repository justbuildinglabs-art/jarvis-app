import { readText, resolveReadable } from "./storage";

// Serving a deliverable to the report overlay. The path arrives from the
// browser, so the guard is the point: markdown only, inside the dirs runs
// write to, no traversal. resolveReadable() holds that rule for every caller.

// Path must stay inside the vault and under the dirs runs write to.

export function readVaultMarkdown(rel: string): string | null {
  const abs = resolveReadable(rel, { requireMd: true });
  return abs ? readText(abs) : null;
}
