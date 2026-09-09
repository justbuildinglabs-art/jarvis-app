import { ALLOWED_SKILLS, writeIntent } from "@/lib/skills";
import { fail, ok, readJsonBody } from "@/lib/http/respond";

// POST /api/queue {skill} — drop an intent into system/queue/ for the runner.
//
// This is the "buttons are real" part: an Ops Board tap ends up here, a file
// lands in the vault, and a separate process picks it up. The skill roster
// comes from skills/, shared with the runner and the HUD, so a button can
// never queue something no runner branch answers.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJsonBody<{ skill?: string }>(req);
  if (!body) return fail("bad json", 400);

  const skill = String(body.skill ?? "");
  if (!ALLOWED_SKILLS.has(skill)) return fail(`unknown skill: ${skill}`, 400);

  try {
    const id = writeIntent(skill, "vault-hud");
    return ok({ ok: true, id, skill });
  } catch (e) {
    return fail(String(e), 500);
  }
}
