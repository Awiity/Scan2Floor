# syntax=docker/dockerfile:1
# Matterport In3D — dvě varianty:
#   slim  → app server (UI + API + inventář); bez Matterport SDK závislostí
#   full  → slim + Playwright/Chromium + Pillow (pipeline capture/detect/anchor/merge)
FROM python:3.12-slim AS slim

WORKDIR /app

# závislosti jen pro app server (fastapi, uvicorn, pydantic, websockets, httpx)
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/app/
COPY static/ /app/static/
# IFC export endpoint (GET /export/ifc) — generuje soubor on-demand, takže i
# slim image potřebuje exporter (ifcopenshell je v requirements.txt)
COPY tools/export_ifc.py /app/tools/export_ifc.py

EXPOSE 8017
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8017"]

# ---------------------------------------------------------------------------
FROM slim AS full

# pipeline nástroje: Playwright + Chromium (headless) + Pillow (QA overlay)
RUN pip install --no-cache-dir playwright pillow && \
    playwright install --with-deps chromium

COPY tools/ /app/tools/
