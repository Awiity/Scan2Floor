"""Coordinate transform & floor/room enrichment bridging Matterport SDK and scan2floor 3D/2D."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import PROCESSED_DIR, SAVES_DIR

DEFAULT_FLOOR_LEVELS: list[float] = [-1.5141, 1.0359, 4.1859]


@dataclass
class S2fContext:
    """Loaded scan2floor scene metadata (centroid, floor elevations, and room polygons)."""

    centroid_xy: tuple[float, float] = (0.0, 0.0)
    floor_levels: list[float] = field(default_factory=list)
    rooms_by_floor: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    wall_bounds_by_floor: dict[int, tuple[float, float, float, float]] = field(default_factory=dict)
    walls_by_floor: dict[int, list[tuple[float, float, float, float, float]]] = field(default_factory=dict)
    sweep_floor_by_id: dict[str, int] = field(default_factory=dict)
    sweeps_s2f_by_id: dict[str, dict[str, float]] = field(default_factory=dict)


def _room_polygon(room: dict[str, Any]) -> list[list[float]]:
    """Extract room polygon in XZ coordinates, falling back to bbox corners."""
    poly = room.get("polygon") or room.get("polygon_xz") or []
    if poly:
        return poly
    bbox = room.get("bbox")
    if isinstance(bbox, dict) and all(k in bbox for k in ("x_min", "x_max", "z_min", "z_max")):
        return [
            [bbox["x_min"], bbox["z_min"]],
            [bbox["x_max"], bbox["z_min"]],
            [bbox["x_max"], bbox["z_max"]],
            [bbox["x_min"], bbox["z_max"]],
        ]
    return []


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


def _load_floor_spatial_data(ctx: S2fContext, base_dir: Path) -> None:
    """Populate rooms_by_floor and wall_bounds_by_floor from base_dir."""
    if not base_dir.is_dir():
        return
    bounds_pts: dict[int, tuple[list[float], list[float]]] = {}

    def _add_pt(fi: int, x: float, z: float) -> None:
        xs, zs = bounds_pts.setdefault(fi, ([], []))
        xs.append(x)
        zs.append(z)

    for name in sorted(os.listdir(base_dir)):
        if name.startswith("rooms_floor_") and name.endswith(".json"):
            try:
                idx = int(name[len("rooms_floor_") : -len(".json")])
                data = json.loads((base_dir / name).read_text(encoding="utf-8"))
                rooms = data.get("rooms", []) if isinstance(data, dict) else []
                ctx.rooms_by_floor[idx] = rooms
                for rm in rooms:
                    for pt in _room_polygon(rm):
                        if len(pt) >= 2:
                            _add_pt(idx, float(pt[0]), float(pt[1]))
            except Exception:
                continue
        elif name.startswith("walls_floor_") and name.endswith(".json"):
            try:
                idx = int(name[len("walls_floor_") : -len(".json")])
                data = json.loads((base_dir / name).read_text(encoding="utf-8"))
                raw_lines = data.get("lines", []) if isinstance(data, dict) else []
                thicks = data.get("thicknesses", []) if isinstance(data, dict) else []
                floor_walls: list[tuple[float, float, float, float, float]] = []
                for wi, seg in enumerate(raw_lines):
                    if isinstance(seg, list) and len(seg) >= 2:
                        p0, p1 = seg[0], seg[1]
                        if (
                            isinstance(p0, (list, tuple))
                            and isinstance(p1, (list, tuple))
                            and len(p0) >= 2
                            and len(p1) >= 2
                        ):
                            x1, z1 = float(p0[0]), float(p0[1])
                            x2, z2 = float(p1[0]), float(p1[1])
                            _add_pt(idx, x1, z1)
                            _add_pt(idx, x2, z2)
                            tv = 0.20
                            if isinstance(thicks, list) and wi < len(thicks):
                                try:
                                    cand_t = float(thicks[wi])
                                    if math.isfinite(cand_t) and cand_t > 0.02:
                                        tv = cand_t
                                except (TypeError, ValueError):
                                    pass
                            floor_walls.append((x1, z1, x2, z2, tv))
                ctx.walls_by_floor[idx] = floor_walls
            except Exception:
                continue

    for idx, (xs, zs) in bounds_pts.items():
        if xs and zs:
            ctx.wall_bounds_by_floor[idx] = (min(xs), max(xs), min(zs), max(zs))


def _populate_sweeps(ctx: S2fContext, sweeps: dict[str, Any]) -> None:
    """Pre-populate ctx.sweep_floor_by_id and ctx.sweeps_s2f_by_id from raw sweep dicts."""
    if not isinstance(sweeps, dict):
        return
    levels = ctx.floor_levels or DEFAULT_FLOOR_LEVELS
    for sid, sw in sweeps.items():
        if not isinstance(sw, dict):
            continue
        pos = sw.get("position")
        if not isinstance(pos, dict):
            continue
        s2f = mp_to_s2f(pos, ctx)
        ctx.sweeps_s2f_by_id[sid] = s2f
        fidx = assign_floor_idx(s2f["y"], levels)
        if fidx is not None:
            ctx.sweep_floor_by_id[sid] = fidx


def load_s2f_context(save_name: str | None = None) -> S2fContext:
    """Load centroid_xy, floor_levels, rooms, wall bounds, and sweep floors from processed/ or saves/<name>/."""
    from .config import MODEL_ID, resolve_paths

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
            ctx.floor_levels = [
                float(lv.get("y", lv) if isinstance(lv, dict) else lv)
                for lv in levels
            ]
        except Exception:
            pass

    _load_floor_spatial_data(ctx, base_dir)

    obj_path = (base_dir / "mp_objects.json") if save_name else resolve_paths(MODEL_ID)["objects"]
    if obj_path.is_file():
        try:
            raw = json.loads(obj_path.read_text(encoding="utf-8"))
            _populate_sweeps(ctx, raw.get("sweeps") or {})
        except Exception:
            pass

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
    """Assign a 3D Y elevation to the matching scan2floor floor slab index."""
    if not floor_levels:
        return None
    indexed = sorted(enumerate(floor_levels), key=lambda kv: kv[1])
    chosen = indexed[0][0]
    for idx, lv in indexed:
        if y_s2f >= lv - 0.15:
            chosen = idx
    return chosen


def _floor_y_band(floor_idx: int, floor_levels: list[float]) -> tuple[float, float] | None:
    """Return (floor_y, ceil_y) elevation bounds for floor_idx."""
    if not floor_levels:
        return None
    indexed = sorted(enumerate(floor_levels), key=lambda kv: kv[1])
    for pos_i, (idx, lv) in enumerate(indexed):
        if idx == floor_idx:
            ceil_y = indexed[pos_i + 1][1] if pos_i + 1 < len(indexed) else lv + 3.0
            return (lv, ceil_y)
    return None


def _sweep_voted_floor(instance: dict[str, Any], sweep_floor_by_id: dict[str, int]) -> int | None:
    """Pick the floor index with highest observation score (or count) across observing sweeps."""
    if not sweep_floor_by_id:
        return None
    scores: dict[int, float] = {}
    for obs in instance.get("observations") or []:
        if not isinstance(obs, dict):
            continue
        f = sweep_floor_by_id.get(obs.get("sweep_id"))
        if f is not None:
            scores[f] = scores.get(f, 0.0) + max(0.01, float(obs.get("score") or 0.0))
    if not scores:
        for sid in instance.get("sweep_ids") or []:
            f = sweep_floor_by_id.get(sid)
            if f is not None:
                scores[f] = scores.get(f, 0.0) + 1.0
    if not scores:
        return None
    return max(scores.items(), key=lambda kv: kv[1])[0]


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
        poly = _room_polygon(room)
        if _point_in_polygon(x_s2f, z_s2f, poly):
            rid = str(room.get("id", "")) or None
            name = room.get("name") or room.get("label") or rid
            return (rid, name)

    # Fallback: closest room centroid within tolerance_m (objects near walls/doorways)
    best: tuple[float, dict[str, Any], list[list[float]]] | None = None
    tol2 = tolerance_m * tolerance_m
    for room in rooms:
        poly = _room_polygon(room)
        if not poly:
            continue
        d2 = _dist2_to_polygon(x_s2f, z_s2f, poly)
        if best is None or d2 < best[0]:
            best = (d2, room, poly)
    if best is not None and best[0] <= max(tol2, 4.0):
        # Only snap if bounding box is close
        poly = best[2]
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
    sid = point.get("sweep_id")
    floor_idx = ctx.sweep_floor_by_id.get(sid) if sid else None
    if floor_idx is None:
        floor_idx = assign_floor_idx(s2f["y"], ctx.floor_levels)
    room_id, room_name = assign_room_id(s2f["x"], s2f["z"], floor_idx, ctx.rooms_by_floor)
    out["s2f_position"] = s2f
    out["floor_idx"] = floor_idx
    out["room_id"] = room_id
    if room_name:
        out["room_name"] = room_name
    return out


def _best_observing_sweep_pos(
    instance: dict[str, Any],
    sweeps_s2f_by_id: dict[str, dict[str, float]],
) -> dict[str, float] | None:
    """Return the s2f position of the highest-confidence observing sweep."""
    obs = sorted(
        (o for o in (instance.get("observations") or []) if isinstance(o, dict)),
        key=lambda o: (-float(o.get("score") or 0.0), float(o.get("distance_m") or 99.0)),
    )
    for o in obs:
        pos = sweeps_s2f_by_id.get(str(o.get("sweep_id") or ""))
        if pos is not None:
            return pos
    for sid in instance.get("sweep_ids") or []:
        pos = sweeps_s2f_by_id.get(str(sid))
        if pos is not None:
            return pos
    return None


def _nearest_wall_match(
    px: float,
    pz: float,
    walls: list[tuple[float, float, float, float, float]],
    max_dist_m: float,
) -> tuple[float, int, float, float, float, float, float, float, float] | None:
    """Return closest wall match within ``max_dist_m`` as (dist, wall_idx, proj_x, proj_z, x1, z1, x2, z2, thick)."""
    best: tuple[float, int, float, float, float, float, float, float, float] | None = None
    for wi, (x1, z1, x2, z2, thick) in enumerate(walls):
        dx = x2 - x1
        dz = z2 - z1
        l2 = dx * dx + dz * dz
        if l2 < 1e-8:
            continue
        t = max(0.0, min(1.0, ((px - x1) * dx + (pz - z1) * dz) / l2))
        proj_x = x1 + t * dx
        proj_z = z1 + t * dz
        dist = math.hypot(px - proj_x, pz - proj_z)
        if dist <= max_dist_m and (best is None or dist < best[0]):
            best = (dist, wi, proj_x, proj_z, x1, z1, x2, z2, thick)
    return best


def compute_equipment_snap(
    instance: dict[str, Any],
    s2f: dict[str, float],
    floor_idx: int | None,
    ctx: S2fContext,
) -> dict[str, Any]:
    """Compute realistic wall/ceiling-snapped 3D coordinates and orientation for equipment."""
    from .objects import normalize_label

    levels = ctx.floor_levels or DEFAULT_FLOOR_LEVELS
    if floor_idx is None:
        return {
            "snapped_s2f_position": dict(s2f),
            "rotation_y": 0.0,
            "mount_type": "free",
            "wall_idx": None,
            "floor_y": None,
            "ceil_y": None,
        }

    band = _floor_y_band(floor_idx, levels)
    if band is None:
        floor_y = round(float(levels[0]), 4)
        ceil_y = round(floor_y + 2.8, 4)
    else:
        floor_y = round(float(band[0]), 4)
        ceil_y = round(float(band[1]), 4)

    label = normalize_label(instance.get("label") or instance.get("raw_label") or "other")
    walls = ctx.walls_by_floor.get(floor_idx, [])
    obs_pos = _best_observing_sweep_pos(instance, ctx.sweeps_s2f_by_id)

    sx, sy, sz = float(s2f["x"]), float(s2f["y"]), float(s2f["z"])
    rot_y = 0.0
    mount_type = "detected"
    wall_idx: int | None = None

    if label in {"hasici_pristroj", "nouzove_osvetleni"}:
        match = _nearest_wall_match(sx, sz, walls, max_dist_m=1.20)
        if label == "hasici_pristroj":
            sy = round(min(ceil_y - 0.35, floor_y + 0.90), 4)
            wall_offset = 0.10
        else:
            sy = round(min(ceil_y - 0.35, floor_y + 2.25), 4)
            wall_offset = 0.06

        if match is not None:
            _, wall_idx, proj_x, proj_z, x1, z1, x2, z2, thick = match
            wlen = math.hypot(x2 - x1, z2 - z1) or 1.0
            ux, uz = (x2 - x1) / wlen, (z2 - z1) / wlen
            nx, nz = -uz, ux
            ref = obs_pos if obs_pos is not None else s2f
            if (float(ref["x"]) - proj_x) * nx + (float(ref["z"]) - proj_z) * nz < 0.0:
                nx, nz = -nx, -nz
            off = thick / 2.0 + wall_offset
            sx = round(proj_x + nx * off, 4)
            sz = round(proj_z + nz * off, 4)
            rot_y = round(math.degrees(math.atan2(nx, nz)) % 360.0, 2)
            mount_type = "wall"
        elif label == "hasici_pristroj":
            mount_type = "floor"
            if obs_pos is not None:
                dx = float(obs_pos["x"]) - sx
                dz = float(obs_pos["z"]) - sz
                if math.hypot(dx, dz) > 0.05:
                    rot_y = round(math.degrees(math.atan2(dx, dz)) % 360.0, 2)
        else:
            mount_type = "ceiling"
            sy = round(ceil_y - 0.08, 4)
            near_wall = _nearest_wall_match(sx, sz, walls, max_dist_m=4.0)
            if near_wall is not None:
                _, wall_idx, _, _, x1, z1, x2, z2, _ = near_wall
                rot_y = round(math.degrees(-math.atan2(z2 - z1, x2 - x1)) % 360.0, 2)
    elif label == "svitidlo":
        mount_type = "ceiling"
        sy = round(ceil_y - 0.05, 4)
        near_wall = _nearest_wall_match(sx, sz, walls, max_dist_m=4.0)
        if near_wall is not None:
            _, wall_idx, _, _, x1, z1, x2, z2, _ = near_wall
            rot_y = round(math.degrees(-math.atan2(z2 - z1, x2 - x1)) % 360.0, 2)

    return {
        "snapped_s2f_position": {"x": round(sx, 4), "y": round(sy, 4), "z": round(sz, 4)},
        "rotation_y": rot_y,
        "mount_type": mount_type,
        "wall_idx": wall_idx,
        "floor_y": floor_y,
        "ceil_y": ceil_y,
    }


def enrich_instance(instance: dict[str, Any], ctx: S2fContext) -> dict[str, Any]:
    """Return a copy of a Matterport object instance enriched with ``s2f_position``, ``floor_idx``, ``room_id``, and snapped placement."""
    from .objects import normalize_label

    out = dict(instance)
    out["label"] = normalize_label(out.get("label") or out.get("raw_label") or "other")
    pos = instance.get("anchor") or instance.get("position") or {}
    s2f = mp_to_s2f(pos, ctx)
    levels = ctx.floor_levels or DEFAULT_FLOOR_LEVELS
    floor_idx = _sweep_voted_floor(instance, ctx.sweep_floor_by_id)
    if floor_idx is None:
        floor_idx = assign_floor_idx(s2f["y"], levels)

    # Reject extreme raycast outliers > 25 m from all observing sweeps
    obs_sids = [
        str(o.get("sweep_id"))
        for o in (instance.get("observations") or [])
        if isinstance(o, dict) and o.get("sweep_id")
    ] + [str(sid) for sid in (instance.get("sweep_ids") or []) if sid]
    obs_positions = [ctx.sweeps_s2f_by_id[sid] for sid in obs_sids if sid in ctx.sweeps_s2f_by_id]
    if obs_positions:
        min_d = min(
            math.sqrt(
                (s2f["x"] - sp["x"]) ** 2
                + (s2f["y"] - sp["y"]) ** 2
                + (s2f["z"] - sp["z"]) ** 2
            )
            for sp in obs_positions
        )
        if min_d > 25.0:
            floor_idx = None

    # Clamp 3D marker elevation into its assigned storey band
    if floor_idx is not None:
        band = _floor_y_band(floor_idx, levels)
        if band is not None:
            lo = band[0] + 0.08
            hi = max(lo, band[1] - 0.12)
            s2f["y"] = round(min(max(s2f["y"], lo), hi), 4)

    snap_info = compute_equipment_snap(instance, s2f, floor_idx, ctx)
    snap_pos = snap_info["snapped_s2f_position"]
    room_id, room_name = assign_room_id(snap_pos["x"], snap_pos["z"], floor_idx, ctx.rooms_by_floor)
    out["s2f_position"] = s2f
    out["snapped_s2f_position"] = snap_pos
    out["rotation_y"] = snap_info["rotation_y"]
    out["mount_type"] = snap_info["mount_type"]
    out["wall_idx"] = snap_info["wall_idx"]
    out["floor_y"] = snap_info["floor_y"]
    out["ceil_y"] = snap_info["ceil_y"]
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
    floor_idx = assign_floor_idx(s2f["y"], ctx.floor_levels or DEFAULT_FLOOR_LEVELS)
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

    _load_floor_spatial_data(ctx, base_dir)
    _populate_sweeps(ctx, raw.get("sweeps") or {})

    out: list[dict[str, Any]] = []
    for inst in instances:
        if not isinstance(inst.get("anchor"), dict):
            continue
        enriched = enrich_instance(inst, ctx)
        if enriched.get("floor_idx") == floor_idx:
            out.append(enriched)
    return out


def load_placed_or_mp_equipment(data_dir: str | Path, floor_idx: int) -> list[dict[str, Any]]:
    """Return placed equipment from ``equipment_floor_<N>.json`` if present, else Matterport instances."""
    from .objects import SUPPORTED_EQUIPMENT_LABELS

    base_dir = Path(data_dir)
    eq_path = base_dir / f"equipment_floor_{floor_idx}.json"
    if eq_path.is_file():
        try:
            raw = json.loads(eq_path.read_text(encoding="utf-8"))
            items = raw.get("items") if isinstance(raw, dict) else None
            if isinstance(items, list):
                out: list[dict[str, Any]] = []
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    copy_it = dict(it)
                    if "x" in it and "y" in it and "z" in it:
                        copy_it["s2f_position"] = {
                            "x": float(it["x"]),
                            "y": float(it["y"]),
                            "z": float(it["z"]),
                        }
                    out.append(copy_it)
                return out
        except Exception:
            pass

    return [
        inst
        for inst in load_mp_instances_for_dir(base_dir, floor_idx)
        if inst.get("label") in SUPPORTED_EQUIPMENT_LABELS
    ]

