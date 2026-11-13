"""Coordinate transform & floor/room enrichment bridging Matterport SDK and scan2floor 3D/2D."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import PROCESSED_DIR, SAVES_DIR


@dataclass
class S2fContext:
    """Loaded scan2floor scene metadata (centroid, floor elevations, and room polygons)."""

    centroid_xy: tuple[float, float] = (0.0, 0.0)
    floor_levels: list[float] = field(default_factory=list)
    rooms_by_floor: dict[int, list[dict[str, Any]]] = field(default_factory=dict)


def _point_in_polygon(px: float, pz: float, polygon: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test in XZ coordinates."""
    if len(polygon) < 3:
        return False
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, zi = float(polygon[i][0]), float(polygon[i][1])
        xj, zj = float(polygon[j][0]), float(polygon[j][1])
        intersect = ((zi > pz) != (zj > pz)) and (
            px < (xj - xi) * (pz - zi) / ((zj - zi) or 1e-12) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


def _polygon_centroid(polygon: list[list[float]]) -> tuple[float, float]:
    if not polygon:
        return (0.0, 0.0)
    xs = [float(p[0]) for p in polygon]
    zs = [float(p[1]) for p in polygon]
    return (sum(xs) / len(xs), sum(zs) / len(zs))


def _dist2_to_polygon(px: float, pz: float, polygon: list[list[float]]) -> float:
    cx, cz = _polygon_centroid(polygon)
    return (px - cx) ** 2 + (pz - cz) ** 2


def load_s2f_context(save_name: str | None = None) -> S2fContext:
    """Load centroid_xy, floor_levels, and rooms_floor_*.json from processed/ or saves/<name>/."""
    base_dir = (SAVES_DIR / save_name) if save_name else PROCESSED_DIR
    ctx = S2fContext()
    info_path = base_dir / "info.json"
    if info_path.is_file():
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            cxy = info.get("centroid_xy") or [0.0, 0.0]
            if len(cxy) >= 2:
                ctx.centroid_xy = (float(cxy[0]), float(cxy[1]))
            levels = info.get("floor_levels") or []
            ctx.floor_levels = [float(v) for v in levels]
        except Exception:
            pass

    if base_dir.is_dir():
        for name in sorted(os.listdir(base_dir)):
            if name.startswith("rooms_floor_") and name.endswith(".json"):
                try:
                    idx = int(name[len("rooms_floor_") : -len(".json")])
                    data = json.loads((base_dir / name).read_text(encoding="utf-8"))
                    rooms = data.get("rooms", []) if isinstance(data, dict) else []
                    ctx.rooms_by_floor[idx] = rooms
                except Exception:
                    continue
    return ctx


def mp_to_s2f(pos: dict[str, Any] | tuple[float, float, float], ctx: S2fContext) -> dict[str, float]:
    """Transform Matterport SDK Y-up position into centered scan2floor Three.js space.

    Cloud preprocessing stores ``(x_cloud - cx, z_cloud_up, -(y_cloud - cy))``,
    and Matterport SDK already gives ``(x_mp, y_up_mp, z_mp) == (x_cloud, z_cloud_up, -y_cloud)``.
    Therefore ``x_s2f = x_mp - cx``, ``y_s2f = y_mp``, ``z_s2f = z_mp + cy``.
    """
    if isinstance(pos, dict):
        x = float(pos.get("x", 0.0))
        y = float(pos.get("y", 0.0))
        z = float(pos.get("z", 0.0))
    else:
        x, y, z = float(pos[0]), float(pos[1]), float(pos[2])
    cx, cy = ctx.centroid_xy
    return {
        "x": round(x - cx, 4),
        "y": round(y, 4),
        "z": round(z + cy, 4),
    }


def s2f_to_mp(pos: dict[str, Any] | tuple[float, float, float], ctx: S2fContext) -> dict[str, float]:
    """Inverse transform from scan2floor centered Three.js space to Matterport SDK Y-up space."""
    if isinstance(pos, dict):
        x = float(pos.get("x", 0.0))
        y = float(pos.get("y", 0.0))
        z = float(pos.get("z", 0.0))
    else:
        x, y, z = float(pos[0]), float(pos[1]), float(pos[2])
    cx, cy = ctx.centroid_xy
    return {
        "x": round(x + cx, 4),
        "y": round(y, 4),
        "z": round(z - cy, 4),
    }


def assign_floor_idx(y_s2f: float, floor_levels: list[float]) -> int | None:
    """Assign a 3D Y elevation to the matching scan2floor floor index via midpoint boundaries."""
    if not floor_levels:
        return None
    indexed = sorted(enumerate(floor_levels), key=lambda kv: kv[1])
    if len(indexed) == 1:
        return indexed[0][0]
    for i in range(len(indexed) - 1):
        midpoint = 0.5 * (indexed[i][1] + indexed[i + 1][1])
        if y_s2f < midpoint:
            return indexed[i][0]
    return indexed[-1][0]


def assign_room_id(
    x_s2f: float,
    z_s2f: float,
    floor_idx: int | None,
    rooms_by_floor: dict[int, list[dict[str, Any]]],
    tolerance_m: float = 0.75,
) -> tuple[str | None, str | None]:
    """Return ``(room_id, room_name)`` containing ``(x_s2f, z_s2f)`` on ``floor_idx``."""
    if floor_idx is None:
        return (None, None)
    rooms = rooms_by_floor.get(floor_idx, [])
    for room in rooms:
        poly = room.get("polygon_xz") or []
        if _point_in_polygon(x_s2f, z_s2f, poly):
            rid = str(room.get("id", "")) or None
            name = room.get("name") or room.get("label") or rid
            return (rid, name)

    # Fallback: closest room centroid within tolerance_m (objects near walls/doorways)
    best: tuple[float, dict[str, Any]] | None = None
    tol2 = tolerance_m * tolerance_m
    for room in rooms:
        poly = room.get("polygon_xz") or []
        if not poly:
            continue
        d2 = _dist2_to_polygon(x_s2f, z_s2f, poly)
        if best is None or d2 < best[0]:
            best = (d2, room)
    if best is not None and best[0] <= max(tol2, 4.0):
        # Only snap if bounding box is close
        poly = best[1].get("polygon_xz") or []
        xs = [float(p[0]) for p in poly]
        zs = [float(p[1]) for p in poly]
        if (
            min(xs) - tolerance_m <= x_s2f <= max(xs) + tolerance_m
            and min(zs) - tolerance_m <= z_s2f <= max(zs) + tolerance_m
        ):
            rid = str(best[1].get("id", "")) or None
            name = best[1].get("name") or best[1].get("label") or rid
            return (rid, name)
    return (None, None)


def enrich_point(point: dict[str, Any], ctx: S2fContext) -> dict[str, Any]:
    """Return a copy of a Matterport viewpoint enriched with ``s2f_position``, ``floor_idx``, ``room_id``."""
    out = dict(point)
    pos = point.get("position") or {}
    s2f = mp_to_s2f(pos, ctx)
    floor_idx = assign_floor_idx(s2f["y"], ctx.floor_levels)
    room_id, room_name = assign_room_id(s2f["x"], s2f["z"], floor_idx, ctx.rooms_by_floor)
    out["s2f_position"] = s2f
    out["floor_idx"] = floor_idx
    out["room_id"] = room_id
    if room_name:
        out["room_name"] = room_name
    return out


def enrich_instance(instance: dict[str, Any], ctx: S2fContext) -> dict[str, Any]:
    """Return a copy of a Matterport object instance enriched with ``s2f_position``, ``floor_idx``, ``room_id``."""
    out = dict(instance)
    pos = instance.get("anchor") or instance.get("position") or {}
    s2f = mp_to_s2f(pos, ctx)
    floor_idx = assign_floor_idx(s2f["y"], ctx.floor_levels)
    room_id, room_name = assign_room_id(s2f["x"], s2f["z"], floor_idx, ctx.rooms_by_floor)
    out["s2f_position"] = s2f
    out["floor_idx"] = floor_idx
    out["room_id"] = room_id
    if room_name:
        out["room_name"] = room_name
    return out


def enrich_sweep(sweep_id: str, sweep: dict[str, Any], ctx: S2fContext) -> dict[str, Any]:
    """Return an enriched sweep summary with ``s2f_position``, ``floor_idx``, ``room_id``, and detections."""
    out = dict(sweep)
    out["sweep_id"] = sweep_id
    pos = sweep.get("position") or {}
    s2f = mp_to_s2f(pos, ctx)
    floor_idx = assign_floor_idx(s2f["y"], ctx.floor_levels)
    room_id, room_name = assign_room_id(s2f["x"], s2f["z"], floor_idx, ctx.rooms_by_floor)
    out["s2f_position"] = s2f
    out["floor_idx"] = floor_idx
    out["room_id"] = room_id
    if room_name:
        out["room_name"] = room_name
    # Enrich individual sweep detection anchors from either flat detections or views[yaw].objects
    dets = []
    for d in sweep.get("detections") or []:
        d_copy = dict(d)
        if isinstance(d.get("anchor"), dict):
            d_copy["s2f_anchor"] = mp_to_s2f(d["anchor"], ctx)
        dets.append(d_copy)
    if not dets and isinstance(sweep.get("views"), dict):
        for yaw_key, view in sweep["views"].items():
            for d in (view or {}).get("objects") or []:
                d_copy = dict(d)
                d_copy.setdefault("view_heading", yaw_key)
                if isinstance(d.get("anchor"), dict):
                    d_copy["s2f_anchor"] = mp_to_s2f(d["anchor"], ctx)
                dets.append(d_copy)
    out["detections"] = dets
    return out


def load_mp_instances_for_dir(data_dir: str | Path, floor_idx: int) -> list[dict[str, Any]]:
    """Load enriched Matterport instances assigned to ``floor_idx`` for ``processed_dir`` or a save folder."""
    from .config import MODEL_ID, resolve_paths

    base_dir = Path(data_dir)
    obj_path = base_dir / "mp_objects.json"
    if not obj_path.is_file():
        # Only fall back to active processed matterport store if not an explicit save missing mp_objects.json
        if (base_dir / "meta.json").is_file():
            return []
        obj_path = resolve_paths(MODEL_ID)["objects"]
    if not obj_path.is_file():
        return []

    try:
        raw = json.loads(obj_path.read_text(encoding="utf-8"))
        instances = raw.get("instances") or []
    except Exception:
        return []

    ctx = S2fContext()
    info_path = base_dir / "info.json"
    if info_path.is_file():
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            cxy = info.get("centroid_xy") or [0.0, 0.0]
            if len(cxy) >= 2:
                ctx.centroid_xy = (float(cxy[0]), float(cxy[1]))
            ctx.floor_levels = [
                float(lv.get("y", lv) if isinstance(lv, dict) else lv)
                for lv in (info.get("floor_levels") or [])
            ]
        except Exception:
            pass

    if base_dir.is_dir():
        for name in sorted(os.listdir(base_dir)):
            if name.startswith("rooms_floor_") and name.endswith(".json"):
                try:
                    idx = int(name[len("rooms_floor_") : -len(".json")])
                    rdata = json.loads((base_dir / name).read_text(encoding="utf-8"))
                    ctx.rooms_by_floor[idx] = rdata.get("rooms", []) if isinstance(rdata, dict) else []
                except Exception:
                    continue

    out: list[dict[str, Any]] = []
    for inst in instances:
        if not isinstance(inst.get("anchor"), dict):
            continue
        enriched = enrich_instance(inst, ctx)
        if enriched.get("floor_idx") == floor_idx:
            out.append(enriched)
    return out

