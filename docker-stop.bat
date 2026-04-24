@echo off
REM ── Scan2Floor — Stop Docker container ──────────────────────────────────────
cd /d "%~dp0"
docker compose down
echo Scan2Floor stopped.
pause
