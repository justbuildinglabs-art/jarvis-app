@echo off
REM start-voice-server.cmd - launches the local Kokoro TTS server detached.
REM Want it hidden at login? See "Start at login" in README.md (Task Scheduler).

cd /d "%~dp0"

REM Wake word off by default - speaker bleed into the mic makes hands-free
REM overlap with Jarvis's own replies unless you wear headphones.
REM Delete this line (or set "on") to arm hands-free.
set "WAKE_WORD=off"

start "jarvis-voice" /min ".venv\Scripts\python.exe" server.py
