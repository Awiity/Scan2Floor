@echo off
echo Starting Scan2Floor Backend...
cd /d "%~dp0backend"

:: Start FastAPI using uvicorn
python -m uvicorn main:app --reload --host 0.0.0.0 --port 7070
