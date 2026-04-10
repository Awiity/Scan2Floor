"""
wall_detection_c2b.py  —  Cloud2BIM-style wall detector for Scan2Floor

Algorithm (ported from Cloud2BIM aux_functions.py / identify_walls())
----------------------------------------------------------------------
1. Load full-density wall-band points from wall_slice_floor_N.npy
2. Extract a mid-height Z-slice (85–120 % of storey height, matching Cloud2BIM's
   z_section_boundaries=[0.85, 1.2]).  This avoids floor/ceiling clutter.
3. Project to the XZ horizontal plane and build a pixel-size 2-D density
   histogram (grid_size metres per pixel).
4. Threshold relative to local density → binary mask.
5. Morphological closing (skimage/cv2) to bridge small scan gaps.
6. cv2.findContours → cv2.approxPolyDP (Douglas-Peucker) → line segments.
7. Convert pixel coordinates back to metres.
8. Filter segments shorter than min_wall_m.
9. Iterative collinear merge (reuses existing merge_collinear_segments).
10. Group parallel segment pairs whose perpendicular distance ≤ max_wall_thickness.
11. Compute wall axis (midline) and thickness from each pair group.
12. Optional Manhattan snap (0° / 90°).
13. Write walls_floor_N.json in the same format as wall_detection.py.

Coordinate system reminder
--------------------------
wall_slice_floor_N.npy is already in Y-up (Three.js) coords:
    col 0 = x_yup   (east-west)
    col 1 = y_yup   (height)
    col 2 = z_yup   (north-south, negated)
We work in the XZ horizontal plane (cols 0 and 2).
"""

from __future__ import annotations

import json
import math
import os

import cv2
import numpy as np

# ── Geometry helpers (previously in wall_detection.py) ────────────────────

def snap_lines_to_manhattan(lines, angle_tolerance: float = 10.0):
    """Snap near-axis lines to exact 0° / 90°."""
    import numpy as np
    snapped = []
    tol = np.radians(angle_tolerance)
    for line in lines:
        x1, y1, x2, y2 = line[0]
        ang = abs(np.arctan2(y2 - y1, x2 - x1))
        if ang < tol or abs(ang - np.pi) < tol:          # horizontal
            avg_y = int(round((y1 + y2) / 2))
            snapped.append([[x1, avg_y, x2, avg_y]])
        elif abs(ang - np.pi / 2) < tol:                 # vertical
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
    """Iteratively merge near-collinear segments that are close together."""
    import numpy as np
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
                da = abs(ang_i - ang_j) % np.pi
                if da > tol_rad and abs(da - np.pi) > tol_rad:
                    continue
                seg_len = max(1e-9, ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)
                mx, mz = (x3 + x4) / 2.0, (y3 + y4) / 2.0
                perp = abs((y2 - y1) * mx - (x2 - x1) * mz + x2 * y1 - y2 * x1) / seg_len
                if perp > max_perp_px:
                    continue
                ux, uy = (x2 - x1) / seg_len, (y2 - y1) / seg_len
                proj_i0, proj_i1 = x1 * ux + y1 * uy, x2 * ux + y2 * uy
                proj_j0, proj_j1 = x3 * ux + y3 * uy, x4 * ux + y4 * uy
                lo_i, hi_i = min(proj_i0, proj_i1), max(proj_i0, proj_i1)
                lo_j, hi_j = min(proj_j0, proj_j1), max(proj_j0, proj_j1)
                if max(lo_j - hi_i, lo_i - hi_j) > gap_px:
                    continue
                group.extend([(x3, y3), (x4, y4)])
                used[j] = True
                changed = True
            if len(group) > 2:
                pts_arr = np.array(group, dtype=float)
                mean = pts_arr.mean(axis=0)
                _, _, vt = np.linalg.svd(pts_arr - mean, full_matrices=False)
                direction = vt[0]
                projs = (pts_arr - mean) @ direction
                p_lo = mean + projs.min() * direction
                p_hi = mean + projs.max() * direction
                result.append([[int(round(p_lo[0])), int(round(p_lo[1])),
                                int(round(p_hi[0])), int(round(p_hi[1]))]])
            else:
                result.append([[x1, y1, x2, y2]])
        merged = result
    return merged


# ═════════════════════════════════════════════════════════════════════════════
# Geometry helpers (matching Cloud2BIM aux_functions.py)
# ═════════════════════════════════════════════════════════════════════════════

def _dist(p1, p2) -> float:
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def _dist_point_to_line(point, ls, le):
    """Perpendicular distance from *point* to the infinite line through ls→le."""
    lv = (le[0] - ls[0], le[1] - ls[1])
    ll = math.hypot(*lv)
    if ll < 1e-12:
        return _dist(point, ls)
    pv = (point[0] - ls[0], point[1] - ls[1])
    cross = lv[0] * pv[1] - lv[1] * pv[0]
    return abs(cross) / ll


def _segments_angle_ok(s1, s2, tol_deg: float = 5.0) -> bool:
    """True if the two segments are approximately parallel (within tol_deg)."""
    dx1, dy1 = s1[1][0] - s1[0][0], s1[1][1] - s1[0][1]
    dx2, dy2 = s2[1][0] - s2[0][0], s2[1][1] - s2[0][1]
    m1 = math.hypot(dx1, dy1)
    m2 = math.hypot(dx2, dy2)
    if m1 < 1e-12 or m2 < 1e-12:
        return False
    cos_a = (dx1 * dx2 + dy1 * dy2) / (m1 * m2)
    cos_a = max(-1.0, min(1.0, cos_a))
    angle = math.degrees(math.acos(cos_a))
    return angle < tol_deg or abs(angle - 180.0) < tol_deg


def _x_overlap(s1, s2, rotate_angle: float) -> float:
    """Return the 1-D overlap length after rotating both segments to the X-axis."""
    def rot(p, a):
        ca, sa = math.cos(a), math.sin(a)
        return ca * p[0] + sa * p[1]

    proj = [rot(s1[0], -rotate_angle), rot(s1[1], -rotate_angle),
            rot(s2[0], -rotate_angle), rot(s2[1], -rotate_angle)]
    lo1, hi1 = min(proj[0], proj[1]), max(proj[0], proj[1])
    lo2, hi2 = min(proj[2], proj[3]), max(proj[2], proj[3])
    return min(hi1, hi2) - max(lo1, lo2)


def _group_parallel_segments(
    segments: list,
    max_wall_thickness: float,
    angle_tol_deg: float = 5.0,
) -> tuple[list, list]:
    """
    Group segment pairs that are parallel AND within max_wall_thickness of each other.

    Returns
    -------
    groups : list of list-of-segments   (only groups with ≥ 2 segments)
    singles: list of segments            (unpaired — outer-wall candidates)
    """
    segs = list(segments)  # work on a copy
    groups: list = []
    singles: list = []

    while segs:
        cur = segs.pop(0)
        group = [cur]
        i = 0
        while i < len(segs):
            other = segs[i]
            if not _segments_angle_ok(cur, other, angle_tol_deg):
                i += 1
                continue
            # Check that endpoints are close enough
            min_ep_dist = min(
                _dist(p1, p2)
                for p1 in cur
                for p2 in other
            )
            if min_ep_dist > max_wall_thickness:
                i += 1
                continue
            # Check there is some 1-D overlap along the shared axis
            ang = math.atan2(cur[1][1] - cur[0][1], cur[1][0] - cur[0][0])
            if _x_overlap(cur, other, ang) >= 0:
                group.append(other)
                segs.pop(i)
            else:
                i += 1

        if len(group) >= 2:
            groups.append(group)
        else:
            singles.append(cur)

    return groups, singles


def _calc_wall_axis(group: list) -> tuple[list, float]:
    """
    Compute the wall centre-line and thickness from a pair group.

    Returns
    -------
    axis      : [[x1,z1], [x2,z2]]  — centre-line endpoints
    thickness : float               — perpendicular distance between the two faces
    """
    # Pick the longest segment as reference
    lengths = [_dist(s[0], s[1]) for s in group]
    idx_long = int(np.argmax(lengths))
    long_seg = group[idx_long]
    others = [group[j] for j in range(len(group)) if j != idx_long]

    # Direction of the longest segment
    dx = long_seg[1][0] - long_seg[0][0]
    dy = long_seg[1][1] - long_seg[0][1]
    norm = math.hypot(dx, dy)
    if norm < 1e-12:
        return list(long_seg), 0.0
    dx /= norm
    dy /= norm

    # Perpendicular distance from other segments to the reference
    perp_dists = []
    for other in others:
        for pt in other:
            perp_dists.append(_dist_point_to_line(pt, long_seg[0], long_seg[1]))
    thickness = float(np.mean(perp_dists)) if perp_dists else 0.0
    half = thickness / 2.0

    # Shift the long-segment endpoints perpendicular by half-thickness
    # to land on the centre-line
    ax_start = [long_seg[0][0] + half * (-dy), long_seg[0][1] + half * dx]
    ax_end   = [long_seg[1][0] + half * (-dy), long_seg[1][1] + half * dx]

    # Choose the side that is geometrically between the two faces
    # (smaller total distance to all segment endpoints)
    all_pts = [pt for s in group for pt in s]
    d_initial = sum(_dist(pt, ax_start) + _dist(pt, ax_end) for pt in all_pts)
    ax_start2 = [long_seg[0][0] - half * (-dy), long_seg[0][1] - half * dx]
    ax_end2   = [long_seg[1][0] - half * (-dy), long_seg[1][1] - half * dx]
    d_flip    = sum(_dist(pt, ax_start2) + _dist(pt, ax_end2) for pt in all_pts)

    if d_flip < d_initial:
        ax_start, ax_end = ax_start2, ax_end2

    return [ax_start, ax_end], thickness


def _furthest_pair(pts: list) -> tuple:
    """Return the two most-distant points from a list."""
    best_d, p1, p2 = -1.0, pts[0], pts[0]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = _dist(pts[i], pts[j])
            if d > best_d:
                best_d, p1, p2 = d, pts[i], pts[j]
    return p1, p2


# ═════════════════════════════════════════════════════════════════════════════
# Debug helpers
# ═════════════════════════════════════════════════════════════════════════════

def _save_png(arr: np.ndarray, path: str) -> None:
    try:
        a = arr.astype(np.float32)
        if a.max() > a.min():
            a = (a - a.min()) / (a.max() - a.min()) * 255.0
        img = cv2.flip(a.astype(np.uint8), 0)
        cv2.imwrite(path, img)
    except Exception:
        pass


def _save_segs_png(base: np.ndarray, segs_m, x_min, z_min, gs, path, colour=(0, 0, 255)):
    try:
        h, w = base.shape[:2]
        rgb = cv2.cvtColor(cv2.flip(base.copy(), 0), cv2.COLOR_GRAY2BGR)
        for seg in segs_m:
            x1p = int((seg[0][0] - x_min) / gs)
            y1p = h - 1 - int((seg[0][1] - z_min) / gs)
            x2p = int((seg[1][0] - x_min) / gs)
            y2p = h - 1 - int((seg[1][1] - z_min) / gs)
            cv2.line(rgb, (x1p, y1p), (x2p, y2p), colour, 1)
        cv2.imwrite(path, rgb)
    except Exception:
        pass


# ═════════════════════════════════════════════════════════════════════════════
# Public API
# ═════════════════════════════════════════════════════════════════════════════

def detect_walls_c2b_for_floor(floor_idx: int, config: dict) -> list:
    """
    Cloud2BIM-style wall detection for one floor.

    Parameters (same keys as wall_detection.detect_walls_for_floor)
    ---------------------------------------------------------------
    grid_size         float   cell size in metres        (default 0.02)
    min_wall_m        float   min wall segment length m  (default 0.40)
    max_wall_thickness float  max thickness for pairing  (default 0.75)
    snap_to_axis      bool    Manhattan snap             (default True)
    dp_tolerance      float   Douglas-Peucker parameter  (default 0.04 m)
    save_debug        bool    write debug PNGs           (default True)
    threshold_frac    float   relative density threshold (default 0.01)

    Returns
    -------
    list[[[x1,z1],[x2,z2]]]   wall centre-line segments in metres.
    """
    base_dir      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.path.join(base_dir, "processed")
    info_path     = os.path.join(processed_dir, "info.json")

    with open(info_path) as fh:
        info = json.load(fh)

    levels = info.get("floor_levels", [])
    if floor_idx >= len(levels):
        raise ValueError(
            f"Floor index {floor_idx} out of range "
            f"(info.json has {len(levels)} floor(s))."
        )

    floor_y = float(levels[floor_idx])

    # ── Unpack config ─────────────────────────────────────────────────────
    grid_size         = float(config.get("grid_size",          0.02))
    min_wall_m        = float(config.get("min_wall_m",         0.40))
    max_wall_thick    = float(config.get("max_wall_thickness",  0.75))
    snap_to_axis      = bool(config.get("snap_to_axis",        True))
    dp_tol_m          = float(config.get("dp_tolerance",       0.04))
    save_debug        = bool(config.get("save_debug",          True))
    threshold_frac    = float(config.get("threshold_frac",     0.01))

    # ── Load wall-slice points ────────────────────────────────────────────
    slice_path = os.path.join(processed_dir, f"wall_slice_floor_{floor_idx}.npy")
    if not os.path.exists(slice_path):
        raise FileNotFoundError(
            f"wall_slice_floor_{floor_idx}.npy not found."
            " Run preprocess_walls.py first."
        )

    pts = np.load(slice_path)   # (M, 3) float32  [x_yup, y_yup, z_yup]
    print(f"\n[c2b floor {floor_idx}] loaded slice: {len(pts):,} pts")
    print(f"[c2b floor {floor_idx}] floor_y = {floor_y:+.3f} m")

    # ── Height band — Cloud2BIM uses 85–120 % of storey height ───────────
    # Estimate storey height from adjacent floor levels or fall back to 3 m.
    if floor_idx + 1 < len(levels):
        storey_h = float(levels[floor_idx + 1]) - floor_y
    else:
        storey_h = 3.0
    storey_h = max(storey_h, 2.0)   # guard

    z_pct_lo, z_pct_hi = 0.30, 0.90   # keep generous range (Cloud2BIM: 0.85–1.20 relative)
    y_lo = floor_y + z_pct_lo * storey_h
    y_hi = floor_y + z_pct_hi * storey_h

    mask = (pts[:, 1] >= y_lo) & (pts[:, 1] < y_hi)
    pts_band = pts[mask]
    print(f"[c2b floor {floor_idx}] band [{y_lo:.2f} … {y_hi:.2f}]: {len(pts_band):,} pts")

    if len(pts_band) < 50:
        print(f"[c2b floor {floor_idx}] too few points — skipping")
        _write_empty(floor_idx, processed_dir, grid_size)
        return []

    # ── 2-D density histogram on XZ plane ────────────────────────────────
    xz     = pts_band[:, [0, 2]]
    x_min, z_min = xz.min(axis=0)
    x_max, z_max = xz.max(axis=0)

    raw_w = max(10, int(np.ceil((x_max - x_min) / grid_size)))
    raw_h = max(10, int(np.ceil((z_max - z_min) / grid_size)))
    MAX_DIM = 4096
    width  = min(raw_w, MAX_DIM)
    height = min(raw_h, MAX_DIM)

    px = np.clip(np.floor((xz[:, 0] - x_min) / grid_size).astype(np.int32), 0, width  - 1)
    py = np.clip(np.floor((xz[:, 1] - z_min) / grid_size).astype(np.int32), 0, height - 1)

    grid = np.zeros((height, width), dtype=np.float32)
    np.add.at(grid, (py, px), 1.0)

    print(f"[c2b floor {floor_idx}] grid {width}×{height}  gs={grid_size*100:.0f} cm")

    # ── Threshold → binary ────────────────────────────────────────────────
    max_density = grid.max()
    threshold   = max(1.0, threshold_frac * max_density)
    binary = ((grid > threshold).astype(np.uint8) * 255)

    # ── Morphological close (5×5) – Cloud2BIM uses closing((5,5)) ────────
    k5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, k5)

    # ── Find contours ─────────────────────────────────────────────────────
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    print(f"[c2b floor {floor_idx}] contours: {len(contours)}")

    # ── Douglas-Peucker approximation → line segments ─────────────────────
    dp_tol_px = max(1.0, dp_tol_m / grid_size)
    all_segs_px: list[tuple] = []   # list of (p1_px, p2_px) where each is (x,y) pixel

    for cnt in contours:
        if cv2.contourArea(cnt) < 4:
            continue
        approx = cv2.approxPolyDP(cnt, dp_tol_px, closed=True)
        approx = np.squeeze(approx, axis=1)   # (K, 2)
        if len(approx) < 2:
            continue
        for i in range(len(approx)):
            p1 = tuple(approx[i])
            p2 = tuple(approx[(i + 1) % len(approx)])
            all_segs_px.append((p1, p2))

    print(f"[c2b floor {floor_idx}] D-P segments: {len(all_segs_px)}")

    # ── Convert pixel → metres ────────────────────────────────────────────
    def px_to_m(p):
        return (p[0] * grid_size + x_min, p[1] * grid_size + z_min)

    segs_m = [
        [list(px_to_m(s[0])), list(px_to_m(s[1]))]
        for s in all_segs_px
    ]

    # ── Filter short segments ─────────────────────────────────────────────
    segs_m = [s for s in segs_m if _dist(s[0], s[1]) >= min_wall_m * 0.5]  # generous pre-filter
    print(f"[c2b floor {floor_idx}] after length pre-filter: {len(segs_m)}")

    # ── Collinear merge (reuse our robust implementation) ─────────────────
    # Convert to the [[x1,y1,x2,y2]] pixel format expected by merge_collinear_segments
    def m_to_px_line(s):
        x1p = int((s[0][0] - x_min) / grid_size)
        y1p = int((s[0][1] - z_min) / grid_size)
        x2p = int((s[1][0] - x_min) / grid_size)
        y2p = int((s[1][1] - z_min) / grid_size)
        return [[x1p, y1p, x2p, y2p]]

    lines_px = [m_to_px_line(s) for s in segs_m]
    min_len_px = max(1, int(min_wall_m * 0.5 / grid_size))
    merged_px = merge_collinear_segments(lines_px, gap_px=min_len_px, angle_tol_deg=4.0, max_perp_px=3.0)
    print(f"[c2b floor {floor_idx}] after collinear merge: {len(merged_px)}")

    # Back to metres
    def px_line_to_m(l):
        x1p, y1p, x2p, y2p = l[0]
        return [
            [x1p * grid_size + x_min, y1p * grid_size + z_min],
            [x2p * grid_size + x_min, y2p * grid_size + z_min],
        ]

    segs_merged = [px_line_to_m(l) for l in merged_px]
    segs_merged = [s for s in segs_merged if _dist(s[0], s[1]) >= min_wall_m * 0.5]

    # ── Group parallel pairs → wall axes ──────────────────────────────────
    groups, singles = _group_parallel_segments(segs_merged, max_wall_thick)
    print(f"[c2b floor {floor_idx}] parallel groups: {len(groups)}  singles: {len(singles)}")

    wall_axes: list[list] = []
    wall_thicknesses: list[float] = []

    for grp in groups:
        axis, thick = _calc_wall_axis(grp)
        if _dist(axis[0], axis[1]) >= min_wall_m:
            wall_axes.append(axis)
            wall_thicknesses.append(thick)

    # Singles with no matching face are added as-is (outer walls, single-face scans)
    for seg in singles:
        if _dist(seg[0], seg[1]) >= min_wall_m:
            wall_axes.append(seg)
            wall_thicknesses.append(0.0)

    print(f"[c2b floor {floor_idx}] wall axes: {len(wall_axes)}")

    # ── Manhattan snap ────────────────────────────────────────────────────
    if snap_to_axis:
        # Convert to Hough-style [[x1,y1,x2,y2]] for the shared helper
        def axis_to_hough(ax):
            return [[
                int((ax[0][0] - x_min) / grid_size),
                int((ax[0][1] - z_min) / grid_size),
                int((ax[1][0] - x_min) / grid_size),
                int((ax[1][1] - z_min) / grid_size),
            ]]

        hough_axs = [axis_to_hough(ax) for ax in wall_axes]
        snapped = snap_lines_to_manhattan(hough_axs, angle_tolerance=10.0)
        # Convert back
        wall_axes = [
            [
                [l[0][0] * grid_size + x_min, l[0][1] * grid_size + z_min],
                [l[0][2] * grid_size + x_min, l[0][3] * grid_size + z_min],
            ]
            for l in snapped
        ]
        # Re-apply minimum length filter after snap
        wall_axes = [ax for ax in wall_axes if _dist(ax[0], ax[1]) >= min_wall_m]

    print(f"[c2b floor {floor_idx}] final walls: {len(wall_axes)}")

    # ── Debug PNGs ────────────────────────────────────────────────────────
    if save_debug:
        dbg = os.path.join(processed_dir, f"debug_c2b_floor{floor_idx}")
        _save_png(grid, f"{dbg}_1_density.png")
        _save_png(binary, f"{dbg}_2_binary.png")
        _save_png(closed, f"{dbg}_3_closed.png")
        _save_segs_png(closed, segs_merged, x_min, z_min, grid_size,
                        f"{dbg}_4_merged_segs.png", colour=(0, 200, 0))
        _save_segs_png(closed, wall_axes, x_min, z_min, grid_size,
                        f"{dbg}_5_wall_axes.png", colour=(0, 0, 255))
        print(f"[c2b floor {floor_idx}] debug PNGs: {dbg}_1-5_*.png")

    # ── Save JSON (same format as wall_detection.py) ──────────────────────
    real_lines = wall_axes   # already [[x1,z1],[x2,z2]] in metres
    out_path = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    result = {
        "floor_idx":  floor_idx,
        "grid_size":  grid_size,
        "x_min":      float(x_min),
        "z_min":      float(z_min),
        "source":     f"cloud2bim-c2b ({len(real_lines)} walls)",
        "lines":      real_lines,
    }
    with open(out_path, "w") as fh:
        json.dump(result, fh)

    return real_lines


# ── Internal utility ──────────────────────────────────────────────────────────

def _write_empty(floor_idx: int, processed_dir: str, grid_size: float) -> None:
    out = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    with open(out, "w") as fh:
        json.dump({
            "floor_idx": floor_idx,
            "grid_size": grid_size,
            "x_min": 0.0,
            "z_min": 0.0,
            "source": "empty-c2b",
            "lines": [],
        }, fh)
