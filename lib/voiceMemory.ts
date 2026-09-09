// Conversational memory moved to lib/voice/memory.ts, alongside the rest of
// the voice layer. This re-export keeps `@/lib/voiceMemory` working.
export {
  clearMemory,
  rememberExchange,
  recentExchanges,
  allExchanges,
  conversationContext,
} from "./voice/memory";
export type { Exchange } from "./voice/memory";
