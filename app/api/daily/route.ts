import { toggleTop3 } from "@/lib/vault";
import { fail, ok, readJsonBody } from "@/lib/http/respond";

// POST /api/daily {index, done} — flip a Top 3 checkbox in TODAY's note.
//
// Today's only: a carried-over note is history, and the Goals panel renders
// it read-only to match. The index bound mirrors the parser, which recognises
// exactly three checkboxes.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJsonBody<{ index?: unknown; done?: unknown }>(req);
  if (!body) return fail("bad body", 400);

  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index > 2 || typeof body.done !== "boolean") {
    return fail("need {index: 0-2, done: boolean}", 400);
  }
  if (!toggleTop3(index, body.done)) {
    return fail("no matching checkbox in today's note", 404);
  }
  return ok({ ok: true });
}
