"""Settings, all env-derived, all in one place."""

import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PORT = 4871
VOICE = os.environ.get("KOKORO_VOICE", "bm_george")  # calm British male
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
SAMPLE_RATE = 24000  # kokoro output rate
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small.en")

# Domain vocabulary bias. Without it, whisper renders "MRR" as "M.R.A." and
# mangles the skill names it is most often asked for — the words this
# assistant hears are not the words a general model expects.
WHISPER_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Jarvis dashboard voice commands: MRR, revenue, YouTube subscribers, "
    "TikTok, Instagram, metrics pull, morning report, inbox brief, GitHub "
    "trending, trend scan, daily briefing, runner, queue, top three priorities.",
)

WAKE_ENABLED = os.environ.get("WAKE_WORD", "on").lower() not in ("off", "0", "false")
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))

# The longest reply that will be spoken. Anything past this is truncated
# rather than queued — a runaway reply should not hold the speaker for a
# minute.
MAX_SPEAK_CHARS = 900

# Below this, a POSTed clip is a stray keypress rather than speech.
MIN_CLIP_BYTES = 1000
