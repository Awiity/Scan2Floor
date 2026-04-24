@echo off
REM ── Scan2Floor — GPU Docker build and launch ──────────────────────────────
REM Requires: Docker Desktop running + NVIDIA Container Toolkit in WSL2.
REM GPU: RTX 4060 Laptop   CUDA driver: 13.0   CuPy: cuda12x (forward compat)

cd /d "%~dp0"

echo [1/4] Verifying GPU access...
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu22.04 nvidia-smi 2>nul
if ERRORLEVEL 1 (
    echo.
    echo ERROR: GPU not accessible from Docker.
    echo Make sure NVIDIA Container Toolkit is installed in WSL2:
    echo   https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
    echo And that Docker Desktop has WSL2 GPU support enabled.
    pause
    exit /b 1
)

echo [2/4] Building React frontend...
cd frontend
call npm install --silent
call npm run build
if ERRORLEVEL 1 (
    echo ERROR: Frontend build failed.
    pause
    exit /b 1
)
cd ..

echo [3/4] Building GPU Docker image (first run installs CuPy ~200MB, takes a few minutes)...
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
if ERRORLEVEL 1 (
    echo ERROR: Docker Compose GPU build failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  Scan2Floor GPU is running!
echo.
echo  Local:  http://localhost:8000
echo.
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' -and $_.InterfaceAlias -notlike '*WSL*' } | Select-Object -First 1).IPAddress"') do (
    echo  LAN:    http://%%i:8000
)
echo.
echo  GPU:    RTX 4060 Laptop  /  CuPy cuda12x
echo ============================================================
echo.
echo [4/4] Verifying CuPy inside container...
docker exec scan2floor python -c "import cupy; n=cupy.cuda.runtime.getDeviceCount(); print(f'CuPy {cupy.__version__} -- {n} GPU device(s) visible OK')"
echo.
pause
