# A.I. HUD

A heads-up display for your own life that you drive by talking to it —
**runs on your machine**, keeps everything in ordinary files, and hands the
hard thinking to a Claude agent working in the background. Press and hold
Space, say something; it replies inside a second, drops real work onto a
queue, and reads the results back to you once they land. Nothing on the
screen is decorative — every value traces to a file you can open.

**Quickest route to making it yours: run `claude` inside this folder.**
Claude Code picks up `ONBOARD.md`, interviews you about where your vault
lives, your timezone, the numbers you care about, the voice you want — and
makes each edit as you answer. Everything below is for people who would
rather read first or wire it up themselves.

## Two minutes to a running HUD

```bash
npm install
npx next dev -p 4870        # → http://localhost:4870
```

The visual demo needs nothing further — it boots against the bundled
`starter-vault/` and its placeholder data. Three additions turn the demo
into something real:

1. **The runner**, which is what actually executes skills: `node runner/runner.js`
   in another terminal. It expects the `claude` CLI installed and signed in.
2. **Voice**, optional and entirely offline: see [Voice server setup](#voice-server-setup).
3. **Your own vault and numbers**: run `claude` here and let the interview
   handle it, or work through `ONBOARD.md` by hand.

**Once you're running day to day**, open `claude` in this folder and say
**"spin up Jarvis"**. Whatever isn't already up — voice server, runner, HUD —
gets started detached, so closing the terminal doesn't take it down. To have
it come up at login, ask Claude to "make Jarvis start on boot" and it will
install the startup shortcuts (`start-hud.vbs`, `runner/start-runner.vbs`,
`voice-server/start-voice-server.vbs`).

## How the pieces fit

**Illustrated version: [`docs/architecture.html`](docs/architecture.html)** —
opens in any browser, no network needed. Weighing up cloud voice instead of
the local models? [`docs/voice-engine-comparison.html`](docs/voice-engine-comparison.html)
charts ElevenLabs against Kokoro and whisper on speed and cost. In brief:

```
┌──────────────────────────── YOUR MACHINE ────────────────────────────┐   ┌─ CLOUD (opt) ─┐
│                                                                      │   │               │
│  Browser HUD ──── Next.js server ──── THE VAULT ──── Runner daemon ──┼───┼─ Anthropic    │
│  :4870 orb/PTT    :4870 router        plain files    polls queue,    │   │  API          │
│       │           rules→Haiku→qwen    md/json/csv    spawns headless │   │  · Haiku route│
│       │                │                             claude -p       │   │  · claude -p  │
│  Voice server :4871 ───┘              Ollama :11434                  │   │    (tier 3 +  │
│  Kokoro TTS · whisper STT             offline router fallback        │   │     skills)   │
└──────────────────────────────────────────────────────────────────────┘   └───────────────┘
```

- **Your speech stays put** — both transcription (faster-whisper) and
  synthesis (Kokoro) execute locally; on a GPU the push-to-talk round trip
  runs 175–500ms.
- **The router sorts every utterance into one of three tiers**: tier 1 fires
  a skill by writing an intent onto the queue, tier 2 answers immediately
  (~25ms) from the current vault snapshot, tier 3 hands off to a background
  headless-Claude session whose answer gets spoken when it arrives.
- **The idea to hold onto**: the voice layer dispatches, it doesn't do the
  work. Files are the message bus, so every stage of every job can be
  inspected on disk afterwards.

## What lives in the vault

```
VAULT_ROOT/                       (default: ./starter-vault)
├── system/
│   ├── queue/                    intents written by HUD, claimed by runner
│   ├── runs/                     run records + logs (*.json, *.md)
│   ├── metrics/
│   │   ├── metrics.csv           timestamp,source,metric,value,status,error
│   │   └── latest-video.json     newest upload stats (optional)
│   ├── schemas/daily-note.md     frozen daily-note contract
│   └── runner-status.json        runner heartbeat (written by runner)
├── daily-notes/YYYY-MM-DD.md     priorities, schedule, focus
└── inbox/
    ├── reports/morning/          morning briefings (feeds the Signal Scan panel)
    └── voice/                    voice-ask answers
```

Absence is handled everywhere rather than crashing: files that aren't there
render as empty panels, a runner that has stopped shows RUNNER OFFLINE, and
a missing voice-server produces an orderly 503.

## Configuration

Environment variables come from your shell or from `~/.claude/.env`, a plain
`KEY=value` file where the process environment takes precedence. The
`NEXT_PUBLIC_*` ones are the exception — they belong in `.env.local` at the
repo root, since they get baked into the client bundle at build time.

| Var | Purpose | Default |
|---|---|---|
| `VAULT_ROOT` | vault folder | `./starter-vault` |
| `HUD_TZ` | IANA timezone for "today" (HUD + runner) | `America/Chicago` |
| `HUD_USER_NAME` | how voice notes refer to you | `User` |
| `AGENTIC_OS_MODEL` | model for background `claude -p` runs | `claude-opus-4-8` |
| `ANTHROPIC_API_KEY` | enables Haiku intent routing (~$0.002/ask) | unset (optional) |
| `VOICE_ROUTER` | force router engine: `auto`/`rules`/`haiku`/`local` | `auto` |
| `VOICE_ROUTER_MODEL` / `OLLAMA_URL` | local routing fallback | `qwen3.5:4b` / `:11434` |
| `VOICE_SERVER_URL` | TTS/STT server | `http://127.0.0.1:4871` |
| `KOKORO_VOICE` / `KOKORO_SPEED` | TTS voice + speed | `bm_george` / `1.0` |
| `WHISPER_MODEL` / `WHISPER_PROMPT` | STT model + vocab bias | `small.en` / built-in |
| `KOKORO_DEVICE` / `WHISPER_DEVICE` | force `cpu` if CUDA misbehaves | auto |
| `WAKE_WORD` | hands-free wake word (`on`/`off`) | `off` (speaker bleed) |
| `NEXT_PUBLIC_OBSIDIAN_VAULT` | Obsidian vault name for deep links | unset (link hidden) |
| `NEXT_PUBLIC_VOICE_WS` | wake-event websocket | `ws://127.0.0.1:4871/events` |

⚠️ Keep `ANTHROPIC_API_KEY` confined to the `~/.claude/.env` FILE. Exported
as a system-wide variable, it silently switches your interactive `claude`
CLI off your subscription and onto API billing.

## Voice server setup

Speech in and speech out, both local. Setup happens once (shown for Windows;
Mac and Linux follow the same shape):

```bash
cd voice-server
python -m venv .venv
.venv/Scripts/pip install kokoro-onnx fastapi uvicorn soundfile faster-whisper ^
  onnxruntime-gpu nvidia-cudnn-cu12 nvidia-cublas-cu12 nvidia-cufft-cu12 ^
  nvidia-cuda-runtime-cu12 nvidia-curand-cu12
# CPU-only machines: replace onnxruntime-gpu + nvidia-* with plain onnxruntime
```

Fetch `kokoro-v1.0.onnx` (~325MB) and `voices-v1.0.bin` (~28MB) from the
[kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases)
and drop both into `voice-server/`. Launch it with
`voice-server\start-voice-server.vbs` to run hidden, or
`.venv/Scripts/python server.py` to watch it. Expect roughly 250ms per
sentence of synthesis and 130ms of transcription on a GPU; a CPU does the
same work about four times slower.

**Choosing a voice**: `.venv/bin/python make_samples.py` (on Windows,
`.venv\Scripts\python make_samples.py`) renders `samples/` — British and
American male voices by default, or set `SAMPLE_PREFIXES="bf_,af_"` to
audition other families. Open `audition.html`, listen, then put your pick in
`KOKORO_VOICE`/`KOKORO_SPEED` and restart the server.

**Hands-free wake word (optional)**: install with
`pip install --no-deps openwakeword`, then
`pip install sounddevice requests tqdm scikit-learn websockets`. That
`--no-deps` flag is doing real work — without it the plain install replaces
your GPU onnxruntime with the CPU build. Then pull the model:
`python -c "from openwakeword.utils import download_models; download_models(['hey_jarvis_v0.1'])"`.
It ships disabled, because without headphones the microphone hears the HUD's
own voice and retriggers.

## Living with it

- **Hold Space** to talk. "Brief me" or "good morning" produces the spoken
  rundown. Questions like "what's in the queue" or "how many subscribers do
  I have" come back instantly. "Run the inbox brief" dispatches a job.
  Anything open-ended becomes a background task, spoken aloud when finished.
- **Esc** cuts off speech. Rows in Paper Trail open the report overlay, and
  Goals checkboxes can be ticked — but only on the current day's note.
- **TRANSCRIPT**, bottom-left, replays the voice conversation; RESET empties it.
- **Demo modes**, which need no data at all: `?demo=callouts` populates the
  document cards, `?demo=taskwork` performs the whole task-card lifecycle.
  Number keys 1–5 pin the core into a given mode, and B steps through the
  backgrounds.

## Security

There is deliberately **no authentication** here — it is a localhost tool,
and its API can both queue real work and read anything in your vault. Don't
bind it to `0.0.0.0`, don't forward ports 4870 or 4871, and don't run it on
a machine you share with people you don't trust.

## Mac and Linux

The whole stack is Node and Python, so it runs anywhere. The two `.vbs`
files are purely a Windows nicety — substitute `node runner/runner.js &` and
`python voice-server/server.py &`, or wire up launchd or systemd. On Apple
Silicon, install plain `onnxruntime` for CPU inference, or pin
`KOKORO_DEVICE=cpu` and `WHISPER_DEVICE=cpu`.

## Making it your own

`ONBOARD.md` is the map: an interview Claude Code conducts on your behalf,
followed by an Edit Manifest naming every place personalization touches —
the skill roster, voice aliases, the spoken-offer wording that has to stay in
sync, the metrics panels, the morning-report research beat. After any change
under `lib/`, satisfy both gates: `npm test` (a 16-case router sweep that
costs nothing) and `npx tsc --noEmit`.
