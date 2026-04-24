@echo off
REM ── Scan2Floor — Docker build and launch ─────────────────────────────────────
REM Run this script from the scan2floor\ directory (or double-click it).
REM Requirements: Docker Desktop running, Node.js 18+ on PATH.

cd /d "%~dp0"

echo [1/3] Building React frontend...
cd frontend
call npm install --silent
call npm run build
if ERRORLEVEL 1 (
    echo ERROR: Frontend build failed. Check Node.js is installed.
    pause
    exit /b 1
)
cd ..

echo [2/3] Building Docker image and starting container...
docker compose up --build -d
if ERRORLEVEL 1 (
    echo ERROR: Docker Compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  Scan2Floor is running!
echo.
echo  Local:  http://localhost:8000
echo.
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' -and $_.InterfaceAlias -notlike '*WSL*' } | Select-Object -First 1).IPAddress"') do (
    echo  LAN:    http://%%i:8000
)
echo ============================================================
echo.
echo Tip: run docker-stop.bat to shut down the container.
pause
