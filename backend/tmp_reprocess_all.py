"""
Reprocess all floors: Cloud2BIM wall detection + opening detection + room detection.
Run from backend/ directory:
    python tmp_reprocess_all.py
"""
import sys
sys.path.insert(0, '.')

from pipeline.wall_detection_c2b import detect_walls_c2b_for_floor
from pipeline.opening_detection   import detect_openings_for_floor
from pipeline.room_detection      import detect_rooms_for_floor
from pipeline.dxf_export          import export_floor_dxf
import json, os

PROCESSED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "processed")

with open(os.path.join(PROCESSED_DIR, "info.json")) as fh:
    info = json.load(fh)
n_floors = len(info.get("floor_levels", []))

wall_cfg = {
    "grid_size"         : 0.02,
    "snap_to_axis"      : True,
    "min_wall_m"        : 0.40,
    "max_wall_thickness": 0.75,
    "dp_tolerance"      : 0.04,
    "threshold_frac"    : 0.01,
    "save_debug"        : True,
}

opening_cfg = {
    "wall_thickness"        : 0.25,
    "min_door_width"        : 0.70,
    "min_window_width"      : 0.50,
    "door_height_threshold" : 1.85,
}

room_cfg = {
    "wall_thickness_m"  : 0.20,   # auto-scales to pixels based on grid_size
    "extend_m"          : 0.45,   # endpoint extension to seal T-junctions
    "min_seg_m"         : 0.4,
    "min_room_m2"       : 0.8,
    "max_room_m2"       : 800.0,
    "min_room_width_m"  : 0.60,
    "save_debug"        : True,
}

print(f"\n{'='*60}")
print(f"  Reprocessing {n_floors} floor(s) - Cloud2BIM algorithm")
print(f"{'='*60}\n")

for fi in range(n_floors):
    print(f"\n{'-'*60}")
    print(f"  FLOOR {fi}")
    print(f"{'-'*60}")

    # 1 - Walls (C2B)
    walls = detect_walls_c2b_for_floor(fi, wall_cfg)
    print(f"  -> {len(walls)} wall segments")

    # 2 - Openings
    op = detect_openings_for_floor(fi, opening_cfg)
    print(f"  -> {op['n_doors']} doors  {op['n_windows']} windows")

    # 3 - Rooms
    rm = detect_rooms_for_floor(fi, room_cfg)
    print(f"  -> {rm['n_rooms']} rooms")
    for r in rm['rooms']:
        print(f"      R{r['id']:02d}  {r['area_m2']:7.1f} m2  "
              f"centroid ({r['centroid_x']:.2f}, {r['centroid_z']:.2f})")

    # 4 - Export DXF + SVG
    dxf = export_floor_dxf(fi, PROCESSED_DIR)
    print(f"  -> DXF: {os.path.basename(dxf)}")

print(f"\n{'='*60}")
print("  All floors done.")
print(f"{'='*60}\n")
