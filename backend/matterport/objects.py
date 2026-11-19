"""Equipment detection vocabulary, geometry anchoring, unit normalization, clustering, and store."""

from __future__ import annotations

import json
import math
import re
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import (
    CAPTURE_HFOV,
    CAPTURE_TAN_HALF,
    CAPTURE_YAW_SIGN,
    MERGE_RADIUS,
    MODEL_ID,
    resolve_paths,
)

SUPPORTED_EQUIPMENT_LABELS: tuple[str, ...] = (
    "hasici_pristroj",
    "svitidlo",
    "nouzove_osvetleni",
)

# 25 Czech/English building & MEP equipment object classes
VOCABULARY: list[dict[str, Any]] = [
    {"id": "dvere", "cz": "dveře", "en": "door", "synonyms": ["door", "dvere", "entrance"], "default_height_m": 2.0},
    {"id": "okno", "cz": "okno", "en": "window", "synonyms": ["window", "okno"], "default_height_m": 1.2},
    {"id": "radiator", "cz": "radiátor", "en": "radiator", "synonyms": ["radiator", "heater", "topeni"], "default_height_m": 0.6},
    {"id": "hasici_pristroj", "cz": "hasicí přístroj", "en": "fire extinguisher", "synonyms": ["fire extinguisher", "extinguisher", "hasici pristroj", "hasicak"], "default_height_m": 0.6},
    {"id": "hydrant", "cz": "hydrant", "en": "fire hydrant", "synonyms": ["fire hydrant", "hydrant", "hose cabinet"], "default_height_m": 0.7},
    {"id": "rozvadec", "cz": "elektrický rozvaděč", "en": "electrical panel", "synonyms": ["electrical panel", "breaker box", "switchboard", "rozvadec", "electric box"], "default_height_m": 0.8},
    {"id": "zasuvka", "cz": "zásuvka", "en": "power outlet", "synonyms": ["power outlet", "socket", "outlet", "zasuvka"], "default_height_m": 0.1},
    {"id": "vypinac", "cz": "vypínač", "en": "light switch", "synonyms": ["light switch", "switch", "vypinac"], "default_height_m": 0.1},
    {"id": "svitidlo", "cz": "svítidlo", "en": "light fixture", "synonyms": ["light fixture", "lamp", "ceiling light", "svitidlo", "svetlo"], "default_height_m": 0.2},
    {"id": "nouzove_osvetleni", "cz": "nouzové osvětlení", "en": "emergency exit light", "synonyms": ["exit sign", "emergency light", "nouzove osvetleni", "exit", "vychod", "unikovy", "nouzovy", "vychod_(unikovy,_nouzovy)"], "default_height_m": 0.25},
    {"id": "kamera", "cz": "bezpečnostní kamera", "en": "security camera", "synonyms": ["security camera", "cctv", "camera", "kamera"], "default_height_m": 0.2},
    {"id": "detektor_koure", "cz": "detektor kouře", "en": "smoke detector", "synonyms": ["smoke detector", "fire alarm", "sensor", "detektor", "cidlo"], "default_height_m": 0.08},
    {"id": "klimatizace", "cz": "klimatizace", "en": "air conditioner", "synonyms": ["air conditioner", "ac unit", "hvac", "klimatizace"], "default_height_m": 0.35},
    {"id": "ventilace", "cz": "ventilační mřížka", "en": "air vent", "synonyms": ["air vent", "vent", "grille", "diffuser", "ventilace", "mrizka"], "default_height_m": 0.3},
    {"id": "kotel", "cz": "kotel / tepelné čerpadlo", "en": "boiler", "synonyms": ["boiler", "furnace", "heat pump", "kotel", "ohrivac"], "default_height_m": 1.2},
    {"id": "potrubi", "cz": "potrubí", "en": "pipe", "synonyms": ["pipe", "piping", "duct", "potrubi", "trubka"], "default_height_m": 0.3},
    {"id": "umyvadlo", "cz": "umyvadlo", "en": "sink", "synonyms": ["sink", "washbasin", "umyvadlo"], "default_height_m": 0.4},
    {"id": "wc", "cz": "toaleta", "en": "toilet", "synonyms": ["toilet", "wc", "toaleta", "zachod"], "default_height_m": 0.75},
    {"id": "sprcha", "cz": "sprcha", "en": "shower", "synonyms": ["shower", "sprcha"], "default_height_m": 1.8},
    {"id": "stul", "cz": "stůl", "en": "desk", "synonyms": ["desk", "table", "stul"], "default_height_m": 0.75},
    {"id": "zidle", "cz": "židle", "en": "chair", "synonyms": ["chair", "armchair", "zidle", "kreslo"], "default_height_m": 0.85},
    {"id": "skrin", "cz": "skříň", "en": "cabinet", "synonyms": ["cabinet", "wardrobe", "shelf", "locker", "skrin", "regal"], "default_height_m": 1.8},
    {"id": "monitor", "cz": "monitor / TV", "en": "monitor", "synonyms": ["monitor", "tv", "television", "screen", "display", "obrazovka"], "default_height_m": 0.5},
    {"id": "schody", "cz": "schodiště", "en": "stairs", "synonyms": ["stairs", "staircase", "schody", "schodiste"], "default_height_m": 2.5},
    {"id": "zabradli", "cz": "zábradlí", "en": "railing", "synonyms": ["railing", "handrail", "banister", "zabradli"], "default_height_m": 1.0},
]

_VOCAB_BY_ID: dict[str, dict[str, Any]] = {entry["id"]: entry for entry in VOCABULARY}
_LABEL_MAP: dict[str, str] = {}
for _v in VOCABULARY:
    _LABEL_MAP[_v["id"]] = _v["id"]
    _LABEL_MAP[_v["en"].lower()] = _v["id"]
    for _syn in _v["synonyms"]:
        _LABEL_MAP[_syn.lower()] = _v["id"]

MAX_PLAUSIBLE_ANCHOR_M: float = 100.0
MM_THRESHOLD_M: float = 1000.0
MM_SCALE: float = 1000.0


def now_iso() -> str:
    """Return current UTC timestamp in ISO-8601 seconds resolution."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def strip_diacritics(text: str) -> str:
    """Remove Unicode combining marks (e.g. Czech diacritics) from ``text``."""
    return "".join(
        ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch)
    )


def normalize_label(raw_label: str) -> str:
    """Normalize a raw detector/UI label into a canonical vocabulary ID when matched."""
    cleaned = strip_diacritics(str(raw_label or "")).strip().lower()
    if not cleaned:
        return "other"
    if cleaned in _LABEL_MAP:
        return _LABEL_MAP[cleaned]
    for key, target in _LABEL_MAP.items():
        if key in cleaned or cleaned in key:
            return target
    return re.sub(r"[/\\\s]+", "_", cleaned).strip("_") or "other"


def bearing_for(
    heading_deg: float,
    bbox_norm: list[float] | tuple[float, ...],
    tan_half: float = CAPTURE_TAN_HALF,
    yaw_sign: float = CAPTURE_YAW_SIGN,
) -> tuple[float, float, float]:
    """Compute world yaw & pitch (degrees) and horizontal offset for a normalized 2D bbox [x1,y1,x2,y2]."""
    x1, y1, x2, y2 = (float(bbox_norm[0]), float(bbox_norm[1]), float(bbox_norm[2]), float(bbox_norm[3]))
    cx = 0.5 * (x1 + x2)
    cy = 0.5 * (y1 + y2)
    dx = (cx - 0.5) * 2.0 * tan_half
    dy = (0.5 - cy) * 2.0 * tan_half
    yaw_offset = math.degrees(math.atan(dx))
    pitch_deg = math.degrees(math.atan(dy))
    world_yaw = (heading_deg + yaw_sign * yaw_offset) % 360.0
    return (round(world_yaw, 2), round(pitch_deg, 2), round(yaw_offset, 2))


def ray_direction(yaw_deg: float, pitch_deg: float = 0.0) -> tuple[float, float, float]:
    """Return unit 3D ray vector in Matterport Y-up SDK coordinates from world yaw/pitch."""
    yaw_rad = math.radians(yaw_deg)
    pitch_rad = math.radians(pitch_deg)
    cp = math.cos(pitch_rad)
    dx = -math.sin(yaw_rad) * cp
    dy = math.sin(pitch_rad)
    dz = -math.cos(yaw_rad) * cp
    norm = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    return (dx / norm, dy / norm, dz / norm)


def validate_anchor(
    origin: dict[str, Any] | tuple[float, float, float],
    anchor: dict[str, Any] | tuple[float, float, float],
    max_dist_m: float = MAX_PLAUSIBLE_ANCHOR_M,
) -> float | None:
    """Return Euclidean distance if finite and <= ``max_dist_m``, else ``None``."""
    if isinstance(origin, dict):
        ox, oy, oz = float(origin.get("x", 0.0)), float(origin.get("y", 0.0)), float(origin.get("z", 0.0))
    else:
        ox, oy, oz = float(origin[0]), float(origin[1]), float(origin[2])
    if isinstance(anchor, dict):
        ax, ay, az = float(anchor.get("x", 0.0)), float(anchor.get("y", 0.0)), float(anchor.get("z", 0.0))
    else:
        ax, ay, az = float(anchor[0]), float(anchor[1]), float(anchor[2])
    if not all(math.isfinite(v) for v in (ox, oy, oz, ax, ay, az)):
        return None
    dist = math.sqrt((ax - ox) ** 2 + (ay - oy) ** 2 + (az - oz) ** 2)
    if dist > max_dist_m:
        return None
    return round(dist, 3)


def estimate_distance(
    label: str,
    bbox_norm: list[float] | tuple[float, ...],
    hfov_deg: float = CAPTURE_HFOV,
) -> float:
    """Rough pinhole distance estimate in meters from object bbox height & canonical height."""
    h_norm = max(0.02, abs(float(bbox_norm[3]) - float(bbox_norm[1])))
    vocab = _VOCAB_BY_ID.get(normalize_label(label))
    ref_h = float(vocab["default_height_m"]) if vocab else 0.7
    vfov_rad = math.radians(hfov_deg * 0.65)
    focal_norm = 0.5 / math.tan(0.5 * vfov_rad)
    dist = (ref_h * focal_norm) / h_norm
    return round(max(0.4, min(dist, 15.0)), 2)


def fix_anchor_dict(
    anchor: dict[str, Any],
    origin: dict[str, Any],
    threshold_m: float = MM_THRESHOLD_M,
    scale: float = MM_SCALE,
) -> tuple[dict[str, float], bool]:
    """Scale a millimeter-encoded anchor down to meters when coordinate magnitude exceeds threshold."""
    ax = float(anchor.get("x", 0.0))
    ay = float(anchor.get("y", 0.0))
    az = float(anchor.get("z", 0.0))
    if max(abs(ax), abs(ay), abs(az)) > threshold_m:
        return (
            {
                "x": round(ax / scale, 4),
                "y": round(ay / scale, 4),
                "z": round(az / scale, 4),
            },
            True,
        )
    return ({"x": ax, "y": ay, "z": az}, False)


def _iter_sweep_objects(sweep: dict[str, Any]):
    """Yield `(heading_or_none, obj_dict)` from either flat `detections` or legacy `views[yaw].objects`."""
    for det in sweep.get("detections") or []:
        yield det.get("view_heading"), det
    for yaw_key, view in (sweep.get("views") or {}).items():
        if not isinstance(view, dict):
            continue
        try:
            hdg = int(float(yaw_key)) % 360
        except (TypeError, ValueError):
            hdg = None
        for obj in view.get("objects") or []:
            yield hdg, obj


def normalize_anchor_units_data(
    data: dict[str, Any],
    threshold_m: float = MM_THRESHOLD_M,
    scale: float = MM_SCALE,
) -> tuple[dict[str, Any], dict[str, int]]:
    """Normalize any legacy millimeter detection anchors in ``sweeps`` (detections or views) to meters."""
    sweeps = data.get("sweeps", {}) or {}
    scaled_count = 0
    total_anchors = 0
    rejected_count = 0

    for sweep in sweeps.values():
        origin = sweep.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0}
        for _, det in _iter_sweep_objects(sweep):
            anchor = det.get("anchor")
            if not isinstance(anchor, dict):
                continue
            total_anchors += 1
            fixed, was_scaled = fix_anchor_dict(anchor, origin, threshold_m=threshold_m, scale=scale)
            if was_scaled:
                scaled_count += 1
            det["anchor"] = fixed
            dist = validate_anchor(origin, fixed)
            if dist is None:
                rejected_count += 1
                det.pop("anchor", None)
                det.pop("distance_m", None)
                det.pop("anchor_dist", None)
            else:
                det["distance_m"] = dist

    return data, {
        "total_anchors": total_anchors,
        "scaled_anchors": scaled_count,
        "rejected_anchors": rejected_count,
    }


def cluster_anchor_objects(
    sweeps: dict[str, dict[str, Any]],
    merge_radius: float = MERGE_RADIUS,
    max_anchor_dist_m: float = MAX_PLAUSIBLE_ANCHOR_M,
) -> list[dict[str, Any]]:
    """Aggregate per-sweep anchored detections with matching label within ``merge_radius`` into instances."""
    clusters: list[dict[str, Any]] = []
    r2 = merge_radius * merge_radius

    for sweep_id, sweep in sweeps.items():
        sweep_pos = sweep.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0}
        for hdg, det in _iter_sweep_objects(sweep):
            anchor = det.get("anchor")
            if not isinstance(anchor, dict):
                continue
            if validate_anchor(sweep_pos, anchor, max_dist_m=max_anchor_dist_m) is None:
                continue

            raw_label = det.get("label") or det.get("raw_label") or "other"
            label = normalize_label(raw_label)
            ax = float(anchor.get("x", 0.0))
            ay = float(anchor.get("y", 0.0))
            az = float(anchor.get("z", 0.0))
            score = float(det.get("score") or det.get("conf") or 0.5)

            matched: dict[str, Any] | None = None
            best_d2 = r2
            for cl in clusters:
                if cl["label"] != label:
                    continue
                ca = cl["anchor"]
                d2 = (ca["x"] - ax) ** 2 + (ca["y"] - ay) ** 2 + (ca["z"] - az) ** 2
                if d2 <= best_d2:
                    best_d2 = d2
                    matched = cl

            obs = {
                "sweep_id": sweep_id,
                "score": round(score, 3),
                "distance_m": det.get("distance_m") or det.get("anchor_dist"),
                "yaw": det.get("world_yaw"),
                "pitch": det.get("pitch"),
                "view_heading": hdg if hdg is not None else det.get("view_heading"),
            }
            if matched is None:
                clusters.append(
                    {
                        "label": label,
                        "raw_label": det.get("raw_label", raw_label),
                        "anchor": {"x": round(ax, 4), "y": round(ay, 4), "z": round(az, 4)},
                        "max_score": round(score, 3),
                        "floor": sweep.get("floor"),
                        "observations": [obs],
                    }
                )
            else:
                n = len(matched["observations"])
                ca = matched["anchor"]
                matched["anchor"] = {
                    "x": round((ca["x"] * n + ax) / (n + 1), 4),
                    "y": round((ca["y"] * n + ay) / (n + 1), 4),
                    "z": round((ca["z"] * n + az) / (n + 1), 4),
                }
                matched["max_score"] = round(max(matched["max_score"], score), 3)
                if matched.get("floor") is None and sweep.get("floor") is not None:
                    matched["floor"] = sweep.get("floor")
                matched["observations"].append(obs)

    # Assign stable sequential instance IDs sorted by label & floor
    clusters.sort(key=lambda c: (c["label"], c.get("floor") or "", -c["max_score"]))
    counts: dict[str, int] = {}
    for cl in clusters:
        lbl = cl["label"]
        counts[lbl] = counts.get(lbl, 0) + 1
        cl["instance_id"] = f"{lbl}_{counts[lbl]:03d}"
        cl["observation_count"] = len(cl["observations"])
        cl["sweep_ids"] = sorted({o["sweep_id"] for o in cl["observations"] if o.get("sweep_id")})
    return clusters


def tags_for_sweep(sweep: dict[str, Any], instances: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Build Mattertag-compatible 3D tag payloads for a sweep."""
    sweep_pos = sweep.get("position") or {"x": 0.0, "y": 0.0, "z": 0.0}
    tags: list[dict[str, Any]] = []
    for idx, det in enumerate(sweep.get("detections") or []):
        anchor = det.get("anchor")
        if not isinstance(anchor, dict):
            continue
        tags.append(
            {
                "id": f"det_{idx}",
                "label": det.get("label", "object"),
                "score": det.get("score", 0.0),
                "anchorPosition": anchor,
                "stemVector": {
                    "x": 0.0,
                    "y": 0.25,
                    "z": 0.0,
                },
                "distance_m": det.get("distance_m")
                or validate_anchor(sweep_pos, anchor),
            }
        )
    return tags


class ObjectStore:
    """Thread-safe atomic JSON store for Matterport sweeps, detections, and clustered instances."""

    def __init__(self, path: Path | str | None = None, model_id: str | None = None):
        if path is not None:
            self.path = Path(path)
        else:
            self.path = resolve_paths(model_id or MODEL_ID)["objects"]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._data: dict[str, Any] = self._load()

    def _empty(self) -> dict[str, Any]:
        return {
            "model_id": MODEL_ID,
            "updated_at": now_iso(),
            "sweeps": {},
            "instances": [],
        }

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return self._empty()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw.setdefault("sweeps", {})
                raw.setdefault("instances", [])
                for inst in raw["instances"]:
                    if isinstance(inst, dict):
                        inst["label"] = normalize_label(
                            inst.get("label") or inst.get("raw_label") or "other"
                        )
                return raw
        except Exception:
            pass
        return self._empty()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data["updated_at"] = now_iso()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(self.path)

    def reload(self) -> None:
        """Reload objects.json from disk."""
        with self._lock:
            self._data = self._load()

    def raw(self) -> dict[str, Any]:
        """Return a shallow copy of the root object dictionary."""
        with self._lock:
            return {
                "model_id": self._data.get("model_id", MODEL_ID),
                "updated_at": self._data.get("updated_at"),
                "sweeps": dict(self._data.get("sweeps", {})),
                "instances": list(self._data.get("instances", [])),
            }

    def sweeps(self) -> dict[str, dict[str, Any]]:
        """Return sweep dictionary keyed by sweep_id."""
        with self._lock:
            return dict(self._data.get("sweeps", {}))

    def instances(self, label: str | None = None) -> list[dict[str, Any]]:
        """Return clustered equipment instances, optionally filtered by normalized label."""
        with self._lock:
            insts = list(self._data.get("instances", []))
        if label:
            norm = normalize_label(label)
            insts = [i for i in insts if normalize_label(i.get("label", "")) == norm]
        return insts

    def get_instance(self, instance_id: str) -> dict[str, Any] | None:
        """Return single clustered instance matching ``instance_id``."""
        with self._lock:
            for inst in self._data.get("instances", []):
                if inst.get("instance_id") == instance_id:
                    return dict(inst)
        return None

    def get_sweep(self, sweep_id: str) -> dict[str, Any] | None:
        """Return sweep entry matching ``sweep_id``."""
        with self._lock:
            sw = self._data.get("sweeps", {}).get(sweep_id)
            return dict(sw) if isinstance(sw, dict) else None

    def inventory_summary(self) -> list[dict[str, Any]]:
        """Aggregate counts per equipment label across clustered instances (or unclustered detections)."""
        with self._lock:
            insts = list(self._data.get("instances", []))
            sweeps = dict(self._data.get("sweeps", {}))

        by_label: dict[str, dict[str, Any]] = {}
        if insts:
            for inst in insts:
                lbl = normalize_label(inst.get("label", "other"))
                bucket = by_label.setdefault(
                    lbl,
                    {
                        "label": lbl,
                        "count": 0,
                        "sweeps": set(),
                        "max_score": 0.0,
                        "sample_instance_id": inst.get("instance_id"),
                    },
                )
                bucket["count"] += 1
                bucket["max_score"] = max(bucket["max_score"], float(inst.get("max_score", 0.0)))
                for sid in inst.get("sweep_ids", []):
                    bucket["sweeps"].add(sid)
        else:
            for sid, sw in sweeps.items():
                for det in sw.get("detections") or []:
                    lbl = normalize_label(det.get("label", "other"))
                    bucket = by_label.setdefault(
                        lbl,
                        {
                            "label": lbl,
                            "count": 0,
                            "sweeps": set(),
                            "max_score": 0.0,
                            "sample_instance_id": None,
                        },
                    )
                    bucket["count"] += 1
                    bucket["max_score"] = max(bucket["max_score"], float(det.get("score", 0.0)))
                    bucket["sweeps"].add(sid)

        rows = []
        for lbl, b in by_label.items():
            vocab = _VOCAB_BY_ID.get(lbl, {})
            rows.append(
                {
                    "label": lbl,
                    "cz": vocab.get("cz", lbl),
                    "en": vocab.get("en", lbl),
                    "count": b["count"],
                    "sweep_count": len(b["sweeps"]),
                    "max_score": round(b["max_score"], 3),
                    "sample_instance_id": b["sample_instance_id"],
                }
            )
        rows.sort(key=lambda r: (-r["count"], r["label"]))
        return rows

    def recompute_clusters(self, merge_radius: float = MERGE_RADIUS) -> int:
        """Re-run unit normalization + spatial clustering and persist updated instances."""
        with self._lock:
            self._data, _ = normalize_anchor_units_data(self._data)
            sweeps = self._data.get("sweeps", {}) or {}
            instances = cluster_anchor_objects(sweeps, merge_radius=merge_radius)
            self._data["instances"] = instances
            self._save()
            return len(instances)

    def upsert_sweep_detections(
        self,
        sweep_id: str,
        sweep_meta: dict[str, Any],
        detections: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Store or update detections for a sweep and recompute clustered instances."""
        with self._lock:
            sweeps = self._data.setdefault("sweeps", {})
            existing = sweeps.get(sweep_id, {})
            entry = {
                **existing,
                **sweep_meta,
                "detections": detections,
                "updated_at": now_iso(),
            }
            sweeps[sweep_id] = entry
            self._data["instances"] = cluster_anchor_objects(sweeps, merge_radius=MERGE_RADIUS)
            self._save()
            return dict(entry)
