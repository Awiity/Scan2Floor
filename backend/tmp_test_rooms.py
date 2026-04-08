import sys
sys.path.insert(0, '.')
from pipeline.room_detection import detect_rooms_for_floor

for fi in range(3):
    r = detect_rooms_for_floor(fi, {})
    print(f"Floor {fi}: {r['n_rooms']} rooms detected")
    for rm in r['rooms']:
        print(f"  R{rm['id']:02d}  {rm['area_m2']:7.1f} m2  centroid ({rm['centroid_x']:.1f}, {rm['centroid_z']:.1f})")
print("Done.")
