"""The local voice stack: Kokoro TTS and faster-whisper STT behind FastAPI.

Split out of a single server.py so each concern can be read — and imported —
on its own. Importing this package does NOT load the models; that happens in
``runtime`` and only when something asks for them, which is what lets the
contract tests import ``audio`` and ``config`` without a GPU or 400MB of
weights.

    config    ports, voice, model names, env-derived settings
    platform  the Windows CUDA DLL search-path fix, before any import needs it
    runtime   loading and holding the two models, and the lock they share
    audio     pure audio helpers: streaming WAV header, sentence chunking
    events    the wake-word thread and the WebSocket the HUD listens on
    app       the FastAPI routes
"""
