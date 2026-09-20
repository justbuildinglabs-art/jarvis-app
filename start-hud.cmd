@echo off
REM start-hud.cmd - launches the HUD server detached (Windows).
REM Survives the terminal/Claude session that started it. Uses the production
REM build when one exists (fast, stable), else falls back to dev mode.
REM Want it hidden at login? See "Start at login" in README.md (Task Scheduler).
REM Mac/Linux: `nohup npx next start -p 4870 &` (after `npx next build`).

cd /d "%~dp0"

if exist ".next" (
  start "jarvis-hud" /min cmd /c "npx next start -p 4870"
) else (
  start "jarvis-hud" /min cmd /c "npx next dev -p 4870"
)
