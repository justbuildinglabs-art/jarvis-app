import { homeEnv } from "../../homeEnv";
import type { VaultState } from "../../vault";
import type { RouteResult, RouterEngine } from "../types";
import { PANEL_IDS } from "../types";
import { routerSystem } from "./prompt";
import { validateRouted, type RoutedJson } from "./validate";

// A small local model through Ollama — free, offline, ~600ms warm.

// qwen3.5:4b via Ollama — picked by bench (scripts/bench-router-model.mjs):
// 15/16 tier accuracy, 16/16 JSON + skill discipline, p50 ~600ms / p90 ~800ms
// warm on the 5090. Grammar-enforced JSON via Ollama's `format` schema, so
// parsing never fails — validateRouted only has to police the VALUES.

const OLLAMA_URL = () => homeEnv("OLLAMA_URL") || "http://127.0.0.1:11434";
const LOCAL_ROUTER_MODEL = () => homeEnv("VOICE_ROUTER_MODEL") || "qwen3.5:4b";
const LOCAL_TIMEOUT_MS = 6000; // covers a cold model load; warm calls ~600ms

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "integer", enum: [1, 2, 3] },
    skill: { type: "string" },
    reply: { type: "string" },
    panels: { type: "array", items: { type: "string", enum: [...PANEL_IDS] } },
  },
  required: ["tier", "reply"],
};

// fire-and-forget warmup so the first real utterance doesn't pay the model
// load; keep_alive 24h keeps the 3.4GB resident after that
let localWarmed = false;
export function warmLocal() {
  if (localWarmed) return;
  localWarmed = true;
  fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LOCAL_ROUTER_MODEL(),
      stream: false,
      think: false,
      keep_alive: "24h",
      options: { num_predict: 1 },
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {
    localWarmed = false; // ollama down — retry the warmup on a later call
  });
}

export async function localRoute(
  transcript: string,
  state: VaultState,
  convo = ""
): Promise<RouteResult | null> {
  warmLocal();
  const res = await fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    body: JSON.stringify({
      model: LOCAL_ROUTER_MODEL(),
      stream: false,
      think: false, // qwen3.5 small ships thinking-off, but be explicit
      keep_alive: "24h",
      format: ROUTE_SCHEMA,
      options: { temperature: 0.2, num_predict: 200 },
      messages: [
        { role: "system", content: routerSystem(state, convo) },
        { role: "user", content: transcript },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string } };
  const text = json.message?.content ?? "";
  if (!text) return null;
  return validateRouted(JSON.parse(text) as RoutedJson, "local");
}

export const localEngine: RouterEngine = {
  name: "local",
  route: (transcript, state, convo) => localRoute(transcript, state, convo),
};
