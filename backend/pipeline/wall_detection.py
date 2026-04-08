"""
wall_detection.py  —  Phase 4 (rewrite: full-density + vertical-extent car filter)

Key improvements
----------------
1. Uses full-density wall_slice_floor_N.npy produced by preprocess_walls.py
   instead of the 1:100-sampled pointcloud.bin.  Falls back gracefully when no
   slice file exists.

2. Vertical-extent car filter (car_filter=True by default):
   Builds TWO occupancy images:
     • img_all  — every wall-band point
     • img_high — only points above floor_y + 1.55 m  (above typical car roof)
   Hough transform runs only on cells that appear in BOTH images.
   Result: the parking area's car bodies no longer produce hundreds of
   spurious lines because car roofs never reach 1.55 m above the floor level
   while structural walls reach 2.0–2.5 m.

3. Conservative post-processing: collinear merge only, with a tight
   perpendicular-distance check to avoid merging walls from different rooms.
   The aggressive parallel-wall suppression that was collapsing entire rooms
   has been removed.

4. Per-floor debug PNGs (debug_floor<N>_*.png) saved to processed/ so you
   can visually inspect each stage without re-running everything.
"""

from __future__ import annotations

import json
import os
import struct

import cv2
import numpy as np

# ─────────────────────────────────────────────────────────────────────────────
# Data loading
# ─────────────────────────────────────────────────────────────────────────────


def _load_from_bin(bin_path: str, y_min: float, y_max: float) -> np.ndarray:
    """Load points from the legacy 1:100 pointcloud.bin and filter by Y band."""
    with open(bin_path, "rb") as fh:
        buf = fh.read()
    N = struct.unpack("<I", buf[:4])[0]
    pos = np.frombuffer(buf, dtype=np.float32, count=N * 3, offset=4).reshape(N, 3)
    mask = (pos[:, 1] >= y_min) & (pos[:, 1] <= y_max)
    return pos[mask]


def _load_from_slice(slice_path: str, y_min: float, y_max: float) -> np.ndarray:
    """Load points from a dense wall_slice_floor_N.npy and filter by Y band."""
    pts = np.load(slice_path)  # (M, 3) float32  [x_yup, y_yup, z_yup]
    mask = (pts[:, 1] >= y_min) & (pts[:, 1] <= y_max)
    return pts[mask]


def load_wall_points(
    floor_idx: int,
    processed_dir: str,
    y_min: float,
    y_max: float,
) -> tuple[np.ndarray, str]:
    """
    Return *(pts, source_label)* for the requested floor and Y band.
    Prefers dense wall_slice_floor_N.npy; falls back to pointcloud.bin.
    """
    slice_path = os.path.join(processed_dir, f"wall_slice_floor_{floor_idx}.npy")
    if os.path.exists(slice_path):
        pts = _load_from_slice(slice_path, y_min, y_max)
        return pts, f"dense-slice ({len(pts):,} pts)"

    bin_path = os.path.join(processed_dir, "pointcloud.bin")
    if os.path.exists(bin_path):
        pts = _load_from_bin(bin_path, y_min, y_max)
        return pts, f"legacy-1:100 ({len(pts):,} pts)"

    raise FileNotFoundError(
        f"Neither wall_slice_floor_{floor_idx}.npy nor pointcloud.bin found "
        f"in {processed_dir}.  Run preprocess_walls.py (preferred) or the "
        "original preprocess step."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────


def _seg_length(seg) -> float:
    dx = seg[1][0] - seg[0][0]
    dz = seg[1][1] - seg[0][1]
    return (dx * dx + dz * dz) ** 0.5


def snap_lines_to_manhattan(lines, angle_tolerance: float = 10.0):
    """Snap near-axis lines to exact 0° / 90°."""
    snapped = []
    tol = np.radians(angle_tolerance)

    for line in lines:
        x1, y1, x2, y2 = line[0]
        ang = abs(np.arctan2(y2 - y1, x2 - x1))

        if ang < tol or abs(ang - np.pi) < tol:  # horizontal
            avg_y = int(round((y1 + y2) / 2))
            snapped.append([[x1, avg_y, x2, avg_y]])
        elif abs(ang - np.pi / 2) < tol:  # vertical
            avg_x = int(round((x1 + x2) / 2))
            snapped.append([[avg_x, y1, avg_x, y2]])
        else:
            snapped.append([[x1, y1, x2, y2]])

    return np.array(snapped) if snapped else np.empty((0, 1, 4), dtype=np.int32)


def merge_collinear_segments(
    lines_px: list,
    gap_px: int = 15,
    angle_tol_deg: float = 4.0,
    max_perp_px: float = 2.5,
) -> list:
    """
    Iteratively merge near-collinear segments that are close together.

    Only merges when ALL three conditions hold:
      • angle difference  < angle_tol_deg
      • perpendicular offset of one segment's midpoint from the other < max_perp_px
      • 1D projected gap along the shared axis ≤ gap_px  (negative = overlap)

    The gap is measured by projecting both segments onto a shared 1D axis
    (segment i's direction) and checking the distance between the two
    projected spans.  This correctly handles the case where one segment is
    entirely contained within another — their 2D endpoint distances can be
    large even though there is zero real gap — which the old min-Euclidean
    check failed to detect.
    """
    if not lines_px:
        return lines_px

    tol_rad = np.radians(angle_tol_deg)
    merged = list(lines_px)
    changed = True

    while changed:
        changed = False
        used = [False] * len(merged)
        result = []

        for i in range(len(merged)):
            if used[i]:
                continue

            x1, y1, x2, y2 = merged[i][0]
            ang_i = np.arctan2(y2 - y1, x2 - x1)
            group = [(x1, y1), (x2, y2)]

            for j in range(i + 1, len(merged)):
                if used[j]:
                    continue
                x3, y3, x4, y4 = merged[j][0]
                ang_j = np.arctan2(y4 - y3, x4 - x3)

                # --- angle check (modulo π) ---
                da = abs(ang_i - ang_j) % np.pi
                if da > tol_rad and abs(da - np.pi) > tol_rad:
                    continue

                # --- collinearity check (perpendicular distance) ---
                seg_len = max(1e-9, ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)
                mx, mz = (x3 + x4) / 2.0, (y3 + y4) / 2.0
                perp = (
                    abs((y2 - y1) * mx - (x2 - x1) * mz + x2 * y1 - y2 * x1) / seg_len
                )
                if perp > max_perp_px:
                    continue

                # --- gap check (1D projection along segment i's axis) ---
                # Project all four endpoints onto the unit direction of
                # segment i.  The gap between the two 1D spans is negative
                # when the segments overlap, zero when they touch, and
                # positive when there is a true gap.  This handles the case
                # where one segment is entirely inside the other (endpoints
                # are far apart in 2D but the real gap is zero).
                ux, uy = (x2 - x1) / seg_len, (y2 - y1) / seg_len
                proj_i0 = x1 * ux + y1 * uy
                proj_i1 = x2 * ux + y2 * uy
                proj_j0 = x3 * ux + y3 * uy
                proj_j1 = x4 * ux + y4 * uy

                lo_i, hi_i = min(proj_i0, proj_i1), max(proj_i0, proj_i1)
                lo_j, hi_j = min(proj_j0, proj_j1), max(proj_j0, proj_j1)

                # Gap between projected spans (negative = overlap)
                gap_1d = max(lo_j - hi_i, lo_i - hi_j)
                if gap_1d > gap_px:
                    continue

                group.extend([(x3, y3), (x4, y4)])
                used[j] = True
                changed = True

            # Fit a PCA-based spanning segment over all grouped points
            if len(group) > 2:
                pts_arr = np.array(group, dtype=float)
                mean = pts_arr.mean(axis=0)
                _, _, vt = np.linalg.svd(pts_arr - mean, full_matrices=False)
                direction = vt[0]
                projs = (pts_arr - mean) @ direction
                p_lo = mean + projs.min() * direction
                p_hi = mean + projs.max() * direction
                result.append(
                    [
                        [
                            int(round(p_lo[0])),
                            int(round(p_lo[1])),
                            int(round(p_hi[0])),
                            int(round(p_hi[1])),
                        ]
                    ]
                )
            else:
                result.append([[x1, y1, x2, y2]])

        merged = result

    return merged


# ─────────────────────────────────────────────────────────────────────────────
# Debug image helpers
# ─────────────────────────────────────────────────────────────────────────────


def _save_density_png(arr: np.ndarray, path: str) -> None:
    """Save an int32/float occupancy array as a normalised PNG (Y-up)."""
    try:
        a = arr.astype(np.float32)
        if a.max() > a.min():
            a = (a - a.min()) / (a.max() - a.min()) * 255.0
        img = cv2.flip(a.astype(np.uint8), 0)
        cv2.imwrite(path, img)
    except Exception:
        pass


def _save_lines_png(
    base_grey: np.ndarray, lines, path: str, colour: tuple = (0, 0, 255)
) -> None:
    """Draw detected lines on the base image (Y-up) and save."""
    try:
        h = base_grey.shape[0]
        rgb = cv2.cvtColor(cv2.flip(base_grey, 0), cv2.COLOR_GRAY2BGR)
        for line in lines:
            x1, y1, x2, y2 = line[0]
            cv2.line(rgb, (x1, h - 1 - y1), (x2, h - 1 - y2), colour, 1)
        cv2.imwrite(path, rgb)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def detect_walls_for_floor(floor_idx: int, config: dict) -> list:
    """
    Detect wall line segments for a given floor.

    Parameters
    ----------
    floor_idx : int
        0-based floor index matching info.json floor_levels.
    config : dict
        Recognised keys
        ~~~~~~~~~~~~~~~
        grid_size        float   voxel cell size in metres       (default 0.05)
        snap_to_axis     bool    Manhattan snap 0°/90°            (default True)
        min_wall_m       float   minimum wall length in metres    (default 0.80)
        hough_threshold  int     minimum Hough vote count         (default 40)
        max_gap_m        float   Hough max gap in metres          (default 0.25)
        car_filter       bool    vertical-extent car filter       (default True)
        car_top_m        float   height above floor for car-top   (default 1.55)
        ceiling_cap_m    float   height above floor below which   (default 2.05)
                                 the "mid-zone" check is applied.
                                 Points above this are treated as ceiling
                                 reflections and excluded from the has_high
                                 test.  Set to ≈ (garage clearance − 0.2 m).
                                 For non-parking floors with 3 m+ ceilings
                                 the ceiling will be outside the wall band
                                 anyway so this value has no effect.
        save_debug       bool    write per-floor debug PNGs       (default True)

    Returns
    -------
    list[[[x1,z1],[x2,z2]]]
        Wall segments in metres (Y-up X/Z world coordinates).
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.path.join(base_dir, "processed")
    info_path = os.path.join(processed_dir, "info.json")

    with open(info_path) as fh:
        info = json.load(fh)

    levels = info.get("floor_levels", [])
    if floor_idx >= len(levels):
        raise ValueError(
            f"Floor index {floor_idx} out of range "
            f"(info.json has {len(levels)} floor(s))."
        )

    floor_y = float(levels[floor_idx])

    # ── Unpack config ─────────────────────────────────────────────────────────
    grid_size = float(config.get("grid_size", 0.05))
    snap_to_axis = bool(config.get("snap_to_axis", True))
    min_wall_m = float(config.get("min_wall_m", 0.80))
    hough_threshold = int(config.get("hough_threshold", 40))
    max_gap_m = float(config.get("max_gap_m", 0.25))
    car_filter = bool(config.get("car_filter", True))
    car_top_m = float(config.get("car_top_m", 1.55))
    # ceiling_cap_m caps the "mid-zone" used by the car filter.
    # Points above floor_y + ceiling_cap_m are excluded from the has_high
    # check so that ceiling reflections inside low-clearance parking garages
    # (typical Czech garage clearance ≈ 2.1–2.3 m) don't create false
    # "above-car" signals for open parking-space cells.
    ceiling_cap_m = float(config.get("ceiling_cap_m", 2.05))
    save_debug = bool(config.get("save_debug", True))

    # ── Height band to load ───────────────────────────────────────────────────
    # Start 0.25 m above detected floor to skip floor-surface reflections.
    # End 2.55 m above floor to capture full wall height (incl. door frames).
    # The wider slice is needed so the car-filter has above-car-top data too.
    y_min = floor_y + 0.25
    y_max = floor_y + 2.55

    # ── Load points ───────────────────────────────────────────────────────────
    try:
        pts, source_lbl = load_wall_points(floor_idx, processed_dir, y_min, y_max)
    except FileNotFoundError as exc:
        raise exc

    print(f"\n[floor {floor_idx}] source     : {source_lbl}")
    print(f"[floor {floor_idx}] y_band     : [{y_min:.3f} ... {y_max:.3f}] m")
    print(f"[floor {floor_idx}] floor_y    : {floor_y:.3f} m")

    if len(pts) < 50:
        print(f"[floor {floor_idx}] WARNING: only {len(pts)} points -- skipping")
        _write_empty_result(floor_idx, processed_dir, grid_size)
        return []

    # ── Build XZ occupancy images ─────────────────────────────────────────────
    xz = pts[:, [0, 2]]  # horizontal plan view  (X, Z)
    y_val = pts[:, 1]  # height

    x_min_r, z_min_r = xz.min(axis=0)
    x_max_r, z_max_r = xz.max(axis=0)

    raw_w = int(np.ceil((x_max_r - x_min_r) / grid_size))
    raw_h = int(np.ceil((z_max_r - z_min_r) / grid_size))
    MAX_DIM = 4096
    width = max(10, min(raw_w, MAX_DIM))
    height = max(10, min(raw_h, MAX_DIM))

    if raw_w > MAX_DIM or raw_h > MAX_DIM:
        print(
            f"[floor {floor_idx}] WARNING: grid {raw_w}×{raw_h} clamped to "
            f"{width}×{height}"
        )

    # Pixel indices for every point
    px = np.clip(
        np.floor((xz[:, 0] - x_min_r) / grid_size).astype(np.int32),
        0,
        width - 1,
    )
    py = np.clip(
        np.floor((xz[:, 1] - z_min_r) / grid_size).astype(np.int32),
        0,
        height - 1,
    )

    # Image A — all wall-band points
    img_all = np.zeros((height, width), dtype=np.int32)
    np.add.at(img_all, (py, px), 1)

    # ── Vertical-extent car filter ────────────────────────────────────────────
    # Strategy: check for scan points in TWO non-overlapping height zones.
    #
    #   lower zone : [y_min, floor_y + car_top_m]
    #                Contains car bodies AND the lower portion of walls.
    #
    #   mid zone   : (floor_y + car_top_m, floor_y + ceiling_cap_m]
    #                Above car roofs but BELOW ceiling reflections.
    #                Only structural walls have scan points here.
    #
    # Rule: wall_valid = has_lower_pts AND has_mid_pts
    #
    # • Cars         → has_lower=T, has_mid=F  (car < car_top_m)         → ✗
    # • Walls        → has_lower=T, has_mid=T  (wall spans full height)   → ✓
    # • Ceiling only → has_lower=F, has_mid=F  (ceiling > ceiling_cap_m)  → ✗
    #
    # ceiling_cap_m (default 2.05 m) is chosen to stay below the soffit of
    # a typical Czech parking garage (clearance ≈ 2.1–2.3 m).  For
    # higher-ceiling floors the ceiling is already above the loaded wall
    # band, so this cap has no negative effect on those floors.

    car_top_y = floor_y + car_top_m
    ceiling_cap_y = floor_y + ceiling_cap_m

    lower_mask = y_val <= car_top_y
    mid_mask = (y_val > car_top_y) & (y_val <= ceiling_cap_y)

    n_lower = int(lower_mask.sum())
    n_mid = int(mid_mask.sum())

    if car_filter and n_lower > 0 and n_mid > 0:
        img_lo = np.zeros((height, width), dtype=np.int32)
        np.add.at(img_lo, (py[lower_mask], px[lower_mask]), 1)

        img_mi = np.zeros((height, width), dtype=np.int32)
        np.add.at(img_mi, (py[mid_mask], px[mid_mask]), 1)

        has_low = img_lo >= 2  # ≥2 pts in lower zone (stable signal)
        has_mid = img_mi >= 1  # ≥1 pt  in mid zone  (walls always have some)

        # A cell must satisfy BOTH conditions to be treated as a wall.
        wall_valid = (has_low & has_mid).astype(np.uint8) * 255

        # Small dilation to bridge hair-line scan gaps on genuine walls.
        # Safe because only cells that passed both checks are dilated,
        # so we will never propagate into pure-car or pure-ceiling areas.
        k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        wall_valid = cv2.dilate(wall_valid, k3, iterations=1)

        n_wall_cells = int((wall_valid > 0).sum())
        pct_mid = 100.0 * n_mid / len(pts)
        print(
            f"[floor {floor_idx}] car filter : mid-zone "
            f"({car_top_y:.2f} - {ceiling_cap_y:.2f} m)  "
            f"{n_mid:,} pts ({pct_mid:.1f}%)  ->  "
            f"{n_wall_cells:,} wall cells kept"
        )
    else:
        wall_valid = np.full((height, width), 255, dtype=np.uint8)
        if car_filter:
            reason = (
                "no pts in lower zone"
                if n_lower == 0
                else f"no pts in mid-zone ({car_top_y:.2f}-{ceiling_cap_y:.2f} m)"
            )
            print(f"[floor {floor_idx}] car filter : inactive ({reason})")

    # ── Solid binary image (filtered) ─────────────────────────────────────────
    # Require ≥3 raw points in a cell to call it a solid wall voxel.
    # Then mask out cells that failed the vertical-extent check.
    solid = (img_all >= 3).astype(np.uint8) * 255
    solid_filtered = np.where(wall_valid > 0, solid, 0).astype(np.uint8)

    # Morphological close — bridges 1-cell (5 cm) gaps from scan dropouts
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(solid_filtered, cv2.MORPH_CLOSE, k3)

    # ── Canny → Hough ────────────────────────────────────────────────────────
    edges = cv2.Canny(closed, 50, 150, apertureSize=3)

    min_len_px = max(8, int(min_wall_m / grid_size))
    max_gap_px = max(4, int(max_gap_m / grid_size))

    print(
        f"[floor {floor_idx}] Hough      : threshold={hough_threshold}  "
        f"minLen={min_len_px}px ({min_wall_m:.2f} m)  "
        f"maxGap={max_gap_px}px ({max_gap_m:.2f} m)"
    )

    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=hough_threshold,
        minLineLength=min_len_px,
        maxLineGap=max_gap_px,
    )

    raw_n = len(lines) if lines is not None else 0
    print(f"[floor {floor_idx}] raw lines  : {raw_n}")

    if lines is None:
        print(f"[floor {floor_idx}] no lines found -- returning empty")
        _write_empty_result(floor_idx, processed_dir, grid_size)
        return []

    # ── Collinear merge ───────────────────────────────────────────────────────
    # Conservative: only merges truly co-linear close segments (same wall,
    # different scan passes).  Does NOT suppress parallel walls from different
    # rooms (that was the root cause of rooms disappearing).
    lines_merged = merge_collinear_segments(
        list(lines),
        gap_px=max(max_gap_px * 2, 20),
        angle_tol_deg=4.0,
        max_perp_px=2.5,
    )
    print(f"[floor {floor_idx}] after merge: {len(lines_merged)}")

    # ── Manhattan snap ────────────────────────────────────────────────────────
    if snap_to_axis:
        lines_final = snap_lines_to_manhattan(lines_merged, angle_tolerance=10.0)
    else:
        lines_final = lines_merged

    # ── Pixel → metric, minimum-length filter ────────────────────────────────
    real_lines = []
    for line in lines_final:
        x1p, y1p, x2p, y2p = line[0]
        rx1 = float(x1p * grid_size + x_min_r)
        rz1 = float(y1p * grid_size + z_min_r)
        rx2 = float(x2p * grid_size + x_min_r)
        rz2 = float(y2p * grid_size + z_min_r)
        seg = [[rx1, rz1], [rx2, rz2]]
        if _seg_length(seg) >= min_wall_m:
            real_lines.append(seg)

    print(f"[floor {floor_idx}] final walls: {len(real_lines)}")

    # ── Debug PNGs ────────────────────────────────────────────────────────────
    if save_debug:
        dbg_prefix = os.path.join(processed_dir, f"debug_floor{floor_idx}")
        _save_density_png(
            img_all.astype(np.float32).clip(0, 30),
            f"{dbg_prefix}_1_density_all.png",
        )
        if car_filter and n_mid > 0:
            _save_density_png(
                (wall_valid > 0).astype(np.float32) * 255,
                f"{dbg_prefix}_2_wall_mask.png",
            )
        _save_density_png(solid_filtered, f"{dbg_prefix}_3_solid_filtered.png")
        _save_density_png(edges, f"{dbg_prefix}_4_edges.png")
        _save_lines_png(closed, list(lines_final), f"{dbg_prefix}_5_lines.png")
        print(f"[floor {floor_idx}] debug PNGs : {dbg_prefix}_1-5_*.png")

    # ── Save JSON ─────────────────────────────────────────────────────────────
    out_path = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    result = {
        "floor_idx": floor_idx,
        "grid_size": grid_size,
        "x_min": float(x_min_r),
        "z_min": float(z_min_r),
        "source": source_lbl,
        "lines": real_lines,
    }
    with open(out_path, "w") as fh:
        json.dump(result, fh)

    return real_lines


# ─────────────────────────────────────────────────────────────────────────────
# Internal utilities
# ─────────────────────────────────────────────────────────────────────────────


def _write_empty_result(floor_idx: int, processed_dir: str, grid_size: float) -> None:
    out = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    with open(out, "w") as fh:
        json.dump(
            {
                "floor_idx": floor_idx,
                "grid_size": grid_size,
                "x_min": 0.0,
                "z_min": 0.0,
                "source": "empty",
                "lines": [],
            },
            fh,
        )
