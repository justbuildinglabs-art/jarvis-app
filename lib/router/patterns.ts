// Utterance-shape patterns shared by more than one module.

export const QUESTION_START =
  /^(what|how|is|are|was|did|when|who|where|why|any|do i|does|tell me)\b/;

// The full ~25s rundown fires ONLY on deliberate whole-utterance triggers —
// "give me the rundown", "brief me", "good morning". An earlier wide net of
// ~20 loose phrasings hijacked specific questions ("what's going on with the
// trending report today" got the whole daily spiel). Specific asks now fall
// through to the model engines, which answer about the THING asked.
export const BRIEFING_RE =
  /^(?:hey |ok |okay |so )*(?:jarvis,? )?(?:(?:can you |could you |what'?s |whats )?(?:give me |read me |run )?(?:the |my )?(?:daily |morning |full )?(?:rundown|briefing)|brief me|catch me up|good morning|morning,? jarvis)(?: for today| on today| today)?(?: please)?(?:,? jarvis)?$/;
