"""Jarvis local voice — Kokoro TTS + faster-whisper STT behind FastAPI on :4871.

The standalone voice process. The Next API routes stay stateless; this holds
the warm models, because loading whisper per request would cost more than the
transcription. lib/voice/tts.ts and lib/voice/stt.ts find it via /health and
degrade to a silent HUD when it is not running.

    GET  /health         {"ok": true, "voice": ..., "stt": {...}}
    GET  /speak?text=... audio/wav, streamed sentence by sentence so the
                         browser starts playing after the FIRST sentence
    POST /stt            raw audio body (webm/opus/wav) -> {"text": ...}
    WS   /events         wake-word and barge-in events for the HUD

Run: .venv/bin/python server.py   (or start-voice-server.cmd on Windows)

This file is the entry point only. The server lives in the jarvis_voice
package beside it — config, platform, runtime, audio, events, app — so that
the pure parts can be imported and tested without loading 400MB of weights.
"""

# MUST come before anything that imports faster_whisper: on Windows the CUDA
# DLLs from the nvidia-* wheels are not on the search path until this runs.
from jarvis_voice.platform import setup_dll_path

setup_dll_path()

import io

import soundfile as sf
import uvicorn

from jarvis_voice.app import app
from jarvis_voice.config import PORT, SAMPLE_RATE, SPEED, VOICE
from jarvis_voice.runtime import KOKORO_DEVICE, WHISPER_DEVICE, kokoro, whisper
from jarvis_voice.config import WHISPER_MODEL


def warm_models() -> None:
    """Pay the first-run cost at boot instead of on the user's first sentence.

    Whisper's first CUDA run JITs kernels and takes about nine seconds. Rather
    than ship silence for a canned clip, this feeds whisper the audio kokoro
    just produced — so one warmup exercises the whole pipeline end to end.
    """
    samples, _ = kokoro.create("Systems online.", voice=VOICE, speed=SPEED, lang="en-gb")
    warm = io.BytesIO()
    sf.write(warm, samples, SAMPLE_RATE, format="WAV")
    warm.seek(0)
    list(whisper.transcribe(warm, beam_size=1, language="en")[0])


if __name__ == "__main__":
    warm_models()
    print(
        f"kokoro({KOKORO_DEVICE}) + whisper({WHISPER_MODEL}/{WHISPER_DEVICE}) warm "
        f"— serving :{PORT} voice={VOICE}"
    )
    # 127.0.0.1 only: nothing here authenticates, and nothing here should be
    # reachable from another machine.
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
