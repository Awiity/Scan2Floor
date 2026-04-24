# ── Scan2Floor Backend — Production Image ─────────────────────────────────────
# Base: slim Python 3.11 (no GUI, no X11 needed)
FROM python:3.11-slim

WORKDIR /app

# System libraries required by OpenCV headless and Open3D
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (cached layer unless requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# ── Volume mount points (set matching paths in docker-compose.yml) ─────────────
# /processed  — writable volume for all pipeline outputs (persists between runs)
# /data       — read-only host folder containing the .xyz scan file(s)
# /c2b        — read-only host folder containing Cloud2BIM output_xyz/

# Expose the API port
EXPOSE 8000

# Production server — no --reload flag
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
