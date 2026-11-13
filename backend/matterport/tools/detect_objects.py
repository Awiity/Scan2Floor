"""CLI tool: run remote GroundingDINO/YOLO object inference on captured sweep views."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
from pathlib import Path
from typing import Any

import httpx

from ..config import AI_AUTH_TOKEN, AI_FILE_URL, AI_THRESHOLD, AI_WORKERS, MODEL_ID, resolve_paths
from ..objects import ObjectStore, VOCABULARY, bearing_for, normalize_label


def _detect_file(
    client: httpx.Client,
    img_path: Path,
    prompts: list[str],
    threshold: float,
) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {AI_AUTH_TOKEN}"} if AI_AUTH_TOKEN else {}
    with img_path.open("rb") as fh:
        resp = client.post(
            AI_FILE_URL,
            files={"file": (img_path.name, fh, "image/jpeg")},
            data={"prompts": json.dumps(prompts), "threshold": str(threshold)},
            headers=headers,
            timeout=60.0,
        )
    resp.raise_for_status()
    payload = resp.json()
    return payload.get("detections") or payload.get("objects") or []


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AI object detection on captured Matterport sweeps.")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--threshold", type=float, default=AI_THRESHOLD)
    parser.add_argument("--workers", type=int, default=AI_WORKERS)
    args = parser.parse_args()

    paths = resolve_paths(args.model_id)
    store = ObjectStore(path=paths["objects"], model_id=args.model_id)
    prompts = [v["en"] for v in VOCABULARY]
    cap_root = paths["captures"]
    if not cap_root.is_dir():
        raise SystemExit(f"Captures directory missing: {cap_root}")

    tasks: list[tuple[str, int, Path]] = []
    for sdir in sorted(cap_root.iterdir()):
        if not sdir.is_dir():
            continue
        for img in sorted(sdir.glob("h*.jpg")):
            try:
                hdg = int(img.stem.lstrip("h"))
            except ValueError:
                continue
            tasks.append((sdir.name, hdg, img))

    results_by_sweep: dict[str, list[dict[str, Any]]] = {}
    with httpx.Client() as client:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {
                pool.submit(_detect_file, client, img, prompts, args.threshold): (sid, hdg)
                for sid, hdg, img in tasks
            }
            for fut in concurrent.futures.as_completed(futs):
                sid, hdg = futs[fut]
                try:
                    dets = fut.result()
                except Exception:
                    continue
                for d in dets:
                    bbox = d.get("bbox_norm") or d.get("bbox")
                    if not bbox or len(bbox) < 4:
                        continue
                    yaw, pitch, _ = bearing_for(hdg, bbox)
                    lbl = normalize_label(d.get("label", ""))
                    results_by_sweep.setdefault(sid, []).append(
                        {
                            "label": lbl,
                            "raw_label": d.get("label"),
                            "score": round(float(d.get("score", 0.0)), 3),
                            "bbox_norm": [round(float(v), 4) for v in bbox[:4]],
                            "view_heading": hdg,
                            "world_yaw": yaw,
                            "pitch": pitch,
                        }
                    )

    for sid, dets in results_by_sweep.items():
        existing = store.get_sweep(sid) or {}
        store.upsert_sweep_detections(sid, {"position": existing.get("position")}, dets)
    print(json.dumps({"sweeps_updated": len(results_by_sweep)}))


if __name__ == "__main__":
    main()

