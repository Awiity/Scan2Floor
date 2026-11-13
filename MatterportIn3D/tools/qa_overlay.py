"""QA overlay — nakreslí detekce, anchory a promítané instance do capture snímek.

Pro každý sken se sekci `capture/<sid>/yawXXX.jpg` nakreslí:
  - bbox raw detekce (žlutý) s číslem jistoty,
  - anchor dot (zelený) — promítnutý zpět do obrazu (mělo by padat do bboxu),
  - instance z `objects.json["instances"]` (červený kruh + id) — promítané
    ze 3D pozice do view, jsou-li v zorném poli a nejsou dál než 30 m.

Vstup: objects.json (--out) a capture adresář (--captures).
Výstup: `<capture>/<sid>/qa_yawXXX.jpg` — původní snímky zůstávají.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import CAPTURE_DIR, CAPTURE_TAN_HALF, OBJECTS_FILE  # noqa: E402
from app.objects import RAY_CENTER_Y, ObjectStore  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402

IMG_W, IMG_H = 1280, 720
RAYS_UP = 640.0  # stejná "ohnisková" konstanta jako RAY_HALF_WIDTH


def forward_right(yaw: float) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Kamera souřadnice — stejná konvence jako app/objects.py::ray_direction."""
    a = math.radians(float(yaw))
    forward = (-math.sin(a), 0.0, -math.cos(a))
    right = (math.cos(a), 0.0, -math.sin(a))
    return forward, right


def dist3d(pozice: dict[str, float], cam_pos: dict[str, float]) -> float:
    """Vzdálenost instance od kamery (m) — pro --max-dist filtr."""
    return math.hypot(
        float(pozice["x"]) - float(cam_pos["x"]),
        float(pozice["y"]) - float(cam_pos["y"]),
        float(pozice["z"]) - float(cam_pos["z"]),
    )


def project_to_view(
    pos: dict[str, float], cam_pos: dict[str, float], yaw: float, tan_half: float,
) -> tuple[int, int] | None:
    """Promítne 3D bod do pixelů view (1280×720); None, když je mimo zorné pole."""
    dx = float(pos["x"]) - float(cam_pos["x"])
    dy = float(pos["y"]) - float(cam_pos["y"])
    dz = float(pos["z"]) - float(cam_pos["z"])
    forward, right = forward_right(yaw)
    z_depth = dx * forward[0] + dy * forward[1] + dz * forward[2]
    x_right = dx * right[0] + dy * right[1] + dz * right[2]
    y_up = dy  # v up osách modelu roste nahoru
    if z_depth <= 0.5:  # za kamerou / na ní
        return None
    th = math.atan(x_right / z_depth)
    xc_norm = 0.5 + math.tan(th) / (2.0 * float(tan_half))
    if not (0.0 <= xc_norm <= 1.0):
        return None
    tv = math.atan(y_up / z_depth)
    # inverze app/objects.py::ray_direction — optická osa v ořezu na 408 px
    yc_px = RAY_CENTER_Y - math.tan(tv) / float(tan_half) * RAYS_UP
    if not (0.0 <= yc_px <= IMG_H):
        return None
    return (round(xc_norm * IMG_W), round(yc_px))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(OBJECTS_FILE))
    ap.add_argument("--captures", default=str(CAPTURE_DIR))
    ap.add_argument("--max-dist", type=float, default=30.0)
    args = ap.parse_args()

    data = ObjectStore(Path(args.out)).load()
    sweeps = data.get("sweeps", {})
    instances = data.get("instances") or []

    n_views = n_bbox = n_anchor = n_inst = 0
    for sid, entry in sweeps.items():
        cdir = Path(args.captures) / sid
        if not cdir.is_dir():
            continue
        cam_pos = entry.get("position") or {"x": 0, "y": 0, "z": 0}
        for yaw_key, view in (entry.get("views") or {}).items():
            img_path = cdir / f"yaw{int(float(yaw_key)):03d}.jpg"
            if not img_path.is_file():
                continue
            yaw = float(yaw_key)
            img = Image.open(img_path).convert("RGB")
            dr = ImageDraw.Draw(img)

            # 1) raw detekce + anchory
            for obj in view.get("objects") or []:
                bbox = obj.get("bbox") or []
                if len(bbox) != 4:
                    continue
                x0 = bbox[0] * IMG_W
                y0 = bbox[1] * IMG_H
                x1 = bbox[2] * IMG_W
                y1 = bbox[3] * IMG_H
                dr.rectangle([x0, y0, x1, y1], outline=(255, 200, 40), width=2)
                n_bbox += 1
                anchor = obj.get("anchor")
                if isinstance(anchor, dict) and anchor:
                    # zpětná projekce anchoru: směr od kamery k anchoru
                    p = project_to_view(anchor, cam_pos, yaw, CAPTURE_TAN_HALF)
                    if p:
                        est = obj.get("anchor_estimated")
                        color = (255, 120, 90) if est else (60, 255, 120)
                        r = 6
                        dr.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], outline=color, width=3)
                        n_anchor += 1

            # 2) instance promítané do view — jen do max_dist od kamery
            for inst in instances:
                if dist3d(inst["pozice"], cam_pos) > args.max_dist:
                    continue
                p = project_to_view(inst["pozice"], cam_pos, yaw, CAPTURE_TAN_HALF)
                if p is None:
                    continue  # za kamerou / mimo zorné pole
                dr.ellipse([p[0] - 9, p[1] - 9, p[0] + 9, p[1] + 9], outline=(255, 80, 80), width=3)
                dr.text((p[0] + 12, p[1] - 6), f"{inst['id']} {inst['label'][:16]}", fill=(255, 120, 120))
                n_inst += 1

            out_path = cdir / f"qa_yaw{int(float(yaw_key)):03d}.jpg"
            img.save(out_path, quality=85)
            n_views += 1

    print(
        f"QA overlay: {n_views} viewů, bboxů {n_bbox}, anchorů {n_anchor}, "
        f"promítaných instancí {n_inst}"
    )


if __name__ == "__main__":
    main()
