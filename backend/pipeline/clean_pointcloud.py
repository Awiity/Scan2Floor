#!/usr/bin/env python3
"""
clean_pointcloud.py  —  Per-storey point cloud cleaner
======================================================
Down-samples raw point clouds and removes 'foreign objects' (furniture, tables,
clutter, floating artifacts) leaving only structural elements per storey:
  - Floor planes
  - Ceiling planes
  - Walls (vertical columns spanning 65-100% of storey height per floor)

Usage:
    python pipeline/clean_pointcloud.py --xyz "path/to/cloud.xyz" --out "processed/cloud_cleaned.xyz"
    python pipeline/clean_pointcloud.py --downsample-pct 20.0 --span-min 0.65 --span-max 1.00
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

# Force UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Path resolution ──────────────────────────────────────────────────────────
_THIS_FILE = Path(__file__).resolve()
BASE_DIR = _THIS_FILE.parent.parent
PROCESSED_DIR = Path(os.environ.get("PROCESSED_DIR", str(BASE_DIR / "processed")))
_XYZ_CONFIG = PROCESSED_DIR / "xyz_path.json"
_DEFAULT_XYZ = Path(os.environ.get("DATA_DIR", str(BASE_DIR.parent.parent / "data" / "matterpak"))) / "cloud.xyz"


def resolve_xyz_path(cli_path: str | None = None) -> Path:
    if cli_path:
        return Path(cli_path)
    if _XYZ_CONFIG.exists():
        try:
            data = json.loads(_XYZ_CONFIG.read_text())
            candidate = Path(data.get("xyz_path", ""))
            if candidate.suffix.lower() == ".xyz" and candidate.exists():
                return candidate
        except Exception:
            pass
    return _DEFAULT_XYZ


def clean_point_cloud(
    input_path: Path,
    output_path: Path,
    downsample_pct: float = 20.0,
    span_min: float = 0.65,
    span_max: float = 1.00,
    grid_size: float = 0.10,
    plane_tolerance: float = 0.08,
) -> dict:
    """
    Cleans point cloud according to per-storey height span criteria:
      1. Downsamples point cloud to target percentage downsample_pct (1.0 to 100.0).
      2. Detects all floor/ceiling slab peak levels (densest horizontal peaks in height distribution).
         Uses a two-pass strategy so that thin metal frames below a roof do not suppress the real
         roof-slab peak (Fix: parking lot roof detection).
      3. Segments point cloud into storeys [P_k, P_{k+1}] with storey height H_k.
      4. Identifies wall points per storey in 2D columns (X, Y) spanning >= span_min of storey height H_k.
      5. Retains floor, ceiling, and valid wall points for all storeys; discards foreign objects.
         Furniture (chairs, tables) is rejected via a horizontal-cluster veto: cells that are dense
         horizontally but do not span the required wall height are excluded (Fix: furniture removal).

    Returns stats dict.
    """
    t0 = time.time()
    downsample_pct = max(1.0, min(100.0, float(downsample_pct)))
    sample_rate = max(1, int(round(100.0 / downsample_pct)))

    print(f"Reading input point cloud: {input_path}")
    print(f"Target downsample ratio: {downsample_pct:.1f}% (sampling 1 in every {sample_rate} points)")

    try:
        import pandas as pd
        _HAS_PANDAS = True
    except ImportError:
        _HAS_PANDAS = False

    CHUNK = 2_000_000
    positions_list = []
    total_raw_points = 0

    if _HAS_PANDAS:
        reader = pd.read_csv(
            str(input_path),
            header=None,
            sep=" ",
            usecols=[0, 1, 2],
            names=["x", "y", "z"],
            chunksize=CHUNK,
            dtype=np.float32,
            engine="c",
            on_bad_lines="skip",
        )
        row_count = 0
        for chunk in reader:
            n = len(chunk)
            total_raw_points += n
            indices = np.arange(row_count % sample_rate, n, sample_rate)
            row_count += n
            if len(indices) > 0:
                sampled_pts = chunk.values[indices]
                positions_list.append(sampled_pts)
    else:
        with open(input_path, "r", errors="replace") as fh:
            buf = []
            idx = 0
            for line in fh:
                try:
                    vals = line.split()
                    x, y, z = float(vals[0]), float(vals[1]), float(vals[2])
                    total_raw_points += 1
                    if idx % sample_rate == 0:
                        buf.append([x, y, z])
                    idx += 1
                    if len(buf) >= CHUNK:
                        positions_list.append(np.array(buf, dtype=np.float32))
                        buf = []
                except Exception:
                    continue
            if buf:
                positions_list.append(np.array(buf, dtype=np.float32))

    if not positions_list:
        raise ValueError(f"No valid points read from {input_path}")

    pts = np.concatenate(positions_list, axis=0)  # Shape (N, 3)
    N_sampled = len(pts)
    print(f"Loaded {total_raw_points:,} raw points → {N_sampled:,} points sampled ({N_sampled / max(1, total_raw_points) * 100:.1f}%)")

    # Height coordinate: Matterport Z is vertical height in raw XYZ
    heights = pts[:, 2]
    h_min, h_max = float(heights.min()), float(heights.max())
    print(f"Height range (raw Z): {h_min:.2f} to {h_max:.2f} m")

    # ── Detect floor & ceiling slab peaks (two-pass strategy) ────────────────
    # Pass 1: Coarse scan with 1.8m minimum separation — finds main floor/ceiling slabs.
    # Pass 2: Fine scan with 0.6m minimum separation — finds sub-peaks between coarse ones.
    #   Sub-peaks that fall within 1.0m of a coarse peak are treated as metal frames / beams
    #   (parking lot scenario).  In that case we keep the HIGHER of the two as the true slab
    #   edge (the actual roof, not the frame below it).
    bin_size = 0.05  # 5cm bins
    bins = np.arange(h_min, h_max + bin_size, bin_size)
    hist, bin_edges = np.histogram(heights, bins=bins)

    try:
        from scipy.signal import find_peaks

        # --- Pass 1: coarse peaks (floors / main ceilings) ---
        min_dist_coarse = int(1.8 / bin_size)
        peaks_coarse, props_coarse = find_peaks(
            hist, distance=min_dist_coarse, prominence=max(hist) * 0.05
        )
        coarse_heights = sorted([float(bin_edges[p]) for p in peaks_coarse])

        # --- Pass 2: fine peaks (may catch roof hidden behind metal frames) ---
        min_dist_fine = int(0.6 / bin_size)
        peaks_fine, props_fine = find_peaks(
            hist, distance=min_dist_fine, prominence=max(hist) * 0.03
        )
        fine_heights = sorted([float(bin_edges[p]) for p in peaks_fine])

        # Merge: for each coarse peak, check if a fine peak sits 0.2–1.0m above it
        # (metal frame gap).  If yes, replace the coarse peak with the fine one above it
        # (i.e. promote the actual roof slab).
        peak_heights_set = set(coarse_heights)
        for cp in coarse_heights:
            for fp in fine_heights:
                gap = fp - cp
                if 0.20 <= gap <= 1.00:
                    # A fine peak sits just above a coarse peak → the fine one is
                    # more likely the real slab (roof above metal frame)
                    peak_heights_set.discard(cp)
                    peak_heights_set.add(fp)
                    print(f"  [roof-fix] Replaced frame peak {cp:.2f}m → slab peak {fp:.2f}m")
                    break  # one promotion per coarse peak is enough

        peak_heights = sorted(peak_heights_set)

    except ImportError:
        # Fallback: manual two-pass without scipy
        min_sep_coarse = int(1.8 / bin_size)
        min_sep_fine = int(0.6 / bin_size)
        threshold_coarse = max(hist) * 0.05
        threshold_fine = max(hist) * 0.03

        def _manual_peaks(min_sep, threshold):
            found = []
            last_p = -min_sep
            for i in range(1, len(hist) - 1):
                if (hist[i] > threshold
                        and hist[i] >= hist[i - 1]
                        and hist[i] >= hist[i + 1]
                        and (i - last_p) >= min_sep):
                    found.append(float(bin_edges[i]))
                    last_p = i
            return found

        coarse_heights = _manual_peaks(min_sep_coarse, threshold_coarse)
        fine_heights = _manual_peaks(min_sep_fine, threshold_fine)

        peak_heights_set = set(coarse_heights)
        for cp in coarse_heights:
            for fp in fine_heights:
                gap = fp - cp
                if 0.20 <= gap <= 1.00:
                    peak_heights_set.discard(cp)
                    peak_heights_set.add(fp)
                    print(f"  [roof-fix] Replaced frame peak {cp:.2f}m → slab peak {fp:.2f}m")
                    break

        peak_heights = sorted(peak_heights_set)

    print(f"Detected {len(peak_heights)} height peak(s): {[f'{v:.2f}' for v in peak_heights]}")

    # Build per-storey floor/ceiling bands [F_k, C_k]
    storeys = []
    if len(peak_heights) >= 2:
        for k in range(len(peak_heights) - 1):
            f_k = peak_heights[k]
            c_k = peak_heights[k + 1]
            storeys.append((f_k, c_k))
        # Top storey ceiling extension if points extend higher
        last_f = peak_heights[-1]
        top_c = min(last_f + 2.8, h_max)
        if top_c > last_f + 1.0:
            storeys.append((last_f, top_c))
    elif len(peak_heights) == 1:
        f_0 = peak_heights[0]
        c_0 = min(f_0 + 2.8, h_max)
        storeys.append((f_0, c_0))
    else:
        storeys.append((h_min + 0.1, h_max - 0.1))

    print(f"Segmented point cloud into {len(storeys)} storey(s):")
    for k, (f_k, c_k) in enumerate(storeys):
        print(f"  Storey {k}: Floor = {f_k:.2f} m, Ceiling = {c_k:.2f} m (Height H_{k} = {c_k - f_k:.2f} m)")

    # ── Per-Storey Structural Classification ─────────────────────────────────
    keep_mask = np.zeros(N_sampled, dtype=bool)
    x_coords = pts[:, 0]
    y_coords = pts[:, 1]

    grid_x = np.floor((x_coords - x_coords.min()) / grid_size).astype(np.int32)
    grid_y = np.floor((y_coords - y_coords.min()) / grid_size).astype(np.int32)
    grid_x_offset = grid_x - grid_x.min()
    grid_y_offset = grid_y - grid_y.min()
    cell_keys = (grid_x_offset.astype(np.int64) << 32) | grid_y_offset.astype(np.int64)

    total_floor_pts = 0
    total_ceiling_pts = 0
    total_wall_pts = 0

    # Neighbour radius (in grid cells) used for local floor/ceiling smoothing.
    # 3 cells at 10cm grid = 30cm radius neighbourhood.
    _NEIGH_R = 3

    for k, (f_k, c_k) in enumerate(storeys):
        h_k = max(1.0, c_k - f_k)
        # Widen the storey band to ±0.8m to tolerate large floor elevation
        # changes (stepped corridors, ramps, split-levels).
        storey_lo = f_k - 0.80
        storey_hi = c_k + 0.80
        in_storey = (heights >= storey_lo) & (heights <= storey_hi)
        if not np.any(in_storey):
            continue

        # Tight slab bands (±8 cm) to avoid including furniture tops / legs as floor.
        is_floor_k = in_storey & (np.abs(heights - f_k) <= plane_tolerance)
        is_ceiling_k = in_storey & (np.abs(heights - c_k) <= plane_tolerance)

        # 2D Column height span inside storey k
        storey_indices = np.where(in_storey)[0]
        storey_gx = grid_x_offset[storey_indices]
        storey_gy = grid_y_offset[storey_indices]
        storey_cell_keys = cell_keys[storey_indices]
        storey_heights = heights[storey_indices]

        unique_keys, inverse_idx = np.unique(storey_cell_keys, return_inverse=True)
        n_cells = len(unique_keys)
        cell_min_z = np.full(n_cells, np.inf, dtype=np.float32)
        cell_max_z = np.full(n_cells, -np.inf, dtype=np.float32)
        cell_count = np.zeros(n_cells, dtype=np.int32)

        np.minimum.at(cell_min_z, inverse_idx, storey_heights)
        np.maximum.at(cell_max_z, inverse_idx, storey_heights)
        np.add.at(cell_count, inverse_idx, 1)

        # ── Local floor / ceiling estimation per cell (Fix: elevation changes) ──
        # For each unique cell compute its grid position.
        # Use the first point in the storey that maps to each unique cell index.
        cell_gx = np.zeros(n_cells, dtype=np.int32)
        cell_gy = np.zeros(n_cells, dtype=np.int32)
        assigned = np.zeros(n_cells, dtype=bool)
        for si, ci in zip(range(len(storey_indices)), inverse_idx):
            if not assigned[ci]:
                cell_gx[ci] = storey_gx[si]
                cell_gy[ci] = storey_gy[si]
                assigned[ci] = True

        # Build a dict from (gx,gy) → cell index for fast neighbour lookup.
        _key_to_cidx: dict = {}
        for ci in range(n_cells):
            _key_to_cidx[(int(cell_gx[ci]), int(cell_gy[ci]))] = ci

        # Local floor = median of cell_min_z values in a (_NEIGH_R)-cell radius.
        # Local ceiling = median of cell_max_z values in the same neighbourhood.
        # This smooths over small steps while still following ramps/split-levels.
        local_floor = np.empty(n_cells, dtype=np.float32)
        local_ceil  = np.empty(n_cells, dtype=np.float32)

        for ci in range(n_cells):
            gxc, gyc = int(cell_gx[ci]), int(cell_gy[ci])
            neigh_mins = []
            neigh_maxs = []
            for dx in range(-_NEIGH_R, _NEIGH_R + 1):
                for dy in range(-_NEIGH_R, _NEIGH_R + 1):
                    nb = _key_to_cidx.get((gxc + dx, gyc + dy))
                    if nb is not None:
                        neigh_mins.append(cell_min_z[nb])
                        neigh_maxs.append(cell_max_z[nb])
            local_floor[ci] = np.percentile(neigh_mins, 10)  # robust low-end
            local_ceil[ci]  = np.percentile(neigh_maxs, 90)  # robust high-end

        local_h = np.maximum(local_ceil - local_floor, 0.5)  # avoid div/0

        # Wall span against local height context.
        cell_spans = cell_max_z - cell_min_z
        cell_ratios = cell_spans / local_h

        # A valid wall column must:
        #   - span >= span_min of its LOCAL storey height
        #   - not span wildly beyond the local storey (catches tall furniture/posts)
        #   - reach close to the LOCAL floor (within 40% of local height from bottom)
        #   - reach close to the LOCAL ceiling (within 40% of local height from top)
        cell_reach_bot = (cell_min_z <= (local_floor + 0.40 * local_h))
        cell_reach_top = (cell_max_z >= (local_ceil  - 0.40 * local_h))

        valid_wall_cells = (
            (cell_ratios >= span_min) &
            (cell_ratios <= (span_max + 0.20)) &
            cell_reach_bot &
            cell_reach_top
        )

        # ── Furniture veto (Fix: chairs/tables) ──────────────────────────────
        # A cell that does NOT qualify as a wall but is dense horizontally at
        # mid-height (0.3–1.4 m above local floor) is a horizontal surface object
        # (table top, chair seat, shelf). Mark those cells explicitly rejected.
        furniture_height_lo = local_floor + 0.25  # 25 cm above local floor
        furniture_height_hi = local_floor + 1.40  # 140 cm above local floor
        cell_mid_z = (cell_min_z + cell_max_z) * 0.5
        furniture_cells = (
            ~valid_wall_cells &
            (cell_spans < 0.50) &
            (cell_mid_z >= furniture_height_lo) &
            (cell_mid_z <= furniture_height_hi)
        )
        rejected_furniture_cells = furniture_cells
        n_furniture_cells = int(np.sum(rejected_furniture_cells))

        # ── Sloped-wall accommodation (Fix: rooms with sloped walls) ─────────
        # In a room with sloped/raked walls each cell only partially spans the
        # local height, but they form a consistent slope across neighbours.
        # Relax: also accept cells that span >= 0.35 of local height AND whose
        # neighbours collectively confirm wall presence (at least 2 neighbours
        # are already valid walls). This avoids completely wiping sloped rooms.
        tentative_slope_cells = (
            ~valid_wall_cells &
            ~rejected_furniture_cells &
            (cell_ratios >= 0.35) &
            cell_reach_bot  # must still start from the floor area
        )
        # Count valid-wall neighbours for each tentative-slope cell.
        if np.any(tentative_slope_cells):
            slope_confirmed = np.zeros(n_cells, dtype=bool)
            for ci in np.where(tentative_slope_cells)[0]:
                gxc, gyc = int(cell_gx[ci]), int(cell_gy[ci])
                wall_neighbour_count = 0
                for dx in range(-2, 3):
                    for dy in range(-2, 3):
                        if dx == 0 and dy == 0:
                            continue
                        nb = _key_to_cidx.get((gxc + dx, gyc + dy))
                        if nb is not None and valid_wall_cells[nb]:
                            wall_neighbour_count += 1
                if wall_neighbour_count >= 2:
                    slope_confirmed[ci] = True
            valid_wall_cells = valid_wall_cells | slope_confirmed
        else:
            slope_confirmed = np.zeros(n_cells, dtype=bool)

        is_wall_storey = valid_wall_cells[inverse_idx] & ~rejected_furniture_cells[inverse_idx]
        is_wall_k = np.zeros(N_sampled, dtype=bool)
        is_wall_k[storey_indices[is_wall_storey]] = True

        # Local-floor and local-ceiling point retention for elevation-change areas.
        # Replace global flat-slab floor/ceiling with a per-cell local band.
        local_floor_per_pt = local_floor[inverse_idx]
        local_ceil_per_pt  = local_ceil[inverse_idx]
        is_floor_local = in_storey.copy()
        is_floor_local[:] = False
        is_ceiling_local = in_storey.copy()
        is_ceiling_local[:] = False
        is_floor_local[storey_indices]   = (storey_heights <= (local_floor_per_pt + plane_tolerance))
        is_ceiling_local[storey_indices] = (storey_heights >= (local_ceil_per_pt  - plane_tolerance))

        # Combine: keep both the original global slab points AND the local-floor/ceiling points.
        storey_keep = is_floor_k | is_floor_local | is_ceiling_k | is_ceiling_local | is_wall_k
        keep_mask |= storey_keep

        n_fl  = int(np.sum(is_floor_k | is_floor_local))
        n_cl  = int(np.sum(is_ceiling_k | is_ceiling_local))
        n_wl  = int(np.sum(is_wall_k & ~(is_floor_k | is_floor_local) & ~(is_ceiling_k | is_ceiling_local)))
        n_sl  = int(np.sum(slope_confirmed))

        total_floor_pts   += n_fl
        total_ceiling_pts += n_cl
        total_wall_pts    += n_wl

        print(f"  Storey {k} cleaning breakdown:")
        print(f"    Floor points   : {n_fl:,}")
        print(f"    Ceiling points : {n_cl:,}")
        print(f"    Wall points    : {n_wl:,}")
        print(f"    Slope-wall cells rescued: {n_sl:,}")
        print(f"    Furniture cells vetoed: {n_furniture_cells:,} (chairs/tables)")

    cleaned_pts = pts[keep_mask]
    N_cleaned = len(cleaned_pts)
    removed_count = N_sampled - N_cleaned
    retention_pct = (N_cleaned / max(1, N_sampled)) * 100.0

    print(f"\nOverall Cleaning Summary:")
    print(f"  Total kept structural points : {N_cleaned:,} ({retention_pct:.1f}% of sampled)")
    print(f"  Total foreign objects removed: {removed_count:,} points ({100.0 - retention_pct:.1f}% removed)")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Saving cleaned point cloud to: {output_path}")

    if _HAS_PANDAS:
        df_out = pd.DataFrame(cleaned_pts, columns=["x", "y", "z"])
        df_out.to_csv(str(output_path), sep=" ", header=False, index=False, float_format="%.4f")
    else:
        with open(output_path, "w") as fh:
            for row in cleaned_pts:
                fh.write(f"{row[0]:.4f} {row[1]:.4f} {row[2]:.4f}\n")

    size_mb = output_path.stat().st_size / 1_048_576
    elapsed = time.time() - t0
    print(f"✓ Point cloud cleaning complete in {elapsed:.1f} s. Output file size: {size_mb:.1f} MB")

    stats = {
        "total_raw_points": total_raw_points,
        "sampled_points": N_sampled,
        "cleaned_points": N_cleaned,
        "removed_points": removed_count,
        "retention_pct": round(retention_pct, 2),
        "n_storeys": len(storeys),
        "storeys": [(round(f, 2), round(c, 2)) for f, c in storeys],
        "output_path": str(output_path),
        "elapsed_s": round(elapsed, 1),
    }

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-Storey Point Cloud Cleaner — removes foreign objects while preserving multi-floor walls")
    parser.add_argument("--xyz", metavar="PATH", default=None, help="Input .xyz point cloud path")
    parser.add_argument("--out", metavar="PATH", default=None, help="Output cleaned .xyz path")
    parser.add_argument("--downsample-pct", type=float, default=20.0, help="Downsample to X percent (default: 20.0)")
    parser.add_argument("--span-min", type=float, default=0.65, help="Min height span ratio per storey (default: 0.65)")
    parser.add_argument("--span-max", type=float, default=1.00, help="Max height span ratio per storey (default: 1.00)")
    parser.add_argument("--grid-size", type=float, default=0.10, help="2D column grid size in metres (default: 0.10)")

    args = parser.parse_args()

    input_xyz = resolve_xyz_path(args.xyz)
    if not input_xyz.exists():
        print(f"[ERROR] Input .xyz file not found: {input_xyz}")
        sys.exit(1)

    output_xyz = Path(args.out) if args.out else PROCESSED_DIR / "cloud_cleaned.xyz"

    clean_point_cloud(
        input_path=input_xyz,
        output_path=output_xyz,
        downsample_pct=args.downsample_pct,
        span_min=args.span_min,
        span_max=args.span_max,
        grid_size=args.grid_size,
    )


if __name__ == "__main__":
    main()
