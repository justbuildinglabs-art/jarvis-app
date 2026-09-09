import { readVaultState } from "../vault";
import type { RouteResult } from "./types";
import { chainFor, preferenceFromEnv, runChain } from "./chain";
import { inFlightGuard } from "./guard";
import { warmHaiku } from "./engines/haiku";

// ---------------------------------------------------------------------------
// route(transcript) → {tier, skill?, reply}
//
//   tier 1  dispatch a skill to the queue
//   tier 2  answer from the vault snapshot
//   tier 3  needs real thinking — goes to a background job, honestly
//
// The engine ladder that decides which lives in ./chain.ts; the answers the
// rules engine can give without a model live in ./answers/. This file is the
// entry point and nothing else: read the world, walk the chain, apply the
// guard.
// ---------------------------------------------------------------------------

export async function route(transcript: string, convo = ""): Promise<RouteResult> {
  warmHaiku(); // no-op once warmed; retries a failed module-load ping
  const state = readVaultState();
  const result = await runChain(chainFor(preferenceFromEnv()), transcript, state, convo);
  return inFlightGuard(result, transcript, state);
}

warmHaiku(); // module load = the first voice API hit; warm while rules answer

// --- public surface ----------------------------------------------------------
// Callers import from "@/lib/router" and are unaffected by the split.
export { PANEL_IDS } from "./types";
export type { RouteResult, Reveal, PanelId, RouterEngine } from "./types";
export { rulesRoute } from "./engines/rules";
export { inFlightGuard } from "./guard";

// --- test seams ---------------------------------------------------------------
// Pure builders the golden suite pins directly, so the model-engine prompts
// and the rules engine's sub-answers can be checked without a network call.
export { routerSystem, stateSummary } from "./engines/prompt";
export { validateRouted } from "./engines/validate";
export { briefing, briefingOffer } from "./answers/briefing";
export { stateAnswer, openDocAnswer } from "./answers/state";
export { smalltalk, matchSkill } from "./answers/smalltalk";
export { pendingOffer } from "./offer";
export { chainFor, ROUTER_PREFERENCES } from "./chain";
