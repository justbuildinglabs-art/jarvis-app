@echo off
REM start-runner.cmd - launches the runner daemon detached (Windows).
REM Want it hidden at login? See "Start at login" in README.md (Task Scheduler).
REM Mac/Linux: just `node runner/runner.js &` or a launchd/systemd unit.

cd /d "%~dp0"

start "jarvis-runner" /min node runner.js
