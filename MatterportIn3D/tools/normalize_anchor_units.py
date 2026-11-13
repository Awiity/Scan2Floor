"""Jednorázová migrace jednotek anchorů (mm → m) v objects.json.

Root-cause reálného bugu: SDK `Pointer.intersection` position pro
`intersectedobject.unknown` je v mm místo m — 22 event-anchorů (labely
dveře/okno/potrubí/východ) má souřadnice ~ ±8 000 m. Skript přepočítá tyto
raw anchors (i `anchor_dist`) ÷1000; legitimní anchors v m (max < práh) zůstávají.
Instanci sekci (`instances`) pak přegeneruje `tools/merge_objects.py`
(cluster_anchor_objects), export `tools/export_ifc.py`.

Idempotentní — druhé spuštění je no-op. Před zápisem udělá backup `.pre-units`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import OBJECTS_FILE  # noqa: E402

# Práh max souřadnice anchoru: nad tím je pravděpodobně v mm (legitimní < 100 m)
MM_THRESHOLD_M = 1000.0
MM_SCALE = 1000.0
BACKUP_SUFFIX = ".pre-units"


def fix_anchor(anchor: dict | None) -> tuple[dict | None, bool]:
    """Konvertuje anchor v mm na m (max souřadnice nad práhem); vrací (anchor, změna)."""
    if not isinstance(anchor, dict) or not anchor:
        return anchor, False
    big = max(abs(float(v)) for v in anchor.values()) > MM_THRESHOLD_M
    if not big:
        return anchor, False
    fixed = {k: round(float(v) / MM_SCALE, 4) for k, v in anchor.items()}
    return fixed, True


def run(file_path: str | Path = OBJECTS_FILE) -> tuple[int, int]:
    """Konvertuje mm anchors v raw views; vrací (konvertovaných, celkem anchors)."""
    path = Path(file_path)
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    changed, total = 0, 0
    for _sid, entry in data.get("sweeps", {}).items():
        for _yaw, view in (entry.get("views") or {}).items():
            for obj in view.get("objects") or []:
                anchor, _changed = fix_anchor(obj.get("anchor"))
                total += 1
                if not _changed:
                    continue
                obj["anchor"] = anchor
                if isinstance(obj.get("anchor_dist"), (int, float)):
                    obj["anchor_dist"] = round(float(obj["anchor_dist"]) / MM_SCALE, 3)
                changed += 1
    if changed:
        backup = path.with_suffix(path.suffix + BACKUP_SUFFIX)
        backup.write_text(raw, encoding="utf-8")
        path.write_text(json.dumps(data), encoding="utf-8")
    return changed, total


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", default=str(OBJECTS_FILE))
    args = ap.parse_args()
    changed, total = run(args.file)
    print(f"anchorů celkem: {total}, konvertováno mm→m: {changed}")


if __name__ == "__main__":
    main()
