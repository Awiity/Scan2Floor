"""Merge instancí — globální katalog fyzických objektů (Fáze 2 inventáře).

Načte objects.json, z anchorů všech raw detekcí složí greedy clusteringem
per label globální instance (`app/objects.py::cluster_anchor_objects`) a
zapíše je do sekce `instances` v objects.json. Surová per-view data zůstávají
nedotčená — opakovaný běh je idempotentní (re-cluster z raw dat).

Paprsek/anchor fáze (`tools/anchor_objects.py`) musí být hotová — bez
anchorů se instance neskládají.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import OBJECTS_FILE  # noqa: E402
from app.objects import ObjectStore, cluster_anchor_objects  # noqa: E402


def run(args) -> int:
    store = ObjectStore(Path(args.out))
    data = store.load()
    instances = cluster_anchor_objects(data)
    data["instances"] = instances
    from datetime import datetime, timezone

    data["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    store.save(data)

    # auto-push do centrálního registru (jen když je MP_REGISTRY_URL nastaveno)
    from app.registry_sync import push_after_change

    action = push_after_change(store.path.parent)
    if action:
        print(f"registry: {action}")

    # statistiky
    by_cat: dict[str, int] = {}
    for inst in instances:
        by_cat[inst["kategorie"]] = by_cat.get(inst["kategorie"], 0) + 1
    raw_total = sum(
        1
        for entry in data.get("sweeps", {}).values()
        for view in (entry.get("views") or {}).values()
        for _obj in (view.get("objects") or [])
    )
    raw_no_anchor = sum(
        1
        for entry in data.get("sweeps", {}).values()
        for view in (entry.get("views") or {}).values()
        for obj in (view.get("objects") or [])
        if not isinstance(obj.get("anchor"), dict) or not obj.get("anchor")
    )
    print(f"instancí: {len(instances)} z {raw_total} raw objektů (bez anchoru: {raw_no_anchor})")
    for cat, n in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"  {cat}: {n}")
    top = sorted(instances, key=lambda i: -i["hits"])[:15]
    print("nejviděnější:")
    for inst in top:
        print(
            f"  {inst['ikona']} {inst['label'][:30]} — {inst['hits']}× "
            f"(max conf {inst['max_conf']}, pozice x{inst['pozice']['x']}, "
            f"y{inst['pozice']['y']}, z{inst['pozice']['z']})"
        )
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(OBJECTS_FILE))
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
