import sys
sys.path.insert(0, '.')
from pipeline.room_detection import detect_rooms_for_floor

cfg = {
    "wall_thickness_m" : 0.20,
    "extend_m"         : 0.45,
    "min_seg_m"        : 0.4,
    "min_room_m2"      : 0.8,
    "max_room_m2"      : 800.0,
    "min_room_width_m" : 0.60,
    "save_debug"       : True,
}

for fi in range(3):
    r = detect_rooms_for_floor(fi, cfg)
    print(f"Floor {fi}: {r['n_rooms']} rooms detected")
    for rm in r['rooms']:
        print(f"  R{rm['id']:02d}  {rm['area_m2']:7.1f} m2  centroid ({rm['centroid_x']:.1f}, {rm['centroid_z']:.1f})")
print("Done.")
