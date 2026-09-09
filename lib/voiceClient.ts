// The voice client moved to lib/voice/ when it was split into the singleton
// (client.ts) and the pure pieces it used to carry inline: the text scrubber,
// the Web Audio helper, and the tunables.
//
// This re-export keeps `@/lib/voiceClient` working for existing callers.
export { voice } from "./voice/client";
export type { Reveal } from "./voice/types";
