import { transcribe } from "@/lib/stt";
import { dispatchTranscript } from "@/lib/voiceDispatch";
import { VoiceConfigError } from "@/lib/tts";
import { fail, ok, unavailable } from "@/lib/http/respond";

// POST /api/voice — a push-to-talk clip as a raw audio body.
//
// audio → STT → the shared dispatch (route, maybe queue an intent, remember
// the exchange) → {transcript, tier, skill, reply}. The client speaks `reply`
// through /api/speak. Wake-word transcripts skip the STT step and arrive at
// /api/voice/text instead.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

const MIN_BYTES = 1000; // below this it's a stray keypress, not speech
const MAX_BYTES = 8 * 1024 * 1024; // ~8MB, well over a minute of opus

export async function POST(req: Request) {
  let audio: Buffer;
  try {
    audio = Buffer.from(await req.arrayBuffer());
  } catch {
    return fail("bad body", 400);
  }
  if (audio.length < MIN_BYTES) return fail("clip too short", 400);
  if (audio.length > MAX_BYTES) return fail("clip too long", 413);

  const mime = req.headers.get("content-type") || "audio/webm";

  try {
    const transcript = await transcribe(audio, mime);
    // STT heard nothing usable — say so rather than dispatching silence
    if (!transcript) return ok({ transcript: "", tier: 3, reply: "I didn't catch that." });

    return ok(await dispatchTranscript(transcript, "voice-ptt") as unknown as Record<string, unknown>);
  } catch (e) {
    if (e instanceof VoiceConfigError) {
      // the voice stack isn't set up — a config problem, not a request problem
      return unavailable(e.message);
    }
    return fail(String(e), 502);
  }
}
