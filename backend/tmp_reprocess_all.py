"""
Reprocess all floors: wall detection (snap=True) + opening detection + room detection.
Run from backend/ directory:
    python tmp_reprocess_all.py
"""
import sys
sys.path.insert(0, '.')

from pipeline.wall_detection   import detect_walls_for_floor
from pipeline.opening_detection import detect_openings_for_floor
from pipeline.room_detection   import detect_rooms_for_floor
from pipeline.dxf_export       import export_floor_dxf
import json, os

PROCESSED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "processed")

with open(os.path.join(PROCESSED_DIR, "info.json")) as fh:
    info = json.load(fh)
n_floors = len(info.get("floor_levels", []))

wall_cfg = {
    "grid_size"      : 0.05,
    "snap_to_axis"   : True,   # ← ENABLED
    "min_wall_m"     : 0.80,
    "hough_threshold": 40,
    "max_gap_m"      : 0.25,
    "car_filter"     : True,
    "car_top_m"      : 1.55,
    "ceiling_cap_m"  : 2.05,
    "save_debug"     : True,
}

opening_cfg = {
    "wall_thickness"       : 0.25,
    "min_door_width"       : 0.70,
    "min_window_width"     : 0.50,
    "door_height_threshold": 1.85,
}

room_cfg = {
    "wall_thickness_px": 4,
    "close_kernel_px"  : 7,
    "min_seg_m"        : 0.4,
    "min_room_m2"      : 0.8,
    "max_room_m2"      : 800.0,
    "save_debug"       : True,
}

print(f"\n{'='*60}")
print(f"  Reprocessing {n_floors} floor(s) with snap_to_axis=True")
print(f"{'='*60}\n")

for fi in range(n_floors):
    print(f"\n{'─'*60}")
    print(f"  FLOOR {fi}")
    print(f"{'─'*60}")

    # 1 – Walls
    walls = detect_walls_for_floor(fi, wall_cfg)
    print(f"  → {len(walls)} wall segments")

    # 2 – Openings
    op = detect_openings_for_floor(fi, opening_cfg)
    print(f"  → {op['n_doors']} doors  {op['n_windows']} windows")

    # 3 – Rooms
    rm = detect_rooms_for_floor(fi, room_cfg)
    print(f"  → {rm['n_rooms']} rooms")
    for r in rm['rooms']:
        print(f"      R{r['id']:02d}  {r['area_m2']:7.1f} m²  "
              f"centroid ({r['centroid_x']:.2f}, {r['centroid_z']:.2f})")

    # 4 – Export DXF + SVG
    dxf = export_floor_dxf(fi, PROCESSED_DIR)
    print(f"  → DXF: {os.path.basename(dxf)}")

print(f"\n{'='*60}")
print("  All floors done.")
print(f"{'='*60}\n")
