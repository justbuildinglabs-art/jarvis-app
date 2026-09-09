import { homeEnv } from "../homeEnv";
import type { VaultState } from "../vault";
import type { RouteResult, RouterEngine } from "./types";
import { rulesEngine } from "./engines/rules";
import { haikuEngine } from "./engines/haiku";
import { localEngine } from "./engines/local";
import { cliEngine } from "./engines/cli";

// How an utterance finds an answer.
//
// This used to be a run of `if (pref === "…")` blocks, each repeating the
// same "try it, catch, fall back to rules" dance, with the auto path
// hardcoding the order a fourth time. The policy is now data: a preference
// names an ordered list of engines, and one runner walks whichever list it
// gets. Adding an engine means writing it and naming it in a list.
//
// Two rules hold for every list:
//   * the rules engine is always last, and always answers, so the chain
//     cannot run out of engines;
//   * an engine that throws is an engine that declined. A 4xx from the API,
//     a dead Ollama, a missing `claude` binary — none of them may take the
//     voice loop down with them.

/** An engine may gate itself out of the chain (Haiku with no API key). */
type GatedEngine = RouterEngine & { available?: () => boolean };

const RULES: GatedEngine[] = [rulesEngine];

/**
 * VOICE_ROUTER → the engines to try, in order.
 *
 * `auto` is the interesting one and encodes the latency ladder: answer from
 * rules at ~0ms when they recognise the utterance; otherwise pay for the
 * cheapest smart engine that is actually available — the API when a key
 * exists (~1s), a local model if one is running (~1-2s), and failing both,
 * the logged-in CLI (~11s), which needs no key at all. Only when every one
 * of them declines does the caller fall back to the generic tier-3 reply and
 * a background job.
 */
const CHAINS: Record<string, GatedEngine[]> = {
  auto: [rulesEngine, haikuEngine, localEngine, cliEngine],
  haiku: [haikuEngine, rulesEngine],
  local: [localEngine, rulesEngine],
  cli: [cliEngine, rulesEngine],
  rules: RULES,
};

export const ROUTER_PREFERENCES = Object.keys(CHAINS);

/** An unknown VOICE_ROUTER value is a typo, not a request for silence —
 *  fall back to the full ladder rather than crippling routing. */
export function chainFor(pref: string): GatedEngine[] {
  return CHAINS[pref.toLowerCase()] ?? CHAINS.auto;
}

/**
 * Walk a chain until an engine commits to an answer.
 *
 * "Commits" is the subtle part, and it is why the rules engine can sit at the
 * head of the auto chain without shutting the model engines out: a result
 * carrying `fallthrough` means "I recognised nothing concrete", so the walk
 * continues and remembers it as the floor. Anything else is the answer.
 */
export async function runChain(
  engines: GatedEngine[],
  transcript: string,
  state: VaultState,
  convo: string
): Promise<RouteResult> {
  let floor: RouteResult | null = null;

  for (const engine of engines) {
    if (engine.available && !engine.available()) continue;

    let result: RouteResult | null = null;
    try {
      result = await engine.route(transcript, state, convo);
    } catch {
      // an engine that fails is an engine that declined — never fatal
      result = null;
    }
    if (!result) continue;
    if (!result.fallthrough) return result;
    floor ??= result;
  }

  // Every engine declined or fell through. The floor is the rules engine's
  // fallthrough result, which carries the honest "working on it" reply and
  // the flag that sends the ask to a background job.
  return floor ?? rulesEngine.route(transcript, state, convo) as RouteResult;
}

export function preferenceFromEnv(): string {
  return (homeEnv("VOICE_ROUTER") || "auto").toLowerCase();
}
