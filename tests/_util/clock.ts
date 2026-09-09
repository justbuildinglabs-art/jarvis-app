import { mock } from "node:test";
import { FROZEN_NOW_MS } from "./env";

/** Freeze Date (Date.now, new Date) at the fixture instant. Call in before(). */
export function freezeClock(nowMs: number = FROZEN_NOW_MS): void {
  mock.timers.enable({ apis: ["Date"], now: nowMs });
}

/** Advance the frozen clock by N ms (Date only — timers are untouched). */
export function tickClock(ms: number): void {
  mock.timers.tick(ms);
}

export function thawClock(): void {
  mock.timers.reset();
}
