// Sanity checks on the harness itself: env pinning, hermetic HOME, frozen
// clock, and fixture shape. If this file fails, no golden can be trusted.
import "./_util/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_ROOT, FROZEN_NOW_ISO, TODAY, TOMORROW } from "./_util/env";
import { freezeClock, thawClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, IDS } from "./_util/fixtureVault";

before(() => {
  buildFixtureVault();
  freezeClock();
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

test("clock is frozen at the fixture instant", () => {
  assert.equal(new Date().toISOString(), FROZEN_NOW_ISO);
  assert.equal(Date.now(), Date.parse(FROZEN_NOW_ISO));
});

test("HOME is redirected — no ~/.claude/.env leaks in", async () => {
  const { homeEnv } = await import("@/lib/homeEnv");
  assert.equal(homeEnv("ANTHROPIC_API_KEY"), undefined);
  assert.equal(homeEnv("VOICE_ROUTER"), "rules");
});

test("config resolves to the fixture vault", async () => {
  const { VAULT_ROOT, HUD_TZ } = await import("@/lib/config");
  assert.equal(VAULT_ROOT, FIXTURE_ROOT);
  assert.equal(HUD_TZ, "America/Chicago");
});

test("vault readers see the fixture as designed", async () => {
  const { readVaultState } = await import("@/lib/vault");
  const s = readVaultState();
  assert.equal(s.generated_at, FROZEN_NOW_ISO);
  assert.equal(s.daily?.date, TODAY);
  assert.equal(s.daily?.isToday, true);
  assert.equal(s.daily?.top3.length, 3);
  assert.equal(s.daily?.schedule.length, 4);
  assert.equal(s.runner?.alive, true);
  assert.equal(s.runner?.heartbeat_age_s, 20);
  assert.deepEqual(
    s.runs.map((r) => r.id),
    [
      IDS.runInboxRunning,
      IDS.runVoiceAskLinked,
      IDS.runMorningToday,
      IDS.runPlanTodayError,
      IDS.runMorningYesterday,
      IDS.runCleanupOld,
      IDS.runVoiceAskOld,
    ]
  );
  assert.equal(s.runs[1].link, "https://mail.google.com/mail/u/0/#drafts?compose=abc123");
  assert.equal(s.runs[1].label, "fable five launch");
  assert.equal(s.morning?.heads.length, 4);
  assert.equal(s.morning?.links[3], null);
  assert.equal(s.queue.length, 2);
  assert.deepEqual(s.etas, { "morning-report": 300, "vault-cleanup": 95, "voice-ask": 58 });
  const yt = s.metrics.find((m) => m.source === "youtube" && m.metric === "subscribers");
  assert.equal(yt?.value, 50405);
  assert.equal(yt?.deltaWeek, 805);
  assert.equal(yt?.delta, 115);
});

test("runner prompt builders import without booting", async () => {
  const r = await import("../runner/runner.js");
  assert.equal(r.todayDate(), TODAY);
  assert.equal(r.tomorrowDate(), TOMORROW);
  assert.equal(r.CLAUDE_MODEL, "claude-opus-5");
  assert.match(r.buildPrompt({ id: "x", skill: "plan-today", args: {} }, "daily-notes/x.md") ?? "", /^Execute the requested task/);
});

test("rules router answers from the fixture and memory offer is live", async () => {
  const { rulesRoute, pendingOffer } = await import("@/lib/router");
  const { readVaultState } = await import("@/lib/vault");
  assert.equal(pendingOffer(), "inbox-brief");
  const r = rulesRoute("give me the rundown", readVaultState());
  assert.equal(r.tier, 2);
  assert.match(r.reply, /^Good morning/);
});
