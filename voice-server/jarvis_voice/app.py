"""The HTTP and WebSocket surface.

Four endpoints, and the shape of each is driven by how the browser consumes
it:

    GET  /health   what is loaded and on which device — the HUD polls this to
                   decide whether voice is available at all
    GET  /speak    a STREAMED audio/wav response, so playback starts after the
                   first sentence rather than the whole reply
    POST /stt      raw audio in, text out
    WS   /events   wake-word and barge-in events pushed to the HUD

Localhost only, by design: nothing here authenticates, because nothing here
should ever be reachable from another machine.
"""

import asyncio
import io
import time

import numpy as np
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from .audio import chunks_of, wav_header
from .config import (
    MAX_SPEAK_CHARS,
    MIN_CLIP_BYTES,
    SAMPLE_RATE,
    SPEED,
    VOICE,
    WHISPER_MODEL,
    WHISPER_PROMPT,
)
from .events import set_loop, wake, wake_status, ws_clients
from .runtime import KOKORO_DEVICE, WHISPER_DEVICE, kokoro, whisper, whisper_lock

app = FastAPI()


@app.websocket("/events")
async def events(ws: WebSocket):
    await ws.accept()
    # hello tells the HUD whether hands-free is actually armed — the client
    # can't read /health cross-origin, and "wake word armed" must not lie
    await ws.send_text(json.dumps({"type": "hello", "wake": bool(wake and wake.ok)}))
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings — content ignored
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


@app.on_event("startup")
async def _startup():
    set_loop(asyncio.get_running_loop())
    if wake is not None:
        wake.start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "kokoro",
        "voice": VOICE,
        "device": KOKORO_DEVICE,
        "stt": {"ok": True, "model": WHISPER_MODEL, "device": WHISPER_DEVICE},
        "wake": wake_status(),
    }


@app.post("/stt")
async def stt(req: Request):
    audio = await req.body()
    if len(audio) < MIN_CLIP_BYTES:
        return Response(status_code=400, content="clip too short")
    t0 = time.time()
    # faster-whisper decodes webm/opus/wav via PyAV from a file-like object
    with whisper_lock:
        segments, _info = whisper.transcribe(
            io.BytesIO(audio), beam_size=1, language="en", vad_filter=False,
            initial_prompt=WHISPER_PROMPT,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "ms": int((time.time() - t0) * 1000)}


@app.get("/speak")
def speak(text: str = ""):
    text = text.strip()[:MAX_SPEAK_CHARS]
    if not text:
        return Response(status_code=400, content="empty text")

    def gen():
        yield wav_header(SAMPLE_RATE)
        for chunk in chunks_of(text):
            samples, sr = kokoro.create(chunk, voice=VOICE, speed=SPEED, lang="en-gb")
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
            yield pcm.tobytes()
            # short breath between sentences
            yield b"\x00" * int(SAMPLE_RATE * 0.12) * 2

    return StreamingResponse(gen(), media_type="audio/wav",
                             headers={"Cache-Control": "no-store"})
