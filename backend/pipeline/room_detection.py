"""
room_detection.py  —  Phase M3: Room boundary detection

Algorithm
---------
1. Load wall segments from walls_floor_<N>.json.
2. Rasterise the walls as thick lines onto a binary occupancy image.
3. Extend segment endpoints to seal T-junction gaps.
4. Progressive multi-pass morphological close to bridge progressively
   larger scan dropout gaps.
5. Invert the image: walls → 0, empty space → 255.
6. Run cv2.connectedComponentsWithStats (8-connectivity).
7. Identify exterior: the single largest connected component that touches
   the image border (not ALL border-touching ones; interior alcoves near
   the border should still count as rooms).
8. Filter by area (min_room_m2 / max_room_m2) and aspect ratio
   (rejects thin parking-spot gaps detected as rooms).
9. Save processed/rooms_floor_<N>.json and debug PNGs.

Key parameters (all auto-scaled from grid_size when not supplied)
-----------------------------------------------------------------
wall_thickness_m   float  drawn wall half-width in metres       (default 0.20)
extend_m           float  endpoint extension to seal T-junctions (default 0.45)
close_passes       list   [(kernel_px, iterations), ...]         (auto)
min_room_m2        float  minimum room area                      (default 0.8)
max_room_m2        float  maximum room area                      (default 800)
min_room_width_m   float  min room dimension for aspect filter   (default 0.6)
min_seg_m          float  ignore walls shorter than this         (default 0.4)
save_debug         bool   write debug PNGs                       (default True)

Output JSON schema
------------------
{
  "floor_idx": 1,
  "grid_size": 0.02,
  "n_rooms": 8,
  "rooms": [
    {
      "id": 1,
      "area_m2": 14.32,
      "bbox": {"x_min": -10.8, "x_max": -4.7, "z_min": -5.0, "z_max": 0.7},
      "centroid_x": -7.75,
      "centroid_z": -2.15
    }, ...
  ]
}
"""

from __future__ import annotations

import json
import os

import cv2
import numpy as np


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def detect_rooms_for_floor(floor_idx: int, config: dict) -> dict:
    """
    Detect room boundaries for a given floor.

    Reads  : processed/walls_floor_<N>.json + processed/info.json
    Writes : processed/rooms_floor_<N>.json
             processed/debug_floor<N>_rooms.png  (if save_debug=True)
             processed/debug_floor<N>_rooms_canvas.png (wall raster, if save_debug)
    Returns: result dict  { floor_idx, n_rooms, rooms }
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.environ.get("PROCESSED_DIR", os.path.join(base_dir, "processed"))

    wall_path = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        raise FileNotFoundError(
            f"Wall data not found for floor {floor_idx}. "
            "Run wall detection first."
        )

    with open(wall_path) as fh:
        wall_data = json.load(fh)

    lines    = wall_data.get("lines", [])
    grid_size = float(config.get("grid_size", wall_data.get("grid_size", 0.05)))

    # ── Auto-scale geometric parameters from grid_size ────────────────────────
    # wall_thickness_m  → how wide we draw each wall segment (both sides)
    wall_thickness_m   = float(config.get("wall_thickness_m",   0.20))
    wall_thickness_px  = max(2, int(round(wall_thickness_m / grid_size)))

    # extend_m → how far we project endpoint caps to seal T-junctions
    extend_m           = float(config.get("extend_m",           0.45))
    extend_px          = max(4, int(round(extend_m / grid_size)))

    # Progressive morphological closing: [(kernel_size_px, iterations), ...]
    # Heals gaps from small → large, proportional to grid.
    # Default: three passes at 10 cm, 25 cm, 50 cm gap radius.
    def _k(metres):
        """Odd kernel size at least 3 that covers `metres` of gap."""
        k = max(3, int(round(metres / grid_size)) | 1)  # ensure odd
        return k

    default_passes = [
        (_k(0.10), 2),   # seal 10 cm gaps
        (_k(0.25), 2),   # seal 25 cm gaps
        (_k(0.50), 1),   # seal 50 cm gaps
    ]
    close_passes = config.get("close_passes", default_passes)

    min_seg_m      = float(config.get("min_seg_m",      0.4))
    min_room_m2    = float(config.get("min_room_m2",    0.8))
    max_room_m2    = float(config.get("max_room_m2", 800.0))
    min_room_w_m   = float(config.get("min_room_width_m", 0.60))
    save_debug     = bool(config.get("save_debug", True))

    if not lines:
        print(f"[rooms floor {floor_idx}] no walls — returning empty")
        return _empty_result(floor_idx, processed_dir, grid_size)

    # ── Build world-space bounding box ────────────────────────────────────────
    all_x = [p[0] for seg in lines for p in seg]
    all_z = [p[1] for seg in lines for p in seg]
    x_min_r = min(all_x)
    z_min_r = min(all_z)
    x_max_r = max(all_x)
    z_max_r = max(all_z)

    # Add enough border so walls at the edge aren't clipped and the
    # morphological kernels have room to operate.
    BORDER_CELLS = max(5, extend_px + 2)
    x_min_r -= BORDER_CELLS * grid_size
    z_min_r -= BORDER_CELLS * grid_size
    z_max_r += BORDER_CELLS * grid_size  # needed for flipped Y mapping

    raw_w = int(np.ceil((x_max_r - x_min_r) / grid_size)) + BORDER_CELLS * 2
    raw_h = int(np.ceil((z_max_r - z_min_r) / grid_size)) + BORDER_CELLS * 2
    MAX_DIM = 6000
    width  = max(10, min(raw_w, MAX_DIM))
    height = max(10, min(raw_h, MAX_DIM))

    print(
        f"[rooms floor {floor_idx}] grid {width}×{height}  "
        f"({grid_size*100:.0f} cm/px)  walls={len(lines)}  "
        f"wall_thick={wall_thickness_px}px  extend={extend_px}px"
    )

    # ── Filter out very short / diagonal noise segments ───────────────────────
    filtered_lines = [
        seg for seg in lines
        if ((seg[1][0]-seg[0][0])**2 + (seg[1][1]-seg[0][1])**2) ** 0.5 >= min_seg_m
    ]
    n_filt = len(lines) - len(filtered_lines)
    print(
        f"[rooms floor {floor_idx}] filtered {n_filt} short segs  "
        f"({len(filtered_lines)} remain)"
    )

    # ── Helper: world → pixel ─────────────────────────────────────────────────
    # Y is flipped: image row 0 = z_max (top of world), row height-1 = z_min.
    # This matches right-handed coordinates where +Z points "up" on screen.
    def _to_px(x: float, z: float) -> tuple[int, int]:
        px = int(round((x - x_min_r) / grid_size))
        py = int(round((z_max_r - z) / grid_size))  # flipped
        return (
            max(0, min(px, width - 1)),
            max(0, min(py, height - 1)),
        )

    # ── Rasterise walls with endpoint caps ───────────────────────────────────
    canvas = np.zeros((height, width), dtype=np.uint8)
    thickness_draw = wall_thickness_px * 2 + 1   # always odd

    for seg in filtered_lines:
        p1, p2 = seg
        pt1 = _to_px(p1[0], p1[1])
        pt2 = _to_px(p2[0], p2[1])

        dx = pt2[0] - pt1[0]
        dy = pt2[1] - pt1[1]
        length = max(1.0, (dx * dx + dy * dy) ** 0.5)
        ux = dx / length
        uy = dy / length

        # Extend both endpoints outward to seal T-junctions
        ext_pt1 = (
            max(0, min(width - 1,  int(round(pt1[0] - ux * extend_px)))),
            max(0, min(height - 1, int(round(pt1[1] - uy * extend_px)))),
        )
        ext_pt2 = (
            max(0, min(width - 1,  int(round(pt2[0] + ux * extend_px)))),
            max(0, min(height - 1, int(round(pt2[1] + uy * extend_px)))),
        )
        cv2.line(canvas, ext_pt1, ext_pt2, color=255, thickness=thickness_draw)

    # ── Progressive gap-closing strategy ─────────────────────────────────────
    # Multiple passes with increasing kernel size heal scan dropout gaps from
    # small (10 cm) to large (50 cm) without over-inflating thin corridors.
    for (k_size, iters) in close_passes:
        k_size = k_size | 1          # ensure odd
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (k_size, k_size))
        canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, k, iterations=iters)

    wall_px = int((canvas > 0).sum())
    print(
        f"[rooms floor {floor_idx}] wall pixels after close: {wall_px:,}  "
        f"({100.0 * wall_px / (width * height):.1f}%)"
    )

    # Save intermediate canvas for diagnosis
    if save_debug:
        canvas_path = os.path.join(
            processed_dir, f"debug_floor{floor_idx}_rooms_canvas.png"
        )
        cv2.imwrite(canvas_path, canvas)
        print(f"[rooms] wall canvas saved: {canvas_path}")

    # ── Connected components (8-connectivity) ─────────────────────────────────
    inverted = cv2.bitwise_not(canvas)

    n_labels, label_img, stats, centroids = cv2.connectedComponentsWithStats(
        inverted, connectivity=8   # ← 8-conn: diagonal 1-px gaps are bridged
    )

    min_area_px = max(1, int(min_room_m2 / (grid_size ** 2)))
    max_area_px = int(max_room_m2 / (grid_size ** 2))

    # ── Identify exterior as the LARGEST border-touching component ────────────
    # (not ALL border components — interior alcoves near the wall boundary
    # should still be counted as rooms)
    border_labels: set[int] = set()
    for row in (label_img[0, :], label_img[-1, :]):
        border_labels.update(row.tolist())
    for col in (label_img[:, 0], label_img[:, -1]):
        border_labels.update(col.tolist())
    border_labels.discard(0)   # label 0 = walls / background

    exterior_label: int | None = None
    if border_labels:
        exterior_label = max(border_labels, key=lambda lbl: stats[lbl, cv2.CC_STAT_AREA])

    # ── Collect valid rooms ───────────────────────────────────────────────────
    min_dim_px = max(1, int(min_room_w_m / grid_size))

    rooms   = []
    room_id = 0

    for lbl in range(1, n_labels):
        if lbl == exterior_label:
            continue   # the exterior open space

        area_px = int(stats[lbl, cv2.CC_STAT_AREA])
        if area_px < min_area_px or area_px > max_area_px:
            continue

        bx = int(stats[lbl, cv2.CC_STAT_LEFT])
        bz = int(stats[lbl, cv2.CC_STAT_TOP])
        bw = int(stats[lbl, cv2.CC_STAT_WIDTH])
        bh = int(stats[lbl, cv2.CC_STAT_HEIGHT])

        # Aspect-ratio guard: skip regions thinner than min_room_width_m
        # These are typically gaps between parking spots, wall-interior
        # scan slivers, staircase steps, etc.
        if min(bw, bh) < min_dim_px:
            continue

        area_m2 = round(area_px * grid_size ** 2, 3)

        # Back-project pixel bbox → world coords (Y is flipped)
        bbox = {
            "x_min": round(x_min_r + bx * grid_size, 4),
            "z_min": round(z_max_r - (bz + bh) * grid_size, 4),  # flipped
            "x_max": round(x_min_r + (bx + bw) * grid_size, 4),
            "z_max": round(z_max_r - bz * grid_size, 4),          # flipped
        }

        cx_m = round(x_min_r + centroids[lbl][0] * grid_size, 4)
        cz_m = round(z_max_r - centroids[lbl][1] * grid_size, 4)  # flipped

        room_id += 1
        rooms.append(
            {
                "id":         room_id,
                "area_m2":    area_m2,
                "bbox":       bbox,
                "centroid_x": cx_m,
                "centroid_z": cz_m,
            }
        )

    # Sort by area descending
    rooms.sort(key=lambda r: r["area_m2"], reverse=True)
    for idx, room in enumerate(rooms):
        room["id"] = idx + 1

    print(f"[rooms floor {floor_idx}] detected {len(rooms)} room(s)")
    for r in rooms:
        print(
            f"  R{r['id']:02d}  {r['area_m2']:6.1f} m²   "
            f"centroid ({r['centroid_x']:.2f}, {r['centroid_z']:.2f})"
        )

    # ── Debug PNG ─────────────────────────────────────────────────────────────
    if save_debug:
        _save_debug_png(
            height, width, n_labels, label_img, rooms,
            exterior_label, border_labels,
            x_min_r, z_min_r, z_max_r, grid_size,
            os.path.join(processed_dir, f"debug_floor{floor_idx}_rooms.png"),
        )

    # ── Save JSON ─────────────────────────────────────────────────────────────
    result = {
        "floor_idx": floor_idx,
        "grid_size": grid_size,
        "n_rooms":   len(rooms),
        "rooms":     rooms,
    }
    out_path = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")
    with open(out_path, "w") as fh:
        json.dump(result, fh, indent=2)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _empty_result(floor_idx: int, processed_dir: str, grid_size: float) -> dict:
    result = {"floor_idx": floor_idx, "grid_size": grid_size, "n_rooms": 0, "rooms": []}
    out_path = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")
    with open(out_path, "w") as fh:
        json.dump(result, fh, indent=2)
    return result


def _save_debug_png(
    height, width, n_labels, label_img, rooms,
    exterior_label, border_labels,
    x_min_r, z_min_r, z_max_r, grid_size, path,
):
    """Save a colour-coded label image with room centroids annotated.
    
    Colour key:
      • dark grey  — walls (label 0)
      • mid grey   — exterior (border-touching non-room components)
      • solid colour — accepted rooms (random stable hue per room)
      • black      — other rejected components (too small / too thin)
    """
    try:
        rng = np.random.default_rng(42)

        # Build label→colour map
        colours = np.zeros((n_labels, 3), dtype=np.uint8)
        colours[0] = [30, 30, 30]    # walls → dark grey

        for lbl in range(1, n_labels):
            if lbl == exterior_label:
                colours[lbl] = [80, 80, 80]   # exterior → mid grey
            elif lbl in border_labels:
                colours[lbl] = [50, 50, 50]   # minor border component → near-black
            else:
                colours[lbl] = [20, 20, 20]   # rejected interior → dark

        # Accepted rooms get vivid colours
        ROOM_PALETTE = [
            [220,  80,  80],  # red
            [ 80, 160, 220],  # blue
            [ 80, 200, 120],  # green
            [220, 180,  60],  # yellow
            [180,  80, 220],  # purple
            [220, 140,  60],  # orange
            [ 60, 200, 200],  # cyan
            [220,  80, 160],  # pink
            [120, 220,  80],  # lime
            [100, 100, 220],  # indigo
        ]
        for room in rooms:
            # Map room id back to a label by scanning centroids (Y flipped)
            cx_px = int(round((room["centroid_x"] - x_min_r) / grid_size))
            cz_px = int(round((z_max_r - room["centroid_z"]) / grid_size))  # flipped
            cx_px = max(0, min(width - 1, cx_px))
            cz_px = max(0, min(height - 1, cz_px))
            lbl = int(label_img[cz_px, cx_px])
            if lbl > 0:
                palette_idx = (room["id"] - 1) % len(ROOM_PALETTE)
                colours[lbl] = ROOM_PALETTE[palette_idx]

        # Render
        rgb = colours[label_img]   # (H, W, 3)

        # Annotate room centroids
        for room in rooms:
            cx_px = int(round((room["centroid_x"] - x_min_r) / grid_size))
            cz_px = int(round((z_max_r - room["centroid_z"]) / grid_size))  # flipped
            cx_px = max(0, min(width - 1, cx_px))
            cz_px = max(0, min(height - 1, cz_px))

            cv2.circle(rgb, (cx_px, cz_px), 4, (255, 255, 255), -1)
            cv2.putText(
                rgb,
                f"R{room['id']} {room['area_m2']:.0f}m\xb2",
                (cx_px + 6, cz_px + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.40,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )

        cv2.imwrite(path, rgb)
        print(f"[rooms] debug PNG saved: {path}")
    except Exception as exc:
        print(f"[rooms] debug PNG failed: {exc}")
