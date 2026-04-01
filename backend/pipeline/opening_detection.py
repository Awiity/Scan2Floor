"""
opening_detection.py — Phase 5 (M4) — updated to use dense wall slices

Detects doors and windows in detected wall segments by analysing
the vertical point-density profile inside a slab around each wall line.

Algorithm (per wall segment):
  1. Pull all points within ±wall_thickness of the wall line (full height)
  2. Project them onto wall's local 1D axis (u = along wall, v = height)
  3. Build 2D occupancy grid (5cm × 5cm)
  4. Scan columns for vertical gaps:
       DOOR   — gap spans  0 m – 1.9 m, width ≥ 0.7 m
       WINDOW — gap spans ~0.7 m – 2.0 m with sill points below, width ≥ 0.5 m
  5. Merge adjacent gap columns into single opening objects

Output: openings_floor_<N>.json
  { floor_idx, n_doors, n_windows, openings: [ { type, width, x, z, … } ] }
"""

import json
import os
import struct

import numpy as np

# ── Helpers ─────────────────────────────────────────────────────────────────


def _load_all_points(bin_path: str) -> np.ndarray:
    """Load full point cloud (N,3) [X Y Z], Y = height."""
    with open(bin_path, "rb") as f:
        buf = f.read()
    N = struct.unpack("<I", buf[:4])[0]
    return np.frombuffer(buf, dtype=np.float32, count=N * 3, offset=4).reshape(N, 3)


def _load_floor_points(
    floor_idx: int,
    processed_dir: str,
    floor_y: float,
) -> tuple[np.ndarray, str]:
    """
    Return (pts, source_label) for a floor's full height band.

    Priority:
      1. wall_slice_floor_<N>.npy  — dense, pre-extracted, preferred
      2. pointcloud.bin            — legacy 1:100 fallback

    The slice already spans [floor_y - 0.05, floor_y + 2.65]; we widen
    slightly when loading from pointcloud.bin for safety.
    """
    slice_path = os.path.join(processed_dir, f"wall_slice_floor_{floor_idx}.npy")
    if os.path.exists(slice_path):
        pts = np.load(slice_path)  # (M, 3) float32  [x, y, z]
        # The slice covers floor_y ± small margin; keep the useful part
        mask = (pts[:, 1] >= floor_y - 0.1) & (pts[:, 1] <= floor_y + 2.7)
        pts = pts[mask]
        return pts, f"dense-slice ({len(pts):,} pts)"

    bin_path = os.path.join(processed_dir, "pointcloud.bin")
    if os.path.exists(bin_path):
        all_pts = _load_all_points(bin_path)
        mask = (all_pts[:, 1] >= floor_y) & (all_pts[:, 1] <= floor_y + 2.7)
        pts = all_pts[mask]
        return pts, f"legacy-1:100 ({len(pts):,} pts)"

    raise FileNotFoundError(
        f"No point source found in {processed_dir}. "
        "Run preprocess_walls.py or the original preprocess step."
    )


def _dist_to_line(pts_xz: np.ndarray, x1, z1, x2, z2):
    """
    Signed perpendicular distance + projection parameter t for each XZ point.
    Returns (dist, t) where t ∈ [0,1] means on the segment.
    """
    dx, dz = x2 - x1, z2 - z1
    seg_len_sq = dx * dx + dz * dz
    if seg_len_sq < 1e-9:
        inf = np.full(len(pts_xz), np.inf)
        return inf, np.zeros(len(pts_xz))

    t = ((pts_xz[:, 0] - x1) * dx + (pts_xz[:, 1] - z1) * dz) / seg_len_sq
    nx = x1 + t * dx - pts_xz[:, 0]
    nz = z1 + t * dz - pts_xz[:, 1]
    dist = np.sqrt(nx * nx + nz * nz)
    return dist, t


def _merge_gaps(gaps: list[tuple], min_sep_m: float = 0.05) -> list[tuple]:
    """Merge adjacent or very-close gaps of the same type into single spans."""
    if not gaps:
        return []
    gaps = sorted(gaps, key=lambda g: g[0])
    merged = [gaps[0]]
    for start, end, gtype in gaps[1:]:
        prev_s, prev_e, prev_t = merged[-1]
        if gtype == prev_t and start - prev_e <= min_sep_m:
            merged[-1] = (prev_s, end, prev_t)
        else:
            merged.append((start, end, gtype))
    return merged


# ── Per-wall analysis ────────────────────────────────────────────────────────


def _analyse_wall(seg, floor_pts: np.ndarray, floor_y: float, config: dict) -> list:
    """
    Analyse one wall segment for openings.

    Parameters
    ----------
    seg        : [[x1,z1],[x2,z2]] in metres (XZ plane)
    floor_pts  : points already filtered to floor_y … floor_y+2.5 m  (N,3)
    floor_y    : floor world-Y value
    config     : detection config dict

    Returns list of opening dicts.
    """
    wall_thickness = config.get("wall_thickness", 0.25)  # slab half-width
    min_door_w = config.get("min_door_width", 0.70)
    min_win_w = config.get("min_window_width", 0.50)
    door_h_thr = config.get("door_height_threshold", 1.85)
    bin_m = 0.05  # 5 cm grid

    x1, z1 = seg[0]
    x2, z2 = seg[1]
    wall_len = float(np.hypot(x2 - x1, z2 - z1))
    if wall_len < 0.3:
        return []

    # ── Slab filter ──────────────────────────────────────────────────────────
    pts_xz = floor_pts[:, [0, 2]]
    dist, t = _dist_to_line(pts_xz, x1, z1, x2, z2)
    mask = (dist <= wall_thickness) & (t >= 0.0) & (t <= 1.0)
    pts_slab = floor_pts[mask]
    t_slab = t[mask]

    if len(pts_slab) < 5:
        return []

    # ── Build 2D occupancy grid ───────────────────────────────────────────────
    n_u = max(1, int(np.ceil(wall_len / bin_m)))
    height_range = 2.5
    n_v = max(1, int(np.ceil(height_range / bin_m)))

    u_idx = np.clip((t_slab * wall_len / bin_m).astype(int), 0, n_u - 1)
    v_raw = pts_slab[:, 1] - floor_y  # height above floor
    v_idx = np.clip((v_raw / bin_m).astype(int), 0, n_v - 1)

    grid = np.zeros((n_v, n_u), dtype=np.int32)
    np.add.at(grid, (v_idx, u_idx), 1)
    occupied = grid >= 2  # ≥2 pts/cell = solid

    # ── Zone index boundaries ────────────────────────────────────────────────
    door_top = min(n_v, int(door_h_thr / bin_m))
    sill_bot = 0
    sill_top = min(n_v, int(0.65 / bin_m))  # sill region  0 – 0.65 m
    win_bot = int(0.65 / bin_m)
    win_top = min(n_v, int(2.05 / bin_m))  # window band  0.65 – 2.05 m

    # ── Column-by-column gap scan ────────────────────────────────────────────
    raw_gaps: list[tuple] = []  # (u_start_m, u_end_m, type)
    in_gap = False
    gap_u0 = 0
    gap_type = "door"

    for u in range(n_u):
        col = occupied[:, u]

        door_empty = not np.any(col[:door_top])
        has_sill = np.any(col[sill_bot:sill_top])
        win_empty = not np.any(col[win_bot:win_top])

        is_door = door_empty
        is_window = win_empty and has_sill and not door_empty

        opening = is_door or is_window
        otype = "door" if is_door else "window"

        if opening and not in_gap:
            in_gap = True
            gap_u0 = u
            gap_type = otype
        elif not opening and in_gap:
            raw_gaps.append((gap_u0 * bin_m, u * bin_m, gap_type))
            in_gap = False

    if in_gap:
        raw_gaps.append((gap_u0 * bin_m, n_u * bin_m, gap_type))

    merged = _merge_gaps(raw_gaps)

    # ── Build output objects ─────────────────────────────────────────────────
    results = []
    for u_s, u_e, gtype in merged:
        width = u_e - u_s
        min_w = min_door_w if gtype == "door" else min_win_w
        if width < min_w:
            continue

        frac = ((u_s + u_e) / 2) / wall_len
        ox = x1 + frac * (x2 - x1)
        oz = z1 + frac * (z2 - z1)

        # Hinge/start endpoint (the further edge from the arc)
        hinge_frac = u_s / wall_len
        hx = x1 + hinge_frac * (x2 - x1)
        hz = z1 + hinge_frac * (z2 - z1)

        results.append(
            {
                "type": gtype,
                "width": round(width, 3),
                "u_start": round(u_s, 3),
                "u_end": round(u_e, 3),
                "x": round(ox, 4),
                "z": round(oz, 4),
                "hinge_x": round(hx, 4),
                "hinge_z": round(hz, 4),
                "wall_x1": x1,
                "wall_z1": z1,
                "wall_x2": x2,
                "wall_z2": z2,
                "wall_len": round(wall_len, 4),
            }
        )

    return results


# ── Public entry point ───────────────────────────────────────────────────────


def detect_openings_for_floor(floor_idx: int, config: dict) -> dict:
    """
    Detect doors and windows in all walls of a given floor.

    Reads  : processed/walls_floor_<N>.json  +  processed/info.json
    Writes : processed/openings_floor_<N>.json
    Returns: full result dict  { floor_idx, n_doors, n_windows, openings }
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.path.join(base_dir, "processed")
    bin_path = os.path.join(processed_dir, "pointcloud.bin")
    info_path = os.path.join(processed_dir, "info.json")
    wall_path = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")

    if not os.path.exists(wall_path):
        raise FileNotFoundError(
            f"Wall data not found for floor {floor_idx}. Run wall detection first."
        )

    with open(info_path) as f:
        info = json.load(f)
    with open(wall_path) as f:
        wall_data = json.load(f)

    floor_levels = info.get("floor_levels", [])
    if floor_idx >= len(floor_levels):
        raise ValueError(f"Floor index {floor_idx} not found in info.json")

    floor_y = float(floor_levels[floor_idx])
    walls = wall_data.get("lines", [])

    # Load point cloud — prefer dense wall_slice, fall back to pointcloud.bin
    floor_pts, src_label = _load_floor_points(floor_idx, processed_dir, floor_y)
    print(f"[openings floor {floor_idx}] source: {src_label}")

    all_openings: list[dict] = []
    for wall_idx, seg in enumerate(walls):
        ops = _analyse_wall(seg, floor_pts, floor_y, config)
        for op in ops:
            op["wall_idx"] = wall_idx
        all_openings.extend(ops)

    result = {
        "floor_idx": floor_idx,
        "n_doors": sum(1 for o in all_openings if o["type"] == "door"),
        "n_windows": sum(1 for o in all_openings if o["type"] == "window"),
        "openings": all_openings,
    }

    out_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    return result
