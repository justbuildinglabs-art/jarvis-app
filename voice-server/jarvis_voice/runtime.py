"""The two models, loaded once and shared.

Both loaders follow the same rule: try the fast path, and fall back to the
slow one rather than failing. A broken CUDA stack should make this server
slower, never dead — the HUD is still usable at CPU speed, and an assistant
that will not start is worse than one that takes a second longer to answer.

The whisper lock matters more than it looks. One model serves two callers
(the /stt route and the wake-word thread), and ``transcribe`` returns a LAZY
generator — so the segments have to be consumed INSIDE the lock. Draining it
outside would run the actual decode unguarded while the other caller is also
in the model.
"""

import threading

from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

from .config import HERE, WHISPER_MODEL, WHISPER_PROMPT

import os

def load_kokoro():
    """CUDA via onnxruntime-gpu (~250ms/sentence vs ~1050ms CPU). kokoro-onnx
    picks the provider from ONNX_PROVIDER at init; if CUDA can't actually
    create (missing DLLs etc) onnxruntime silently falls back to CPU inside
    the session, so trust the session's own report, not the env var."""
    model = os.path.join(HERE, "kokoro-v1.0.onnx")
    voices = os.path.join(HERE, "voices-v1.0.bin")
    if os.environ.get("KOKORO_DEVICE", "auto") != "cpu":
        try:
            os.environ["ONNX_PROVIDER"] = "CUDAExecutionProvider"
            k = Kokoro(model, voices)
            if "CUDAExecutionProvider" in k.sess.get_providers():
                return k, "cuda"
        except Exception as e:
            print(f"kokoro cuda failed ({e}); falling back to cpu")
        os.environ.pop("ONNX_PROVIDER", None)
    return Kokoro(model, voices), "cpu"

kokoro, KOKORO_DEVICE = load_kokoro()

kokoro, KOKORO_DEVICE = load_kokoro()

def load_whisper():
    """CUDA float16 (5090 = ~100ms warm) with CPU int8 fallback so a
    broken CUDA stack degrades to slow-but-working, never to dead."""
    if os.environ.get("WHISPER_DEVICE", "auto") != "cpu":
        try:
            m = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
            return m, "cuda"
        except Exception as e:
            print(f"whisper cuda failed ({e}); falling back to cpu int8")
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8"), "cpu"

whisper, WHISPER_DEVICE = load_whisper()

# one whisper model, two callers (/stt route + wake-word thread) — serialize
whisper_lock = threading.Lock()


def transcribe_pcm(audio_f32):
    """float32 mono 16k -> text. Shared by the wake-word capture path."""
    with whisper_lock:
        segments, _info = whisper.transcribe(
            audio_f32, beam_size=1, language="en", vad_filter=False,
            initial_prompt=WHISPER_PROMPT,
        )
        # segments is a lazy generator — consume INSIDE the lock or the
        # actual decode runs unguarded
        return " ".join(s.text.strip() for s in segments).strip()
