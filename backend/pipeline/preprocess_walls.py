#!/usr/bin/env python3
"""
preprocess_walls.py  —  Full-density wall slice extractor

Problem solved here
-------------------
The existing pipeline samples cloud.xyz at 1:100 (1.14 M from 114 M points).
At that density the voxel grid used by wall_detection.py is too sparse: walls
appear as dotted lines and the Hough transform misses many of them.  The
parking area makes it even worse — cars at 0.3–1.5 m height produce hundreds
of spurious Hough lines.

What this script does
---------------------
1. Streams the raw cloud.xyz (≈ 4.4 GB) in 2 M-line pandas chunks.
2. Applies the exact same Matterport Z-up → Three.js Y-up coordinate
   transform that was used when building pointcloud.bin:
       x_yup = x_raw - cx
       y_yup = z_raw          (height stays as height)
       z_yup = -(y_raw - cy)
3. For every floor level extracted from info.json it filters points
   whose y_yup falls inside  [floor_y - 0.05,  floor_y + 2.65].
   The band is intentionally wider than the 0.3–2.2 m detection slice
   so that opening_detection.py can also use these files.
4. Applies 5 cm voxel down-sampling (matches wall_detection grid_size)
   via periodic numpy deduplication to keep RAM bounded.
5. Writes processed/wall_slice_floor_<N>.npy — a float32 (M, 3) array
   [x_yup, y_yup, z_yup] that wall_detection.py and opening_detection.py
   load instead of pointcloud.bin.

Expected run-time: 3–8 minutes depending on I/O speed.
Expected output size: 20–60 MB per floor (5 cm voxels, dense walls).

Usage
-----
    python pipeline/preprocess_walls.py

    # or from the project root
    python -m pipeline.preprocess_walls
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Force UTF-8 output on Windows (CP1252 console can't encode arrows/dashes)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd

# ── Path resolution works whether run as script or imported ─────────────────
_THIS_FILE = Path(__file__).resolve()
BASE_DIR = _THIS_FILE.parent.parent  # …/scan2floor/backend
PROCESSED_DIR = BASE_DIR / "processed"
DATA_DIR = BASE_DIR.parent.parent / "data" / "matterpak"
_DEFAULT_XYZ_PATH = DATA_DIR / "cloud.xyz"
INFO_PATH = PROCESSED_DIR / "info.json"

# ── Tuning constants ─────────────────────────────────────────────────────────
VOXEL = 0.05  # 5 cm — matches default grid_size in wall_detection.py
BAND_BELOW = 0.05  # metres below detected floor level to include
BAND_ABOVE = 2.65  # metres above floor level to include
CHUNK_LINES = 2_000_000  # pandas chunk size — trades RAM for parse speed
DEDUP_EVERY = 8  # run np.unique dedup after every N chunks per floor


# ── Helpers ──────────────────────────────────────────────────────────────────


def _dedup_voxels(arrays_x: list, arrays_y: list, arrays_z: list):
    """
    Concatenate accumulated int32 voxel-index arrays and return only unique
    rows as three 1-D int32 arrays.  Much cheaper than a Python set.
    """
    if not arrays_x:
        return np.empty(0, np.int32), np.empty(0, np.int32), np.empty(0, np.int32)

    vx = np.concatenate(arrays_x)
    vy = np.concatenate(arrays_y)
    vz = np.concatenate(arrays_z)

    combined = np.column_stack([vx, vy, vz])  # (N, 3) int32
    unique = np.unique(combined, axis=0)  # sort + deduplicate rows
    return unique[:, 0], unique[:, 1], unique[:, 2]


def _voxels_to_pts(vx: np.ndarray, vy: np.ndarray, vz: np.ndarray) -> np.ndarray:
    """Convert int32 voxel indices back to float32 metric coordinates (voxel centre)."""
    pts = np.empty((len(vx), 3), dtype=np.float32)
    pts[:, 0] = (vx.astype(np.float32) + 0.5) * VOXEL
    pts[:, 1] = (vy.astype(np.float32) + 0.5) * VOXEL
    pts[:, 2] = (vz.astype(np.float32) + 0.5) * VOXEL
    return pts


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    # ── CLI arguments ─────────────────────────────────────────────────────────
    parser = argparse.ArgumentParser(description="Full-density wall slice extractor")
    parser.add_argument(
        "--xyz",
        metavar="PATH",
        default=None,
        help="Path to the .xyz point cloud file (overrides default location)",
    )
    args = parser.parse_args()

    XYZ_PATH = Path(args.xyz) if args.xyz else _DEFAULT_XYZ_PATH

    t0 = time.time()

    # ── Validate inputs ───────────────────────────────────────────────────────
    if not XYZ_PATH.exists():
        print(f"[ERROR] cloud.xyz not found at:\n        {XYZ_PATH}")
        sys.exit(1)

    if not INFO_PATH.exists():
        print(f"[ERROR] info.json not found at:\n        {INFO_PATH}")
        print("        Run preprocess_o3d.py first to detect floor levels.")
        sys.exit(1)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    # ── Load metadata ─────────────────────────────────────────────────────────
    with open(INFO_PATH) as fh:
        info = json.load(fh)

    cx = float(info["centroid_xy"][0])
    cy = float(info["centroid_xy"][1])
    floor_levels = info.get("floor_levels", [])

    if not floor_levels:
        print(
            "[ERROR] info.json contains no floor_levels. Run preprocess_o3d.py first."
        )
        sys.exit(1)

    n_floors = len(floor_levels)
    print(f"\n{'=' * 60}")
    print("  preprocess_walls.py -- full-density wall slice extractor")
    print(f"{'=' * 60}")
    print(f"  cloud.xyz   : {XYZ_PATH}")
    print(f"  centroid    : cx={cx:.4f}  cy={cy:.4f}  (raw X/Y in cloud.xyz)")
    print(f"  voxel size  : {VOXEL * 100:.0f} cm")
    print(f"  floors      : {n_floors}")
    print()

    # ── Compute height bands per floor (in Y_yup = Z_raw space) ──────────────
    #    Y_yup = z_raw, so floor_level IS the z_raw value.
    bands: list[tuple[float, float]] = []
    for fi, fl in enumerate(floor_levels):
        y_lo = fl - BAND_BELOW
        y_hi = fl + BAND_ABOVE
        bands.append((y_lo, y_hi))
        print(
            f"  floor {fi}: level={fl:+.3f} m  ->  band [{y_lo:+.3f}, {y_hi:+.3f}] m  "
            f"(span {y_hi - y_lo:.2f} m)"
        )

    print()

    # ── Per-floor accumulator lists ───────────────────────────────────────────
    # We store int32 voxel indices (not float coords) to save memory.
    acc_vx: list[list[np.ndarray]] = [[] for _ in range(n_floors)]
    acc_vy: list[list[np.ndarray]] = [[] for _ in range(n_floors)]
    acc_vz: list[list[np.ndarray]] = [[] for _ in range(n_floors)]

    # ── Stream cloud.xyz ──────────────────────────────────────────────────────
    file_size_mb = XYZ_PATH.stat().st_size / 1_048_576
    print(f"Streaming {XYZ_PATH.name}  ({file_size_mb:,.0f} MB)  ...\n")

    total_pts = 0
    chunk_idx = 0
    last_print = time.time()

    # pandas c-engine is fastest; only read the 3 coordinate columns
    # The cloud.xyz file uses single spaces as separator, but we use the
    # python engine with r'\s+' for robustness against any irregular spacing.
    # For maximum speed on a known-clean file you could switch to
    # engine='c' with sep=' ', but the python engine is reliable here and
    # disk I/O will be the bottleneck regardless for a 4.4 GB file.
    reader = pd.read_csv(
        str(XYZ_PATH),
        header=None,
        sep=r"\s+",
        usecols=[0, 1, 2],
        names=["xr", "yr", "zr"],
        chunksize=CHUNK_LINES,
        dtype=np.float32,
        engine="python",
        on_bad_lines="skip",
    )

    for chunk in reader:
        chunk_idx += 1
        x_raw = chunk["xr"].values  # Matterport X
        y_raw = chunk["yr"].values  # Matterport Y  (horizontal, NOT height)
        z_raw = chunk["zr"].values  # Matterport Z  (height)

        # ── Coordinate transform: Matterport Z-up → Three.js Y-up ─────────────
        # This EXACTLY matches the transform used when building pointcloud.bin:
        #   pos_yup = (x_raw - cx,  z_raw,  -(y_raw - cy))
        x_yup = x_raw - cx
        y_yup = z_raw  # height becomes the Y axis
        z_yup = -(y_raw - cy)

        # ── Voxel indices (int32, no offset needed — numpy handles negatives) ─
        vx = np.floor(x_yup / VOXEL).astype(np.int32)
        vy = np.floor(y_yup / VOXEL).astype(np.int32)
        vz = np.floor(z_yup / VOXEL).astype(np.int32)

        # ── Per-floor filter and accumulation ─────────────────────────────────
        for fi, (y_lo, y_hi) in enumerate(bands):
            mask = (y_yup >= y_lo) & (y_yup < y_hi)
            n_in = int(mask.sum())
            if n_in == 0:
                continue
            acc_vx[fi].append(vx[mask].copy())
            acc_vy[fi].append(vy[mask].copy())
            acc_vz[fi].append(vz[mask].copy())

        total_pts += len(x_raw)

        # ── Periodic deduplication — keeps per-floor RAM bounded ──────────────
        if chunk_idx % DEDUP_EVERY == 0:
            for fi in range(n_floors):
                if len(acc_vx[fi]) > 1:
                    ux, uy, uz = _dedup_voxels(acc_vx[fi], acc_vy[fi], acc_vz[fi])
                    acc_vx[fi] = [ux]
                    acc_vy[fi] = [uy]
                    acc_vz[fi] = [uz]

        # ── Progress report ───────────────────────────────────────────────────
        now = time.time()
        if now - last_print >= 10.0:
            elapsed = now - t0
            pts_per_s = total_pts / elapsed if elapsed > 0 else 0
            pct = min(100.0, 100.0 * total_pts / 114_036_775)
            print(
                f"  {total_pts:>13,} pts  ({pct:5.1f}%)  "
                f"{pts_per_s / 1e6:.2f} M pts/s  "
                f"chunk {chunk_idx}"
            )
            last_print = now

    elapsed_stream = time.time() - t0
    print(f"\nStreaming done: {total_pts:,} points in {elapsed_stream:.1f} s\n")
    print("Final dedup + save...")

    # ── Final dedup + save ────────────────────────────────────────────────────
    # Also update info.json with per-floor point counts so the API can report them.
    slice_info: dict[str, int] = {}

    for fi in range(n_floors):
        print(f"Floor {fi}: final deduplication...", end="", flush=True)
        ux, uy, uz = _dedup_voxels(acc_vx[fi], acc_vy[fi], acc_vz[fi])
        acc_vx[fi] = acc_vy[fi] = acc_vz[fi] = []  # free memory

        if len(ux) == 0:
            print(f"  [WARN] no points found for floor {fi}!")
            continue

        pts = _voxels_to_pts(ux, uy, uz)  # (M, 3) float32

        out_path = PROCESSED_DIR / f"wall_slice_floor_{fi}.npy"
        np.save(str(out_path), pts)
        n_pts = len(pts)
        slice_info[f"wall_slice_floor_{fi}"] = n_pts
        print(f"  {n_pts:>8,} unique voxels  ->  {out_path.name}")

    # ── Persist slice metadata to info.json ───────────────────────────────────
    with open(INFO_PATH) as fh:
        info = json.load(fh)
    info["wall_slices"] = slice_info
    info["wall_slice_voxel_m"] = VOXEL
    with open(INFO_PATH, "w") as fh:
        json.dump(info, fh, indent=2)
    print(f"\nUpdated {INFO_PATH.name} with wall_slices metadata.")

    total_elapsed = time.time() - t0
    print(f"\nAll done in {total_elapsed:.1f} s  ({total_elapsed / 60:.1f} min).")
    print("Wall slices are ready -- run wall detection to regenerate floor plans.\n")


if __name__ == "__main__":
    main()
