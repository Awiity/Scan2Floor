"""Matterport In3D — server pro ovládání kamery Matterport modelu.

Rozhraní pro cizí systém:
  POST /move          — jednorázový skok na pozici (JSON, viz níže)
  WS   /ws            — živý proud pozic (stejný formát JSON)
  GET  /health        — kontrola dostupnosti + počet připojených prohlížečů
  GET  /config        — konfigurace pro frontend (model, kalibrace)
  GET  /points        — uložené body (sweep + pozice + natočení)
  POST /points        — uložení bodu
  DELETE /points/{id} — smazání bodu
  POST /points/{id}/goto — přesun prohlížečů na uložený bod
  GET  /export/ifc    — IFC 4 export inventáře + bodů (attachment)
  GET  /objects       — rozpoznané objekty (tagy) pro všechny skeny
  GET  /objects/{sweep} — objekty konkrétního skenu

Formát zprávy (POST i WS):
  {
    "position": {"x": 1.25, "y": -0.4, "z": 3.1},
    "view": {"mode": "lookAt", "x": 2.0, "y": -0.4, "z": 3.1},
             -- nebo --
            {"mode": "angles", "yaw": 45, "pitch": 0},
    "mode": "smooth"          -- nebo "instant"
  }

Souřadnice jsou v souřadnicích bodového mraku; server aplikuje kalibraci
(remap os + posun) z app/config.py a rozesílá všem připojeným prohlížečům.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from . import config
from .objects import ObjectStore
from .points import PointStore

app = FastAPI(
    title="Matterport In3D",
    description="Ovládání kamery Matterport modelu podle souřadnic bodového mraku.",
)


# CORS — remote UI (přes IP) checkuje localhost:8017/health pro tlačítko
# „3D náhled" — odpovědi nesmí být zablokované cross-origin
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"])


@app.on_event("startup")
def _startup_registry_sync() -> None:
    """Auto synchronizace s centrálním registrem (jen když MP_REGISTRY_URL)."""
    import logging

    try:
        from app.registry_sync import run_startup_sync

        run_startup_sync()
    except Exception as e:  # registr nedostupný při startu — appka normálně poběží
        logging.getLogger("app.main").warning(
            "Startup sync s registrem selhal (%s) — data nechávám lokální, "
            "sync se zkusí při dalším startu nebo push po merge/capture.", e
        )

# Úložiště pojmenovaných pozic kamery (data/<model_id>/points.json)
store = PointStore(config.POINTS_FILE)
# Úložiště rozpoznaných objektů (objects.json — výstup tools/detect_objects.py)
object_store = ObjectStore(config.OBJECTS_FILE)


# ---------------------------------------------------------------------------
# Datové modely
# ---------------------------------------------------------------------------
class Position(BaseModel):
    x: float
    y: float
    z: float


class View(BaseModel):
    mode: Literal["lookAt", "angles"]
    # pro mode="lookAt"
    x: float | None = None
    y: float | None = None
    z: float | None = None
    # pro mode="angles" (stupně, dle konvence Camera.pose z Matterport SDK)
    yaw: float | None = None
    pitch: float | None = None

    @model_validator(mode="after")
    def check_fields(self) -> "View":
        if self.mode == "lookAt":
            if None in (self.x, self.y, self.z):
                raise ValueError(
                    'view.mode="lookAt" vyžaduje pole view.x, view.y a view.z'
                )
        elif self.mode == "angles":
            if self.yaw is None:
                raise ValueError('view.mode="angles" vyžaduje pole view.yaw')
        return self


class MoveMessage(BaseModel):
    position: Position
    view: View
    mode: Literal["smooth", "instant"] = "smooth"


class Rotation(BaseModel):
    x: float = 0.0  # pitch
    y: float = 0.0  # yaw


class PointCreate(BaseModel):
    """Bod uložený z prohlížeče (souřadnice modelu, viz Camera.getPose())."""

    name: str = Field(min_length=1, max_length=64)
    sweep: str = ""
    position: Position
    rotation: Rotation = Rotation()
    mode: str = ""


# ---------------------------------------------------------------------------
# Správa připojených prohlížečů (WebSocket)
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, payload: dict) -> int:
        """Pošle zprávu všem; neúspěšné odesílatele zahodí. Vrátí počet úspěšných."""
        dead: list[WebSocket] = []
        sent = 0
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
                sent += 1
            except Exception:  # pragma: no cover — prasklé spojení
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
        return sent


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Obsluha chyb validace -> 400 s popisem (dle designu)
# ---------------------------------------------------------------------------
@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{"loc": [str(p) for p in e["loc"]], "msg": e["msg"]} for e in exc.errors()]
    return JSONResponse(status_code=400, content={"error": "invalid_message", "details": errors})


# ---------------------------------------------------------------------------
# Endpointy
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "clients": len(manager.active)}


@app.get("/config")
async def get_config() -> dict:
    return {
        "modelId": config.MODEL_ID,
        "hasApplicationKey": bool(config.APPLICATION_KEY),
        "axisMap": config.AXIS_MAP,
        "coordOffset": config.COORD_OFFSET,
        "remoteHint": config.remote_hint_env(),
    }


@app.post("/move")
async def move(msg: MoveMessage) -> dict:
    """Přijme pozici (v souřadnicích mraku), aplikuje kalibraci a rozesije ji."""
    payload = {
        "position": config.cloud_to_model(msg.position.model_dump()),
        "view": msg.view.model_dump(),
        "mode": msg.mode,
    }
    sent = await manager.broadcast(payload)
    return {"status": "accepted", "sent_to": sent, "model_position": payload["position"]}


@app.get("/points")
async def list_points() -> dict:
    """Vrátí všechna uložená místa (nejstarší první)."""
    return {"points": store.list()}


@app.post("/points", status_code=201)
async def create_point(point: PointCreate) -> dict:
    """Uloží aktuální pozici kamery jako pojmenovaný bod."""
    if not point.name.strip():
        raise HTTPException(status_code=400, detail="name nesmí být prázdné")
    return store.add(point.model_dump())


@app.delete("/points/{point_id}", status_code=204)
async def delete_point(point_id: str) -> Response:
    if not store.delete(point_id):
        raise HTTPException(status_code=404, detail="bod neexistuje")
    return Response(status_code=204)


@app.post("/points/{point_id}/goto")
async def goto_point(point_id: str) -> dict:
    """Pošle prohlížečům pokyn přesunout kameru na uložený bod."""
    point = store.get(point_id)
    if point is None:
        raise HTTPException(status_code=404, detail="bod neexistuje")
    sent = await manager.broadcast({"type": "goto", "point": point})
    return {"status": "accepted", "sent_to": sent, "point": point}


# ---------------------------------------------------------------------------
# Rozpoznané objekty (tagy) — výstup tools/detect_objects.py
# ---------------------------------------------------------------------------
@app.get("/objects")
async def objects_summary() -> dict:
    """Přehled objektů pro všechny skeny (sloučené po pohledech)."""
    return object_store.summary(hfov=config.CAPTURE_HFOV, sign=config.CAPTURE_YAW_SIGN)


@app.get("/objects/{sweep_id}")
async def objects_for_sweep(sweep_id: str) -> dict:
    """Tagy jednoho skenu (s směrem, na který se kamera umí otočit)."""
    tags = object_store.for_sweep(sweep_id, hfov=config.CAPTURE_HFOV, sign=config.CAPTURE_YAW_SIGN)
    return {"sweep": sweep_id, "tags": tags}


# ---------------------------------------------------------------------------
# Inventář globálních instancí — výstup tools/merge_objects.py
# ---------------------------------------------------------------------------
@app.get("/inventory")
async def inventory_summary() -> dict:
    """Počty instancí per kategorie + celý katalog (id, label, pozice, …)."""
    inst = object_store.instances()
    counts: dict[str, int] = {}
    for i in inst:
        counts[i["kategorie"]] = counts.get(i["kategorie"], 0) + 1
    return {"counts": counts, "instances": inst}


@app.get("/inventory/{label}")
async def inventory_label(label: str, near: str | None = None) -> dict:
    """Instance daného štítku; s `near=x,y,z` seřazené podle vzdálenosti."""
    inst = [i for i in object_store.instances() if i["label"] == label]
    if not inst:
        raise HTTPException(status_code=404, detail="štítek neexistuje v inventáři")
    if near:
        try:
            x, y, z = (float(v.strip()) for v in near.split(","))
        except ValueError:
            raise HTTPException(status_code=400, detail="near musí být 'x,y,z'") from None
        enriched = []
        for i in inst:
            p = i["pozice"]
            dist = math.sqrt((p["x"] - x) ** 2 + (p["y"] - y) ** 2 + (p["z"] - z) ** 2)
            enriched.append({**i, "dist": round(dist, 2)})
        inst = enriched
        inst.sort(key=lambda i: i["dist"])
    return {"label": label, "instances": inst}


@app.get("/inventory/where/{label}")
async def inventory_where(label: str, near: str | None = None) -> dict:
    """„Kde jsou" — pole bodů v bodovém formátu (jako /points), s `near` seřazeno.

    name „<label> <n>", sweep = sweep s nejvyšší jistotou, position z pozice
    instance, rotation {x:0, y: bearing} — prohlédnutelné stávající „Projít body".
    """
    inst = [i for i in object_store.instances() if i["label"] == label]
    if not inst:
        raise HTTPException(status_code=404, detail="štítek neexistuje v inventáři")
    points = []
    for n, i in enumerate(inst, start=1):
        best = (i.get("sweeps") or [{}])
        best = max(best, key=lambda s: s.get("conf") or 0.0)
        points.append(
            {
                "name": f"{label} {n}",
                "sweep": best.get("sweep") or "",
                "position": {
                    "x": i["pozice"]["x"], "y": i["pozice"]["y"], "z": i["pozice"]["z"],
                },
                "rotation": {"x": 0, "y": best.get("bearing") or 0.0},
            }
        )
    if near:
        try:
            x, y, z = (float(v.strip()) for v in near.split(","))
        except ValueError:
            raise HTTPException(status_code=400, detail="near musí být 'x,y,z'") from None
        for p in points:
            p["dist"] = round(
                math.sqrt(
                    (p["position"]["x"] - x) ** 2 + (p["position"]["y"] - y) ** 2
                    + (p["position"]["z"] - z) ** 2
                ),
                2,
            )
        points.sort(key=lambda p: p["dist"])
    return {"label": label, "points": points}


@app.post("/inventory/save-as-points/{label}", status_code=201)
async def inventory_save_as_points(label: str) -> dict:
    """Uloží instance štítku jako pojmenované body („<label> <n>") — prohlídku
    kolem nich pak zajistí stávající „Projít body"."""
    inst = [i for i in object_store.instances() if i["label"] == label]
    if not inst:
        raise HTTPException(status_code=404, detail="štítek neexistuje v inventáři")
    saved = 0
    for n, i in enumerate(inst, start=1):
        best = (i.get("sweeps") or [{}])
        best = max(best, key=lambda s: s.get("conf") or 0.0)
        store.add(
            {
                "name": f"{label} {n}",
                "sweep": best.get("sweep") or "",
                "position": {
                    "x": i["pozice"]["x"], "y": i["pozice"]["y"], "z": i["pozice"]["z"],
                },
                "rotation": {"x": 0.0, "y": best.get("bearing") or 0.0},
            }
        )
        saved += 1
    return {"saved": saved, "label": label}


@app.post("/goto-instance/{instance_id}")
async def goto_instance(instance_id: str) -> dict:
    """Pošle prohlížečům pokyn skočit k instanci (sweep + bearing na ni)."""
    inst = next(
        (i for i in object_store.instances() if i["id"] == instance_id), None
    )
    if inst is None:
        raise HTTPException(status_code=404, detail="instance neexistuje")
    sent = await manager.broadcast({"type": "goto-instance", "instance": inst})
    return {"status": "accepted", "sent_to": sent, "instance": inst}


# ---------------------------------------------------------------------------
# Export do BIM (IFC 4) — on-demand generace souboru (tools/export_ifc.py)
# ---------------------------------------------------------------------------
@app.get("/export/ifc")
def export_ifc() -> FileResponse:
    """Generuje export.ifc na požadavek (čerstvý — i bez pipeline běhu) a
    servíruje ho jako attachment (Revit/Blender si ho rovnou uloží).

    Sync handler — FastAPI ho sám spouští ve threadpoolu, takže generace
    (~1 s) neblokuje event loop (WS broadcasty běží dál)."""
    from tools.export_ifc import export_to_ifc

    if not (config.DATA_DIR / "objects.json").is_file():
        raise HTTPException(status_code=404, detail="inventář neexistuje (objects.json chybí)")
    out = export_to_ifc(config.DATA_DIR, model_id=config.MODEL_ID)
    return FileResponse(out, media_type="model/ifc", filename="export.ifc")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Živý proud pozic pro prohlížeče.

    Prohlížeč jen poslouchá; případné přijaté zprávy se ignorují
    (využitelné např. pro keep-alive ping).
    """
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(ws)


# ---------------------------------------------------------------------------
# Statické soubory — index.html se servíruje s injektovanou konfigurací
# ---------------------------------------------------------------------------
_index_path = Path(config.STATIC_DIR) / "index.html"
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")

# Remote režim — QA snímky (qa_yawNNN.jpg / yawNNN.jpg) z data/<model>/capture/
# mkdir: přepnutí prostoru (prázdný data/<model>/) nesmí spadnout na mountu —
# StaticFiles s check_dir=True při importu vyhodí RuntimeError
config.CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/captures", StaticFiles(directory=config.CAPTURE_DIR), name="captures")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    html = _index_path.read_text(encoding="utf-8")
    inject = json.dumps(
        {
            "modelId": config.MODEL_ID,
            "applicationKey": config.APPLICATION_KEY,
            "axisMap": config.AXIS_MAP,
            "coordOffset": config.COORD_OFFSET,
        },
        ensure_ascii=False,
    )
    html = html.replace("__MP_CONFIG__", inject)
    return HTMLResponse(html)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
