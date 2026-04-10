"""
floor_from_c2b.py  —  Read Cloud2BIM horiz_surface_*.xyz outputs and derive
                      accurate floor levels for info.json.

Background
----------
Cloud2BIM was already run on cloud.xyz and saved horizontal surface point clouds
to Cloud2BIM-1.03/output_xyz/horiz_surface_N.xyz.  Each file is one horizontal
surface (alternately floor/ceiling of each storey).  The files use Matterport's
raw coordinate system (Z-up), saved with headers:

    //X    Y    Z      (tab-separated)

where Z is the Matterport HEIGHT axis (= y_yup in our Three.js Y-up system).

This module:
  1. Reads every horiz_surface_*.xyz from the Cloud2BIM output folder.
  2. Computes the median Z value per surface  →  candidate levels.
  3. Converts to y_yup (no-op: y_yup = z_raw).
  4. Sorts levels and groups them into consecutive slab pairs.
  5. Picks the LOWER value of each pair as the storey floor level.
  6. Writes the new floor_levels into info.json so the rest of the pipeline
     (wall_detection.py etc.) benefits immediately.

Usage (standalone)
------------------
    python pipeline/floor_from_c2b.py

API usage
---------
    from pipeline.floor_from_c2b import update_floor_levels_from_c2b
    result = update_floor_levels_from_c2b(c2b_output_dir, processed_dir)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

import numpy as np

# ── Path defaults ────────────────────────────────────────────────────────────
_THIS_FILE = Path(__file__).resolve()
_BASE_DIR   = _THIS_FILE.parent.parent          # …/scan2floor/backend
_WORK_DIR   = _BASE_DIR.parent.parent           # …/WORK
_C2B_DIR    = _WORK_DIR / "Cloud2BIM-1.03" / "output_xyz"
_PROCESSED  = _BASE_DIR / "processed"
_INFO_PATH  = _PROCESSED / "info.json"

# Max Z gap (metres) between two surfaces to consider them a slab pair
_MAX_SLAB_GAP = 1.0
# Min Z gap between consecutive storeys
_MIN_STOREY_GAP = 1.5


def _read_horiz_surface(path: Path) -> Optional[np.ndarray]:
    """
    Read a horiz_surface_N.xyz file produced by Cloud2BIM.

    Cloud2BIM saves them with pandas.to_csv using sep='\\t' and a header:
        //X<tab>Y<tab>Z
    The third column (Z in Matterport coords) is the HEIGHT axis.

    Returns a 1-D float32 array of Z values, or None on error.
    """
    try:
        import pandas as pd
    except ImportError:
        # Fallback: manual parsing
        z_vals = []
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i == 0:
                    continue          # skip header
                parts = line.split()
                if len(parts) >= 3:
                    try:
                        z_vals.append(float(parts[2]))
                    except ValueError:
                        pass
        return np.array(z_vals, dtype=np.float32) if z_vals else None

    try:
        df = pd.read_csv(
            str(path),
            sep=r"\s+",
            header=0,
            usecols=[2],          # third column = Z = height
            names=["x", "y", "z"],
            dtype=np.float32,
            engine="python",
            on_bad_lines="skip",
        )
        z = df["z"].dropna().values
        return z if len(z) > 0 else None
    except Exception as exc:
        print(f"  [WARN] could not read {path.name}: {exc}")
        return None


def _pair_surfaces(sorted_levels: list[float]) -> list[tuple[float, float]]:
    """
    Given N surface Z values sorted ascending, pair consecutive values that
    are within _MAX_SLAB_GAP of each other into (bottom, top) slab pairs.
    Unpaired surfaces (large gap to neighbours) are treated as standalone floors.
    Returns a list of (floor_z, ceiling_z) tuples.
    """
    pairs: list[tuple[float, float]] = []
    used = [False] * len(sorted_levels)

    i = 0
    while i < len(sorted_levels):
        if used[i]:
            i += 1
            continue

        level = sorted_levels[i]
        # Look ahead for a close partner
        if i + 1 < len(sorted_levels) and not used[i + 1]:
            gap = sorted_levels[i + 1] - level
            if gap <= _MAX_SLAB_GAP:
                pairs.append((level, sorted_levels[i + 1]))
                used[i] = used[i + 1] = True
                i += 2
                continue

        # Standalone surface — treat as both floor and ceiling
        pairs.append((level, level))
        used[i] = True
        i += 1

    return pairs


def update_floor_levels_from_c2b(
    c2b_output_dir: str | Path | None = None,
    processed_dir: str | Path | None = None,
    info_path: str | Path | None = None,
) -> dict:
    """
    Main entry point called by the FastAPI endpoint.

    Parameters
    ----------
    c2b_output_dir : path to Cloud2BIM output_xyz folder
    processed_dir  : path to scan2floor backend/processed/
    info_path      : path to info.json (auto-derived from processed_dir if None)

    Returns
    -------
    dict  summary with keys: n_surfaces, old_floor_levels, new_floor_levels,
                              slab_pairs, status
    """
    c2b_dir   = Path(c2b_output_dir)  if c2b_output_dir  else _C2B_DIR
    proc_dir  = Path(processed_dir)   if processed_dir   else _PROCESSED
    info_file = Path(info_path)        if info_path        else (proc_dir / "info.json")

    # ── Discover horiz_surface files ─────────────────────────────────────────
    xyz_files = sorted(c2b_dir.glob("horiz_surface_*.xyz"))
    if not xyz_files:
        return {
            "status": "error",
            "message": f"No horiz_surface_*.xyz files found in {c2b_dir}",
        }

    print(f"\n[floor_from_c2b] Found {len(xyz_files)} surface files in {c2b_dir}")

    # ── Compute median Z per file ─────────────────────────────────────────────
    surface_z: list[float] = []
    for fpath in xyz_files:
        z_arr = _read_horiz_surface(fpath)
        if z_arr is None or len(z_arr) < 10:
            print(f"  [SKIP] {fpath.name} — too few points")
            continue
        med = float(np.median(z_arr))
        print(f"  {fpath.name:30s}  n={len(z_arr):>9,}  median_z={med:+.4f} m")
        surface_z.append(med)

    if not surface_z:
        return {
            "status": "error",
            "message": "Could not read any usable horiz_surface_*.xyz file.",
        }

    surface_z.sort()
    print(f"\n  Sorted surface Z values: {[f'{v:+.4f}' for v in surface_z]}")

    # ── Pair surfaces into slab bottom/top ────────────────────────────────────
    slab_pairs = _pair_surfaces(surface_z)
    print(f"\n  Slab pairs (bottom, top): {slab_pairs}")

    # ── Derive floor levels (bottom of each slab = storey floor) ─────────────
    # In Y-up coords y_yup = z_raw, so the conversion is trivial.
    # We keep only storeys that are at least _MIN_STOREY_GAP apart.
    raw_floors = sorted(set(pair[0] for pair in slab_pairs))
    floor_levels: list[float] = []
    for fl in raw_floors:
        if not floor_levels or (fl - floor_levels[-1]) >= _MIN_STOREY_GAP:
            floor_levels.append(round(fl, 4))

    print(f"\n  New floor_levels (y_yup): {floor_levels}")

    # ── Update info.json ──────────────────────────────────────────────────────
    if not info_file.exists():
        return {
            "status": "error",
            "message": f"info.json not found at {info_file}",
        }

    with open(info_file) as fh:
        info = json.load(fh)

    old_levels = info.get("floor_levels", [])
    info["floor_levels"] = floor_levels
    info["floor_levels_source"] = "cloud2bim_horiz_surfaces"
    info["slab_pairs_c2b"] = slab_pairs

    with open(info_file, "w") as fh:
        json.dump(info, fh, indent=2)

    print(f"\n  Updated {info_file.name}  old={old_levels}  new={floor_levels}")

    return {
        "status": "ok",
        "n_surfaces": len(surface_z),
        "old_floor_levels": old_levels,
        "new_floor_levels": floor_levels,
        "slab_pairs": slab_pairs,
        "message": (
            f"Updated info.json with {len(floor_levels)} floor level(s) "
            f"derived from {len(surface_z)} Cloud2BIM horizontal surfaces."
        ),
    }


# ── Standalone CLI ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = update_floor_levels_from_c2b()
    print("\n--- Result ---")
    print(json.dumps(result, indent=2))
