// Tunables the voice client shares with its callers.

// Client-side, so NEXT_PUBLIC_ (inlined at build). Keep in step with
// VOICE_SERVER_URL in lib/config.ts if the voice-server moves.
export const WAKE_EVENTS_URL =
  process.env.NEXT_PUBLIC_VOICE_WS ?? "ws://127.0.0.1:4871/events";

// Kokoro bm_george at 1.0 speaks ~13 chars/sec. Close enough to time a
// callout's appearance to the sentence being spoken, which is the whole
// trick behind reveals feeling narrated rather than dumped.
export const CHARS_PER_SEC = 13;

// Post-wake utterances that just mean "never mind". The wake word already
// barged in and stopped playback, so there is nothing left to do but drop it.
export const DISMISS_RE = /^(stop|cancel|never ?mind|nothing|no|nope|shut up|quiet)[\s.!,]*$/i;
