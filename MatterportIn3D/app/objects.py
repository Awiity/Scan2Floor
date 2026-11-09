"""Rozpoznané objekty ve skenech — normalizace štítků a agregace pohledů.

Detektor (`tools/detect_objects.py`) ukládá surové odpovědi modelu po
jednotlivých pohledech. Tenhle modul z nich skládá „tagy" pro jedno místo:

* stejný objekt viděný ze dvou pohledů se sloučí (štítek + blízký směr),
* z polohy objektu v obrázku se spočítá směr pohledu (bearing), na který se
  kamera umí otočit přes `Sweep.moveTo(id, {rotation: {y: bearing}}).
"""
from __future__ import annotations

import json
import logging
import math
import os
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Slovník štítků: (klíčová slova v odpovědi modelu) -> (štítek, kategorie, ikona)
# ---------------------------------------------------------------------------
VOCABULARY: list[tuple[tuple[str, ...], tuple[str, str, str]]] = [
    (("hasici", "extinguisher", "hasici pristroj"), ("hasicí přístroj", "požární", "🧯")),
    (("hydrant",), ("hydrant", "požární", "🚒")),
    (("hlasic", "detector", "detektor"), ("hlásič", "požární", "🚨")),
    (("vychod", "exit", "unikov"), ("východ", "bezpečnost", "🏃")),
    (("dvere", "door"), ("dveře", "přístup", "🚪")),
    (("okno", "window"), ("okno", "přístup", "🪟")),
    (("schodist", "schody", "stair"), ("schodiště", "přístup", "🪜")),
    (("vy tah", "vytah", "elevator", "lift"), ("výtah", "přístup", "🛗")),
    (("rack", "server"), ("serverový rack", "IT", "🖥️")),
    (("rozvadec", "switchboard", "rozvodn", "electro"), ("rozvaděč", "elektro", "⚡")),
    (("klimatiz", "air condition", "hvac", "chlazeni"), ("klimatizace", "vzduchotechnika", "❄️")),
    (("potrub", "pipe", "duct"), ("potrubí", "vzduchotechnika", "🧰")),
    (("kabelov", "cable tray", "zlab", "kabelaz"), ("kabelový žlab", "elektro", "🔌")),
    (("svetl", "light", "zarivk", "lamp"), ("světlo", "osvětlení", "💡")),
    (("cedule", "znacka", "sign", "label plate"), ("cedule", "orientace", "🪧")),
    (("kamera", "camera", "cctv"), ("kamera", "zabezpečení", "📷")),
    (("vypinac", "switch plate"), ("vypínač", "elektro", "🔘")),
    (("zasuvk", "socket", "outlet"), ("zásuvka", "elektro", "🔌")),
    (("stul", "desk", "table"), ("stůl", "nábytek", "🪑")),
    (("zidle", "chair"), ("židle", "nábytek", "💺")),
    (("skrin", "cabinet", "cupboard"), ("skříň", "nábytek", "🗄️")),
    (("umyvadlo", "sink"), ("umyvadlo", "hygiena", "🚰")),
    (("wc", "toilet", "zachod"), ("WC", "hygiena", "🚽")),
    (("kuchyn", "kitchen"), ("kuchyňka", "hygiena", "🍽️")),
    (("rostlin", "plant"), ("rostlina", "interiér", "🪴")),
]

UNKNOWN = ("jiné", "jiné", "❓")

logger = logging.getLogger(__name__)

# Max rozumná souřadnice anchoru (m) — model rozsah ~ ±35 m. Nad práh je
# anchor pravděpodobně v mm (SDK bug pro `intersectedobject.unknown`) →
# vyloučení z clusteringu, jinak vznikají instance v mm (IFC souřadnice ~ km).
MAX_PLAUSIBLE_ANCHOR_M = 100.0


def strip_diacritics(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    )


def normalize_label(raw: str) -> tuple[str, str, str]:
    """Převede štítek z modelu na (štítek, kategorie, ikona)."""
    key = strip_diacritics((raw or "").strip().lower())
    for keywords, result in VOCABULARY:
        for kw in keywords:
            if kw in key:
                return result
    return UNKNOWN


# ---------------------------------------------------------------------------
# Geometrie: poloha objektu na snímku -> směr pohledu
#
# Kalibrace měřená na modelu (Pointer.intersection, sken n3u8e7wq…):
#   * forward(yaw) = (−sin yaw, 0, −cos yaw)  (up = +Y; yaw 90 → −X, 270 → +X)
#   * paprsek skrz pixel vpravo od středu → horizontální úhel ROSTE o
#     atan(2(xc−0.5)·tan(HFOV/2)); ATAN model, lineární 90° bývá ~3–5° mimo
#   * pixel nad středem (yc < 408) → paprsek nahoru
# ---------------------------------------------------------------------------
RAY_CENTER_Y = 408.0   # střed canvasu (viewport 1280×816; snímek 720 = ořez 96 px)
RAY_HALF_WIDTH = 640.0  # polovina šířky canvasu — referenční měřítko offsetu


def forward_vector(yaw: float) -> tuple[float, float, float]:
    """Jednotkový směr pohledu kamery v souřadnicích modelu (up = +Y)."""
    rad = math.radians(float(yaw))
    return (-math.sin(rad), 0.0, -math.cos(rad))


def bearing_for(
    yaw: float,
    x_center: float,
    hfov: float | None = None,
    sign: float = -1.0,
) -> float:
    """Směr (yaw), kterým se kamera otočí na objekt uprostřed bboxu.

    `x_center` je vodorovný střed bboxu (0 = levý okraj, 1 = pravý).
    ATAN model kalibrovaný paprsky: offset úhlu = atan(2(xc−0.5)·tan(hfov/2));
    `sign=-1` — objekt vpravo na snímku se centročí nižším yawem (měřeno).
    Bez `hfov` se použije kalibrovaná hodnota z configu (100,5°).
    """
    if hfov is None:
        from app.config import CAPTURE_HFOV

        hfov = CAPTURE_HFOV
    off = math.atan(2.0 * (float(x_center) - 0.5) * math.tan(math.radians(float(hfov) / 2.0)))
    return (float(yaw) + float(sign) * math.degrees(off)) % 360.0


def ray_direction(
    yaw: float,
    x_center: float,
    y_center: float,
    tan_half: float | None = None,
) -> tuple[float, float, float]:
    """Jednotkový směr paprsku skrz střed bboxu (přesné na 0,2° dle kalibrace).

    Směr paprsku = forward·cos(θh)·cos(θv) + right·sin(θh)·cos(θv) + up·sin(θv),
    kde θh = atan(2(xc−0.5)·tan_half) je offset **dopravo na snímku** a θv =
    atan((408−yc_px)/640·tan_half) nahoru; right = (cos yaw, 0, −sin yaw).
    Rozvinuté: (cosv·sin(θh − yaw), sinv, −cosv·cos(θh − yaw)) — při yaw 0
    tedy (sin θh, sin θv, −cos θh). `y_center` je v pixelech snímku (0 = horní
    okraj); bez `tan_half` se použije kalibrační hodnota z configu.
    """
    if tan_half is None:
        from app.config import CAPTURE_TAN_HALF

        tan_half = CAPTURE_TAN_HALF
    h_off = math.atan(2.0 * (float(x_center) - 0.5) * float(tan_half))
    v_up = math.atan((RAY_CENTER_Y - float(y_center)) / RAY_HALF_WIDTH * float(tan_half))
    a = h_off - math.radians(float(yaw))
    cos_v = math.cos(v_up)
    return (
        cos_v * math.sin(a),
        math.sin(v_up),
        -cos_v * math.cos(a),
    )


def _angle_diff(a: float, b: float) -> float:
    """Nejmenší úhlová vzdálenost dvou směrů (0–180°)."""
    d = abs((a - b) % 360.0)
    return min(d, 360.0 - d)


def _circular_mean(angles: Iterable[float], weights: Iterable[float]) -> float:
    x = y = 0.0
    for a, w in zip(angles, weights):
        rad = math.radians(a)
        x += math.cos(rad) * w
        y += math.sin(rad) * w
    if abs(x) < 1e-9 and abs(y) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(y, x)) % 360.0


# ---------------------------------------------------------------------------
# Anchor pass: validace průsečíku, fallback vzdálenost, přenos do tagů
# ---------------------------------------------------------------------------
# Typická šířka objektu v metrech — fallback odhad vzdálenosti z úhlové
# velikosti bboxu, když paprsek neuspěl (anchor_estimated).
CATEGORY_WIDTH: dict[str, float] = {
    "hasicí přístroj": 0.30,
    "hydrant": 0.50,
    "hlásič": 0.15,
    "východ": 0.90,
    "dveře": 0.95,
    "okno": 1.20,
    "schodiště": 1.20,
    "výtah": 1.50,
    "serverový rack": 0.70,
    "rozvaděč": 0.90,
    "klimatizace": 0.90,
    "potrubí": 0.50,
    "kabelový žlab": 0.50,
    "světlo": 0.60,
    "cedule": 0.40,
    "kamera": 0.20,
    "vypínač": 0.12,
    "zásuvka": 0.12,
    "stůl": 1.40,
    "židle": 0.50,
    "skříň": 0.90,
    "umyvadlo": 0.60,
    "WC": 0.50,
    "kuchyňka": 0.80,
    "rostlina": 0.40,
    "jiné": 0.50,
}


def validate_anchor(
    pose_position: dict[str, float],
    hit: dict[str, Any],
    yaw: float,
    x_center: float,
    y_center: float,
    tan_half: float | None = None,
) -> tuple[float, float]:
    """Úhlová odchylka (°) a vzdálenost průsečíku od očekávaného paprsku.

    `hit` je poslední event `Pointer.intersection` (position). Očekávaný směr
    počítá `ray_direction`; odchylka nad ~6° znamená zastaralý event (paprsek
    z předchozí pozice myši) — volající pak použije fallback.
    """
    dx = float(hit["position"]["x"]) - float(pose_position["x"])
    dy = float(hit["position"]["y"]) - float(pose_position["y"])
    dz = float(hit["position"]["z"]) - float(pose_position["z"])
    dist = math.sqrt(dx * dx + dy * dy + dz * dz)
    expected = ray_direction(yaw, x_center, y_center, tan_half)
    if dist < 0.05:  # průsečík v kameře — nesmysl
        return 180.0, 0.0
    dot = (dx * expected[0] + dy * expected[1] + dz * expected[2]) / dist
    dot = max(-1.0, min(1.0, dot))
    angle = math.degrees(math.acos(dot))
    return angle, dist


def estimate_distance(
    label: str,
    bbox: list[float],
    tan_half: float | None = None,
) -> float:
    """Odhad vzdálenosti z úhlové šířky bboxu a typické šířky objektu.

    Úhlová šířka ω mezi krajními paprsky bboxu; dist = šířka / (2·tan(ω/2)).
    """
    if tan_half is None:
        from app.config import CAPTURE_TAN_HALF

        tan_half = CAPTURE_TAN_HALF
    if len(bbox) != 4:
        return 3.0

    def _angle(t: float) -> float:
        return math.atan(2.0 * (t - 0.5) * float(tan_half))

    omega = _angle(bbox[2]) - _angle(bbox[0])
    if omega <= 1e-6:
        return 3.0
    width = CATEGORY_WIDTH.get(label, 0.5)
    return width / (2.0 * math.tan(omega / 2.0))


# ---------------------------------------------------------------------------
# Merge instancí: poloměry per kategorie + greedy clustering s capem průměru
# ---------------------------------------------------------------------------
def merge_radius(label: str) -> float:
    """Slučovací poloměr pro štítek (config, default přes env)."""
    from app.config import MERGE_RADIOS, MERGE_RADIUS_DEFAULT

    return MERGE_RADIOS.get(label, MERGE_RADIUS_DEFAULT)


def cluster_anchor_objects(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Skládá globální instance z anchorů všech skenů (greedy per label).

    Vstup `data["sweeps"]` (raw per-view detekce s anchor). Cluster roste od
    objektu s nejvyšší conf; kandidát přibude, když je od některého člena
    ≤ poloměr a cluster průměrem nepřeleze cap (poloměr × MERGE_CAP_FACTOR) —
    jinak vznikne nová instance (brání řetězení přes chodbu).
    Výstup: [{id, label, kategorie, ikona, pozice, sweeps: [{sweep, bearing,
    conf, views}], max_conf, hits}] seřazené sestupně podle hits.
    """
    # 1) seber raw objekty s anchorem, seskup dle labelu
    by_label: dict[str, list[dict[str, Any]]] = {}
    for sid, entry in data.get("sweeps", {}).items():
        for yaw_key, view in (entry.get("views") or {}).items():
            try:
                yaw = int(float(yaw_key)) % 360
            except (TypeError, ValueError):
                continue
            for obj in view.get("objects") or []:
                anchor = obj.get("anchor")
                if not isinstance(anchor, dict) or not anchor:
                    continue
                # sanity: anchor mimo rozsah modelu (pravděpodobně mm) → vyloučit
                if max(abs(float(v)) for v in anchor.values()) > MAX_PLAUSIBLE_ANCHOR_M:
                    logger.warning(
                        "cluster_anchor_objects: vyloučen anchor mimo rozsah modelu "
                        "(raw label %r, sweep %s, view %s) — pravděpodobně jednotky mm",
                        obj.get("label", ""),
                        sid,
                        yaw_key,
                    )
                    continue
                label, category, icon = normalize_label(obj.get("label", ""))
                by_label.setdefault(label, []).append(
                    {
                        "sweep": sid,
                        "view": yaw,
                        "label": label,
                        "category": category,
                        "icon": icon,
                        "conf": float(obj.get("conf") or 0.0),
                        "bbox": obj.get("bbox") or [0, 0, 0, 0],
                        "anchor": anchor,
                        "estimated": bool(obj.get("anchor_estimated")),
                    }
                )

    # 2) greedy clustering per label (exkluzivní — objekt jen v jednom clusteru)
    instances: list[dict[str, Any]] = []
    for label, items in by_label.items():
        items.sort(key=lambda o: -o["conf"])
        radius = merge_radius(label)
        cap = radius * 2.0
        clusters: list[list[dict[str, Any]]] = []
        used: set[int] = set()  # id() — obsah diktů se může rovnat napříč objekty
        for seed in items:
            if id(seed) in used:
                continue
            cluster = [seed]
            used.add(id(seed))
            changed = True
            while changed:
                changed = False
                for cand in items:
                    if id(cand) in used:
                        continue
                    # blízkost k některému členu
                    near = any(
                        _anchor_dist(cand["anchor"], m["anchor"]) <= radius
                        for m in cluster
                    )
                    if not near:
                        continue
                    # cap průměru: vzdálenost k nejvzdálenějšímu členu ≤ cap
                    if _anchor_dist(
                        cand["anchor"], max(
                            cluster, key=lambda m: _anchor_dist(cand["anchor"], m["anchor"])
                        )["anchor"]
                    ) > cap:
                        continue
                    cluster.append(cand)
                    used.add(id(cand))
                    changed = True
            clusters.append(cluster)

        for cluster in clusters:
            # centroid anchorů
            pozice = {
                "x": round(sum(float(o["anchor"]["x"]) for o in cluster) / len(cluster), 3),
                "y": round(sum(float(o["anchor"]["y"]) for o in cluster) / len(cluster), 3),
                "z": round(sum(float(o["anchor"]["z"]) for o in cluster) / len(cluster), 3),
            }
            # per-sweep agregace: max conf, median bearing, seznam viewů
            per_sweep: dict[str, list[dict[str, Any]]] = {}
            for o in cluster:
                per_sweep.setdefault(o["sweep"], []).append(o)
            sweeps: list[dict[str, Any]] = []
            for sid, objs in sorted(per_sweep.items()):
                best = max(objs, key=lambda o: o["conf"])
                xc = (float(best["bbox"][0]) + float(best["bbox"][2])) / 2.0
                bearing = round(
                    bearing_for(best["view"], xc), 1
                )
                sweeps.append(
                    {
                        "sweep": sid,
                        "bearing": bearing,
                        "conf": round(best["conf"], 3),
                        "views": sorted(o["view"] for o in objs),
                    }
                )
            instances.append(
                {
                    "id": "inst-0000",  # přepsáno níže sekvenčně
                    "label": label,
                    "kategorie": cluster[0]["category"],
                    "ikona": cluster[0]["icon"],
                    "pozice": pozice,
                    "sweeps": sweeps,
                    "max_conf": round(max(o["conf"] for o in cluster), 3),
                    "hits": len(cluster),
                    "estimated": any(o["estimated"] for o in cluster),
                }
            )

    instances.sort(
        key=lambda i: (-i["hits"], i["label"], i["pozice"]["x"], i["pozice"]["y"], i["pozice"]["z"])
    )
    for i, inst in enumerate(instances, start=1):
        inst["id"] = f"inst-{i:04d}"
    return instances


def _anchor_dist(a: dict[str, float], b: dict[str, float]) -> float:
    return math.sqrt(
        (float(a["x"]) - float(b["x"])) ** 2
        + (float(a["y"]) - float(b["y"])) ** 2
        + (float(a["z"]) - float(b["z"])) ** 2
    )


# ---------------------------------------------------------------------------
# Agregace tagů pro jedno místo
# ---------------------------------------------------------------------------
def tags_for_sweep(
    entry: dict[str, Any],
    hfov: float | None = None,
    sign: float = -1.0,
    dedupe_deg: float = 25.0,
    min_conf: float = 0.0,
) -> list[dict[str, Any]]:
    """Poskládá tagy z `entry["views"]` (pohledy po yaw)."""
    if hfov is None:
        from app.config import CAPTURE_HFOV

        hfov = CAPTURE_HFOV
    items: list[dict[str, Any]] = []
    for yaw_key, view in (entry.get("views") or {}).items():
        try:
            yaw = float(yaw_key)
        except (TypeError, ValueError):
            continue
        for obj in view.get("objects") or []:
            bbox = obj.get("bbox") or []
            if len(bbox) != 4:
                continue
            conf = float(obj.get("conf") or 0.0)
            if conf < min_conf:
                continue
            label, category, icon = normalize_label(obj.get("label", ""))
            xc = (float(bbox[0]) + float(bbox[2])) / 2.0
            item = {
                "label": label,
                "label_raw": obj.get("label", ""),
                "category": category,
                "icon": icon,
                "conf": conf,
                "bbox": [round(float(v), 4) for v in bbox],
                "view": yaw,
                "bearing": round(bearing_for(yaw, xc, hfov, sign), 1),
            }
            if obj.get("anchor") is not None:
                item["anchor"] = obj["anchor"]
                item["anchor_dist"] = obj.get("anchor_dist")
                item["anchor_estimated"] = bool(obj.get("anchor_estimated"))
            items.append(item)

    # sloučení: stejný štítek + blízký směr = jeden objekt
    groups: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda i: -i["conf"]):
        target = next(
            (
                g
                for g in groups
                if g["label"] == item["label"]
                and _angle_diff(g["bearing"], item["bearing"]) <= dedupe_deg
            ),
            None,
        )
        if target is None:
            groups.append(
                {
                    "label": item["label"],
                    "category": item["category"],
                    "icon": item["icon"],
                    "conf": item["conf"],
                    "bearing": item["bearing"],
                    "bbox": item["bbox"],  # z nejjistějšího pohledu
                    "best_view": item["view"],
                    "views": [item["view"]],
                    "hits": 1,
                    "_angles": [item["bearing"]],
                    "_weights": [item["conf"]],
                }
            )
            for key in ("anchor", "anchor_dist", "anchor_estimated"):
                if key in item:
                    groups[-1][key] = item[key]
            continue

        target["hits"] += 1
        target["views"].append(item["view"])
        target["_angles"].append(item["bearing"])
        target["_weights"].append(item["conf"])
        # opakovaný nález zvyšuje jistotu (strop 0,99)
        target["conf"] = round(min(0.99, max(target["conf"], item["conf"]) + 0.03), 2)

    for g in groups:
        g["bearing"] = round(_circular_mean(g["_angles"], g["_weights"]), 1)
        g["views"] = sorted(set(g["views"]))
        for key in ("_angles", "_weights"):
            g.pop(key, None)

    return sorted(groups, key=lambda g: (-g["conf"], g["label"]))


# ---------------------------------------------------------------------------
# Úložiště results (objects.json)
# ---------------------------------------------------------------------------
class ObjectStore:
    """Výsledky detekce v jednom JSON souboru (`objects.json`)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"sweeps": {}}
        if isinstance(data, list):  # starší/robustní formát
            return {"sweeps": {s.get("id"): s for s in data if isinstance(s, dict)}}
        data.setdefault("sweeps", {})
        return data

    def save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".objects-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- veřejné ------------------------------------------------------------
    def summary(self, hfov: float, sign: float) -> dict[str, Any]:
        """Přehled pro UI: každý sken + jeho tagy."""
        data = self.load()
        sweeps = {}
        counts: dict[str, int] = {}
        for sid, entry in data.get("sweeps", {}).items():
            tags = tags_for_sweep(entry, hfov=hfov, sign=sign)
            if not tags:
                continue
            for t in tags:
                counts[t["label"]] = counts.get(t["label"], 0) + 1
            sweeps[sid] = {
                "position": entry.get("position"),
                "rotation": entry.get("rotation") or {},
                "tags": tags,
            }
        return {
            "updated": data.get("updated"),
            "model": data.get("model"),
            "sweep_count": len(sweeps),
            "counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
            "sweeps": sweeps,
        }

    def for_sweep(self, sweep_id: str, hfov: float, sign: float) -> list[dict[str, Any]]:
        entry = self.load().get("sweeps", {}).get(sweep_id)
        if not entry:
            return []
        return tags_for_sweep(entry, hfov=hfov, sign=sign)

    def instances(self) -> list[dict[str, Any]]:
        """Globální instance (sekce `instances` — výstup tools/merge_objects.py)."""
        return self.load().get("instances") or []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
