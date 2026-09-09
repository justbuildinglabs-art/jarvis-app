// Speech text rewriting moved to lib/voice/speech.ts, alongside the rest of
// the voice layer. This re-export keeps `@/lib/spokenText` working.
export { normalizeForSpeech, scrubRunSummary, humanizeFailure } from "./voice/speech";
