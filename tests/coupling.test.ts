// Cross-file couplings that fail silently — the invariants CLAUDE.md lists
// under "Couplings that fail silently", pinned so the refactor can move code
// between files without breaking any of them:
//
//   1. skill roster: ALLOWED_SKILLS (lib/skills.ts) ⟷ the buildPrompt() /
//      deliverablePathFor() branches (runner/runner.js) ⟷ DECK_SKILLS
//      (components/HUD.tsx)
//   2. offer sentence: briefingOffer() ⟷ OFFER_SKILLS ⟷ the regex inside
//      pendingOffer() (all lib/router/offer.ts) — the spoken sentence is parsed
//      back out of memory.jsonl verbatim when the user answers "yes"
//   3. HUD_TZ default: lib/config.ts ⟷ runner/runner.js (each reads the env
//      on its own; both must fall back to the same zone)
//   4. .boot-stagger carries exactly one `animation` (boot-in … forwards)
//   5. SKILL_ALIASES (skills/, via each definition's `aliases`) ⟷ the words
//      printed on the Ops Board
//      buttons — "people say what they see"
//
// plus the smaller tables that ride on the same pattern: MODEL_PHRASES ids ⊆
// the runner's MODEL_ALLOWLIST, hotPanels literals ⊆ PANEL_IDS, SOCIAL_DEFS,
// and the router sweep (`npm test`) as a whole.
//
// Several of these tables are module-private (DECK_SKILLS, SOCIAL_DEFS,
// OFFER_SKILLS, MODEL_PHRASES, the hotPanels.includes("…") call sites, the
// CSS rules, the runner's `case` labels), so they are read out of the SOURCE
// TEXT with regexes. Every such loader is a placeholder: once a registry
// module exists, replace the loader with an import — the goldens (the
// extracted VALUES) stay exactly as they are.
import "./_util/env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FIXTURE_ROOT, FIXTURE_HOME } from "./_util/env";
import { freezeClock, thawClock, tickClock } from "./_util/clock";
import { buildFixtureVault, destroyFixtureVault, IDS, PATHS } from "./_util/fixtureVault";
import { expectGolden } from "./_util/golden";

const MIN = 60_000;
const HOUR = 60 * MIN;

// golden.ts resolves tests/golden from cwd, so cwd is the repo root by contract
const REPO = process.cwd();
const MEMORY_ABS = path.join(FIXTURE_ROOT, PATHS.memory);

before(() => {
  freezeClock();
  // the runner appends to RUNNER_LOG on boot/processOne only — neither runs
  // here (RUNNER_NO_BOOT=1) — but the path must be set BEFORE the module loads
  process.env.RUNNER_LOG = path.join(FIXTURE_ROOT, "runner-test.log");
});
beforeEach(() => {
  buildFixtureVault(); // (d) clears memory, (e) rewrites it — isolate each case
});
after(() => {
  thawClock();
  destroyFixtureVault();
});

// --- source-text loaders (placeholders — see header) -------------------------

const src = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf-8");

/** `const NAME … = [ … ];` (or `{ … };`) — from the declaration to the first
 *  line that is only the closer. */
function declBlock(source: string, name: string, closer: "];" | "};"): string {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `declaration of ${name} not found`);
  const end = source.indexOf(`\n${closer}`, start);
  assert.notEqual(end, -1, `closer of ${name} not found`);
  return source.slice(start, end + closer.length + 1);
}

/** DECK_SKILLS as printed on the Ops Board, in button order.
 *
 *  This used to scrape the array literal out of components/HUD.tsx, because
 *  the table was module-private there. It now comes from the skill registry,
 *  which is where the HUD itself reads it. The loader changed; the golden it
 *  feeds did not — which is the point: the buttons are the same buttons. */
async function loadDeckSkills(): Promise<{ skill: string; label: string }[]> {
  const { DECK_SKILLS } = await import("@/skills/index.js");
  return DECK_SKILLS.map((d) => ({ skill: d.skill, label: d.label }));
}

/** SOCIAL_DEFS — the Vitals panel's social rows.
 *  Was scraped out of components/HUD.tsx while the table was module-private
 *  there; the panel moved to components/hud/panels/Vitals.tsx and exports it,
 *  so this reads the real value now. Loader changed, golden unchanged. */
async function loadSocialDefs(): Promise<{ source: string; metric: string; label: string }[]> {
  const { SOCIAL_DEFS } = await import("@/components/hud/panels/Vitals");
  return SOCIAL_DEFS.map((d) => ({ source: d.source, metric: d.metric, label: d.label }));
}

/** OFFER_SKILLS — spoken phrase → skill, as pendingOffer() maps it.
 *  The table moved from lib/router.ts to lib/router/offer.ts when the router
 *  was split into modules; it is still module-private, so this still reads
 *  the source. Loader path changed, golden unchanged. */
function loadOfferSkills(): Record<string, string> {
  const block = declBlock(src("lib/router/offer.ts"), "OFFER_SKILLS", "};");
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) out[m[1]] = m[2];
  return out;
}

/** MODEL_PHRASES — "use <phrase>" → model id + spoken name. */
function loadModelPhrases(): { phrase: string; id: string; spoken: string }[] {
  const block = declBlock(src("lib/modelOverride.ts"), "MODEL_PHRASES", "};");
  return [
    ...block.matchAll(/(\w+):\s*\{\s*id:\s*"([^"]+)",\s*spoken:\s*"([^"]+)"\s*\}/g),
  ].map((m) => ({ phrase: m[1], id: m[2], spoken: m[3] }));
}

/** Every string literal HUD.tsx passes to hotPanels.includes("…"), in order
 *  of first appearance, de-duplicated. */
function loadHudHotPanelLiterals(): string[] {
  const seen = new Set<string>();
  for (const m of src("components/HUD.tsx").matchAll(/hotPanels\.includes\("([^"]+)"\)/g)) seen.add(m[1]);
  return [...seen];
}

interface CssRule {
  selector: string;
  declarations: string[];
}

/** The whole stylesheet, partials concatenated in @import order. */
function readStylesheet(): string {
  const entry = src("app/globals.css");
  const imports = [...entry.matchAll(/@import\s+"\.\/(.+?)";/g)].map((m) => m[1]);
  assert.ok(imports.length > 0, "no @imports found in app/globals.css");
  return imports.map((rel) => src(`app/${rel}`)).join("\n");
}

/** Leaf rules of globals.css (comments stripped; at-rule preludes are not
 *  part of the selector). Good enough for `.boot-stagger`, which is a
 *  top-level rule. */
function loadCssRules(): { rules: CssRule[]; css: string } {
  // globals.css is now a list of @imports; the rules live in app/styles/*.css.
  // Concatenate them in cascade order — the same order the browser sees — so
  // this still inspects the whole stylesheet. Loader changed, golden unchanged.
  const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, " "),
    declarations: m[2]
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter(Boolean),
  }));
  return { rules, css };
}

// --- runtime helpers ----------------------------------------------------------

async function loadRunner() {
  return import("../runner/runner.js");
}

function writeMemory(lines: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(MEMORY_ABS), { recursive: true });
  fs.writeFileSync(MEMORY_ABS, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), "utf-8");
}

/** Env for a child process: hermetic HOME, no daemon boot, no log append,
 *  and HUD_TZ REMOVED so the default is what gets printed. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_NO_BOOT: "1",
    RUNNER_LOG: "/dev/null",
    HOME: FIXTURE_HOME,
    USERPROFILE: FIXTURE_HOME,
  };
  delete env.HUD_TZ;
  return Object.assign(env, extra);
}

const RUNNER_TZ_EVAL = 'import("./runner/runner.js").then((r) => process.stdout.write(r.HUD_TZ))';
const CONFIG_TZ_EVAL = 'import("./lib/config").then((c) => process.stdout.write(c.HUD_TZ))';

function runnerHudTz(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ["-e", RUNNER_TZ_EVAL], { cwd: REPO, env, encoding: "utf-8" }).trim();
}

function configHudTz(env: NodeJS.ProcessEnv): string {
  return execFileSync("npx", ["tsx", "-e", CONFIG_TZ_EVAL], { cwd: REPO, env, encoding: "utf-8" }).trim();
}

// --- (a) the roster ------------------------------------------------------------

test("(a) ALLOWED_SKILLS, sorted, is the six-skill contract", async () => {
  const { ALLOWED_SKILLS } = await import("@/lib/skills");
  assert.ok(ALLOWED_SKILLS instanceof Set);
  expectGolden("coupling/allowed-skills-sorted", [...ALLOWED_SKILLS].sort());
});

// --- (b) roster ⟷ runner branches ---------------------------------------------

test("(b) every allowed skill has a deliverable path AND a prompt; an unknown skill has neither", async () => {
  const r = await loadRunner();
  const { ALLOWED_SKILLS } = await import("@/lib/skills");

  const probe = (skill: string, args: Record<string, unknown>) => {
    const intent = { id: IDS.queueVoiceAsk, skill, args };
    const deliverable = r.deliverablePathFor(intent);
    const prompt = r.buildPrompt(intent, deliverable);
    return {
      skill,
      args,
      deliverable,
      prompt_is_string: typeof prompt === "string",
      prompt_starts_with_autonomous_prefix: typeof prompt === "string" && prompt.startsWith(r.AUTONOMOUS_PREFIX),
      prompt_ends_with_saved_deliverable: typeof prompt === "string" && prompt.endsWith(`SAVED ${deliverable}`),
    };
  };

  const rows = [...ALLOWED_SKILLS]
    .sort()
    .map((skill) => probe(skill, skill === "voice-ask" ? { prompt: "summarize my week in three bullets" } : {}));
  for (const row of rows) {
    assert.equal(typeof row.deliverable, "string", `${row.skill}: deliverablePathFor returned ${row.deliverable}`);
    assert.ok(row.prompt_is_string, `${row.skill}: buildPrompt returned null`);
    assert.ok(row.prompt_starts_with_autonomous_prefix, `${row.skill}: prompt lacks AUTONOMOUS_PREFIX`);
    assert.ok(row.prompt_ends_with_saved_deliverable, `${row.skill}: prompt does not end with SAVED <deliverable>`);
  }

  // edges: a made-up skill (both null) and voice-ask with no prompt text
  // (deliverable is still built — slug "ask" — but the prompt is null)
  const madeUp = probe("made-up-skill", {});
  assert.equal(madeUp.deliverable, null);
  assert.equal(madeUp.prompt_is_string, false);
  const emptyAsk = probe("voice-ask", {});
  const blankAsk = probe("voice-ask", { prompt: "   " });

  expectGolden("coupling/runner-skill-contract", { allowed: rows, edges: { madeUp, emptyAsk, blankAsk } });
});

test("(b) the roster the runner serves is exactly the roster the API accepts", async () => {
  // Formerly: scrape `case "<skill>":` labels out of deliverablePathFor() and
  // buildPrompt() in runner/runner.js and compare them to ALLOWED_SKILLS.
  //
  // Those switch statements are gone — both functions now delegate to the
  // skill registry, which is also where ALLOWED_SKILLS comes from, so the
  // three-way drift that test existed to catch is no longer expressible.
  // Its golden (coupling/runner-case-labels) pinned the SOURCE ORDER of
  // switch cases: file layout, not behavior. It was deleted rather than
  // force-updated, because the behavior it guarded — every allowed skill
  // resolves to both a path and a prompt, and nothing else does — is pinned
  // by "(b) every allowed skill has a deliverable path AND a prompt" above,
  // which still passes untouched.
  //
  // What remains worth asserting is the invariant itself, now stated against
  // the registry: the roster the runner can serve and the roster the HTTP
  // layer will queue are the same set, derived from the same source.
  const { ALLOWED_SKILLS } = await import("@/lib/skills");
  const { SKILL_IDS, SKILL_BY_ID, isKnownSkill } = await import("@/skills/index.js");

  assert.deepEqual([...ALLOWED_SKILLS], SKILL_IDS, "ALLOWED_SKILLS is the registry roster, in order");
  for (const id of SKILL_IDS) {
    assert.ok(isKnownSkill(id), `${id} must be known to the registry`);
    const def = SKILL_BY_ID.get(id)!;
    assert.equal(typeof def.deliverable, "function", `${id} must define a deliverable path`);
    assert.equal(typeof def.prompt, "function", `${id} must define a prompt`);
  }
  assert.equal(isKnownSkill("not-a-real-skill"), false);

  expectGolden("coupling/registry-roster", {
    roster: SKILL_IDS,
    allowedMatchesRegistry: JSON.stringify([...ALLOWED_SKILLS]) === JSON.stringify(SKILL_IDS),
    perSkill: SKILL_IDS.map((id) => {
      const d = SKILL_BY_ID.get(id)!;
      return {
        id,
        label: d.label,
        deck: d.deck,
        order: d.order,
        aliasOrder: d.aliasOrder,
        aliasCount: d.aliases.length,
        serial: !!d.serial,
        dedupe: !!d.dedupe,
        long: !!d.long,
      };
    }),
  });
});

// --- (c) roster ⟷ Ops Board -----------------------------------------------------

test("(c) DECK_SKILLS as printed on the Ops Board, in order; every deck skill is allowed", async () => {
  const { ALLOWED_SKILLS } = await import("@/lib/skills");
  const deck = await loadDeckSkills();
  assert.ok(deck.length > 0, "no DECK_SKILLS entries extracted");
  for (const d of deck) assert.ok(ALLOWED_SKILLS.has(d.skill), `deck skill ${d.skill} is not in ALLOWED_SKILLS`);
  expectGolden("coupling/deck-skills", deck);
  // the roster is NOT symmetric: voice-ask has no button (it is dispatched by
  // voice only) — pinned as-is, CLAUDE.md's "all three name the same skills"
  // notwithstanding
  expectGolden("coupling/deck-vs-allowed-diff", {
    allowed_without_button: [...ALLOWED_SKILLS].filter((s) => !deck.some((d) => d.skill === s)).sort(),
    button_not_allowed: deck.map((d) => d.skill).filter((s) => !ALLOWED_SKILLS.has(s)),
  });
});

// --- (d) Ops Board labels ⟷ SKILL_ALIASES ---------------------------------------

test("(d) each Ops Board label, spoken as printed, dispatches tier 1 to its own skill", async () => {
  const { rulesRoute, matchSkill } = await import("@/lib/router");
  const { readVaultState } = await import("@/lib/vault");
  fs.writeFileSync(MEMORY_ABS, "", "utf-8"); // no standing offer in play
  const state = readVaultState();
  assert.equal(state.runner?.alive, true); // so the ack is the plain "coming up." form

  const deckRows = await loadDeckSkills();
  const rows = deckRows.map((d) => {
    const transcript = d.label.toLowerCase();
    return { label: d.label, transcript, alias_match: matchSkill(transcript), route: rulesRoute(transcript, state) };
  });
  for (const row of rows) {
    const want = deckRows.find((d) => d.label === row.label)!.skill;
    assert.equal(row.alias_match, want, `"${row.transcript}" matched ${row.alias_match}, button fires ${want}`);
    assert.equal(row.route.tier, 1, `"${row.transcript}" routed tier ${row.route.tier}`);
    assert.equal(row.route.skill, want, `"${row.transcript}" routed to ${row.route.skill}`);
  }
  expectGolden("coupling/deck-label-routes", rows);
});

// --- (e) offer sentence ⟷ OFFER_SKILLS ⟷ pendingOffer() -------------------------

test("(e) every briefingOffer() sentence parses back through pendingOffer() to its OFFER_SKILLS entry", async () => {
  const { briefingOffer, pendingOffer } = await import("@/lib/router");
  const { readVaultState } = await import("@/lib/vault");
  const offerSkills = loadOfferSkills();
  assert.ok(Object.keys(offerSkills).length > 0, "no OFFER_SKILLS entries extracted");
  const state = readVaultState();

  const rows: { local_hour: number; has_report: boolean; sentence: string; phrase: string | null; parsed: string | null }[] = [];
  const probe = (localHour: number, hasReport: boolean) => {
    const sentence = briefingOffer(state, hasReport);
    // a FRESH exchange relative to the (possibly ticked) clock — the offer is
    // only honored within 3 min of the last line
    writeMemory([{ ts: new Date(Date.now() - 30_000).toISOString(), you: "give me the rundown", jarvis: sentence, tier: 2 }]);
    const phrase = Object.keys(offerSkills).find((k) => sentence.toLowerCase().includes(k)) ?? null;
    rows.push({ local_hour: localHour, has_report: hasReport, sentence, phrase, parsed: pendingOffer() });
  };

  probe(10, false);
  probe(10, true);
  try {
    tickClock(6 * HOUR); // 16:30 CDT — past the "morning" cutoff
    probe(16, false);
    probe(16, true);
  } finally {
    thawClock();
    freezeClock();
  }

  for (const row of rows) {
    assert.ok(row.phrase, `no OFFER_SKILLS phrase inside "${row.sentence}"`);
    assert.equal(row.parsed, offerSkills[row.phrase], `"${row.sentence}" parsed to ${row.parsed}`);
  }
  // every offerable skill is reachable from some briefingOffer() branch
  assert.deepEqual(new Set(rows.map((r) => r.parsed)), new Set(Object.values(offerSkills)));

  // freshness edge: exactly 3 min old still counts, 1 ms older does not
  const stale = (ageMs: number) => {
    writeMemory([{ ts: new Date(Date.now() - ageMs).toISOString(), you: "brief me", jarvis: briefingOffer(state, true), tier: 2 }]);
    return { age_ms: ageMs, parsed: pendingOffer() };
  };
  const freshness = [stale(3 * MIN), stale(3 * MIN + 1)];
  assert.notEqual(freshness[0].parsed, null);
  assert.equal(freshness[1].parsed, null);

  expectGolden("coupling/offer-sentences", { offer_skills: offerSkills, offers: rows, freshness });
});

// --- (f) HUD_TZ defaults agree -----------------------------------------------------

test("(f) lib/config and the runner default HUD_TZ to the same zone, and both honor an override", () => {
  const defaults = { runner: runnerHudTz(childEnv()), config: configHudTz(childEnv()) };
  assert.equal(defaults.runner, defaults.config, "HUD_TZ defaults diverged between runner.js and lib/config.ts");
  const override = { runner: runnerHudTz(childEnv({ HUD_TZ: "Asia/Tokyo" })), config: configHudTz(childEnv({ HUD_TZ: "Asia/Tokyo" })) };
  assert.equal(override.runner, "Asia/Tokyo");
  assert.equal(override.config, "Asia/Tokyo");
  expectGolden("coupling/hud-tz-defaults", { defaults, override });
});

// --- (g) SOCIAL_DEFS -------------------------------------------------------------

test("(g) SOCIAL_DEFS rows of the Vitals panel", async () => {
  const defs = await loadSocialDefs();
  assert.ok(defs.length > 0, "no SOCIAL_DEFS entries extracted");
  expectGolden("coupling/social-defs", defs);
});

// --- (h) MODEL_PHRASES ⊆ MODEL_ALLOWLIST ---------------------------------------------

test("(h) every spoken model phrase maps to an id the runner's MODEL_ALLOWLIST accepts", async () => {
  const r = await loadRunner();
  const { extractModelOverride } = await import("@/lib/modelOverride");
  const phrases = loadModelPhrases();
  assert.ok(phrases.length > 0, "no MODEL_PHRASES entries extracted");
  const allowlist = [...r.MODEL_ALLOWLIST];

  const behavior = phrases.map((p) => {
    const o = extractModelOverride(`use ${p.phrase} summarize my week`);
    const modelFor = r.modelFor({ id: "x", skill: "voice-ask", args: { model: o?.model } });
    return { phrase: p.phrase, extracted: o?.model ?? null, spoken: o?.spoken ?? null, runner_model_for: modelFor };
  });
  for (const b of behavior) {
    const want = phrases.find((p) => p.phrase === b.phrase)!.id;
    assert.equal(b.extracted, want);
    assert.ok(r.MODEL_ALLOWLIST.has(want), `${want} is not in MODEL_ALLOWLIST`);
    assert.equal(b.runner_model_for, want, `runner downgraded ${want} to ${b.runner_model_for}`);
  }
  // anything outside the allowlist silently falls back to the default model
  assert.equal(r.modelFor({ id: "x", skill: "voice-ask", args: { model: "claude-nonsense-9" } }), r.CLAUDE_MODEL);
  assert.equal(r.modelFor({ id: "x", skill: "voice-ask", args: {} }), r.CLAUDE_MODEL);

  expectGolden("coupling/model-phrases-vs-allowlist", {
    phrases,
    allowlist,
    default_model: r.CLAUDE_MODEL,
    allowed_but_not_speakable: allowlist.filter((id) => !phrases.some((p) => p.id === id)),
    speakable_but_not_allowed: phrases.map((p) => p.id).filter((id) => !r.MODEL_ALLOWLIST.has(id)),
    behavior,
  });
});

// --- (i) PANEL_IDS ⟷ hotPanels.includes("…") ---------------------------------------

test("(i) every panel id HUD.tsx checks via hotPanels.includes() is a PANEL_IDS member", async () => {
  const { PANEL_IDS } = await import("@/lib/router");
  const hud = loadHudHotPanelLiterals();
  assert.ok(hud.length > 0, "no hotPanels.includes() literals extracted");
  const ids = [...PANEL_IDS] as string[];
  const hudNotInPanelIds = hud.filter((p) => !ids.includes(p));
  assert.deepEqual(hudNotInPanelIds, []);
  expectGolden("coupling/panel-ids-vs-hud-hot-panels", {
    panel_ids: ids,
    hud_hot_panel_literals: hud,
    hud_not_in_panel_ids: hudNotInPanelIds,
    panel_ids_unused_by_hud: ids.filter((p) => !hud.includes(p)),
  });
});

// --- (j) .boot-stagger animation ------------------------------------------------------

test("(j) .boot-stagger rules carry exactly one animation shorthand — boot-in … forwards", () => {
  const { rules, css } = loadCssRules();
  const stagger = rules
    .filter((r) => r.selector.includes(".boot-stagger"))
    .map((r) => ({
      selector: r.selector,
      animation_declarations: r.declarations.filter((d) => /^animation(-[a-z]+)*\s*:/.test(d)),
    }));
  assert.ok(stagger.length > 0, "no rule selects .boot-stagger");
  for (const r of stagger) {
    const shorthands = r.animation_declarations.filter((d) => /^animation\s*:/.test(d));
    assert.equal(shorthands.length, 1, `${r.selector}: expected exactly one animation shorthand, got ${shorthands.length}`);
    assert.match(shorthands[0], /\bboot-in\b/);
    assert.match(shorthands[0], /\bforwards\b/);
  }

  const kf = css.match(/@keyframes\s+boot-in\s*\{([\s\S]*?)\n\}/);
  assert.ok(kf, "@keyframes boot-in not found");
  const frames = [...kf[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    at: m[1].trim(),
    declarations: m[2].split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean),
  }));
  assert.ok(frames[0].declarations.includes("opacity: 0"));
  assert.ok(frames[frames.length - 1].declarations.includes("opacity: 1"));

  expectGolden("coupling/boot-stagger-css", { rules: stagger, keyframes: { name: "boot-in", frames } });
});

// --- (k) the router sweep ------------------------------------------------------------

test("(k) scripts/test-router.ts (npm test) passes end to end", () => {
  const out = execFileSync("npx", ["tsx", "scripts/test-router.ts"], {
    cwd: REPO,
    env: { ...process.env, VOICE_NO_WARMUP: "1" },
    encoding: "utf-8",
  });
  const lines = out.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  assert.match(last, /^All \d+ cases pass\.$/);
  assert.equal(lines.filter((l) => l.startsWith("FAIL")).length, 0);
  const n = Number(/^All (\d+) cases pass\.$/.exec(last)![1]);
  assert.equal(lines.filter((l) => l.startsWith("PASS")).length, n);
  expectGolden("coupling/router-sweep-final-line", last);
});
