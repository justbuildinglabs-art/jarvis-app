// The voice layer, gathered.
//
// Everything between "a person said something" and "the HUD says something
// back" used to be six files scattered through lib/ — voiceClient,
// voiceDispatch, voiceMemory, spokenText, tts, stt — related only by their
// names. They are now one directory that reads in pipeline order:
//
//   stt.ts       audio → text
//   dispatch.ts  text → routed intent (queue write, memory, model override)
//   speech.ts    text → text a phonemizer says correctly
//   tts.ts       text → audio
//   memory.ts    what was said before, so follow-ups resolve
//   client.ts    the browser singleton that drives all of the above
//
// plus the pieces client.ts used to hold inline: types.ts, constants.ts,
// text.ts and audio.ts.
//
// Callers may import from here or from the individual modules; the old
// `@/lib/voiceClient`-style paths still work as re-export shims.

export { transcribe } from "./stt";
export { speak, ttsStatus, VoiceConfigError } from "./tts";
export type { SpeechStream } from "./tts";
export { normalizeForSpeech, scrubRunSummary, humanizeFailure } from "./speech";
export { dispatchTranscript } from "./dispatch";
export type { VoicePayload } from "./dispatch";
export {
  clearMemory,
  rememberExchange,
  recentExchanges,
  allExchanges,
  conversationContext,
} from "./memory";
export type { Exchange } from "./memory";
export { voice } from "./client";
export { sanitize } from "./text";
export { CHARS_PER_SEC, DISMISS_RE, WAKE_EVENTS_URL } from "./constants";
export type { Reveal, Utterance } from "./types";
