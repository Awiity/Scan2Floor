"""Ukládání pojmenovaných pozic kamery do JSON souboru.

Body jsou v souřadnicích Matterport modelu (to, co vrací `Camera.getPose()`),
takže skok na ně nezávisí na kalibraci mraku. Soubor se zapisuje atomicky
(tmp + `os.replace`), aby ho nešlo poškodit přerušeným zápisem.
"""
from __future__ import annotations

import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class PointStore:
    """Jednoduché úložiště bodů v jednom JSON souboru (seznam bodů)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    # -- interní ------------------------------------------------------------
    def _read(self) -> list[dict[str, Any]]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError:
            return []
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return data if isinstance(data, list) else []

    def _write(self, items: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".points-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(items, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.replace(tmp, self.path)
        except BaseException:
            tmp_path = Path(tmp)
            if tmp_path.exists():
                tmp_path.unlink()
            raise

    # -- veřejné ------------------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        return self._read()

    def get(self, point_id: str) -> dict[str, Any] | None:
        return next((p for p in self._read() if p.get("id") == point_id), None)

    def add(self, data: dict[str, Any]) -> dict[str, Any]:
        point = {
            "id": f"pt_{uuid.uuid4().hex[:8]}",
            "name": data["name"],
            "sweep": data.get("sweep") or "",
            "position": data["position"],
            "rotation": data.get("rotation") or {"x": 0.0, "y": 0.0},
            "mode": data.get("mode") or "",
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        items = self._read()
        items.append(point)
        self._write(items)
        return point

    def delete(self, point_id: str) -> bool:
        items = self._read()
        remaining = [p for p in items if p.get("id") != point_id]
        if len(remaining) == len(items):
            return False
        self._write(remaining)
        return True
