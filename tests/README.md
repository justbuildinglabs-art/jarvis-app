# Characterization suite

Pins the observable behavior of the code as it stood **before** the structural
refactor, so every rewrite can be checked against it. It is the gate: a change
that turns a golden red is a behavior change, not a refactor.

## Run

```
npm run test:golden          # the suite
npm run check                # router sweep + suite + tsc  (the gate)
npm run check:full           # check + next build
```

Capture new goldens: `UPDATE_GOLDEN=1 npm run test:golden` (creates missing
files only). Overwriting an existing golden needs `UPDATE_GOLDEN=force` and a
reason — it means behavior changed on purpose.

## Layout

- `tests/_util/env.ts` — **first import of every test file.** Pins env so the
  process is hermetic: `HOME` → empty fixture dir (no `~/.claude/.env`),
  `VAULT_ROOT` → per-process temp vault, `VOICE_ROUTER=rules`,
  `VOICE_NO_WARMUP=1`, `RUNNER_NO_BOOT=1`, voice-server URL unreachable.
- `tests/_util/clock.ts` — `freezeClock()` pins `Date` at
  `2026-09-09T15:30:00Z` (10:30 CDT). Everything time-relative in the fixture
  is built around that instant.
- `tests/_util/fixtureVault.ts` — `buildFixtureVault()` writes the vault
  (metrics, heartbeat, daily notes, morning reports, runs, queue, memory)
  with explicit mtimes. `IDS` / `PATHS` name the fixture's ids and files.
- `tests/_util/golden.ts` — `expectGolden(name, value)`. Strings are stored
  verbatim, everything else as pretty JSON. The fixture path becomes
  `<VAULT>` and non-fixture UUIDs become `<UUID>`.
- `tests/golden/*.golden.txt` — captured expectations. Immutable during the
  refactor.

## Test file shape

```ts
import "../_util/env";                       // first — pins env
import { test, before, after } from "node:test";
import { freezeClock, thawClock } from "../_util/clock";
import { buildFixtureVault, destroyFixtureVault } from "../_util/fixtureVault";
import { expectGolden } from "../_util/golden";

before(() => { buildFixtureVault(); freezeClock(); });
after(() => { thawClock(); destroyFixtureVault(); });

test("state snapshot", async () => {
  const { readVaultState } = await import("@/lib/vault");   // import AFTER env
  expectGolden("vault/state", readVaultState());
});
```

Import library modules dynamically inside tests (or after the env import) —
`lib/config.ts` reads `VAULT_ROOT` at module load.

## Rules for refactor work

1. Goldens are the contract. A refactor never edits `tests/golden/`.
2. Loaders may change. When a symbol moves (e.g. `buildPrompt` leaves
   `runner/runner.js`), update the import in the test file — the expected
   output stays.
3. No network, no `claude` subprocess, no real vault. If a test needs one of
   those, it does not belong here.
