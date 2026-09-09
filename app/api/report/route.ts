import { readVaultMarkdown } from "@/lib/vault";
import { fail, ok } from "@/lib/http/respond";

// GET /api/report?path=inbox/... — serve a vault markdown deliverable to the
// HUD overlay. The path arrives from the browser, so readVaultMarkdown()
// holds the guard: .md only, inside the dirs runs write to, no traversal.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!path) return fail("path required", 400);
  const content = readVaultMarkdown(path);
  if (content === null) return fail("not found or not readable", 404);
  return ok({ path, content });
}
