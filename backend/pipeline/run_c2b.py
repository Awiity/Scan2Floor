#!/usr/bin/env python3
"""
run_c2b.py  —  Cloud2BIM-compatible horizontal surface detector
================================================================
Reimplements Cloud2BIM's identify_slabs() algorithm to produce
horiz_surface_N.xyz files (tab-separated, //X Y Z header) in the
same format that floor_from_c2b.py consumes.

No Cloud2BIM source files or heavy dependencies (open3d/ifcopenshell)
are needed — only numpy, pandas, scipy which are already installed.

Usage (standalone):
    python pipeline/run_c2b.py --xyz /data/matterpak/cloud.xyz
    python pipeline/run_c2b.py --xyz /path/scan.xyz --out-dir /processed/c2b_output

API usage:
    from pipeline.run_c2b import detect_horizontal_surfaces
    surfaces = detect_horizontal_surfaces(xyz_path, out_dir)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# Force UTF-8 on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Path resolution ──────────────────────────────────────────────────────────
_THIS_FILE   = Path(__file__).resolve()
BASE_DIR     = _THIS_FILE.parent.parent
PROCESSED_DIR = Path(os.environ.get("PROCESSED_DIR", str(BASE_DIR / "processed")))
DEFAULT_OUT_DIR = PROCESSED_DIR / "c2b_output"

# ── Algorithm constants (matching Cloud2BIM defaults) ─────────────────────────
Z_STEP          = 0.15    # metres — histogram step for horiz surface search
DENSITY_FRAC    = 0.60    # fraction of max peak above which bands are candidates
MIN_SURFACE_PTS = 100     # minimum points to save a surface
MERGE_GAP       = 2 * Z_STEP   # merge candidate bands closer than this
CHUNK_LINES     = 2_000_000


def _log(msg: str) -> None:
    print(f"[c2b] {msg}", flush=True)


def detect_horizontal_surfaces(
    xyz_path: Path | str,
    out_dir:  Path | str | None = None,
) -> list[dict]:
    """
    Stream xyz_path, detect horizontal surface bands (floors/ceilings),
    save horiz_surface_N.xyz files compatible with floor_from_c2b.py.

    Returns a list of dicts: {file, n_points, median_z, z_lo, z_hi}.
    """
    xyz_path = Path(xyz_path)
    out_dir  = Path(out_dir) if out_dir else DEFAULT_OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    _log(f"Input : {xyz_path}  ({xyz_path.stat().st_size / 1e9:.2f} GB)")
    _log(f"Output: {out_dir}")

    # ── Pass 1a: get Z range ───────────────────────────────────────────────
    _log("Pass 1/2: building Z-axis histogram...")
    z_min_g =  float("inf")
    z_max_g = -float("inf")
    total_pts = 0

    for chunk in pd.read_csv(
        str(xyz_path), header=None, sep=" ",
        usecols=[2], names=["z"],
        chunksize=CHUNK_LINES, dtype=np.float32,
        engine="c", on_bad_lines="skip",
    ):
        z = chunk["z"].dropna().values
        if len(z) == 0:
            continue
        z_min_g = min(z_min_g, float(z.min()))
        z_max_g = max(z_max_g, float(z.max()))
        total_pts += len(z)

    if total_pts == 0:
        _log("ERROR: no valid points read from file")
        return []

    _log(f"Total pts: {total_pts:,}  Z range: [{z_min_g:.3f}, {z_max_g:.3f}] m")

    # ── Pass 1b: build histogram ───────────────────────────────────────────
    n_bins = max(1, int((z_max_g - z_min_g) / Z_STEP) + 2)
    z_edges = z_min_g + np.arange(n_bins + 1) * Z_STEP
    hist    = np.zeros(n_bins, dtype=np.int64)

    for chunk in pd.read_csv(
        str(xyz_path), header=None, sep=" ",
        usecols=[2], names=["z"],
        chunksize=CHUNK_LINES, dtype=np.float32,
        engine="c", on_bad_lines="skip",
    ):
        z = chunk["z"].dropna().values
        idx = np.clip(
            np.floor((z - z_min_g) / Z_STEP).astype(np.int32),
            0, n_bins - 1,
        )
        np.add.at(hist, idx, 1)

    # ── Find candidate surface bands ──────────────────────────────────────
    threshold = DENSITY_FRAC * hist.max()
    _log(f"Histogram peak: {hist.max():,}  threshold: {threshold:,.0f} ({DENSITY_FRAC*100:.0f}%)")

    above = hist > threshold
    raw_bands: list[list[float]] = []
    start = None
    for i, flag in enumerate(above):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            raw_bands.append([float(z_edges[start]), float(z_edges[i])])
            start = None
    if start is not None:
        raw_bands.append([float(z_edges[start]), float(z_edges[n_bins])])

    # Merge bands that are very close together
    merged_bands: list[list[float]] = []
    for lo, hi in raw_bands:
        if merged_bands and lo - merged_bands[-1][1] < MERGE_GAP:
            merged_bands[-1][1] = hi
        else:
            merged_bands.append([lo, hi])

    _log(f"Found {len(merged_bands)} horizontal surface bands:")
    for i, (lo, hi) in enumerate(merged_bands):
        _log(f"  Band {i+1}: Z=[{lo:+.3f}, {hi:+.3f}] m  span={hi-lo:.3f} m")

    if not merged_bands:
        _log("ERROR: no horizontal surfaces detected")
        return []

    # ── Pass 2: extract points per band ───────────────────────────────────
    _log(f"Pass 2/2: extracting points for {len(merged_bands)} surface bands...")
    buffers: list[list[np.ndarray]] = [[] for _ in merged_bands]
    pts_read = 0
    last_print = time.time()

    for chunk in pd.read_csv(
        str(xyz_path), header=None, sep=" ",
        usecols=[0, 1, 2], names=["x", "y", "z"],
        chunksize=CHUNK_LINES, dtype=np.float32,
        engine="c", on_bad_lines="skip",
    ):
        x = chunk["x"].values
        y = chunk["y"].values
        z = chunk["z"].values
        pts_read += len(x)

        for i, (lo, hi) in enumerate(merged_bands):
            mask = (z >= lo) & (z <= hi)
            if mask.any():
                buffers[i].append(np.column_stack([x[mask], y[mask], z[mask]]))

        if time.time() - last_print >= 15.0:
            pct = min(100, 100.0 * pts_read / total_pts)
            _log(f"  {pts_read:,} pts ({pct:.1f}%)")
            last_print = time.time()

    # ── Save horiz_surface_N.xyz ───────────────────────────────────────────
    surfaces: list[dict] = []
    for i, bufs in enumerate(buffers):
        if not bufs:
            _log(f"  Band {i+1}: no points — skip")
            continue
        pts = np.concatenate(bufs, axis=0)
        if len(pts) < MIN_SURFACE_PTS:
            _log(f"  Band {i+1}: only {len(pts)} pts — skip")
            continue

        out_path = out_dir / f"horiz_surface_{i+1}.xyz"
        df = pd.DataFrame(pts, columns=["//X", "Y", "Z"]).round(3)
        df.to_csv(str(out_path), sep="\t", index=False)

        median_z = float(np.median(pts[:, 2]))
        size_mb  = out_path.stat().st_size / 1e6
        _log(
            f"  horiz_surface_{i+1}.xyz: {len(pts):,} pts  "
            f"median_Z={median_z:+.4f} m  ({size_mb:.1f} MB)"
        )
        surfaces.append({
            "file":     str(out_path),
            "n_points": len(pts),
            "median_z": median_z,
            "z_lo":     merged_bands[i][0],
            "z_hi":     merged_bands[i][1],
        })

    elapsed = time.time() - t0
    _log(f"Done: {len(surfaces)} surfaces in {elapsed:.1f} s ({elapsed/60:.1f} min)")

    # Write summary JSON next to the xyz files
    summary = {"surfaces": surfaces, "n_surfaces": len(surfaces)}
    (out_dir / "surfaces.json").write_text(json.dumps(summary, indent=2))

    return surfaces


# ── CLI entry point ───────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cloud2BIM-compatible horizontal surface detector"
    )
    parser.add_argument("--xyz",     metavar="PATH", required=True,
                        help="Path to the .xyz point cloud file")
    parser.add_argument("--out-dir", metavar="DIR",  default=None,
                        help="Output directory (default: PROCESSED_DIR/c2b_output)")
    args = parser.parse_args()

    xyz_path = Path(args.xyz)
    if not xyz_path.exists():
        print(f"[ERROR] XYZ not found: {xyz_path}")
        sys.exit(1)

    out_dir  = Path(args.out_dir) if args.out_dir else DEFAULT_OUT_DIR
    surfaces = detect_horizontal_surfaces(xyz_path, out_dir)
    if not surfaces:
        sys.exit(1)
    print(f"[c2b] {len(surfaces)} surfaces → {out_dir}")


if __name__ == "__main__":
    main()
