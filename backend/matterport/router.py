"""FastAPI APIRouter and WebSocket hub for /api/mp/* Matterport & BIM object integration."""

from __future__ import annotations

import asyncio
import math
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import (
    APPLICATION_KEY,
    MODEL_ID,
    bootstrap_model_data,
    resolve_paths,
)
from .coords import (
    S2fContext,
    enrich_instance,
    enrich_point,
    enrich_sweep,
    load_s2f_context,
    mp_to_s2f,
    s2f_to_mp,
)
from .objects import ObjectStore, VOCABULARY, normalize_label, tags_for_sweep
from .points import PointStore
from .registry_sync import push_after_change
from .tools.export_ifc import export_to_ifc

router = APIRouter(prefix="/api/mp", tags=["matterport"])


class Position(BaseModel):
    x: float
    y: float
    z: float


class Rotation(BaseModel):
    x: float = 0.0
    y: float = 0.0


class MoveRequest(BaseModel):
    position: Position | None = None
    s2f_position: Position | None = None
    rotation: Rotation | None = None
    sweep_id: str | None = None
    transition: str | None = "fly"
    save_name: str | None = None


class PointCreateRequest(BaseModel):
    name: str
    note: str = ""
    position: Position | None = None
    s2f_position: Position | None = None
    rotation: Rotation | None = None
    sweep_id: str | None = None
    floor: Any = None
    save_name: str | None = None


class ConnectionManager:
    """In-process WebSocket fan-out and latest-pose tracker for Showcase <-> 3D/2D sync."""

    def __init__(self) -> None:
        self._clients: list[WebSocket] = []
        self._lock = asyncio.Lock()
        self.latest_pose: dict[str, Any] | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.append(ws)
        if self.latest_pose is not None:
            try:
                await ws.send_json({"type": "pose", **self.latest_pose})
            except Exception:
                pass

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients = [c for c in self._clients if c is not ws]

    async def broadcast(self, message: dict[str, Any], exclude: WebSocket | None = None) -> None:
        async with self._lock:
            clients = list(self._clients)
        stale: list[WebSocket] = []
        for ws in clients:
            if ws is exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                stale.append(ws)
        if stale:
            async with self._lock:
                self._clients = [c for c in self._clients if c not in stale]


manager = ConnectionManager()
_STORE_CACHE: dict[tuple[str, str | None], tuple[PointStore, ObjectStore]] = {}


def get_stores(
    model_id: str | None = None,
    save_name: str | None = None,
) -> tuple[PointStore, ObjectStore, str]:
    """Return cached PointStore and ObjectStore for ``(model_id, save_name)``."""
    mid = (model_id or MODEL_ID).strip() or MODEL_ID
    key = (mid, save_name or None)
    if save_name is None and key not in _STORE_CACHE:
        bootstrap_model_data(mid)
    paths = resolve_paths(mid, save_name=save_name)
    stores = _STORE_CACHE.get(key)
    if stores is None:
        ps = PointStore(path=paths["points"], model_id=mid)
        os_store = ObjectStore(path=paths["objects"], model_id=mid)
        stores = (ps, os_store)
        _STORE_CACHE[key] = stores
    elif save_name is not None:
        # Refresh read-only save snapshots if overwritten
        stores[0].reload()
        stores[1].reload()
    return stores[0], stores[1], mid


def invalidate_store_cache(save_name: str | None = None) -> None:
    """Drop cached stores (e.g. after saving a snapshot or editing JSON externally)."""
    if save_name is None:
        _STORE_CACHE.clear()
    else:
        for k in [k for k in _STORE_CACHE if k[1] == save_name]:
            _STORE_CACHE.pop(k, None)


def _pose_with_s2f(pos: dict[str, Any], ctx: S2fContext) -> dict[str, Any]:
    s2f = mp_to_s2f(pos, ctx)
    from .coords import assign_floor_idx, assign_room_id

    fidx = assign_floor_idx(s2f["y"], ctx.floor_levels)
    rid, rname = assign_room_id(s2f["x"], s2f["z"], fidx, ctx.rooms_by_floor)
    return {
        "s2f_position": s2f,
        "floor_idx": fidx,
        "room_id": rid,
        "room_name": rname,
    }


def _yaw_pitch_between(origin: dict[str, Any], target: dict[str, Any]) -> tuple[float, float]:
    """Compute Matterport SDK look rotation (x=pitch_deg, y=yaw_deg) from ``origin`` to ``target``."""
    dx = float(target.get("x", 0.0)) - float(origin.get("x", 0.0))
    dy = float(target.get("y", 0.0)) - float(origin.get("y", 0.0))
    dz = float(target.get("z", 0.0)) - float(origin.get("z", 0.0))
    horiz = math.hypot(dx, dz) or 1e-6
    yaw = math.degrees(math.atan2(-dx, -dz)) % 360.0
    pitch = max(-60.0, min(60.0, math.degrees(math.atan2(dy, horiz))))
    return (round(pitch, 2), round(yaw, 2))


@router.get("/health")
def mp_health(save_name: str | None = Query(default=None)) -> dict[str, Any]:
    ps, os_store, mid = get_stores(save_name=save_name)
    return {
        "status": "ok",
        "model_id": mid,
        "sdk_key_configured": bool(APPLICATION_KEY),
        "points_count": len(ps.list()),
        "sweeps_count": len(os_store.sweeps()),
        "instances_count": len(os_store.instances()),
        "latest_pose": manager.latest_pose,
    }


@router.get("/config")
def mp_config(save_name: str | None = Query(default=None)) -> dict[str, Any]:
    ctx = load_s2f_context(save_name)
    return {
        "model_id": MODEL_ID,
        "application_key": APPLICATION_KEY,
        "vocabulary": VOCABULARY,
        "centroid_xy": list(ctx.centroid_xy),
        "floor_levels": ctx.floor_levels,
    }


@router.post("/move")
async def mp_move(req: MoveRequest) -> dict[str, Any]:
    ctx = load_s2f_context(req.save_name)
    mp_pos: dict[str, float] | None = None
    if req.position is not None:
        mp_pos = req.position.model_dump()
    elif req.s2f_position is not None:
        mp_pos = s2f_to_mp(req.s2f_position.model_dump(), ctx)

    payload: dict[str, Any] = {
        "type": "move",
        "position": mp_pos,
        "rotation": req.rotation.model_dump() if req.rotation else None,
        "sweep_id": req.sweep_id,
        "transition": req.transition or "fly",
    }
    if mp_pos is not None:
        payload.update(_pose_with_s2f(mp_pos, ctx))
    await manager.broadcast(payload)
    return {"ok": True, **payload}


@router.get("/points")
def mp_list_points(
    save_name: str | None = Query(default=None),
    floor_idx: int | None = Query(default=None),
) -> dict[str, Any]:
    ps, _, mid = get_stores(save_name=save_name)
    ctx = load_s2f_context(save_name)
    pts = [enrich_point(p, ctx) for p in ps.list()]
    if floor_idx is not None:
        pts = [p for p in pts if p.get("floor_idx") == floor_idx]
    return {"model_id": mid, "points": pts}


@router.post("/points")
async def mp_create_point(req: PointCreateRequest) -> dict[str, Any]:
    if req.save_name:
        raise HTTPException(status_code=400, detail="Cannot mutate read-only saved snapshot.")
    ps, os_store, mid = get_stores()
    ctx = load_s2f_context()
    if req.position is not None:
        mp_pos = req.position.model_dump()
    elif req.s2f_position is not None:
        mp_pos = s2f_to_mp(req.s2f_position.model_dump(), ctx)
    elif manager.latest_pose and manager.latest_pose.get("position"):
        mp_pos = manager.latest_pose["position"]
    else:
        raise HTTPException(status_code=400, detail="Position or active pose is required.")

    rot = req.rotation.model_dump() if req.rotation else (
        (manager.latest_pose or {}).get("rotation") or {"x": 0.0, "y": 0.0}
    )
    sweep_id = req.sweep_id or (manager.latest_pose or {}).get("sweep_id")
    created = ps.add(
        {
            "name": req.name,
            "note": req.note,
            "position": mp_pos,
            "rotation": rot,
            "sweep_id": sweep_id,
            "floor": req.floor,
        }
    )
    enriched = enrich_point(created, ctx)
    push_after_change(ps, os_store, model_id=mid)
    await manager.broadcast({"type": "points_changed", "action": "add", "point": enriched})
    return enriched


@router.delete("/points/{point_id}")
async def mp_delete_point(point_id: str) -> dict[str, Any]:
    ps, os_store, mid = get_stores()
    if not ps.delete(point_id):
        raise HTTPException(status_code=404, detail="Point not found")
    push_after_change(ps, os_store, model_id=mid)
    await manager.broadcast({"type": "points_changed", "action": "delete", "point_id": point_id})
    return {"ok": True, "deleted": point_id}


@router.post("/points/{point_id}/go")
async def mp_go_point(
    point_id: str,
    save_name: str | None = Query(default=None),
) -> dict[str, Any]:
    ps, _, _ = get_stores(save_name=save_name)
    pt = ps.get(point_id)
    if pt is None:
        raise HTTPException(status_code=404, detail="Point not found")
    ctx = load_s2f_context(save_name)
    enriched = enrich_point(pt, ctx)
    payload = {
        "type": "move",
        "point_id": point_id,
        "name": enriched.get("name"),
        "position": enriched.get("position"),
        "rotation": enriched.get("rotation"),
        "sweep_id": enriched.get("sweep_id"),
        "s2f_position": enriched.get("s2f_position"),
        "floor_idx": enriched.get("floor_idx"),
        "transition": "fly",
    }
    await manager.broadcast(payload)
    return {"ok": True, **payload}


@router.get("/objects")
def mp_list_objects(
    save_name: str | None = Query(default=None),
    floor_idx: int | None = Query(default=None),
    label: str | None = Query(default=None),
) -> dict[str, Any]:
    _, os_store, mid = get_stores(save_name=save_name)
    ctx = load_s2f_context(save_name)
    raw = os_store.raw()
    sweeps_out: dict[str, Any] = {}
    for sid, sw in (raw.get("sweeps") or {}).items():
        esw = enrich_sweep(sid, sw, ctx)
        if floor_idx is not None and esw.get("floor_idx") != floor_idx:
            continue
        esw["tags"] = tags_for_sweep(sw)
        sweeps_out[sid] = esw

    instances_out = [enrich_instance(inst, ctx) for inst in os_store.instances(label=label)]
    if floor_idx is not None:
        instances_out = [i for i in instances_out if i.get("floor_idx") == floor_idx]

    return {
        "model_id": mid,
        "updated_at": raw.get("updated_at"),
        "sweeps": sweeps_out,
        "instances": instances_out,
        "sweeps_count": len(sweeps_out),
        "instances_count": len(instances_out),
    }


@router.get("/inventory")
def mp_inventory(
    save_name: str | None = Query(default=None),
    floor_idx: int | None = Query(default=None),
) -> dict[str, Any]:
    _, os_store, mid = get_stores(save_name=save_name)
    if floor_idx is None:
        items = os_store.inventory_summary()
        return {"model_id": mid, "floor_idx": None, "items": items}

    ctx = load_s2f_context(save_name)
    vocab_map = {v["id"]: v for v in VOCABULARY}
    by_label: dict[str, dict[str, Any]] = {}
    for inst in os_store.instances():
        ei = enrich_instance(inst, ctx)
        if ei.get("floor_idx") != floor_idx:
            continue
        lbl = normalize_label(ei.get("label", "other"))
        b = by_label.setdefault(
            lbl,
            {
                "label": lbl,
                "cz": vocab_map.get(lbl, {}).get("cz", lbl),
                "en": vocab_map.get(lbl, {}).get("en", lbl),
                "count": 0,
                "sweeps": set(),
                "max_score": 0.0,
                "sample_instance_id": ei.get("instance_id"),
            },
        )
        b["count"] += 1
        b["max_score"] = max(b["max_score"], float(ei.get("max_score", 0.0)))
        for sid in ei.get("sweep_ids", []):
            b["sweeps"].add(sid)
    rows = []
    for lbl, b in by_label.items():
        rows.append(
            {
                "label": lbl,
                "cz": b["cz"],
                "en": b["en"],
                "count": b["count"],
                "sweep_count": len(b["sweeps"]),
                "max_score": round(b["max_score"], 3),
                "sample_instance_id": b["sample_instance_id"],
            }
        )
    rows.sort(key=lambda r: (-r["count"], r["label"]))
    return {"model_id": mid, "floor_idx": floor_idx, "items": rows}


@router.get("/inventory/where/{label}")
def mp_inventory_where(
    label: str,
    save_name: str | None = Query(default=None),
) -> dict[str, Any]:
    _, os_store, mid = get_stores(save_name=save_name)
    ctx = load_s2f_context(save_name)
    norm = normalize_label(label)
    insts = [enrich_instance(i, ctx) for i in os_store.instances(label=norm)]
    sweeps = os_store.sweeps()
    seeing: list[dict[str, Any]] = []
    for sid, sw in sweeps.items():
        matches = [d for d in (sw.get("detections") or []) if normalize_label(d.get("label", "")) == norm]
        if not matches:
            continue
        esw = enrich_sweep(sid, sw, ctx)
        esw["matching_detections"] = matches
        seeing.append(esw)
    return {"model_id": mid, "label": norm, "instances": insts, "sweeps": seeing}


@router.get("/inventory/{label}")
def mp_inventory_label(
    label: str,
    save_name: str | None = Query(default=None),
    floor_idx: int | None = Query(default=None),
) -> dict[str, Any]:
    _, os_store, mid = get_stores(save_name=save_name)
    ctx = load_s2f_context(save_name)
    norm = normalize_label(label)
    insts = [enrich_instance(i, ctx) for i in os_store.instances(label=norm)]
    if floor_idx is not None:
        insts = [i for i in insts if i.get("floor_idx") == floor_idx]
    return {"model_id": mid, "label": norm, "instances": insts}


@router.post("/inventory/save-as-points/{label}")
async def mp_save_inventory_as_points(label: str) -> dict[str, Any]:
    ps, os_store, mid = get_stores()
    ctx = load_s2f_context()
    norm = normalize_label(label)
    insts = os_store.instances(label=norm)
    if not insts:
        raise HTTPException(status_code=404, detail=f"No instances found for {norm}")

    sweeps = os_store.sweeps()
    created: list[dict[str, Any]] = []
    for inst in insts:
        anchor = inst.get("anchor")
        if not isinstance(anchor, dict):
            continue
        obs = sorted(
            inst.get("observations") or [],
            key=lambda o: (-float(o.get("score", 0.0)), float(o.get("distance_m") or 99.0)),
        )
        best_sid = obs[0]["sweep_id"] if obs else (inst.get("sweep_ids") or [None])[0]
        sw = sweeps.get(best_sid) if best_sid else None
        sw_pos = (sw or {}).get("position") or anchor
        pitch, yaw = _yaw_pitch_between(sw_pos, anchor)
        pt = ps.add(
            {
                "name": inst.get("instance_id") or norm,
                "note": f"Auto-saved from {norm} (score={inst.get('max_score', 0)})",
                "position": sw_pos,
                "rotation": {"x": pitch, "y": yaw},
                "sweep_id": best_sid,
                "floor": inst.get("floor"),
            }
        )
        created.append(enrich_point(pt, ctx))

    push_after_change(ps, os_store, model_id=mid)
    await manager.broadcast({"type": "points_changed", "action": "bulk_add", "count": len(created)})
    return {"ok": True, "label": norm, "created_count": len(created), "points": created}


@router.post("/goto-instance/{instance_id}")
async def mp_goto_instance(
    instance_id: str,
    save_name: str | None = Query(default=None),
) -> dict[str, Any]:
    _, os_store, _ = get_stores(save_name=save_name)
    ctx = load_s2f_context(save_name)
    inst = os_store.get_instance(instance_id)
    if inst is None:
        raise HTTPException(status_code=404, detail=f"Instance not found: {instance_id}")

    anchor = inst.get("anchor") or {"x": 0.0, "y": 0.0, "z": 0.0}
    sweeps = os_store.sweeps()
    obs = sorted(
        inst.get("observations") or [],
        key=lambda o: (-float(o.get("score", 0.0)), float(o.get("distance_m") or 99.0)),
    )
    best_sid = obs[0]["sweep_id"] if obs else (inst.get("sweep_ids") or [None])[0]
    sw = sweeps.get(best_sid) if best_sid else None
    sw_pos = (sw or {}).get("position") or anchor
    pitch, yaw = _yaw_pitch_between(sw_pos, anchor)

    payload = {
        "type": "move",
        "instance_id": instance_id,
        "label": inst.get("label"),
        "sweep_id": best_sid,
        "position": sw_pos,
        "rotation": {"x": pitch, "y": yaw},
        "target_anchor": anchor,
        "s2f_position": mp_to_s2f(sw_pos, ctx),
        "target_s2f_position": mp_to_s2f(anchor, ctx),
        "transition": "fly",
    }
    await manager.broadcast(payload)
    return {"ok": True, **payload}


@router.get("/export/ifc")
def mp_export_ifc(save_name: str | None = Query(default=None)) -> FileResponse:
    _, os_store, mid = get_stores(save_name=save_name)
    paths = resolve_paths(mid, save_name=save_name)
    if not paths["objects"].is_file():
        raise HTTPException(status_code=404, detail="No Matterport objects.json found to export.")
    out_dir = paths["base"]
    out_ifc = out_dir / f"{mid}_matterport.ifc"
    try:
        export_to_ifc(paths["objects"], out_ifc, model_id=mid)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"IFC export failed: {exc}") from exc
    return FileResponse(
        path=str(out_ifc),
        media_type="application/octet-stream",
        filename=f"{mid}_matterport.ifc",
    )


@router.get("/captures/{sweep_id}/{filename}")
def mp_get_capture(sweep_id: str, filename: str) -> FileResponse:
    safe_sid = "".join(c for c in sweep_id if c.isalnum() or c in "-_")
    safe_fn = Path(filename).name
    paths = resolve_paths(MODEL_ID)
    cap = paths["captures"] / safe_sid / safe_fn
    if not cap.is_file():
        raise HTTPException(status_code=404, detail="Capture image not found")
    return FileResponse(path=str(cap))


@router.websocket("/ws")
async def mp_websocket(ws: WebSocket) -> None:
    await manager.connect(ws)
    ctx = load_s2f_context()
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "pose" and isinstance(msg.get("position"), dict):
                enriched = {
                    **msg,
                    **_pose_with_s2f(msg["position"], ctx),
                }
                manager.latest_pose = enriched
                await manager.broadcast(enriched, exclude=ws)
            elif mtype in {"move", "view", "highlight", "ping"}:
                if mtype == "ping":
                    await ws.send_json({"type": "pong"})
                else:
                    await manager.broadcast(msg, exclude=ws)
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)

