"""Generate A/B samples for every British-male Kokoro voice at several
speeds into samples/, plus an audition.html to click through them.
Run: .venv\\Scripts\\python.exe make_samples.py
"""
import glob
import os
import sys

# Windows/CUDA only — add_dll_directory doesn't exist on Mac/Linux, and the
# nvidia wheels aren't installed there either, so guard the whole block.
if hasattr(os, "add_dll_directory"):
    for _d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(_d)
        os.environ["PATH"] = _d + os.pathsep + os.environ["PATH"]
    os.environ.setdefault("ONNX_PROVIDER", "CUDAExecutionProvider")
else:
    os.environ.setdefault("ONNX_PROVIDER", "CPUExecutionProvider")

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")
os.makedirs(OUT, exist_ok=True)

TEXT = (
    "Good evening, sir. All systems are operating within normal parameters. "
    "The morning briefing is ready — three priorities on deck, and video "
    "velocity is up about twelve percent since yesterday."
)
SPEEDS = [0.95, 1.0, 1.08]

kokoro = Kokoro(
    os.path.join(HERE, "kokoro-v1.0.onnx"),
    os.path.join(HERE, "voices-v1.0.bin"),
)

# PREFIXES picks which families to audition. bm_ = British male (the Jarvis
# register, and where the default bm_george lives); am_ = American male.
# Override with e.g. SAMPLE_PREFIXES="bm_,bf_" to audition other families —
# the full roster is 54 voices, far too many to sit through by default.
PREFIXES = tuple(os.environ.get("SAMPLE_PREFIXES", "bm_,am_").split(","))
# British voices get the full speed sweep; the rest get 1.0 only, so the page
# stays listenable instead of ballooning to a hundred clips.
voices = sorted(v for v in kokoro.get_voices() if v.startswith(PREFIXES))
print(f"auditioning {len(voices)} voices: {voices}")

rows = []
for voice in voices:
    lang = "en-gb" if voice.startswith("bm_") or voice.startswith("bf_") else "en-us"
    for speed in SPEEDS if voice.startswith("bm_") else [1.0]:
        name = f"{voice}_x{speed:.2f}.wav"
        samples, sr = kokoro.create(TEXT, voice=voice, speed=speed, lang=lang)
        sf.write(os.path.join(OUT, name), samples, sr)
        rows.append((voice, speed, name))
        print("wrote", name)

items = "\n".join(
    f'<div class="row"><b>{v}</b> <span>x{s:.2f}</span>'
    f'<audio controls preload="none" src="samples/{n}"></audio></div>'
    for v, s, n in rows
)
html = f"""<!doctype html><meta charset="utf-8"><title>Kokoro voice audition</title>
<style>body{{background:#0a0e14;color:#9fd8e8;font-family:Consolas,monospace;padding:2rem}}
.row{{display:flex;align-items:center;gap:1rem;margin:.4rem 0}}
.row b{{width:8rem}}.row span{{width:4rem;opacity:.6}}audio{{width:30rem}}</style>
<h2>Kokoro voice audition — current: {os.environ.get("KOKORO_VOICE", "bm_george")} x{float(os.environ.get("KOKORO_SPEED", "1.0")):.2f}</h2>
<p>Pick one, then set KOKORO_VOICE / KOKORO_SPEED in ~/.claude/.env and restart the voice-server.</p>
{items}
"""
with open(os.path.join(HERE, "audition.html"), "w", encoding="utf-8") as f:
    f.write(html)
print(f"\n{len(rows)} samples -> {OUT}\naudition page -> {os.path.join(HERE, 'audition.html')}")
