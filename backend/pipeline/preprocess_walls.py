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
import os
import sys
import time
from pathlib import Path

# Force UTF-8 output on Windows (CP1252 console can't encode arrows/dashes)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd

# ── Optional GPU acceleration via CuPy ───────────────────────────────────────
# CuPy mirrors the NumPy API and uses GPU radix sort for cp.unique —
# 10–30× faster than NumPy's merge sort on the 1–5 M row voxel arrays.
# Falls back to CPU NumPy silently if CuPy is not installed.
try:
    import cupy as cp
    _GPU = True
    print("[gpu] CuPy detected — voxel deduplication will run on GPU", flush=True)
except ImportError:
    _GPU = False

# ── Path resolution works whether run as script or imported ─────────────────
_THIS_FILE = Path(__file__).resolve()
BASE_DIR = _THIS_FILE.parent.parent  # …/scan2floor/backend
# Read from env var so Docker volume mount at /processed is respected.
PROCESSED_DIR = Path(os.environ.get("PROCESSED_DIR", str(BASE_DIR / "processed")))
DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR.parent.parent / "data" / "matterpak")))
_DEFAULT_XYZ_PATH = DATA_DIR / "cloud.xyz"
INFO_PATH = PROCESSED_DIR / "info.json"

# ── Tuning constants ─────────────────────────────────────────────────────────
VOXEL = 0.05  # 5 cm — matches default grid_size in wall_detection.py
BAND_BELOW = 0.50  # metres below detected floor level to include (was 0.05)
BAND_ABOVE = 3.20  # metres above floor level to include  (was 2.65)
CHUNK_LINES = 2_000_000  # pandas chunk size — trades RAM for parse speed
DEDUP_EVERY = 4  # run dedup after every N chunks (lower = less VRAM pressure)

# Floor heightmap constants
HEIGHTMAP_CELL = 0.50  # 50 cm cells for the local floor elevation map
HEIGHTMAP_FLOOR_PCT = 10  # percentile of Y values used as local floor elevation

# Bit-packing constants for 1D int64 voxel encoding
# 21 bits per axis covers ±2^20 ≈ ±1 M voxels = ±52 km at 5 cm — well beyond any building.
_VOXEL_OFFSET = 1 << 20
_VOXEL_MASK   = (1 << 21) - 1


# ── Helpers ──────────────────────────────────────────────────────────────────


def _encode_keys(vx: np.ndarray, vy: np.ndarray, vz: np.ndarray) -> np.ndarray:
    """
    Pack three int32 voxel indices into one int64 key (21 bits each).
    Layout: [vx:21][vy:21][vz:21] — total 63 bits, safe in signed int64.
    """
    return (
        (vx.astype(np.int64) + _VOXEL_OFFSET) << 42 |
        (vy.astype(np.int64) + _VOXEL_OFFSET) << 21 |
        (vz.astype(np.int64) + _VOXEL_OFFSET)
    )


def _decode_keys(keys: np.ndarray):
    """Unpack int64 keys back to three int32 arrays."""
    vz = ((keys      ) & _VOXEL_MASK) - _VOXEL_OFFSET
    vy = ((keys >> 21) & _VOXEL_MASK) - _VOXEL_OFFSET
    vx = ((keys >> 42) & _VOXEL_MASK) - _VOXEL_OFFSET
    return vx.astype(np.int32), vy.astype(np.int32), vz.astype(np.int32)


def _dedup_voxels(arrays_x: list, arrays_y: list, arrays_z: list):
    """
    Deduplicate voxel triples using a 1-D int64 encoding.

    WHY 1-D:
    cp.unique(array, axis=0) has no native GPU kernel for 2-D row-unique.
    Internally CuPy converts the (N,3) array to a structured void dtype and
    runs a lexicographic sort — allocating 2-3× the array size as workspace
    on VRAM and running far slower than advertised.  Encoding three int32
    indices into one int64 key lets cp.unique use its true radix-sort path:
    O(N) in practice, 3× less VRAM, and 5-10× faster on large arrays.
    """
    if not arrays_x:
        return np.empty(0, np.int32), np.empty(0, np.int32), np.empty(0, np.int32)

    vx = np.concatenate(arrays_x)
    vy = np.concatenate(arrays_y)
    vz = np.concatenate(arrays_z)

    keys = _encode_keys(vx, vy, vz)   # (N,) int64 — one value per voxel

    if _GPU:
        try:
            gkeys        = cp.asarray(keys)
            unique_keys  = cp.asnumpy(cp.unique(gkeys))   # true 1-D radix sort
            del gkeys                                      # free VRAM immediately
            cp.get_default_memory_pool().free_all_blocks()
        except Exception:
            unique_keys = np.unique(keys)   # CPU fallback on any GPU error
    else:
        unique_keys = np.unique(keys)

    return _decode_keys(unique_keys)


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

    # Use the C engine (sep=" ") — it is 20-50× faster than
    # engine="python" with sep=r"\s+" on large files (114 M pts).
    # Matterport XYZ files are reliably single-space delimited.
    reader = pd.read_csv(
        str(XYZ_PATH),
        header=None,
        sep=" ",
        usecols=[0, 1, 2],
        names=["xr", "yr", "zr"],
        chunksize=CHUNK_LINES,
        dtype=np.float32,
        engine="c",
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

        # ── Build local floor heightmap ───────────────────────────────────────
        # For each 50cm×50cm XZ cell, compute the 10th-percentile Y value.
        # This gives the local floor elevation, robust to furniture/noise.
        print(f"Floor {fi}: computing local floor heightmap...", end="", flush=True)
        floor_y = floor_levels[fi]

        x_vals = pts[:, 0]
        z_vals = pts[:, 2]
        y_vals = pts[:, 1]

        # Only use points near the actual floor surface for heightmap
        # (within 40cm above the global floor level)
        floor_mask = (y_vals >= floor_y - BAND_BELOW) & (y_vals <= floor_y + 0.40)
        if floor_mask.sum() < 50:
            # Fallback: use bottom 20% of all points in the slice
            y_sorted = np.sort(y_vals)
            y_cutoff = y_sorted[int(len(y_sorted) * 0.20)]
            floor_mask = y_vals <= y_cutoff

        fx = x_vals[floor_mask]
        fz = z_vals[floor_mask]
        fy = y_vals[floor_mask]

        hm_x_min, hm_x_max = float(x_vals.min()), float(x_vals.max())
        hm_z_min, hm_z_max = float(z_vals.min()), float(z_vals.max())
        hm_cols = max(1, int(np.ceil((hm_x_max - hm_x_min) / HEIGHTMAP_CELL)))
        hm_rows = max(1, int(np.ceil((hm_z_max - hm_z_min) / HEIGHTMAP_CELL)))

        # Assign each floor-region point to a cell
        cx_idx = np.clip(
            np.floor((fx - hm_x_min) / HEIGHTMAP_CELL).astype(np.int32),
            0, hm_cols - 1,
        )
        cz_idx = np.clip(
            np.floor((fz - hm_z_min) / HEIGHTMAP_CELL).astype(np.int32),
            0, hm_rows - 1,
        )
        cell_id = cz_idx.astype(np.int64) * hm_cols + cx_idx.astype(np.int64)

        # Compute percentile-based floor elevation per cell
        heightmap = np.full(hm_rows * hm_cols, np.nan, dtype=np.float32)
        for cid in np.unique(cell_id):
            cell_mask = cell_id == cid
            cell_y = fy[cell_mask]
            if len(cell_y) >= 3:
                heightmap[cid] = np.percentile(cell_y, HEIGHTMAP_FLOOR_PCT)
            elif len(cell_y) > 0:
                heightmap[cid] = float(cell_y.min())

        heightmap_2d = heightmap.reshape(hm_rows, hm_cols)

        # Fill NaN cells by nearest-neighbour interpolation from valid cells
        valid = ~np.isnan(heightmap_2d)
        if valid.any() and not valid.all():
            from scipy.ndimage import distance_transform_edt
            # distance_transform_edt with return_indices gives nearest valid index
            _, nearest_idx = distance_transform_edt(~valid, return_indices=True)
            heightmap_2d = heightmap_2d[nearest_idx[0], nearest_idx[1]]
        elif not valid.any():
            # No valid cells at all — fall back to global floor_y
            heightmap_2d[:] = floor_y

        # Light Gaussian smooth to handle scan noise (sigma = 1 cell = 50cm)
        try:
            from scipy.ndimage import gaussian_filter
            heightmap_2d = gaussian_filter(heightmap_2d, sigma=1.0)
        except ImportError:
            pass  # Skip smoothing if scipy unavailable

        # Save heightmap
        hm_path = PROCESSED_DIR / f"floor_heightmap_{fi}.npy"
        np.save(str(hm_path), heightmap_2d)

        hm_meta = {
            "x_min": round(hm_x_min, 4),
            "z_min": round(hm_z_min, 4),
            "x_max": round(hm_x_max, 4),
            "z_max": round(hm_z_max, 4),
            "cell_size": HEIGHTMAP_CELL,
            "rows": hm_rows,
            "cols": hm_cols,
            "min_elev": round(float(np.nanmin(heightmap_2d)), 4),
            "max_elev": round(float(np.nanmax(heightmap_2d)), 4),
            "variation_m": round(
                float(np.nanmax(heightmap_2d) - np.nanmin(heightmap_2d)), 4
            ),
        }
        slice_info[f"floor_heightmap_{fi}"] = hm_meta
        print(
            f"  {hm_rows}×{hm_cols} cells  "
            f"elev=[{hm_meta['min_elev']:+.3f}, {hm_meta['max_elev']:+.3f}]  "
            f"Δ={hm_meta['variation_m']:.3f} m  ->  {hm_path.name}"
        )

    # ── Persist slice metadata to info.json ───────────────────────────────────
    with open(INFO_PATH) as fh:
        info = json.load(fh)
    info["wall_slices"] = slice_info
    info["wall_slice_voxel_m"] = VOXEL
    def _json_default(obj):
        if isinstance(obj, (np.floating, np.integer)):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    with open(INFO_PATH, "w") as fh:
        json.dump(info, fh, indent=2, default=_json_default)
    print(f"\nUpdated {INFO_PATH.name} with wall_slices + heightmap metadata.")

    total_elapsed = time.time() - t0
    print(f"\nAll done in {total_elapsed:.1f} s  ({total_elapsed / 60:.1f} min).")
    print("Wall slices are ready -- run wall detection to regenerate floor plans.\n")


if __name__ == "__main__":
    main()
