"""CLI utility to re-cluster multi-sweep Matterport detections into deduplicated instances."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ..config import MERGE_RADIUS, MODEL_ID, resolve_paths
from ..objects import ObjectStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Cluster sweep object detections into instances.")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--objects", default=None)
    parser.add_argument("--radius", type=float, default=MERGE_RADIUS)
    args = parser.parse_args()
    path = Path(args.objects) if args.objects else resolve_paths(args.model_id)["objects"]
    store = ObjectStore(path=path, model_id=args.model_id)
    count = store.recompute_clusters(merge_radius=args.radius)
    print(json.dumps({"model_id": args.model_id, "instances": count, "radius_m": args.radius}))


if __name__ == "__main__":
    main()

