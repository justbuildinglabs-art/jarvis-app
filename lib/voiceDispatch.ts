// Transcript dispatch moved to lib/voice/dispatch.ts, alongside the rest of
// the voice layer. This re-export keeps `@/lib/voiceDispatch` working.
export { dispatchTranscript } from "./voice/dispatch";
export type { VoicePayload } from "./voice/dispatch";
