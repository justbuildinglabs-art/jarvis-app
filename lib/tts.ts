// TTS moved to lib/voice/tts.ts. This re-export keeps `@/lib/tts` working.
export { speak, ttsStatus, VoiceConfigError } from "./voice/tts";
export type { SpeechStream } from "./voice/tts";
