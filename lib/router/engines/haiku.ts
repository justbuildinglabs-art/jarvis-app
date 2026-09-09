import { homeEnv } from "../../homeEnv";
import type { VaultState } from "../../vault";
import type { RouteResult, RouterEngine } from "../types";
import { routerSystem } from "./prompt";
import { validateRouted, type RoutedJson } from "./validate";

// Haiku over the HTTP API — the fastest smart engine (~1s), but it needs an
// ANTHROPIC_API_KEY, which is billed separately from any subscription.

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let haikuWarmed = false;

export function warmHaiku() {
  const key = homeEnv("ANTHROPIC_API_KEY");
  // VOICE_NO_WARMUP: tests import this module — they must not ping the API
  if (haikuWarmed || !key || process.env.VOICE_NO_WARMUP) return;
  haikuWarmed = true;
  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {
    haikuWarmed = false; // network blip — retry on a later call
  });
}


export async function haikuRoute(
  transcript: string,
  state: VaultState,
  convo = ""
): Promise<RouteResult | null> {
  const key = homeEnv("ANTHROPIC_API_KEY");
  if (!key) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: routerSystem(state, convo),
      messages: [{ role: "user", content: transcript }],
    }),
  });
  if (!res.ok) throw new Error(`haiku ${res.status}`);

  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = json.content?.find((c) => c.type === "text")?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return validateRouted(JSON.parse(m[0]) as RoutedJson, "haiku");
}

/** Only offers itself when a key exists; without one it declines instantly
 *  so the chain can fall to an engine that carries its own auth. */
export const haikuEngine: RouterEngine = {
  name: "haiku",
  available: () => Boolean(homeEnv("ANTHROPIC_API_KEY")),
  route: (transcript, state, convo) => haikuRoute(transcript, state, convo),
} as RouterEngine & { available: () => boolean };
