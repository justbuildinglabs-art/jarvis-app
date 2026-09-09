import type { Metric, VaultState } from "../vault";

// Spoken-friendly number, money and time formatting shared by the state
// answers and the briefing. Everything here is pure: no vault, no clock.

// Raw digits ("13,913") make TTS stumble; rounded magnitudes ("about 14
// thousand") flow like a person talking — and that's the register we want.

export function spokenNum(v: number): string {
  const x = Math.round(Math.abs(v));
  if (x >= 1_000_000) {
    const m = x / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} million`;
  }
  // whole thousands only — "4.7 thousand" makes TTS stumble ("four…seven");
  // the demo register is clean wave-tops, precision lives on screen
  if (x >= 1_000) return `${Math.round(x / 1000)} thousand`;
  return String(x);
}

export function spokenMoney(v: number): string {
  const x = Math.round(v);
  if (x >= 1000) return `about $${(Math.round(x / 100) * 100).toLocaleString("en-US")}`;
  return `$${x}`;
}

export function spokenTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  const h24 = parseInt(m[1], 10);
  const h = h24 % 12 || 12;
  const ap = h24 >= 12 ? "PM" : "AM";
  return m[2] === "00" ? `${h} ${ap}` : `${h}:${m[2]} ${ap}`;
}

export function weekDelta(m: Metric): string {
  if (m.deltaWeek === null || m.deltaWeek === 0) return "";
  return m.deltaWeek > 0
    ? ` — up about ${spokenNum(m.deltaWeek)} this week`
    : ` — down about ${spokenNum(m.deltaWeek)} this week`;
}

export function metric(state: VaultState, source: string, name: string): Metric | null {
  return state.metrics.find((m) => m.source === source && m.metric === name) ?? null;
}

/** "a, b and c" — the spoken form of a short list. */
export function listOut(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
