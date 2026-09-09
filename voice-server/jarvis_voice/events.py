"""The event stream the HUD listens on, and the wake-word thread that feeds it.

Two threads meet here. openwakeword runs in its own thread with a blocking
audio input; uvicorn owns the asyncio loop the WebSockets live on. Anything
the wake thread wants to tell the browser has to cross that boundary, which
is what ``emit_event`` is for: it schedules the send onto the loop rather
than touching a socket from the wrong thread.

Set-based client tracking, with removal on any send failure, because a
browser tab closing is the normal case rather than an error.
"""

import asyncio
import json

from wakeword import WakeListener, WAKE_MODEL

from .config import WAKE_ENABLED, WAKE_THRESHOLD
from .runtime import transcribe_pcm


ws_clients: set = set()
main_loop = None


def emit_event(payload: dict):
    if main_loop is None:
        return
    msg = json.dumps(payload)

    async def _send():
        for ws in list(ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                ws_clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), main_loop)


wake = (
    WakeListener(transcribe_pcm, emit_event, threshold=WAKE_THRESHOLD)
    if WAKE_ENABLED
    else None
)


def set_loop(loop) -> None:
    """Hand the uvicorn event loop to emit_event at startup."""
    global main_loop
    main_loop = loop


def wake_status() -> dict:
    """What /health reports about hands-free. `ok` must not lie: the HUD arms
    its wake indicator from it, and claiming a listener that never started
    would leave the user talking to nothing."""
    return {
        "enabled": WAKE_ENABLED,
        "ok": bool(wake and wake.ok),
        "model": WAKE_MODEL,
        "threshold": WAKE_THRESHOLD,
        "error": wake.error if wake else None,
    }
