import { route, type Reveal } from "../router";
import { writeIntent } from "../skills";
import { extractModelOverride } from "../modelOverride";
import { conversationContext, rememberExchange } from "./memory";

// ---------------------------------------------------------------------------
// Transcript → intent. Everything that happens to a spoken sentence after it
// becomes text, and before a reply comes back.
//
// Two front doors arrive here and are treated identically:
//   POST /api/voice       a push-to-talk clip (the route runs STT first)
//   POST /api/voice/text  a wake-word transcript (already text)
//
// Keeping them on one path is the point. Routing, model overrides, queue
// writes and conversation memory all behave the same whether you held Space
// or said the wake word, so there is no second code path to keep in step.
// ---------------------------------------------------------------------------

export interface VoicePayload {
  transcript: string;
  tier: number;
  skill: string | null;
  queued: string | null;
  reply: string;
  engine: string;
  panels: string[];
  deliverable: string | null;
  reveal: "open" | null;
  reveals: Reveal[];
}

export async function dispatchTranscript(
  transcript: string,
  source: string
): Promise<VoicePayload> {
  // "use opus" / "use fable" spoken in the ask → one-run model override;
  // strip the phrase so routing and the voice-ask prompt see the clean ask
  const override = extractModelOverride(transcript);
  const ask = override ? override.stripped : transcript;

  // running conversation memory — lets follow-ups ("make it shorter",
  // "what about the second one") resolve against the last few exchanges
  const convo = conversationContext();

  const result = await route(ask, convo);

  let queued: string | null = null;
  let reply = result.reply;
  if (result.tier === 1 && result.skill) {
    queued = writeIntent(result.skill, source);
  } else if (result.tier === 3 && ask.split(/\s+/).length >= 3) {
    // open-ended ask → headless claude -p via the runner (voice-ask skill);
    // completion is announced like any other run. Word guard keeps noise
    // and half-caught fragments from spawning real sessions.
    queued = writeIntent("voice-ask", source, {
      prompt: ask,
      ...(override ? { model: override.model } : {}),
      ...(convo ? { context: convo } : {}),
    });
    if (override && queued) {
      reply = `On it — running this one on ${override.spoken}. I'll speak up when it lands.`;
    }
  }

  const spokenReply = queued || result.tier !== 3 ? reply : "I didn't catch enough to act on.";

  rememberExchange({
    you: transcript,
    jarvis: spokenReply,
    tier: result.tier,
    skill: result.skill ?? (queued && result.tier === 3 ? "voice-ask" : undefined),
  });

  return {
    transcript,
    tier: result.tier,
    skill: result.skill ?? (result.tier === 3 && queued ? "voice-ask" : null),
    queued,
    reply: spokenReply,
    engine: result.engine,
    panels: result.panels ?? [],
    deliverable: result.deliverable ?? null,
    reveal: result.reveal ?? null,
    reveals: result.reveals ?? [],
  };
}
