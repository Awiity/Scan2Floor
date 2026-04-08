"""
room_detection.py  —  Phase M3: Room boundary detection

Algorithm
---------
1. Load wall segments from walls_floor_<N>.json.
2. Rasterise the walls as thick lines onto a binary occupancy image
   (same coordinate system / grid_size as wall_detection.py).
3. Dilate the rasterised walls slightly to close endpoint near-misses.
4. Invert the image: walls → 0, empty space → 255.
5. Run cv2.connectedComponentsWithStats to label enclosed regions.
6. Filter out tiny noise regions and the large "exterior" region
   (exterior always touches image border).
7. For each surviving region compute:
     • area_m2   — pixel count × grid_size²
     • bbox      — axis-aligned bounding box in metres
     • centroid  — (x, z) in metres, used for room labels
8. Save processed/rooms_floor_<N>.json.
9. Optionally save a colour-coded debug PNG.

Output JSON schema
------------------
{
  "floor_idx": 1,
  "grid_size": 0.05,
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
    Returns: result dict  { floor_idx, n_rooms, rooms }

    Config keys
    -----------
    grid_size            float  voxel cell size in metres         (default 0.05)
    wall_thickness_px    int    drawn wall half-width in pixels    (default 4)
                                Larger = more gap-sealing but
                                narrows tight corridors.
                                Rule of thumb: at 5cm/px, value 4
                                seals ~20 cm endpoint gaps.
    close_kernel_px      int    morphological close kernel size    (default 7)
                                Must be odd.  Bridges corner gaps
                                up to (close_kernel_px // 2) px.
    min_seg_m            float  ignore wall segments shorter than  (default 0.4)
                                this before rasterising — removes
                                diagonal scan noise that punches
                                holes in the wall boundary.
    min_room_m2          float  drop regions smaller than this     (default 0.8)
    max_room_m2          float  drop regions larger than this      (default 800)
    save_debug           bool   write colour-label PNG             (default True)
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.path.join(base_dir, "processed")

    wall_path = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        raise FileNotFoundError(
            f"Wall data not found for floor {floor_idx}. "
            "Run wall detection first."
        )

    with open(wall_path) as fh:
        wall_data = json.load(fh)

    lines = wall_data.get("lines", [])
    grid_size        = float(config.get("grid_size", wall_data.get("grid_size", 0.05)))
    wall_thickness_px = int(config.get("wall_thickness_px", 4))
    close_kernel_px  = int(config.get("close_kernel_px", 11))
    # ensure kernel is odd
    if close_kernel_px % 2 == 0:
        close_kernel_px += 1
    min_seg_m        = float(config.get("min_seg_m", 0.4))
    min_room_m2      = float(config.get("min_room_m2", 0.8))
    max_room_m2      = float(config.get("max_room_m2", 800.0))
    save_debug       = bool(config.get("save_debug", True))

    if not lines:
        print(f"[rooms floor {floor_idx}] no walls — returning empty")
        return _empty_result(floor_idx, processed_dir, grid_size)

    # ── Build world-space bounding box from all wall endpoints ────────────────
    all_x = [p[0] for seg in lines for p in seg]
    all_z = [p[1] for seg in lines for p in seg]
    x_min_r = min(all_x)
    z_min_r = min(all_z)
    x_max_r = max(all_x)
    z_max_r = max(all_z)

    # Add a 1-cell (grid_size) border so walls at the exact edge aren't clipped
    BORDER_CELLS = 3
    x_min_r -= BORDER_CELLS * grid_size
    z_min_r -= BORDER_CELLS * grid_size

    raw_w = int(np.ceil((x_max_r - x_min_r) / grid_size)) + BORDER_CELLS * 2
    raw_h = int(np.ceil((z_max_r - z_min_r) / grid_size)) + BORDER_CELLS * 2
    MAX_DIM = 4096
    width  = max(10, min(raw_w, MAX_DIM))
    height = max(10, min(raw_h, MAX_DIM))

    print(
        f"[rooms floor {floor_idx}] grid {width}×{height}  "
        f"({grid_size*100:.0f} cm)  walls={len(lines)}"
    )

    # ── Rasterise walls ───────────────────────────────────────────────────────
    canvas = np.zeros((height, width), dtype=np.uint8)

    def _to_px(x: float, z: float) -> tuple[int, int]:
        px = int(round((x - x_min_r) / grid_size))
        py = int(round((z - z_min_r) / grid_size))
        return (
            max(0, min(px, width - 1)),
            max(0, min(py, height - 1)),
        )

    # Filter out very short / diagonal noise segments before rasterising.
    # These stub lines (often scan artefacts at stairs, cars, pillars) would
    # punch holes in the wall boundary and let the exterior flood in.
    min_seg_px = max(1.0, min_seg_m / grid_size)
    filtered_lines = []
    for seg in lines:
        p1, p2 = seg
        dx = p2[0] - p1[0]
        dz = p2[1] - p1[1]
        seg_len_m = (dx * dx + dz * dz) ** 0.5
        if seg_len_m >= min_seg_m:
            filtered_lines.append(seg)

    n_filtered = len(lines) - len(filtered_lines)
    print(
        f"[rooms floor {floor_idx}] filtered {n_filtered} short segments  "
        f"({len(filtered_lines)} remain  min_seg={min_seg_m:.2f}m)"
    )

    # ── Draw walls with endpoint extension ───────────────────────────────────
    # Extend each segment's endpoints outward along its own direction by
    # `extend_px` pixels.  This seals T-junction gaps (where a Hough segment
    # ends a few pixels short of meeting a perpendicular wall) without
    # inflating every wall's thickness the way a large kernel would.
    extend_px = int(config.get("extend_px", 6))   # default 6 px = 30 cm at 5 cm/px
    thickness_draw = wall_thickness_px * 2 + 1    # always odd

    for seg in filtered_lines:
        p1, p2 = seg
        pt1 = _to_px(p1[0], p1[1])
        pt2 = _to_px(p2[0], p2[1])

        dx = pt2[0] - pt1[0]
        dy = pt2[1] - pt1[1]
        length = max(1.0, (dx * dx + dy * dy) ** 0.5)
        ux = dx / length
        uy = dy / length

        ext_pt1 = (
            max(0, min(width - 1,  int(round(pt1[0] - ux * extend_px)))),
            max(0, min(height - 1, int(round(pt1[1] - uy * extend_px)))),
        )
        ext_pt2 = (
            max(0, min(width - 1,  int(round(pt2[0] + ux * extend_px)))),
            max(0, min(height - 1, int(round(pt2[1] + uy * extend_px)))),
        )
        cv2.line(canvas, ext_pt1, ext_pt2, color=255, thickness=thickness_draw)

    # ── Gap-closing strategy ──────────────────────────────────────────────────
    # MORPH_CLOSE = dilate then erode.  Bridges remaining corner and diagonal
    # gaps whose size <= close_kernel_px // 2 pixels.
    k_large = cv2.getStructuringElement(
        cv2.MORPH_RECT, (close_kernel_px, close_kernel_px)
    )
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, k_large, iterations=2)

    k_med = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, k_med, iterations=1)

    wall_px = int((canvas > 0).sum())
    print(
        f"[rooms floor {floor_idx}] wall pixels after close: {wall_px:,}  "
        f"({100.0 * wall_px / (width * height):.1f}% of grid)"
    )


    # ── Connected components on the inverted image ────────────────────────────
    inverted = cv2.bitwise_not(canvas)

    n_labels, label_img, stats, centroids = cv2.connectedComponentsWithStats(
        inverted, connectivity=4
    )

    min_area_px = max(1, int(min_room_m2 / (grid_size ** 2)))
    max_area_px = int(max_room_m2 / (grid_size ** 2))

    # Collect labels that touch the image border (→ exterior, skip)
    border_pixels = set()
    border_pixels.update(label_img[0, :].tolist())
    border_pixels.update(label_img[-1, :].tolist())
    border_pixels.update(label_img[:, 0].tolist())
    border_pixels.update(label_img[:, -1].tolist())

    rooms = []
    room_id = 0

    # Label 0 is the background (walls themselves); skip it
    for lbl in range(1, n_labels):
        if lbl in border_pixels:
            continue  # exterior or wall-touching noise

        area_px = int(stats[lbl, cv2.CC_STAT_AREA])
        if area_px < min_area_px or area_px > max_area_px:
            continue

        area_m2 = round(area_px * grid_size ** 2, 3)

        # Bounding box in pixel coords → metres
        bx = int(stats[lbl, cv2.CC_STAT_LEFT])
        bz = int(stats[lbl, cv2.CC_STAT_TOP])
        bw = int(stats[lbl, cv2.CC_STAT_WIDTH])
        bh = int(stats[lbl, cv2.CC_STAT_HEIGHT])

        bbox = {
            "x_min": round(x_min_r + bx * grid_size, 4),
            "z_min": round(z_min_r + bz * grid_size, 4),
            "x_max": round(x_min_r + (bx + bw) * grid_size, 4),
            "z_max": round(z_min_r + (bz + bh) * grid_size, 4),
        }

        cx_m = round(x_min_r + centroids[lbl][0] * grid_size, 4)
        cz_m = round(z_min_r + centroids[lbl][1] * grid_size, 4)

        room_id += 1
        rooms.append(
            {
                "id": room_id,
                "area_m2": area_m2,
                "bbox": bbox,
                "centroid_x": cx_m,
                "centroid_z": cz_m,
            }
        )

    # Sort rooms by area descending (largest first, typically main living areas)
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
            x_min_r, z_min_r, grid_size,
            os.path.join(processed_dir, f"debug_floor{floor_idx}_rooms.png"),
        )

    # ── Save JSON ─────────────────────────────────────────────────────────────
    result = {
        "floor_idx": floor_idx,
        "grid_size": grid_size,
        "n_rooms": len(rooms),
        "rooms": rooms,
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
    x_min_r, z_min_r, grid_size, path,
):
    """Save a colour-coded label image with room centroids annotated."""
    try:
        # Build a colour map — label 0 (walls) stays black
        rng = np.random.default_rng(42)
        colours = np.zeros((n_labels, 3), dtype=np.uint8)
        colours[1:] = rng.integers(60, 220, size=(n_labels - 1, 3), dtype=np.uint8)

        rgb = colours[label_img]  # (H, W, 3)

        # Draw room centroids + IDs
        for room in rooms:
            cx_px = int(round((room["centroid_x"] - x_min_r) / grid_size))
            cz_px = int(round((room["centroid_z"] - z_min_r) / grid_size))
            # Flip Y so label is right-side-up when written with top-left origin
            cv2.putText(
                rgb,
                f"R{room['id']} {room['area_m2']:.0f}m2",
                (cx_px - 10, cz_px),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.4,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )

        cv2.imwrite(path, rgb)
        print(f"[rooms] debug PNG saved: {path}")
    except Exception as exc:
        print(f"[rooms] debug PNG failed: {exc}")
