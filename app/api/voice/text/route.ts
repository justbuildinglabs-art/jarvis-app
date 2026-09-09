import { dispatchTranscript } from "@/lib/voiceDispatch";
import { fail, ok, readJsonBody } from "@/lib/http/respond";

// POST /api/voice/text {transcript} — a transcript the voice-server's wake
// pipeline already produced, so there is no audio to decode here.
//
// Same dispatch and same response shape as /api/voice, deliberately: the
// client handles a wake-word utterance and a push-to-talk clip identically,
// and only the transport differs.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

const MAX_CHARS = 1000;

export async function POST(req: Request) {
  const body = await readJsonBody<{ transcript?: unknown }>(req);
  const transcript = String(body?.transcript ?? "").trim();

  if (!transcript) return fail("no transcript", 400);
  if (transcript.length > MAX_CHARS) return fail("transcript too long", 413);

  try {
    return ok(await dispatchTranscript(transcript, "voice-wake") as unknown as Record<string, unknown>);
  } catch (e) {
    return fail(String(e), 502);
  }
}
