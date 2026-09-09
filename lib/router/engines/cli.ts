import { homeEnv } from "../../homeEnv";
import type { VaultState } from "../../vault";
import type { RouteResult, RouterEngine } from "../types";
import { routerSystem } from "./prompt";
import { validateRouted, type RoutedJson } from "./validate";

// Routes through the logged-in `claude` CLI instead of the HTTP API, so the
// smart fallthrough works with NO ANTHROPIC_API_KEY at all — the CLI carries
// its own auth.
//
// It is not as fast as the direct API (~4s vs ~1s) because the cost is process
// startup, not the model: booting Node and initialising a session. But it is
// far better than the alternative it replaces — without it, every unrecognised
// utterance fell through to a full tier-3 background Opus run at 17-56s.
//
// --strict-mcp-config is load-bearing for latency: skipping MCP server
// discovery measured 6.07s -> 3.70s on a trivial call.
//
// Haiku here is deliberate. This call only classifies an utterance and writes
// one spoken sentence; the heavy reasoning happens later in the background job,
// which runs on Opus via AGENTIC_OS_MODEL.
const CLI_ROUTER_MODEL = () => homeEnv("VOICE_CLI_MODEL") || "haiku";
// Generous because the CLI competes with any background Opus jobs for CPU:
// measured 5.7s idle, 9-15s with three concurrent runs. Too tight and the
// engine silently falls back to rules, which is what it exists to avoid.
const CLI_ROUTER_TIMEOUT_MS = 30_000;

export async function cliRoute(
  transcript: string,
  state: VaultState,
  convo = ""
): Promise<RouteResult | null> {
  const { spawn } = await import("node:child_process");

  const prompt = [
    routerSystem(state, convo),
    "",
    "Reply with the JSON object only. No prose, no code fence.",
    "",
    `Utterance: ${transcript}`,
  ].join("\n");

  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      homeEnv("CLAUDE_BIN") || "claude",
      [
        "-p", prompt,
        "--model", CLI_ROUTER_MODEL(),
        "--max-turns", "1",
        // skip MCP discovery — pure startup cost for a classification call
        "--strict-mcp-config",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    // A slow CLI must not hold the voice loop open; fall through instead.
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("cli router timeout")); },
      CLI_ROUTER_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`cli router exit ${code}`));
    });
  });

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return validateRouted(JSON.parse(m[0]) as RoutedJson, "cli");
}

/** The backstop: no key, no Ollama, still smart. Slower than both, but the
 *  alternative it replaces is a 17-56s background job for one sentence. */
export const cliEngine: RouterEngine = {
  name: "cli",
  route: (transcript, state, convo) => cliRoute(transcript, state, convo),
};
