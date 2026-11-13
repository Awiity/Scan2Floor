"""Auto synchronizace lokálních dat s centrálním registrem (MP_REGISTRY_URL).

Rozhodnutí o směru (ruling: primárně obsahový hash — srovnává sha256
objects.json, ne mtime, ať nejsou synchronizace flaky v rámci sekundy;
timestamp saved_at rozhoduje jen v prvním konfliktu):

  - lokální objects.json chybí            → pull (objects + chybějící captures)
  - prostor v registru chybí              → push
  - sha256 stejný (lokál == remote)       → none
  - rozdíl → dle stavu `.sync_state` (sha poslední synchronizace):
      změnil se jen lokál   → push
      změnil se jen remote  → pull
      změnily se oba        → push (lokál je pracovní kopie — vyhrává)
  - bez `.sync_state` (první rozpor)      → dle compare_versions(saved_at);
    lokál bez saved_at (vlastní pipeline uživatele) vyhrává (push)

Captures diff probíhá vždy (i při "none"): push jen soubory nezařazené v
manifestu `.capture_sync` a v manifestu registru; pull jen chybějící soubory
(dle manifestu registru). Lokální snímky se nikdy nepřepisují.

Volá se: při startu appky (run_startup_sync — jen když MP_REGISTRY_URL),
po merge (tools/merge_objects.py) a po capture (tools/capture_sweeps.py).
"""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx

# testy injektují jiný client factory (TestClient) — produkce httpx.Client
def get_client(base_url: str) -> httpx.Client:
    return httpx.Client(
        base_url=base_url,
        timeout=httpx.Timeout(30.0, read=600.0),
    )


def sha_of(data: dict[str, Any]) -> str:
    """Stabilní obsahový hash objects.json (sort_keys + ensure_ascii)."""
    payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compare_versions(local: str | None, remote: str | None) -> str:
    """'local' | 'remote' | 'equal' dle ISO timestampů saved_at (žádný → prefer lokál)."""
    if local is None and remote is None:
        return "equal"
    if local is None:
        return "local"
    if remote is None:
        return "remote"
    if local == remote:
        return "equal"
    return "local" if local > remote else "remote"


def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sync_once(
    registry_url: str,
    model_id: str,
    data_dir: str | Path,
    client_factory=None,
) -> str:
    """Jeden synchronizační krok. Vrací 'push' | 'pull' | 'none' (objects.json).

    client_factory se vyhodnotí až při volání (testy monkeypatchují
    registry_sync.get_client). Captures se diffují vždy vedle — akce
    je jen o objects.json.
    """
    data_dir = Path(data_dir)
    objects_path = data_dir / "objects.json"
    state_path = data_dir / ".sync_state"

    factory = client_factory or get_client

    local_data = _read_json(objects_path)
    action: str | None = None
    if local_data is None:
        action = "pull"  # lokál prázdný — prostě stáhnout
    else:
        client = factory(registry_url)
        spaces = (client.get("/spaces").json() or {}).get("spaces", [])
        remote_meta = next((s for s in spaces if s.get("model_id") == model_id), None)
        if remote_meta is None:
            action = "push"
        else:
            remote_sha = remote_meta.get("sha256", "")
            local_sha = sha_of(local_data)
            if local_sha == remote_sha:
                action = "none"
            else:
                state = _read_json(state_path)
                if state is None:
                    # první rozpor — rozhodne saved_at (lokál bez saved_at vyhrává)
                    verdict = compare_versions(
                        local_data.get("saved_at"), remote_meta.get("saved_at")
                    )
                    action = "push" if verdict in ("local", "equal") else "pull"
                else:
                    local_changed = local_sha != state.get("sha")
                    remote_changed = remote_sha != state.get("sha")
                    if local_changed and not remote_changed:
                        action = "push"
                    elif remote_changed and not local_changed:
                        action = "pull"
                    else:
                        action = "push"  # obě strany změněny — lokál vyhrává

    client = factory(registry_url)
    if action == "pull":
        pulled = _pull_objects(client, model_id, data_dir)
        if pulled is None:
            # prostor v registraci neexistuje (lokální objects.json taky ne) —
            # objects není co přenést, ale snímky se diffovají pořád
            # (capture-first workflow: nový stroj pošle capture bez objects)
            _sync_captures(client, model_id, data_dir)
            return "none"
        _write_state(state_path, sha_of(pulled))
    elif action == "push":
        pushed = _push_objects(client, model_id, data_dir)
        if pushed is None:
            # lokální objects.json chybí — push neudělám, ale captures se
            # přesto diffovají (stejné pravidlo jako při pull „none")
            _sync_captures(client, model_id, data_dir)
            return "none"
        _write_state(state_path, pushed)

    _sync_captures(client, model_id, data_dir)
    return action or "none"


def _write_state(state_path: Path, sha: str) -> None:
    state_path.write_text(json.dumps({"sha": sha}), encoding="utf-8")


# ---------------------------------------------------------------------------
# objects.json
# ---------------------------------------------------------------------------
def _push_objects(client: httpx.Client, model_id: str, data_dir: Path) -> str | None:
    data = _read_json(data_dir / "objects.json")
    if data is None:
        return None
    res = client.post(f"/spaces/{model_id}", json=data)
    res.raise_for_status()
    return res.json().get("sha256") or sha_of(data)


def _pull_objects(client: httpx.Client, model_id: str, data_dir: Path) -> dict | None:
    res = client.get(f"/spaces/{model_id}")
    if res.status_code == 404:
        return None
    res.raise_for_status()
    data = res.json()
    (data_dir / "objects.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )
    return data


# ---------------------------------------------------------------------------
# captures — per soubor dle manifestů (push jen nové, pull jen chybějící)
# ---------------------------------------------------------------------------
def _capture_manifest_path(data_dir: Path) -> Path:
    return data_dir / "capture" / ".capture_sync"


def _local_capture_manifest(data_dir: Path) -> dict[str, str]:
    return _read_json(_capture_manifest_path(data_dir)) or {}


def _save_capture_manifest(data_dir: Path, manifest: dict[str, str]) -> None:
    p = _capture_manifest_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def _sync_captures(client: httpx.Client, model_id: str, data_dir: Path) -> bool:
    """Diff captures per soubor. True, když se cokoli přeneslo."""
    data_dir = Path(data_dir)
    cap_dir = data_dir / "capture"
    manifest = _local_capture_manifest(data_dir)
    did = False

    # manifest registru (když prostor neexistuje, přeskočíme vše)
    spaces = (client.get("/spaces").json() or {}).get("spaces", [])
    if not any(s.get("model_id") == model_id for s in spaces):
        # prostor nikde — jen push lokálních souborů bez zařazení
        remote_entries: dict[str, str] = {}
        space_exists = False
    else:
        space_exists = True
        mres = client.get(f"/spaces/{model_id}/capture/manifest")
        remote_entries = {
            e["sha"]: e["path"] for e in (mres.json() or {}).get("capture", [])
        } if mres.status_code == 200 else {}

    # push: lokální soubory bez zařazení v manifestu
    local_files = (
        [p for p in sorted(cap_dir.rglob("*")) if p.is_file() and p.name != ".capture_sync"]
        if cap_dir.is_dir()
        else []
    )
    if not space_exists:
        return did  # bez registru není kam posílat
    for p in local_files:
        sha = _file_sha(p)
        if sha in manifest:
            continue
        rel = p.relative_to(cap_dir).as_posix()
        if sha in remote_entries:
            manifest[sha] = rel  # remote ho už má — jen zařadit
            continue
        up = client.post(
            f"/spaces/{model_id}/capture/file",
            params={"path": rel},
            files={"file": (p.name, p.read_bytes(), "application/octet-stream")},
        )
        up.raise_for_status()
        manifest[sha] = rel
        did = True

    # pull: remote soubory, které lokálně chybí — lokální soubor NIKDY
    # nepřepisujeme (konflikt sha = lokální vyhrává, dle hash-first pravidla;
    # typicky lokálně přegenerovaná qa_*.jpg — remote verzi ignorujeme)
    for sha, rel in remote_entries.items():
        if sha in manifest:
            continue
        local_file = cap_dir / rel
        if local_file.is_file():
            if _file_sha(local_file) == sha:
                manifest[sha] = rel  # obsah stejný — jen zařadit do manifestu
            # jinak: konflikt — lokální obsah zachován, remote verzi necháme
            continue
        dl = client.get(f"/spaces/{model_id}/capture/file", params={"path": rel})
        dl.raise_for_status()
        local_file.parent.mkdir(parents=True, exist_ok=True)
        local_file.write_bytes(dl.content)
        manifest[sha] = rel
        did = True

    if local_files or remote_entries:
        _save_capture_manifest(data_dir, manifest)
    return did


# ---------------------------------------------------------------------------
# Hook při startu appky
# ---------------------------------------------------------------------------
def run_startup_sync() -> str | None:
    import os

    url = os.environ.get("MP_REGISTRY_URL", "").strip()
    if not url:
        return None
    from app.config import MODEL_ID, OBJECTS_FILE

    model_id = os.environ.get("MP_MODEL_ID", "") or MODEL_ID
    return sync_once(
        registry_url=url,
        model_id=model_id,
        data_dir=OBJECTS_FILE.parent,
    )


def push_after_change(
    data_dir: str | Path,
    model_id: str | None = None,
    registry_url: str | None = None,
) -> str | None:
    """Push po merge / capture — jen když je MP_REGISTRY_URL nastaveno.

    model_id: default config.MODEL_ID; registry_url: default env
    MP_REGISTRY_URL (není → bez akce, vrací None).
    """
    import os

    url = (registry_url or os.environ.get("MP_REGISTRY_URL", "")).strip()
    if not url:
        return None
    if model_id is None:
        from app.config import MODEL_ID

        model_id = os.environ.get("MP_MODEL_ID", "") or MODEL_ID
    return sync_once(registry_url=url, model_id=model_id, data_dir=data_dir)
