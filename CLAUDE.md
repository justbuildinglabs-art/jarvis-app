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
- Gates to satisfy: `npm test` (a router sweep that spends nothing) and
  `npx tsc --noEmit`. Both, after any change under `lib/`.

## Couplings that fail silently

- The skill roster is duplicated three times — `ALLOWED_SKILLS` in
  `lib/skills.ts`, the `buildPrompt()` branches in `runner/runner.js`, and
  `DECK_SKILLS` in `components/HUD.tsx`. All three have to name the same
  skills.
- The offer sentence built by `briefingOffer()` in `lib/router.ts` is read
  back out of conversation memory word for word when someone replies "yes",
  so it is bound to the `OFFER_SKILLS` keys and the pattern inside
  `pendingOffer()`. Move one, move all three.
- `HUD_TZ` is read independently by `lib/config.ts` and by the runner, both
  defaulting to America/Chicago. Change them as a pair or "today" fractures
  across two different dates.
- Never attach a second `animation` to anything carrying `.boot-stagger`:
  doing so supersedes `boot-in ... forwards` and the panel renders blank.
- Voice aliases in `SKILL_ALIASES` (`lib/router.ts`) need to accept the
  wording actually printed on the Ops Board buttons — people say what they
  can see. Rename a button, extend the pattern.

## Traps worth knowing

- Every edit to `runner/runner.js` must be followed by
  `node --check runner/runner.js`. A syntax error there fails quietly: the
  heartbeat simply goes stale and no log appears.
- Exercising `/api/voice` with a command phrase enqueues a genuine intent
  and the runner will act on it. Use a tier-2 question such as "what's in
  the queue" when you only want to test the pipeline.
- A second HUD tab produces doubled audio. Remember that autoplay stays
  blocked until the tab receives a click or keypress.
- A corrupted webpack cache can hang `next dev`: kill whatever holds 4870,
  remove `.next/`, and start again.
