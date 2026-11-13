"""CLI tool: draw detection bounding boxes and 3D distances onto captured sweep JPGs for QA."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ..config import MODEL_ID, resolve_paths
from ..objects import ObjectStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Render QA bounding-box overlays onto sweep captures.")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--out-dir", default=None)
    args = parser.parse_args()

    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise SystemExit("Pillow is required: pip install Pillow") from exc

    paths = resolve_paths(args.model_id)
    store = ObjectStore(path=paths["objects"], model_id=args.model_id)
    out_root = Path(args.out_dir) if args.out_dir else (paths["base"] / "qa_overlays")
    out_root.mkdir(parents=True, exist_ok=True)

    rendered = 0
    for sid, sw in store.sweeps().items():
        cap_dir = paths["captures"] / sid
        if not cap_dir.is_dir():
            continue
        by_hdg: dict[int, list[dict]] = {}
        for d in sw.get("detections") or []:
            hdg = int(d.get("view_heading", 0))
            by_hdg.setdefault(hdg, []).append(d)

        for hdg, dets in by_hdg.items():
            src_img = cap_dir / f"h{hdg}.jpg"
            if not src_img.is_file():
                continue
            im = Image.open(src_img).convert("RGB")
            draw = ImageDraw.Draw(im)
            w, h = im.size
            for d in dets:
                bbox = d.get("bbox_norm")
                if not bbox or len(bbox) < 4:
                    continue
                x1, y1, x2, y2 = bbox[0] * w, bbox[1] * h, bbox[2] * w, bbox[3] * h
                draw.rectangle([x1, y1, x2, y2], outline=(56, 189, 248), width=3)
                txt = f"{d.get('label', '?')} {d.get('score', 0):.2f}"
                if d.get("distance_m") is not None:
                    txt += f" ({d['distance_m']}m)"
                draw.text((x1 + 4, max(2, y1 - 14)), txt, fill=(255, 255, 255))
            dest = out_root / f"{sid}_h{hdg}.jpg"
            im.save(dest, quality=90)
            rendered += 1

    print(json.dumps({"rendered_overlays": rendered, "out_dir": str(out_root)}))


if __name__ == "__main__":
    main()

