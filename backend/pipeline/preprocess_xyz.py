#!/usr/bin/env python3
"""
preprocess_xyz.py  —  First-stage point cloud preprocessor
===========================================================
Reads a Matterport .xyz file and produces:
  - processed/pointcloud.bin   (downsampled, Y-up, binary for the viewer)
  - processed/info.json        (centroid, bounds, floor_levels)

This is the MISSING step that must run before preprocess_o3d.py or
preprocess_walls.py.

Usage (from scan2floor/backend/):
    python pipeline/preprocess_xyz.py
    python pipeline/preprocess_xyz.py --xyz "C:/path/to/cloud.xyz"
    python pipeline/preprocess_xyz.py --xyz "C:/path/to/cloud.xyz" --sample 200

Options:
    --xyz PATH      Path to the .xyz file (default: reads xyz_path.json or
                    ../../data/matterpak/cloud.xyz)
    --sample N      Keep 1-in-N points for the viewer's pointcloud.bin.
                    Lower = denser but larger file. Default: 100
"""

import argparse
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np

# Force UTF-8 on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Path resolution ──────────────────────────────────────────────────────────
_THIS_FILE   = Path(__file__).resolve()
BASE_DIR     = _THIS_FILE.parent.parent          # …/scan2floor/backend
PROCESSED_DIR = BASE_DIR / "processed"
_XYZ_CONFIG  = PROCESSED_DIR / "xyz_path.json"
_DEFAULT_XYZ = BASE_DIR.parent.parent / "data" / "matterpak" / "cloud.xyz"


def _resolve_xyz(cli_path: str | None) -> Path:
    if cli_path:
        return Path(cli_path)
    if _XYZ_CONFIG.exists():
        try:
            data = json.loads(_XYZ_CONFIG.read_text())
            candidate = Path(data.get("xyz_path", ""))
            if candidate.suffix.lower() == ".xyz":
                return candidate
        except Exception:
            pass
    return _DEFAULT_XYZ


# ── pointcloud.bin writer ────────────────────────────────────────────────────

def _write_pointcloud_bin(positions: np.ndarray, out_path: Path) -> None:
    """
    Binary layout expected by the Three.js viewer and preprocess_o3d.py:
      uint32  N          (little-endian)
      float32 N×3        XYZ positions
      uint8   N×3        RGB colors  (set to 128,128,128 if not available)
    """
    N = len(positions)
    pos_f32 = positions.astype(np.float32)

    # We have no color in the raw .xyz; use neutral grey so the viewer works
    colors_u8 = np.full((N, 3), 128, dtype=np.uint8)

    with open(out_path, "wb") as fh:
        fh.write(struct.pack("<I", N))
        fh.write(pos_f32.tobytes())
        fh.write(colors_u8.tobytes())

    size_mb = out_path.stat().st_size / 1_048_576
    print(f"  Wrote {out_path.name}  ({N:,} points,  {size_mb:.1f} MB)")


# ── Floor detection (peak finding without scipy) ─────────────────────────────

def _detect_floors(y_coords: np.ndarray, output_dir: Path, bin_size: float = 0.05) -> list[float]:
    """
    Find floor levels as peaks in the Y (height) histogram.
    Falls back to a simple sorted-peak approach if scipy is unavailable.
    Returns a list of Y values (one per floor, ascending).
    """
    y_min, y_max = float(y_coords.min()), float(y_coords.max())
    print(f"  Height range (Y-up): {y_min:.2f} to {y_max:.2f} m")

    bins = np.arange(y_min, y_max + bin_size, bin_size)
    hist, bin_edges = np.histogram(y_coords, bins=bins)

    # Save histogram PNG (optional, non-fatal if matplotlib unavailable)
    try:
        import matplotlib.pyplot as plt
        plt.figure(figsize=(10, 4))
        plt.plot(bin_edges[:-1], hist)
        plt.title("Y-height histogram (floor detection)")
        plt.xlabel("Height (m)")
        plt.ylabel("Point count")
        plt.grid(True)
        hist_path = output_dir / "histogram.png"
        plt.savefig(str(hist_path))
        plt.close()
        print(f"  Saved histogram → {hist_path.name}")
    except Exception:
        pass

    # ── Peak finding ─────────────────────────────────────────────────────────
    try:
        from scipy.signal import find_peaks
        min_dist_bins = int(2.0 / bin_size)
        peaks, _ = find_peaks(
            hist,
            distance=min_dist_bins,
            prominence=max(hist) * 0.05,
        )
        floor_y = [float(bin_edges[p]) for p in sorted(peaks)]
    except ImportError:
        # Manual peak detection: any bin whose value is larger than both
        # neighbors and is > 10 % of maximum, separated by 2 m.
        min_sep = int(2.0 / bin_size)
        threshold = max(hist) * 0.10
        floor_y = []
        last_peak_idx = -min_sep
        for i in range(1, len(hist) - 1):
            if (
                hist[i] > threshold
                and hist[i] >= hist[i - 1]
                and hist[i] >= hist[i + 1]
                and (i - last_peak_idx) >= min_sep
            ):
                floor_y.append(float(bin_edges[i]))
                last_peak_idx = i

    print(f"  Detected {len(floor_y)} floor level(s): {[f'{v:.2f}' for v in floor_y]}")
    return floor_y


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="First-stage XYZ preprocessor — creates pointcloud.bin + info.json"
    )
    parser.add_argument(
        "--xyz", metavar="PATH", default=None,
        help="Path to the .xyz point cloud file",
    )
    parser.add_argument(
        "--sample", metavar="N", type=int, default=100,
        help="Keep 1-in-N points for viewer (default: 100, lower = denser)",
    )
    args = parser.parse_args()

    xyz_path = _resolve_xyz(args.cli_xyz if hasattr(args, "cli_xyz") else args.xyz)
    sample_rate = max(1, args.sample)

    print()
    print("=" * 60)
    print("  preprocess_xyz.py — first-stage XYZ preprocessor")
    print("=" * 60)
    print(f"  Input  : {xyz_path}")
    print(f"  Output : {PROCESSED_DIR}")
    print(f"  Sample : 1 in {sample_rate} points for viewer")
    print()

    if not xyz_path.exists():
        print(f"[ERROR] .xyz file not found: {xyz_path}")
        print("        Set the correct path via the UI or xyz_path.json")
        sys.exit(1)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    t0 = time.time()

    # ── Pass 1: compute centroid from ALL points ───────────────────────────────
    print("Pass 1/2: computing centroid (streams entire file)...")
    try:
        import pandas as pd
        _HAS_PANDAS = True
    except ImportError:
        _HAS_PANDAS = False

    CHUNK = 2_000_000
    sum_x = sum_y_raw = 0.0
    total_pts = 0

    if _HAS_PANDAS:
        import pandas as pd
        reader = pd.read_csv(
            str(xyz_path), header=None, sep=r"\s+",
            usecols=[0, 1, 2], names=["xr", "yr", "zr"],
            chunksize=CHUNK, dtype=np.float64,
            engine="python", on_bad_lines="skip",
        )
        for chunk in reader:
            sum_x     += float(chunk["xr"].sum())
            sum_y_raw += float(chunk["yr"].sum())
            total_pts += len(chunk)
            if total_pts % (CHUNK * 10) == 0:
                print(f"  … {total_pts:,} pts")
    else:
        # Pure-numpy fallback
        with open(xyz_path, "r", errors="replace") as fh:
            for line in fh:
                try:
                    vals = line.split()
                    sum_x     += float(vals[0])
                    sum_y_raw += float(vals[1])
                    total_pts += 1
                except Exception:
                    continue

    cx = sum_x / total_pts      # raw Matterport X centroid
    cy = sum_y_raw / total_pts  # raw Matterport Y centroid (horizontal)

    print(f"  Total points in file: {total_pts:,}")
    print(f"  Centroid: cx={cx:.4f}  cy={cy:.4f}")
    print()

    # ── Pass 2: stream points, transform, sample, collect ─────────────────────
    print(f"Pass 2/2: transforming + downsampling (1-in-{sample_rate})...")

    all_positions = []   # list of (M,3) float32 arrays
    all_heights   = []   # list of (M,) float32 — Y-up heights (for floor detect)

    row_idx = 0

    if _HAS_PANDAS:
        reader2 = pd.read_csv(
            str(xyz_path), header=None, sep=r"\s+",
            usecols=[0, 1, 2], names=["xr", "yr", "zr"],
            chunksize=CHUNK, dtype=np.float32,
            engine="python", on_bad_lines="skip",
        )
        for chunk in reader2:
            x_raw = chunk["xr"].values
            y_raw = chunk["yr"].values
            z_raw = chunk["zr"].values

            # Matterport Z-up → Three.js Y-up
            x_yup = x_raw - cx
            y_yup = z_raw            # height
            z_yup = -(y_raw - cy)

            # Sample
            n = len(x_raw)
            indices = np.arange(row_idx % sample_rate, n, sample_rate)
            row_idx += n

            if len(indices) == 0:
                continue

            pts = np.column_stack([
                x_yup[indices], y_yup[indices], z_yup[indices]
            ]).astype(np.float32)
            all_positions.append(pts)
            all_heights.append(y_yup)   # keep ALL y for floor detection

            if (row_idx // CHUNK) % 10 == 0:
                print(f"  … {row_idx:,} pts read  ({len(pts):,} kept this chunk)")
    else:
        with open(xyz_path, "r", errors="replace") as fh:
            buf_pos = []
            buf_h   = []
            for line in fh:
                try:
                    vals = line.split()
                    xr, yr, zr = float(vals[0]), float(vals[1]), float(vals[2])
                except Exception:
                    continue
                x_yup = xr - cx
                y_yup = zr
                z_yup = -(yr - cy)
                buf_h.append(y_yup)
                if row_idx % sample_rate == 0:
                    buf_pos.append([x_yup, y_yup, z_yup])
                row_idx += 1
                if len(buf_h) >= CHUNK:
                    all_heights.append(np.array(buf_h, dtype=np.float32))
                    buf_h = []
                    if buf_pos:
                        all_positions.append(np.array(buf_pos, dtype=np.float32))
                        buf_pos = []
            if buf_h:
                all_heights.append(np.array(buf_h, dtype=np.float32))
            if buf_pos:
                all_positions.append(np.array(buf_pos, dtype=np.float32))

    positions = np.concatenate(all_positions, axis=0)  # (N_sampled, 3)
    y_all     = np.concatenate(all_heights,   axis=0)  # (N_total,) for peaks

    elapsed = time.time() - t0
    print(f"  Done streaming in {elapsed:.1f} s")
    print(f"  Sampled {len(positions):,} points for viewer")
    print()

    # ── Detect floors ─────────────────────────────────────────────────────────
    print("Detecting floor levels...")
    floor_levels = _detect_floors(y_all, PROCESSED_DIR)
    del y_all  # free memory

    # ── Write pointcloud.bin ──────────────────────────────────────────────────
    bin_path = PROCESSED_DIR / "pointcloud.bin"
    print(f"\nWriting {bin_path.name}...")
    _write_pointcloud_bin(positions, bin_path)

    # ── Write info.json ───────────────────────────────────────────────────────
    info_path = PROCESSED_DIR / "info.json"
    bounds = {
        "x_min": float(positions[:, 0].min()),
        "x_max": float(positions[:, 0].max()),
        "y_min": float(positions[:, 1].min()),
        "y_max": float(positions[:, 1].max()),
        "z_min": float(positions[:, 2].min()),
        "z_max": float(positions[:, 2].max()),
    }
    info = {
        "centroid_xy": [float(cx), float(cy)],
        "bounds":      bounds,
        "floor_levels": floor_levels,
        "total_points": total_pts,
        "sampled_points": len(positions),
        "sample_rate": sample_rate,
        "source_xyz": str(xyz_path),
    }
    info_path.write_text(json.dumps(info, indent=2))
    print(f"  Wrote {info_path.name}")

    total_elapsed = time.time() - t0
    print()
    print(f"Done in {total_elapsed:.1f} s  ({total_elapsed / 60:.1f} min)")
    print()
    print("Next steps:")
    print("  1. (Optional) run preprocess_o3d.py to refine floor levels")
    print("  2. Run preprocess_walls.py (or click 'Preprocess Walls' in the UI)")
    print("  3. Run wall detection for each floor")
    print()


if __name__ == "__main__":
    main()
