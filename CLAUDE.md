# A.I. HUD — working notes for Claude Code

## First contact: is this copy configured?

**No `.jarvis-config.json` in the repo root** means nobody has set this clone
up yet. Handle that before touching anything else:

```
node scripts/setup.mjs
```

The script owns all the mechanical setup and is idempotent — it inspects each
step before acting and leaves anything already done alone:

- confirms Node 20+ and a working `claude` CLI
- runs `npm install` when `node_modules/` is absent
- lays down `~/.claude/.env` from a commented template at mode 600, and will
  **never clobber a file that already exists** (the user's keys live there)
- drops `.jarvis-config.json` as the "setup finished" marker

Pass `--voice` to additionally build the Python venv and pull the ~353MB
Kokoro weights. It chooses packages by inspecting the machine: CUDA wheels
when an NVIDIA card is present, plain `onnxruntime` everywhere else. Ignore
the raw install line in the README for this purpose — it is written for
Windows with CUDA, and its `nvidia-*` wheels have no Apple Silicon builds.

Afterwards, open `ONBOARD.md` and conduct the personalization interview:
where the vault lives, which metrics matter, which voice to use. The script
configures the machine; the interview configures the person. Neither
substitutes for the other.

**When something misbehaves later**, run `node scripts/doctor.mjs`. It
enumerates what is wired up and what isn't, with the remedy printed beside
each gap; `--json` emits the same thing for scripts. Consult it before
theorizing — every "it does nothing" and "it feels slow" report so far has
traced back to an unconfigured piece rather than a defect.

Do all of this on your own initiative rather than waiting to be asked, and
don't wave it off because the request seems minor: a half-configured copy
misbehaves in ways that are hard to read.

**`.jarvis-config.json` present** means setup already ran. Take its contents
as the user's settled choices and get on with whatever they came for.

## Before you investigate a "slow" complaint

Requests climb a ladder: regex rules (~0.03s) → a model → a background Opus
job. Whichever engine occupies the middle rung sets the feel of the product.

| Middle-rung engine | Latency | Requirement |
|---|---|---|
| `ANTHROPIC_API_KEY` (HTTP) | ~1s | a key, billed apart from any subscription |
| Ollama on :11434 | ~1-2s | `brew install ollama`, free, stays local |
| `claude` CLI (`cliRoute`) | ~11s | none — this is the automatic backstop |
| Background Opus job | 17-56s | last resort; the answer arrives as a file |

Absent both a key and Ollama, the CLI engine picks up the slack by driving
the already-signed-in CLI instead of an API key. It is the default, it does
work, and it is the slow road. When lag gets reported, read the routing line
in `node scripts/doctor.mjs` before anything else — the cause is nearly
always this rung, not the voice stack, which clocks ~2.7s end to end on CPU.

Two further sources of sluggishness, neither of them bugs: several
background jobs at once (three will saturate the machine and drag everything
down, the router included), and the browser tab itself, where the three.js
centerpiece can occupy half a core.

## Adapt to the platform, silently

Work out which OS you are on and reshape every command, path, and launcher
accordingly without asking. The `.vbs` files are a Windows convenience;
Mac and Linux use the underlying commands directly (nohup, launchd,
systemd). Any machine lacking an NVIDIA GPU runs voice in CPU mode on plain
`onnxruntime` — slower, but complete.

## Bringing the stack up

Any phrasing that means "start it" or "boot it up" should trigger this
sequence. Work through it in order and skip whatever is already live:

1. **Voice server** — poll `http://127.0.0.1:4871/health`. If it doesn't
   answer, start `voice-server\start-voice-server.vbs` on Windows, or
   `voice-server/.venv/bin/python voice-server/server.py` detached
   elsewhere. A missing venv means voice was never installed: say so, point
   at the README section, and carry on — a silent HUD is still a working HUD.
2. **Runner** — read the heartbeat at `<vault>/system/runner-status.json`
   and treat anything older than 2 minutes as dead. Revive it with
   `runner\start-runner.vbs` or a detached `node runner/runner.js`.
3. **HUD** — poll `http://localhost:4870`. If nothing answers, start
   `start-hud.vbs` on Windows or a detached
   `npx next build && npx next start -p 4870`. Launching DETACHED matters:
   use the `.vbs` wrappers, `Start-Process`, or `nohup`, because an ordinary
   background shell job dies the moment this Claude session ends.
4. **Hand it over** — tell them to visit `http://localhost:4870` and hold
   Space to speak, and mention that the browser won't emit any audio until
   it receives one click or keypress inside the tab (autoplay policy).

Should they want it running at login: on Windows, drop shortcuts to the
three `.vbs` files into `shell:startup` (reachable via
`explorer shell:startup`); on Mac use launchd plists; on Linux use systemd
user units. Wire it up for them rather than describing it.

## Shape of the system

- A Next.js 15 HUD on **:4870** (`npx next dev -p 4870`), a Python
  voice-server on **:4871** running Kokoro TTS plus faster-whisper STT, and
  a Node daemon under `runner/` that carries out skills through headless
  `claude -p`.
- Every piece of state is a file beneath the vault (`VAULT_ROOT`, falling
  back to `starter-vault/`). Nothing is stored in a database. For the visual
  overview see `docs/architecture.html`; the README condenses it. A
  cloud-voice cost and latency study lives in
  `docs/voice-engine-comparison.html`.
- The gate is `npm run check`, and it is the whole story: a production build,
  the router sweep, ~390 golden tests, the Python contract suite, and
  `tsc --noEmit`. Run it after any change. The build runs FIRST on purpose —
  some goldens describe its output, and a stale `.next/` would let them pass
  against HTML that no longer matches the source (there is a test that fails
  on exactly that).
- Those goldens pin CURRENT behavior so a refactor can be proven not to have
  changed it. A red golden means behavior moved. `tests/README.md` explains
  the harness and the one rule: loaders may change, expectations may not.

## Where things live

- `skills/` — the skill registry, and the reason adding a skill is now one
  file. Each definition in `skills/definitions/` carries its own id, Ops Board
  label, voice aliases, deliverable path, prompt, and scheduling category.
  The runner, the queue API, the Ops Board and the router all derive their
  view from it. (This replaced five hand-synchronised lists in four files.)
- `lib/router/` — `chain.ts` picks the engine ladder, `engines/` holds rules,
  haiku, local and cli, `answers/` holds everything answerable from the vault
  with no model.
- `lib/vault/` — `storage.ts` is the only module that touches `fs`; each
  reader owns one kind of file.
- `lib/voice/` — the whole voice path in pipeline order: stt, dispatch,
  speech, tts, memory, client.
- `components/hud/` — panels in `panels/`, shared pieces beside them; the root
  component keeps only the state and effects that connect them.
- `app/styles/` — one CSS partial per surface. The numbering IS the cascade.
- `runner/lib/` — config, files, log, skills, pool, execute.
- `voice-server/jarvis_voice/` — config, platform, runtime, audio, events, app.
  `server.py` is now just the entry point.

## Couplings that fail silently

- The offer sentence built by `briefingOffer()` (`lib/router/answers/`) is
  read back out of conversation memory word for word when someone replies
  "yes", so it is bound to the `OFFER_SKILLS` keys and the pattern inside
  `pendingOffer()` (`lib/router/offer.ts`). Move one, move all three.
- `HUD_TZ` is read independently by `lib/config.ts` and by the runner, both
  defaulting to America/Chicago. Change them as a pair or "today" fractures
  across two different dates.
- Never attach a second `animation` to anything carrying `.boot-stagger`:
  doing so supersedes `boot-in ... forwards` and the panel renders blank.
- The order of the `@import` lines in `app/globals.css` is the cascade.
  Reordering them is a visual change, not a tidy-up.
- Voice aliases live with their skill in `skills/definitions/`, and must
  accept the wording printed on the Ops Board button — people say what they
  can see. Rename a button, extend that skill's `aliases`.

The skill roster used to appear in three places and is now in one; `tests/
coupling.test.ts` still asserts every one of these invariants, so breaking one
turns the gate red rather than failing quietly at runtime.

## Traps worth knowing

- Every edit under `runner/` must be followed by
  `node --check runner/runner.js`. A syntax error there fails quietly: the
  heartbeat simply goes stale and no log appears.
- Exercising `/api/voice` with a command phrase enqueues a genuine intent
  and the runner will act on it. Use a tier-2 question such as "what's in
  the queue" when you only want to test the pipeline.
- A second HUD tab produces doubled audio. Remember that autoplay stays
  blocked until the tab receives a click or keypress.
- A corrupted webpack cache can hang `next dev`: kill whatever holds 4870,
  remove `.next/`, and start again.
