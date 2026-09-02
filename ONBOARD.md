# ONBOARD.md — turning this into your HUD

What follows is an interview for Claude Code to conduct. When someone runs
`claude` inside a clone that has no `.jarvis-config.json`, Claude reads this
file and walks them through personalization, asking one thing at a time and
applying each edit as the answer arrives. Anyone preferring to do it by hand
can follow along — every place that needs touching is catalogued in the Edit
Manifest at the end.

## Running the interview (Claude reads this part)

**Step 0 — identify the platform without mentioning it.** Determine the OS
before you ask anything, then quietly shape everything around it: shell
syntax, path separators, whether to use `.vbs` launchers or nohup/launchd/
systemd, and which voice packages apply (Windows or Linux with an NVIDIA
card gets `onnxruntime-gpu` plus the `nvidia-*` wheels; Mac, or anything
without NVIDIA, gets plain `onnxruntime` — mention that voice will run on
CPU, slower but complete). A Windows command shown to a Mac user is a bug.
On Mac, note that HUD, runner, and onboarding behave identically; only voice
speed differs.

**Step 0.5 — get dependencies in place.** A fresh unzip has no
`node_modules/` because dependencies are never bundled. If it's missing, run
`npm install` before the questions rather than after. Say you're installing
while you begin the interview. Assume the `claude` CLI is already present
and authenticated.

Ask one question, apply the resulting edit immediately (an env line or a
file change, per the manifest), confirm it in a single sentence, then move
on. Every question should carry a recommended default. When you reach the
end, run the acceptance checks, write `.jarvis-config.json` in the shape
given below, and explain how to start everything.

### The questions, in order

1. **Vault location.** "Where should your vault live — the folder of plain
   files everything reads and writes? Default: keep using the bundled
   `starter-vault/` for now (you can move later). If you already use an
   Obsidian vault, point at it." → Set `VAULT_ROOT` in `~/.claude/.env`.
   If they point at an existing vault, create `system/queue`, `system/runs`,
   `system/metrics`, `daily-notes`, `inbox/reports/morning` inside it and
   copy `starter-vault/system/schemas/daily-note.md` over.
2. **Timezone.** "What timezone is 'today' for you?" (IANA name, e.g.
   Europe/London). → `HUD_TZ` in `~/.claude/.env`. Warn: the HUD and runner
   read the same var; never set them differently.
3. **Your name.** "How should the voice layer refer to you in its own
   notes?" → `HUD_USER_NAME` in `~/.claude/.env`.
4. **Obsidian.** "Do you use Obsidian on this vault? If yes, what's the
   vault name (folder name as Obsidian shows it)?" → If yes:
   `NEXT_PUBLIC_OBSIDIAN_VAULT=<name>` in `.env.local` in the repo root
   (build-time var). If no: skip — the deep link stays hidden.
5. **Telemetry metrics.** "The Telemetry panel reads `system/metrics/metrics.csv`
   (columns: timestamp,source,metric,value,status,error). The starter data
   is fake. What do you actually want on the wall — YouTube subs? GitHub
   stars? Sales? Anything you can script into that CSV works." → Help them
   sketch a small script (cron/Task Scheduler) appending rows; offer to
   write it. Update `SOCIAL_DEFS` in `components/HUD.tsx` if their sources
   aren't youtube/instagram.
6. **Morning report focus.** "The morning-report skill researches your
   field each day. What's your beat?" → Edit the `morning-report` prompt in
   `runner/runner.js` (the research scope sentence). `node --check` after.
7. **Email triage.** "Want the inbox-brief skill? It needs the Anthropic
   Gmail connector enabled in your Claude account." → If no, remove
   `inbox-brief` from `ALLOWED_SKILLS` (lib/skills.ts), `DECK_SKILLS`
   (components/HUD.tsx), and the runner case — all three, see couplings.
8. **Calendar.** "Want plan-today to pull your Google Calendar? Needs the
   Anthropic Google Calendar connector." → If no, note that plan-today
   still works, just without the schedule.
9. **Voice.** "Voice needs a local Python server (free, offline, ~400MB of
   models). Set it up now or later?" → If now: walk through the voice-server
   setup section in README.md (venv, pip installs, model downloads), then
   the voice audition (`voice-server/make_samples.py` → `audition.html` →
   `KOKORO_VOICE`/`KOKORO_SPEED`). If later: the HUD runs fine silent.
10. **Router brain.** "For sharper voice intent routing you can add an
    Anthropic API key (~$0.002 per ambiguous ask) and/or run a small local
    model via Ollama (free, offline). Rules-only also works." →
    `ANTHROPIC_API_KEY` in `~/.claude/.env` — **the FILE, never a Windows
    env var**, or every interactive `claude` session flips from
    subscription to API billing. Ollama: install + `ollama pull qwen3.5:4b`.
11. **Runner model.** "Which Claude model should background skills run on?
    Default opus — the best output for reports and research. Want it cheaper?
    Pick sonnet (good, much cheaper) or haiku (fastest, cheapest). You can also
    just tell Claude Code to switch it any time." → `AGENTIC_OS_MODEL` in
    `~/.claude/.env` (`claude-opus-4-8` / `claude-sonnet-4-6` /
    `claude-haiku-4-5-20251001`).
12. **Existing skills.** Look through whatever skills the user already has
    installed (`~/.claude/skills/` on Mac and Linux,
    `%USERPROFILE%\.claude\skills\` on Windows). If the directory holds
    anything, list each by name alongside the `description` from its
    SKILL.md and ask: "I found these skills already on your machine — want
    any pinned to the ops board and voice layer?" Every one they choose has
    to be threaded through all of its coupling points (see the Skill roster
    row in the Edit Manifest): add the name to `ALLOWED_SKILLS`
    (lib/skills.ts) and to `DECK_SKILLS` (components/HUD.tsx), give it a
    `deliverablePathFor()` path — `inbox/reports/<skill>/<date>-<id8>.md`
    is a reasonable default — and add a `buildPrompt()` branch whose prompt
    reads `${AUTONOMOUS_PREFIX}` + "Run the /<skill> skill. Write the result
    at exactly ${deliverable} ... End your reply with: SAVED ${deliverable}"
    so their own installed skill does the work, which headless `claude -p`
    can invoke. Follow with `node --check runner/runner.js`. **Caution them
    each time:** the board flow — Paper Trail panel, document cards, spoken
    summary — only functions when the skill writes a markdown artifact to
    its vault path and opens its reply with a single conversational
    sentence. A skill leaning on local scripts, private APIs, or outside
    state may queue and then do nothing. Say nothing at all if the directory
    turns up empty.
13. **Autostart.** "Want Jarvis to start at login — HUD, runner, and
    voice-server?" → Windows: shortcuts to `start-hud.vbs`,
    `runner/start-runner.vbs`, `voice-server/start-voice-server.vbs` in
    `shell:startup` (run `npx next build` first so the HUD launcher uses
    the fast production server). Mac/Linux: offer launchd plists / systemd
    units. If they decline: tell them "spin up Jarvis" in any `claude`
    session here starts everything on demand.

### Acceptance checks (run these, show results)

```
npm test                      # 16-case router sweep — must be 16/16
npx tsc --noEmit              # clean
npx next dev -p 4870          # then:
curl http://localhost:4870/api/state           # 200 JSON, metrics present
curl http://localhost:4870/api/speak           # {"ok":true,"engine":"kokoro"} if voice up,
                                               # {"ok":false} (graceful) if not
node --check runner/runner.js                  # after ANY runner edit
node runner/runner.js  (separate terminal)     # heartbeat: vault system/runner-status.json
```

If voice got installed, test the round trip: hold Space in the HUD and ask
"what's in the queue" — the spoken answer should come back in about a
second. Never run that test with a command phrase such as "run the inbox
brief", because it will dispatch a real job.

### Finish

Write `.jarvis-config.json` in the repo root:

```json
{
  "onboarded": "<ISO date>",
  "vault": "<VAULT_ROOT value>",
  "timezone": "<HUD_TZ>",
  "voice": true,
  "router": "rules|haiku|local|auto",
  "skills": ["morning-report", "inbox-brief", "plan-today", "plan-tomorrow", "vault-cleanup", "voice-ask"]
}
```

Then tell them how to run it: `npx next dev -p 4870` brings up the HUD,
`node runner/runner.js` starts the runner, and the README covers the voice
server. That's the whole job.

---

## Edit Manifest — every personalization touchpoint

| What | File · symbol | How |
|---|---|---|
| Vault path | `lib/config.ts` `VAULT_ROOT` (reads env) | `VAULT_ROOT` in `~/.claude/.env` |
| Timezone | `lib/config.ts` `HUD_TZ` + `runner/runner.js` `HUD_TZ` | `HUD_TZ` in `~/.claude/.env` (one var, both read it) |
| Your name | `lib/config.ts` `USER_NAME` | `HUD_USER_NAME` env |
| Voice server URL | `lib/config.ts` `VOICE_SERVER_URL`; client WS in `lib/voiceClient.ts` | `VOICE_SERVER_URL` env + `NEXT_PUBLIC_VOICE_WS` in `.env.local` |
| Obsidian deep link | `components/ReportOverlay.tsx` `OBSIDIAN_VAULT` | `NEXT_PUBLIC_OBSIDIAN_VAULT` in `.env.local` |
| Skill roster | `lib/skills.ts` `ALLOWED_SKILLS` ⟷ `runner/runner.js` `buildPrompt()`+`deliverablePathFor()` ⟷ `components/HUD.tsx` `DECK_SKILLS` | edit all three together |
| Voice aliases for skills | `lib/router.ts` `SKILL_ALIASES` | regex per skill; must also accept the wording printed on the Ops Board buttons |
| Spoken offers (**load-bearing**) | `lib/router.ts` `briefingOffer()` ⟷ `OFFER_SKILLS` keys ⟷ `pendingOffer()` regex | the offer sentence is parsed back verbatim when the user says "yes" — change all three together or "yes" stops working |
| Morning-report beat | `runner/runner.js` `morning-report` case | edit the research-scope sentence; `node --check` after |
| Telemetry panels | `components/HUD.tsx` `SOCIAL_DEFS` | match your metrics.csv sources |
| TTS voice | `voice-server/server.py` via `KOKORO_VOICE`, `KOKORO_SPEED` | audition first |
| STT vocab bias | `voice-server/server.py` `WHISPER_PROMPT` | list YOUR acronyms + skill names |
| Wake word | `voice-server/start-voice-server.vbs` `WAKE_WORD` | off by default (speaker bleed); headphones recommended |
| Runner model | `runner/runner.js` `CLAUDE_MODEL` | `AGENTIC_OS_MODEL` env; per-ask override allowlist in `MODEL_ALLOWLIST` |
| Rundown trigger phrases | `lib/router.ts` `BRIEFING_RE` | whole-utterance anchored — keep it that way |

**Rules that hold no matter how far you customize**

- The runner launches `claude -p` with `--dangerously-skip-permissions`
  because headless sessions have no one to approve anything, and the default
  permission mode would quietly refuse the deliverable write. What it runs
  is self-contained skill prompts against the user's own vault on localhost.
  Remove the flag and skills stop producing reports.
- `ANTHROPIC_API_KEY` exists as an entry in `~/.claude/.env` and nowhere else.
- Every runner spawn passes `--model` explicitly.
- `node --check runner/runner.js` follows every runner edit.
- `VAULT_ROOT` and `HUD_TZ` must agree between the HUD and the runner.
- Localhost only. Neither the HUD nor the voice-server should ever bind
  `0.0.0.0` — the endpoints that mutate state have no auth, by design.
