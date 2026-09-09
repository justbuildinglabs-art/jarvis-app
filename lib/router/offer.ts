import type { VaultState } from "../vault";
import { recentExchanges } from "../voiceMemory";

// Offer follow-through.
//
// The kickoff brief ends with "Want me to run the inbox audit?" — a bare
// "yes" has to dispatch that skill. The offer is recovered from the LAST
// exchange in conversation memory (fresh within 3 minutes), which keeps the
// whole thing stateless per request: nothing is held in server memory
// between utterances.
//
// LOAD-BEARING: the regex below parses the sentence briefingOffer() wrote,
// word for word. OFFER_SKILLS, that sentence and this pattern change together
// or "yes" silently stops working.

// The kickoff brief ends with "Want me to run the inbox audit?" — a bare "yes"
// must dispatch that skill. The offer is recovered from the LAST exchange in
// convo memory (fresh within 3 min), so this stays stateless per-request.

export const AFFIRM_RE =
  /^(yes|yeah|yep|sure|absolutely|go ahead|do it|let'?s do it|please do|yes please|go for it|sounds good)( please)?,?( jarvis)?$/;
export const DECLINE_RE =
  /^(no|nope|nah|not (right )?now|not yet|later|maybe later|hold off|skip it)( thanks| thank you)?,?( jarvis)?$/;
export const OFFER_SKILLS: Record<string, string> = {
  "morning report": "morning-report",
  "inbox audit": "inbox-brief",
};

export function pendingOffer(): string | null {
  const last = recentExchanges(1)[0];
  if (!last || Date.now() - Date.parse(last.ts) > 3 * 60 * 1000) return null;
  const m = last.jarvis
    .toLowerCase()
    .match(/want me to (?:run|pull) (?:the )?(?:daily )?(morning report|inbox audit)/);
  return m ? OFFER_SKILLS[m[1]] ?? null : null;
}

// dispatch acks must not lie: the intent always queues, but if the runner
// daemon's heartbeat is gone it won't START until someone restarts it —
// say so instead of a cheery "On it"
export function runnerDownNote(state: VaultState): string | null {
  return state.runner?.alive
    ? null
    : "but heads up — the runner daemon looks down, so it'll sit in the queue until that's restarted.";
}

// exported for tests — route() applies it internally
