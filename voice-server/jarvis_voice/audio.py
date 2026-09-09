"""Pure audio helpers — no models, no I/O, no globals.

Kept free of the model imports on purpose: the contract tests exercise these
directly, and they should not need a GPU or 400MB of weights to check how a
paragraph gets split into sentences.
"""

import re
import struct


def wav_header(sample_rate: int) -> bytes:
    """A WAV header declaring an unknown-length stream.

    The data size is the maximum a 32-bit field can hold, which is the
    conventional way to say "I don't know yet". Browsers play the stream
    progressively and stop at end-of-stream, so playback can begin before
    the last sentence has been synthesised.
    """
    data_size = 0x7FFFFFFF - 36
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
        b"data", data_size,
    )


SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def chunks_of(text: str):
    """Split a reply into synthesis chunks, first sentence alone.

    Shipping sentence one by itself is what makes the voice feel immediate:
    playback starts as soon as it is synthesised instead of after the whole
    reply. Everything after it is glued into chunks of at least 60 characters,
    because feeding a phonemizer three-word fragments chops the prosody and
    the result sounds clipped.
    """
    parts = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()]
    if not parts:
        return [text]
    out, cur = [parts[0]], ""
    for p in parts[1:]:
        cur = f"{cur} {p}".strip()
        if len(cur) >= 60:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out
