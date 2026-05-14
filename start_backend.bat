@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: start_backend.bat — Local dev launcher for Scan2Floor backend
::
:: Sets Windows-native paths so the file browser and pipeline work without
:: Docker.  Edit the DATA_ROOT line below if your scans live elsewhere.
::
:: Runs on port 8000 to match the Vite dev-proxy (frontend/vite.config.js).
:: ─────────────────────────────────────────────────────────────────────────────

:: ── Paths (edit as needed) ───────────────────────────────────────────────────
:: Root folder that contains your scan sub-folders (matterpak, matterpak_2, …)
set DATA_ROOT=C:\Users\AWIT\Desktop\WORK\data

:: Where the backend writes all pipeline outputs
set PROCESSED_DIR=%~dp0backend\processed

:: ── Environment ──────────────────────────────────────────────────────────────
:: SCAN_ROOTS: comma-separated dirs the file browser will walk.
::   In Docker this is /data; here we point at the real Windows path.
set SCAN_ROOTS=%DATA_ROOT%

:: DATA_DIR: default scan folder (fallback if nothing is selected in the UI)
set DATA_DIR=%DATA_ROOT%\matterpak

:: C2B_DIR: where Cloud2BIM outputs go (inside processed/ by default)
set C2B_DIR=%PROCESSED_DIR%\c2b_output

echo.
echo  Scan2Floor Backend — Dev Mode
echo  ─────────────────────────────────────────────
echo  SCAN_ROOTS   = %SCAN_ROOTS%
echo  DATA_DIR     = %DATA_DIR%
echo  PROCESSED_DIR= %PROCESSED_DIR%
echo  Port         = 8000
echo  ─────────────────────────────────────────────
echo.

cd /d "%~dp0backend"

:: Start FastAPI with hot-reload.  Port 8000 matches the Vite proxy target.
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
