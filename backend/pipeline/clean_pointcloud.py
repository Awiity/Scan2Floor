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
    plane_tolerance: float = 0.15,
) -> dict:
    """
    Cleans point cloud according to per-storey height span criteria:
      1. Downsamples point cloud to target percentage downsample_pct (1.0 to 100.0).
      2. Detects all floor/ceiling slab peak levels (densest horizontal peaks in height distribution).
      3. Segments point cloud into storeys [P_k, P_{k+1}] with storey height H_k.
      4. Identifies wall points per storey in 2D columns (X, Y) spanning >= span_min of storey height H_k.
      5. Retains floor, ceiling, and valid wall points for all storeys; discards foreign objects.

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

    # Detect all floor & ceiling slab peaks from height histogram
    bin_size = 0.05  # 5cm bins
    bins = np.arange(h_min, h_max + bin_size, bin_size)
    hist, bin_edges = np.histogram(heights, bins=bins)

    try:
        from scipy.signal import find_peaks
        min_dist_bins = int(1.8 / bin_size)
        peaks, _ = find_peaks(hist, distance=min_dist_bins, prominence=max(hist) * 0.05)
        peak_heights = sorted([float(bin_edges[p]) for p in peaks])
    except ImportError:
        min_sep = int(1.8 / bin_size)
        threshold = max(hist) * 0.05
        peak_heights = []
        last_p = -min_sep
        for i in range(1, len(hist) - 1):
            if hist[i] > threshold and hist[i] >= hist[i - 1] and hist[i] >= hist[i + 1] and (i - last_p) >= min_sep:
                peak_heights.append(float(bin_edges[i]))
                last_p = i
        peak_heights.sort()

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

    for k, (f_k, c_k) in enumerate(storeys):
        h_k = max(1.0, c_k - f_k)
        in_storey = (heights >= (f_k - 0.30)) & (heights <= (c_k + 0.30))
        if not np.any(in_storey):
            continue

        is_floor_k = in_storey & (np.abs(heights - f_k) <= plane_tolerance)
        is_ceiling_k = in_storey & (np.abs(heights - c_k) <= plane_tolerance)

        # 2D Column height span inside storey k
        storey_indices = np.where(in_storey)[0]
        storey_cell_keys = cell_keys[storey_indices]
        storey_heights = heights[storey_indices]

        unique_keys, inverse_idx = np.unique(storey_cell_keys, return_inverse=True)
        cell_min_z = np.full(len(unique_keys), np.inf, dtype=np.float32)
        cell_max_z = np.full(len(unique_keys), -np.inf, dtype=np.float32)

        np.minimum.at(cell_min_z, inverse_idx, storey_heights)
        np.maximum.at(cell_max_z, inverse_idx, storey_heights)

        cell_spans = cell_max_z - cell_min_z
        cell_ratios = cell_spans / h_k

        cell_reach_bot = (cell_min_z <= (f_k + 0.35 * h_k))
        cell_reach_top = (cell_max_z >= (f_k + span_min * h_k))

        valid_wall_cells = (
            (cell_ratios >= span_min) &
            (cell_ratios <= (span_max + 0.15)) &
            cell_reach_bot &
            cell_reach_top
        )

        is_wall_storey = valid_wall_cells[inverse_idx]
        is_wall_k = np.zeros(N_sampled, dtype=bool)
        is_wall_k[storey_indices[is_wall_storey]] = True

        storey_keep = is_floor_k | is_ceiling_k | is_wall_k
        keep_mask |= storey_keep

        n_fl = int(np.sum(is_floor_k))
        n_cl = int(np.sum(is_ceiling_k))
        n_wl = int(np.sum(is_wall_k & ~is_floor_k & ~is_ceiling_k))

        total_floor_pts += n_fl
        total_ceiling_pts += n_cl
        total_wall_pts += n_wl

        print(f"  Storey {k} cleaning breakdown:")
        print(f"    Floor points   : {n_fl:,}")
        print(f"    Ceiling points : {n_cl:,}")
        print(f"    Wall points    : {n_wl:,}")

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
