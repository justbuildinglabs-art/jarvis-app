import { speak, ttsStatus, VoiceConfigError } from "@/lib/tts";
import { fail, ok, readJsonBody, unavailable } from "@/lib/http/respond";

// ---------------------------------------------------------------------------
// GET  /api/speak?text=…  → an audio/mpeg stream
// GET  /api/speak         → a config probe: 200 {ok:true} or 503 {ok:false}
// POST /api/speak {text}  → the same stream, for text too long for a URL
//
// The response is a STREAM, consumed as an <audio src>, so the browser starts
// playing after the first sentence is generated rather than waiting for the
// whole reply. That is most of why the voice feels responsive.
// ---------------------------------------------------------------------------

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

const MAX_CHARS = 900;

async function stream(text: string): Promise<Response> {
  const trimmed = text.trim().slice(0, MAX_CHARS);
  if (!trimmed) return fail("empty text", 400);
  try {
    const out = await speak(trimmed);
    return new Response(out.stream, {
      headers: {
        "Content-Type": out.mime,
        "Cache-Control": "no-store",
        "X-Voice-Engine": out.engine,
      },
    });
  } catch (e) {
    // a missing engine is a setup problem (503); a failing one is upstream (502)
    if (e instanceof VoiceConfigError) return unavailable(e.message);
    return fail(String(e), 502);
  }
}

export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("text");
  if (text === null) {
    // no text = the client asking which engine, if any, is live
    const status = await ttsStatus();
    return status.ok ? ok(status) : unavailable("no TTS engine available");
  }
  return stream(text);
}

export async function POST(req: Request) {
  const body = await readJsonBody<{ text?: string }>(req);
  if (!body) return fail("bad json", 400);
  return stream(String(body.text ?? ""));
}
