"""CLI tool: project 2D sweep detections onto 3D anchors using raycasting/pinhole fallback."""

from __future__ import annotations

import argparse
import json

from ..config import MODEL_ID, resolve_paths
from ..objects import ObjectStore, estimate_distance, ray_direction


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute 3D anchors for detected sweep objects.")
    parser.add_argument("--model-id", default=MODEL_ID)
    args = parser.parse_args()

    paths = resolve_paths(args.model_id)
    store = ObjectStore(path=paths["objects"], model_id=args.model_id)
    sweeps = store.sweeps()
    anchored = 0
    for sid, sw in sweeps.items():
        pos = sw.get("position")
        if not isinstance(pos, dict):
            continue
        ox, oy, oz = float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0))
        dets = sw.get("detections") or []
        changed = False
        for d in dets:
            if isinstance(d.get("anchor"), dict):
                continue
            bbox = d.get("bbox_norm")
            yaw = d.get("world_yaw")
            if not bbox or yaw is None:
                continue
            dist = estimate_distance(d.get("label", "other"), bbox)
            dx, dy, dz = ray_direction(float(yaw), float(d.get("pitch", 0.0)))
            d["anchor"] = {
                "x": round(ox + dx * dist, 4),
                "y": round(oy + dy * dist, 4),
                "z": round(oz + dz * dist, 4),
            }
            d["distance_m"] = dist
            anchored += 1
            changed = True
        if changed:
            store.upsert_sweep_detections(sid, {"position": pos}, dets)
    instances_count = store.recompute_clusters()
    print(json.dumps({"anchored_detections": anchored, "instances": instances_count}))


if __name__ == "__main__":
    main()

