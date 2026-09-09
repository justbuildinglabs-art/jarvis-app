import type { VaultState } from "../../vault";
import { SKILL_ALIASES } from "@/skills/index.js";
import { ALLOWED_SKILLS } from "../../skills";
import { spokenNum, metric } from "../format";
import { briefing } from "./briefing";

// Greetings, acknowledgements and mic checks — answered instantly and NEVER
// dispatched to the runner. Without this lane "hey what's up" fell through
// to tier 3 and burned a 30-second background run on a greeting.

// Greetings, acks, mic checks — answered instantly, NEVER dispatched to the
// runner. Note: `t` is already lowercased with ?!. stripped (apostrophes kept).

export function smalltalk(t: string, state: VaultState): string | null {
  if (/\b(can you hear me|are you there|you there|you up|mic check|testing testing|test test)\b/.test(t)) {
    return "Loud and clear.";
  }
  if (/\b(thank you|thanks|appreciate it|appreciate you)\b/.test(t)) {
    return "Anytime.";
  }
  if (/\b(good ?night|i'?m off|heading to bed|signing off|see you tomorrow)\b/.test(t)) {
    return "Goodnight. I'll keep watch.";
  }
  // bare acks in any short combo: "ok", "okay cool", "nice one jarvis"
  if (/^((ok(ay)?|cool|nice|got it|sounds good|great|perfect|alright|sweet|then|one|man|jarvis)\s*){1,4}$/.test(t)) {
    return "Standing by.";
  }
  if (/\b(how are you|how'?s it going|how you doing|you good|you doing ok)\b/.test(t)) {
    return "Running smooth — all systems green. What do you need?";
  }
  if (
    /\b(what'?s up|whats up|wassup|what is up)\b/.test(t) ||
    /^(hey|hi|hello|yo|sup|hey there|good (morning|afternoon|evening))( there)?( jarvis)?$/.test(t)
  ) {
    return greetingReply(state);
  }
  return null;
}

// greeting gets a one-breath status so "what's up" actually answers the
// question — and points at the briefing for the long version
export function greetingReply(state: VaultState): string {
  const bits: string[] = [];
  if (state.runner?.busy) bits.push("the runner's mid-job");
  const open = state.daily?.isToday ? state.daily.top3.filter((p) => !p.done).length : 0;
  if (open > 0) bits.push(`${open === 1 ? "one goal" : `${open} goals`} still open`);
  const status = bits.length > 0 ? bits.join(" and ") : "all quiet on my end";
  return `Not much — ${status}. Say brief me if you want the rundown.`;
}

export function matchSkill(t: string): string | null {
  for (const [re, skill] of SKILL_ALIASES) {
    if (re.test(t) && ALLOWED_SKILLS.has(skill)) return skill;
  }
  return null;
}
