"""Thread-safe atomic JSON persistence for Matterport saved viewpoints (points)."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import MODEL_ID, resolve_paths


class PointStore:
    """Atomic JSON store for named Matterport camera viewpoints."""

    def __init__(self, path: Path | str | None = None, model_id: str | None = None):
        if path is not None:
            self.path = Path(path)
        else:
            self.path = resolve_paths(model_id or MODEL_ID)["points"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._points: list[dict[str, Any]] = self._load()

    def _load(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
            if isinstance(data, dict) and isinstance(data.get("points"), list):
                return data["points"]
        except Exception:
            pass
        return []

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._points, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(self.path)

    def reload(self) -> None:
        """Reload points from disk."""
        with self._lock:
            self._points = self._load()

    def list(self) -> list[dict[str, Any]]:
        """Return shallow copies of all saved viewpoints."""
        with self._lock:
            return [dict(p) for p in self._points]

    def get(self, point_id: str) -> dict[str, Any] | None:
        """Return viewpoint matching ``point_id`` or ``None``."""
        with self._lock:
            for p in self._points:
                if p.get("id") == point_id:
                    return dict(p)
            return None

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create and persist a new viewpoint entry."""
        entry = {
            "id": payload.get("id") or uuid.uuid4().hex[:10],
            "name": str(payload.get("name", "")).strip() or "Point",
            "note": str(payload.get("note", "") or ""),
            "position": payload.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0},
            "rotation": payload.get("rotation") or {"x": 0.0, "y": 0.0},
            "sweep_id": payload.get("sweep_id"),
            "floor": payload.get("floor"),
            "created_at": payload.get("created_at")
            or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._points.append(entry)
            self._save()
        return dict(entry)

    def delete(self, point_id: str) -> bool:
        """Delete viewpoint by ``point_id``. Returns True if deleted."""
        with self._lock:
            before = len(self._points)
            self._points = [p for p in self._points if p.get("id") != point_id]
            if len(self._points) == before:
                return False
            self._save()
            return True

