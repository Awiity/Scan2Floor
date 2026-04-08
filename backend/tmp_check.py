import json
d = 'processed'
for fi in range(3):
    wj = json.load(open(f'{d}/walls_floor_{fi}.json'))
    rj = json.load(open(f'{d}/rooms_floor_{fi}.json'))
    print(f"Floor {fi}: {len(wj['lines'])} walls  |  {rj['n_rooms']} rooms")
    for r in rj['rooms']:
        print(f"  R{r['id']:02d}  {r['area_m2']:7.1f} m2")
