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

Confidence scoring (per opening, 0.0 – 1.0):
  Each opening is assigned a confidence score derived from three signals:

    Signal A — Point density in slab (weight 0.35)
      Ratio of occupied cells to wall-area cells, clipped to [0, 1].
      Dense slabs give more reliable gap detection.

    Signal B — Gap column uniformity (weight 0.35)
      Low std-dev of column-wise gap-row counts → clean, consistent opening.
      High std-dev suggests the "gap" is really sensor noise.

    Signal C — Wall coverage (weight 0.30)
      Fraction of u-columns that contain ≥1 point anywhere in the height band.
      Walls covered < COVERAGE_GUARD_FRAC get a hard penalty.

  Low confidence threshold: confidence < LOW_CONFIDENCE_THRESHOLD (0.45)

Output: openings_floor_<N>.json
  {
    floor_idx, n_doors, n_windows,
    n_walls_analysed, n_walls_with_openings, n_low_confidence,
    openings: [ { type, width, confidence, x, z, … } ]
  }
"""

import json
import os
import struct

import numpy as np

# ── Tunable constants ────────────────────────────────────────────────────────

# Confidence weight for each signal (must sum to 1.0)
WEIGHT_DENSITY   = 0.35   # Signal A: point density inside slab
WEIGHT_UNIFORMITY = 0.35  # Signal B: gap column uniformity
WEIGHT_COVERAGE  = 0.30   # Signal C: wall column coverage

# Walls where fewer than this fraction of u-columns have any points at all
# are considered too sparse for reliable detection; their openings are penalised.
COVERAGE_GUARD_FRAC = 0.30

# Openings below this score are flagged as low-confidence in the summary.
LOW_CONFIDENCE_THRESHOLD = 0.45


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


def _compute_confidence(
    grid: np.ndarray,
    occupied: np.ndarray,
    n_u: int,
    n_v: int,
    gap_col_indices: list[int],
    gap_type: str,
    door_chk_bot: int,
    door_top: int,
    win_bot: int,
    win_top: int,
) -> float:
    """
    Compute a 0.0–1.0 confidence score for any openings found on this wall.

    Parameters
    ----------
    grid        : (n_v, n_u) int32 — raw point counts per cell
    occupied    : (n_v, n_u) bool  — grid >= 2
    n_u, n_v    : grid dimensions
    gap_col_indices : list of column indices that were part of a detected gap
    gap_type    : 'door' or 'window'
    door_chk_bot, door_top, win_bot, win_top : zone row boundaries
    """
    if n_u == 0 or n_v == 0:
        return 0.0

    # ── Signal A: Point density in slab ──────────────────────────────────────
    total_cells = n_u * n_v
    occupied_cells = int(np.sum(occupied))
    # We expect walls to be somewhat dense (20–80%); too sparse = unreliable.
    density_ratio = occupied_cells / max(total_cells, 1)
    # Map to [0,1]: score peaks at 40 % density, falls off at extremes
    # Using a triangle: 0→0, 0.2→0.6, 0.4→1.0, 0.8→0.5, 1.0→0.0
    if density_ratio <= 0.0:
        sig_a = 0.0
    elif density_ratio <= 0.40:
        sig_a = min(1.0, density_ratio / 0.40)
    else:
        sig_a = max(0.0, 1.0 - (density_ratio - 0.40) / 0.60)

    # ── Signal B: Gap column uniformity ──────────────────────────────────────
    # Count empty rows per gap column in the relevant zone.
    if gap_type == "door":
        zone_slice = slice(door_chk_bot, door_top)
    else:
        zone_slice = slice(win_bot, win_top)

    if gap_col_indices:
        gap_zone = occupied[zone_slice, :][:, gap_col_indices]  # zone rows × gap cols
        zone_h = gap_zone.shape[0]
        if zone_h > 0:
            # Number of empty cells per gap column
            empty_per_col = zone_h - gap_zone.sum(axis=0)
            # Uniformity: low std-dev → all columns have similar gaps → clean opening
            if len(empty_per_col) > 1:
                cv = float(np.std(empty_per_col)) / max(float(np.mean(empty_per_col)), 1.0)
                sig_b = max(0.0, 1.0 - cv)        # cv=0 → 1.0, cv≥1 → 0.0
            else:
                sig_b = 1.0  # single-column gap, can't compute variance
        else:
            sig_b = 0.5
    else:
        sig_b = 0.5  # no gap cols sampled

    # ── Signal C: Wall column coverage ───────────────────────────────────────
    # Fraction of u-columns that have at least one point anywhere in height.
    col_has_any = occupied.any(axis=0)            # (n_u,) bool
    coverage = float(col_has_any.sum()) / max(n_u, 1)
    # Hard penalty if wall is too sparse
    if coverage < COVERAGE_GUARD_FRAC:
        sig_c = coverage / COVERAGE_GUARD_FRAC * 0.3   # cap at 0.3
    else:
        sig_c = min(1.0, (coverage - COVERAGE_GUARD_FRAC) / (1.0 - COVERAGE_GUARD_FRAC))

    score = WEIGHT_DENSITY * sig_a + WEIGHT_UNIFORMITY * sig_b + WEIGHT_COVERAGE * sig_c
    return round(float(np.clip(score, 0.0, 1.0)), 3)


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

    Returns list of opening dicts (each includes a 'confidence' key).
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

    # ── Upper height check: structural wall guard ────────────────────────────
    # A true wall segment containing doors/windows must extend to upper heights (>= floor_y + 1.6m).
    # Non-structural segments (car bonnets/roofs) only reach ~1.2m-1.5m and should not spawn door arcs.
    v_raw_all = pts_slab[:, 1] - floor_y
    if float(np.max(v_raw_all)) < 1.60:
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
    # Skip the bottom 15 cm when testing for door emptiness.
    # Real-world scans frequently contain floor-level noise, door thresholds,
    # and metallic transition strips.  A single rogue point at 0.05 m would
    # otherwise block the entire opening from being classified as a door.
    door_floor_ignore_m = 0.15  # metres to ignore at the very bottom
    door_chk_bot = min(n_v, int(door_floor_ignore_m / bin_m))  # e.g. 3 cells
    sill_bot = door_chk_bot  # sill check also starts above the noisy zone
    sill_top = min(n_v, int(0.65 / bin_m))  # sill region  0.15 – 0.65 m
    win_bot = int(0.65 / bin_m)
    win_top = min(n_v, int(2.05 / bin_m))  # window band  0.65 – 2.05 m

    # ── Column-by-column gap scan ────────────────────────────────────────────
    raw_gaps: list[tuple] = []  # (u_start_m, u_end_m, type, [col_indices])
    in_gap = False
    gap_u0 = 0
    gap_type = "door"
    gap_cols: list[int] = []

    for u in range(n_u):
        col = occupied[:, u]

        # Ignore the bottom door_chk_bot cells (threshold / floor noise)
        door_empty = not np.any(col[door_chk_bot:door_top])
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
            gap_cols = [u]
        elif opening and in_gap:
            gap_cols.append(u)
        elif not opening and in_gap:
            raw_gaps.append((gap_u0 * bin_m, u * bin_m, gap_type, list(gap_cols)))
            in_gap = False
            gap_cols = []

    if in_gap:
        raw_gaps.append((gap_u0 * bin_m, n_u * bin_m, gap_type, list(gap_cols)))

    # Merge adjacent gaps (strip the col-index list before merging, re-attach after)
    raw_gaps_simple = [(s, e, t) for s, e, t, _ in raw_gaps]
    merged_simple = _merge_gaps(raw_gaps_simple)

    # Rebuild col lists for merged gaps — approximate by collecting all raw gap
    # col-index lists whose u-ranges overlap the merged span.
    merged: list[tuple] = []
    for m_s, m_e, m_t in merged_simple:
        all_cols: list[int] = []
        for s, e, t, cols in raw_gaps:
            if t == m_t and e > m_s and s < m_e:
                all_cols.extend(cols)
        merged.append((m_s, m_e, m_t, sorted(set(all_cols))))

    # ── Build output objects ─────────────────────────────────────────────────
    results = []
    for u_s, u_e, gtype, gap_col_indices in merged:
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

        confidence = _compute_confidence(
            grid=grid,
            occupied=occupied,
            n_u=n_u,
            n_v=n_v,
            gap_col_indices=gap_col_indices,
            gap_type=gtype,
            door_chk_bot=door_chk_bot,
            door_top=door_top,
            win_bot=win_bot,
            win_top=win_top,
        )

        results.append(
            {
                "type": gtype,
                "width": round(width, 3),
                "confidence": confidence,
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
    Returns: full result dict with confidence stats:
             { floor_idx, n_doors, n_windows,
               n_walls_analysed, n_walls_with_openings, n_low_confidence,
               openings }
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.environ.get(
        "PROCESSED_DIR", os.path.join(base_dir, "processed")
    )
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
    n_walls_with_openings = 0

    for wall_idx, seg in enumerate(walls):
        ops = _analyse_wall(seg, floor_pts, floor_y, config)
        if ops:
            n_walls_with_openings += 1
            for op in ops:
                op["wall_idx"] = wall_idx
        all_openings.extend(ops)

    n_doors    = sum(1 for o in all_openings if o["type"] == "door")
    n_windows  = sum(1 for o in all_openings if o["type"] == "window")
    n_low_conf = sum(
        1 for o in all_openings if o["confidence"] < LOW_CONFIDENCE_THRESHOLD
    )

    print(
        f"[openings floor {floor_idx}] "
        f"{n_doors} doors  {n_windows} windows  "
        f"({n_low_conf} low-confidence, threshold={LOW_CONFIDENCE_THRESHOLD})"
    )

    def _json_default(obj):
        if isinstance(obj, (np.floating, np.integer)):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    result = {
        "floor_idx":             int(floor_idx),
        "n_doors":               int(n_doors),
        "n_windows":             int(n_windows),
        "n_walls_analysed":      len(walls),
        "n_walls_with_openings": int(n_walls_with_openings),
        "n_low_confidence":      int(n_low_conf),
        "low_confidence_threshold": float(LOW_CONFIDENCE_THRESHOLD),
        "openings":              all_openings,
    }

    out_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2, default=_json_default)

    return result
