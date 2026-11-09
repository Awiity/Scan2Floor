"""Centrální registr inventářů — bez Matterport SDK, běží na IP bez licence.

Služba pro distribuci: jednotlivé instance appky (u uživatelů, na serveru)
posílají objects.json (inventář + anchory + raw detekce) a capture snímky,
přičemž kdokoli si prostor stáhne — pipeline (capture → detect → anchor →
merge) trvá hodiny, stažení sekundy.

Rozhraní (kontrakt pro app/registry_sync.py):
  POST  /spaces/{model_id}            — uloží objects.json (JSON body)
  POST  /spaces/{model_id}/capture    — ZIP se snímky (multipart, pole `archive`)
  GET   /spaces/{model_id}            — objects.json daného prostoru
  GET   /spaces/{model_id}/capture    — ZIP se snímky daného prostoru
  GET   /spaces                       — seznam prostorů se saved_at

Ukládání: <MP_REGISTRY_DIR>/<model_id>/objects.json + meta.json (saved_at,
počet instancí) + capture/ (obsah zipu bez kořenových složek).

Běží: uvicorn app.registry:app --port 8019 (Docker compose service `registry`,
adresář ./registry jako volume — mimo ./data, ať se obě synchronizace nekrčí).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI(title="Matterport In3D — centrální registr")

# adresář registru — přepínatelný pro testy (fixture monkeypatch setenv)
registry_dir = Path(os.environ.get("MP_REGISTRY_DIR", "registry"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _space_dir(model_id: str) -> Path:
    # model_id v cestě jen bezpečné znaky — bez /, .. a podivných bajtů
    safe = "".join(c for c in model_id if c.isalnum() or c in "-_")
    if not safe or safe != model_id:
        raise HTTPException(status_code=400, detail="model_id smí obsahovat jen znaky A–Z a 0–9")
    d = registry_dir / safe
    return d


def sha_of_payload(data: dict[str, Any]) -> str:
    """Stabilní obsahový hash pushed objects.json (stejný jako registry_sync.sha_of)."""
    payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@app.post("/spaces/{model_id}")
async def push_space(model_id: str, data: dict) -> dict:
    """Uloží objects.json daného prostoru (poslední push vyhrává)."""
    d = _space_dir(model_id)
    d.mkdir(parents=True, exist_ok=True)
    saved_at = now_iso()
    (d / "objects.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )
    sha = sha_of_payload(data)
    # meta aktualizujeme inkrementálně — capture manifest zůstává zachován
    _update_meta(
        d,
        {
            "model_id": model_id,
            "saved_at": saved_at,
            "sha256": sha,
            "instances": len(data.get("instances") or []),
            "raw_objects": sum(
                1
                for entry in (data.get("sweeps") or {}).values()
                for view in (entry.get("views") or {}).values()
                for _obj in (view.get("objects") or [])
            ),
        },
    )
    return {"status": "saved", "model_id": model_id, "saved_at": saved_at, "sha256": sha}


def _capture_manifest(d: Path) -> list[dict[str, str]]:
    """Manifest captures: [{path, sha}] — synchronizace dle něj pulluje/pushuje."""
    cap = d / "capture"
    if not cap.is_dir():
        return []
    out = []
    for p in sorted(cap.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            out.append(
                {
                    "path": p.relative_to(cap).as_posix(),
                    "sha": hashlib.sha256(p.read_bytes()).hexdigest(),
                }
            )
    return out


def _update_meta(d: Path, patch: dict) -> None:
    meta_path = d / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    meta.update(patch)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


@app.post("/spaces/{model_id}/capture")
async def push_capture(model_id: str, archive: UploadFile) -> dict:
    """Uloží ZIP se capture snímky (strom `capture/`) daného prostoru."""
    d = _space_dir(model_id)
    if not (d / "objects.json").is_file():
        raise HTTPException(status_code=404, detail="prostor v registru neexistuje")
    payload = await archive.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        for name in zf.namelist():
            if name.endswith(("/", "\\")):
                continue
            if name.startswith("capture/"):
                name = name[len("capture/"):]
            target = d / "capture" / name
            if not str(target.resolve()).startswith(str((d / "capture").resolve())):
                continue  # zip-slip
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(name))
    _update_meta(d, {"capture": _capture_manifest(d), "capture_saved_at": now_iso()})
    return {"status": "saved", "model_id": model_id, "capture": now_iso()}


@app.post("/spaces/{model_id}/capture/file")
async def push_capture_file(model_id: str, path: str, file: UploadFile) -> dict:
    """Uloží jeden capture soubor (relativní cesta v capture/)."""
    d = _space_dir(model_id)
    if not (d / "objects.json").is_file():
        raise HTTPException(status_code=404, detail="prostor v registru neexistuje")
    safe = Path(path).as_posix()
    if safe.startswith("/") or ".." in Path(safe).parts:
        raise HTTPException(status_code=400, detail="špatná cesta")
    target = d / "capture" / safe
    if not str(target.resolve()).startswith(str((d / "capture").resolve())):
        raise HTTPException(status_code=400, detail="špatná cesta")
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = await file.read()
    target.write_bytes(payload)
    _update_meta(d, {"capture": _capture_manifest(d), "capture_saved_at": now_iso()})
    return {
        "status": "saved", "path": safe,
        "sha": hashlib.sha256(payload).hexdigest(),
    }


@app.get("/spaces/{model_id}/capture/manifest")
async def capture_manifest(model_id: str) -> dict:
    d = _space_dir(model_id)
    if not (d / "objects.json").is_file():
        raise HTTPException(status_code=404, detail="prostor v registru neexistuje")
    cap = d / "capture"
    if not cap.is_dir() or not [p for p in cap.rglob("*") if p.is_file() and not p.name.startswith(".")]:
        raise HTTPException(status_code=404, detail="snímky v registru nejsou")
    return {"capture": _capture_manifest(d)}


@app.get("/spaces/{model_id}/capture/file")
async def pull_capture_file(model_id: str, path: str) -> Response:
    """Jeden capture soubor — diff synchronizace stahuje jen chybějící."""
    d = _space_dir(model_id)
    safe = Path(path).as_posix()
    if safe.startswith("/") or ".." in Path(safe).parts:
        raise HTTPException(status_code=400, detail="špatná cesta")
    target = d / "capture" / safe
    if not target.is_file() or not str(target.resolve()).startswith(
        str((d / "capture").resolve())
    ):
        raise HTTPException(status_code=404, detail="soubor v registru není")
    return Response(content=target.read_bytes(), media_type="application/octet-stream")


@app.get("/spaces/{model_id}")
async def pull_space(model_id: str) -> dict:
    d = _space_dir(model_id)
    obj = d / "objects.json"
    if not obj.is_file():
        raise HTTPException(status_code=404, detail="prostor v registru neexistuje")
    return json.loads(obj.read_text(encoding="utf-8"))


@app.get("/spaces/{model_id}/capture")
async def pull_capture(model_id: str) -> Response:
    """ZIP se snímky daného prostoru (bez snímků → 404)."""
    d = _space_dir(model_id)
    cap = d / "capture"
    if not cap.is_dir() or not any(cap.iterdir()):
        raise HTTPException(status_code=404, detail="snímky v registru nejsou")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(cap.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(cap))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="capture_{model_id}.zip"'},
    )


@app.get("/spaces")
async def list_spaces() -> dict:
    """Seznam prostorů s timestampy — na co se synchronizace ptá."""
    spaces = []
    if registry_dir.is_dir():
        for meta_path in sorted(registry_dir.glob("*/meta.json")):
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            spaces.append(meta)
    return {"spaces": spaces}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8019)
