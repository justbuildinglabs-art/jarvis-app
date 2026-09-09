import { SKILL_ALIASES } from "@/skills/index.js";
import type { VaultState } from "../../vault";
import type { RouteResult, RouterEngine } from "../types";
import { AFFIRM_RE, DECLINE_RE, pendingOffer, runnerDownNote } from "../offer";
import { openDocAnswer, stateAnswer } from "../answers/state";
import { smalltalk, matchSkill } from "../answers/smalltalk";
import { QUESTION_START } from "../patterns";

// The rules engine — everything the router can decide without a model, at
// roughly zero cost. It answers what it recognises and sets `fallthrough` on
// what it doesn't, which is the signal the chain uses to reach for a model.
//
// Deliberately NOT here: verb-based dispatch. A "command verb anywhere plus
// alias anywhere" rule misfired twice on questions that merely mentioned a
// skill, re-running it. Sentence-level intent is a model's job; these rules
// dispatch only bare, short, unambiguous utterances.

export function rulesRoute(transcript: string, state: VaultState): RouteResult {
  const t = transcript.toLowerCase().replace(/[^a-z0-9$:'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { tier: 3, reply: "I didn't catch that.", engine: "rules" };

  // answer to a standing offer beats everything else
  if (AFFIRM_RE.test(t) || DECLINE_RE.test(t)) {
    const offered = pendingOffer();
    if (offered && AFFIRM_RE.test(t)) {
      return {
        tier: 1,
        skill: offered,
        reply: `On it — ${offered.replace(/-/g, " ")} ${runnerDownNote(state) ?? "running now."}`,
        engine: "rules",
        panels: ["pipeline"],
      };
    }
    if (offered) return { tier: 2, reply: "Standing by.", engine: "rules" };
  }

  const isQuestion = QUESTION_START.test(t) || transcript.includes("?");

  // open-verbs preempt skill dispatch — "show me the trend scan" means the
  // DOCUMENT from the last run, not "run a fresh scan"
  const doc = openDocAnswer(t, state);
  if (doc) {
    return {
      tier: 2,
      reply: doc.text,
      engine: "rules",
      panels: doc.panels,
      deliverable: doc.deliverable,
      reveal: doc.reveal,
    };
  }

  // NO verb-based dispatch here. A command-verb-anywhere + alias-anywhere
  // rule misfired twice on questions that merely mention a skill ("…do you
  // have any you think we should video?" — interrogative "do" counted as a
  // verb and re-ran github-trending). Sentence-level intent is the model
  // engines' job; rules dispatch ONLY the bare-alias short utterances below.

  const answer = stateAnswer(t, state);
  if (answer) {
    return {
      tier: 2,
      reply: answer.text,
      engine: "rules",
      panels: answer.panels,
      deliverable: answer.deliverable,
      reveal: answer.reveal,
      reveals: answer.reveals,
    };
  }

  // chitchat — instant tier-2 reply; without this, "hey what's up" fell
  // through to tier 3 and burned a 30s+ background run on a greeting
  const chat = smalltalk(t, state);
  if (chat) return { tier: 2, reply: chat, engine: "rules" };

  // bare alias, short utterance ("trend scan", "the inbox brief please") —
  // clear-cut dispatch. Longer sentences that name-drop a skill without a
  // command verb are ambiguous: defer to the model engines (when in doubt,
  // let something that can read decide).
  const skill = matchSkill(t);
  if (skill && !isQuestion && t.split(/\s+/).length <= 5) {
    return {
      tier: 1,
      skill,
      reply: `On it — ${skill.replace(/-/g, " ")} ${runnerDownNote(state) ?? "coming up."}`,
      engine: "rules",
      panels: ["pipeline"],
    };
  }

  return {
    tier: 3,
    reply: runnerDownNote(state)
      ? "I've queued that, but heads up — the runner daemon looks down, so it'll wait until that's restarted."
      : "Working on it — I'll speak up when it lands.",
    engine: "rules",
    fallthrough: true,
  };
}

/** The rules engine as a chain member. Synchronous, never declines: its
 *  `fallthrough` flag is what tells the chain to keep going. */
export const rulesEngine: RouterEngine = {
  name: "rules",
  route: (transcript, state) => rulesRoute(transcript, state),
};
