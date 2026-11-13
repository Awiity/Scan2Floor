"""Standalone DCUK Matterport Registry microservice (optional docker-compose service on :8019)."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

REGISTRY_DIR = Path(os.getenv("REGISTRY_DATA_DIR", "./registry_data")).resolve()
REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
_LOCK = threading.Lock()

app = FastAPI(title="Matterport DCUK Registry", version="1.0.0")


class PointPayload(BaseModel):
    id: str
    name: str
    note: str = ""
    position: dict[str, float]
    rotation: dict[str, float] = {"x": 0.0, "y": 0.0}
    sweep_id: str | None = None
    floor: Any = None
    created_at: str | None = None


def _model_dir(model_id: str) -> Path:
    safe = "".join(c for c in model_id if c.isalnum() or c in "-_")
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid model_id")
    d = REGISTRY_DIR / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "mp-registry"}


@app.get("/models/{model_id}/points")
def list_points(model_id: str) -> dict[str, Any]:
    with _LOCK:
        pts = _read_json(_model_dir(model_id) / "points.json", [])
    return {"model_id": model_id, "points": pts}


@app.post("/models/{model_id}/points")
def upsert_point(model_id: str, pt: PointPayload) -> dict[str, Any]:
    with _LOCK:
        path = _model_dir(model_id) / "points.json"
        pts: list[dict[str, Any]] = _read_json(path, [])
        pts = [p for p in pts if p.get("id") != pt.id]
        pts.append(pt.model_dump())
        _write_json(path, pts)
    return {"ok": True, "count": len(pts)}


@app.put("/models/{model_id}/inventory")
def put_inventory(model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        _write_json(_model_dir(model_id) / "inventory.json", payload)
    return {"ok": True}


@app.get("/models/{model_id}/inventory")
def get_inventory(model_id: str) -> Any:
    with _LOCK:
        return _read_json(_model_dir(model_id) / "inventory.json", {"model_id": model_id, "inventory": []})

