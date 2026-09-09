// The router's public shapes. Split out so an engine can be typed against
// the contract without importing the engine chain that selects it.

export interface RouteResult {
  tier: 1 | 2 | 3;
  skill?: string;
  reply: string;
  engine: "haiku" | "rules" | "local" | "cli";
  /** HUD panels the reply talks about — P3 choreography highlights them */
  panels?: PanelId[];
  /** vault-relative md the reply references — HUD offers it via the reveal chip */
  deliverable?: string;
  /** "open" = pop the deliverable overlay immediately instead of offering a chip */
  reveal?: "open";
  /** callouts sequenced to the speech — `at` = char offset into the reply
   *  where the relevant sentence starts; the client converts to time */
  reveals?: Reveal[];
  /** rules engine matched nothing concrete — a smarter engine may retry */
  fallthrough?: boolean;
}

export interface Reveal {
  kind: "doc" | "link";
  /** vault-relative md (doc) or full URL (link) */
  target: string;
  label: string;
  at: number;
}

export const PANEL_IDS = [
  "vitals",
  "pipeline",
  "diagnostics",
  "priorities",
  "schedule",
  "objective",
  "documents",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** What a routing engine is: an utterance plus the world it lands in,
 *  answered or declined. Returning null means "I have no answer" — the
 *  chain moves on to the next engine rather than failing the request. */
export interface RouterEngine {
  /** shows up in RouteResult.engine and in the HUD's log line */
  readonly name: RouteResult["engine"];
  route(
    transcript: string,
    state: import("../vault").VaultState,
    convo: string
  ): Promise<RouteResult | null> | RouteResult | null;
}
