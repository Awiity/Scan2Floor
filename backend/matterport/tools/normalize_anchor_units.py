"""CLI utility to normalize legacy millimeter anchors in objects.json to meters."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ..config import MODEL_ID, resolve_paths
from ..objects import (
    MM_SCALE,
    MM_THRESHOLD_M,
    cluster_anchor_objects,
    normalize_anchor_units_data,
)


def run(
    objects_path: Path | str,
    threshold_m: float = MM_THRESHOLD_M,
    scale: float = MM_SCALE,
    dry_run: bool = False,
) -> dict[str, int]:
    """Normalize millimeter anchors in ``objects_path`` and re-cluster instances."""
    p = Path(objects_path)
    data = json.loads(p.read_text(encoding="utf-8"))
    fixed, stats = normalize_anchor_units_data(data, threshold_m=threshold_m, scale=scale)
    if not dry_run:
        fixed["instances"] = cluster_anchor_objects(fixed.get("sweeps", {}) or {})
        p.write_text(json.dumps(fixed, indent=2, ensure_ascii=False), encoding="utf-8")
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize millimeter anchors to meters.")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--objects", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    path = Path(args.objects) if args.objects else resolve_paths(args.model_id)["objects"]
    print(json.dumps(run(path, dry_run=args.dry_run), indent=2))


if __name__ == "__main__":
    main()

