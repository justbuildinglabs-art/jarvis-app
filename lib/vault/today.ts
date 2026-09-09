import { HUD_TZ } from "../config";

// "Today" in HUD_TZ, not UTC.
//
// toISOString() rolls over at UTC midnight, which is early evening in the
// Americas — so an evening session would decide today's note didn't exist and
// start writing tomorrow's. Every date the vault derives goes through here,
// and the runner derives its own the same way from the same HUD_TZ.

export function todayInVaultTz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HUD_TZ }).format(now);
}
