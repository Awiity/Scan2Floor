"""Testy centrálního registru (app/registry.py) — push/pull inventářů per prostor."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.registry import app as registry_app

client = TestClient(registry_app)


@pytest.fixture(autouse=True)
def temp_registry_dir(tmp_path, monkeypatch):
    from app import registry

    monkeypatch.setenv("MP_REGISTRY_DIR", str(tmp_path / "registry"))
    registry.registry_dir = tmp_path / "registry"
    registry.registry_dir.mkdir(exist_ok=True)


def _inventory_fixture() -> dict:
    return {
        "sweeps": {"s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {}}},
        "instances": [
            {"id": "inst-0001", "label": "hasicí přístroj", "kategorie": "požární",
             "ikona": "🧯", "pozice": {"x": 1.0, "y": 0.0, "z": 0.0},
             "sweeps": [{"sweep": "s1", "bearing": 12.0, "conf": 0.9, "views": [0]}],
             "max_conf": 0.9, "hits": 3},
        ],
    }


def test_push_and_pull_space():
    res = client.post("/spaces/yQPhyaCwigp", json=_inventory_fixture())
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "saved"
    assert "saved_at" in body

    got = client.get("/spaces/yQPhyaCwigp")
    assert got.status_code == 200
    data = got.json()
    assert data["instances"][0]["id"] == "inst-0001"


def test_pull_unknown_space_404():
    assert client.get("/spaces/neexistuje").status_code == 404


def test_space_list_with_timestamp(monkeypatch):
    client.post("/spaces/model-a", json=_inventory_fixture())
    client.post("/spaces/model-b", json=_inventory_fixture())
    res = client.get("/spaces")
    assert res.status_code == 200
    spaces = res.json()["spaces"]
    assert [s["model_id"] for s in spaces] == ["model-a", "model-b"]
    assert all("saved_at" in s for s in spaces)

    # druhý push téhož prostoru přepíše meta a timestamp (deterministicky)
    from app import registry
    first = next(s["saved_at"] for s in spaces if s["model_id"] == "model-a")
    monkeypatch.setattr(registry, "now_iso", lambda: "2026-01-01T00:00:00+00:00")
    client.post("/spaces/model-a", json=_inventory_fixture())
    spaces2 = client.get("/spaces").json()["spaces"]
    a = next(s for s in spaces2 if s["model_id"] == "model-a")
    assert a["saved_at"] == "2026-01-01T00:00:00+00:00"
    assert a["saved_at"] != first


def test_second_push_overwrites_and_keeps_raw():
    client.post("/spaces/model-a", json=_inventory_fixture())
    changed = _inventory_fixture()
    changed["instances"] = []
    client.post("/spaces/model-a", json=changed)
    got = client.get("/spaces/model-a").json()
    assert got["instances"] == []  # poslední push vyhrává


def test_capture_zip_roundtrip(tmp_path):
    client.post("/spaces/model-a", json=_inventory_fixture())
    # zip s dvěma snímky
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("n3u8e7wq4itw/yaw000.jpg", b"\xff\xd8JPEG1")
        zf.writestr("n3u8e7wq4itw/qa_yaw000.jpg", b"\xff\xd8JPEG2")
    buf.seek(0)
    res = client.post(
        "/spaces/model-a/capture",
        files={"archive": ("captures.zip", buf, "application/zip")},
    )
    assert res.status_code == 200

    from app import registry
    cap_dir = registry.registry_dir / "model-a" / "capture" / "n3u8e7wq4itw"
    assert (cap_dir / "yaw000.jpg").read_bytes() == b"\xff\xd8JPEG1"
    assert (cap_dir / "qa_yaw000.jpg").read_bytes() == b"\xff\xd8JPEG2"

    # manifest v meta — synchronizace dle něj pulluje/pushuje jednotlivé soubory
    meta = json.loads((registry.registry_dir / "model-a" / "meta.json").read_text())
    manifest = meta["capture"]
    assert {m["path"] for m in manifest} == {
        "n3u8e7wq4itw/yaw000.jpg", "n3u8e7wq4itw/qa_yaw000.jpg",
    }
    assert all(m["sha"] for m in manifest)

    # single-file upload + download
    up = client.post(
        "/spaces/model-a/capture/file",
        params={"path": "sid2/yaw090.jpg"},
        files={"file": ("yaw090.jpg", b"\xff\xd8J3", "application/octet-stream")},
    )
    assert up.status_code == 200
    dl = client.get("/spaces/model-a/capture/file", params={"path": "sid2/yaw090.jpg"})
    assert dl.status_code == 200 and dl.content == b"\xff\xd8J3"

    # download — celý ZIP se stejným obsahem
    dl = client.get("/spaces/model-a/capture")
    assert dl.status_code == 200
    with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
        assert set(zf.namelist()) == {
            "n3u8e7wq4itw/yaw000.jpg", "n3u8e7wq4itw/qa_yaw000.jpg", "sid2/yaw090.jpg",
        }


def test_capture_manifest_endpoint():
    # push s captures → meta nese manifest path+sha
    client.post("/spaces/model-a", json=_inventory_fixture())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("sid/yaw000.jpg", b"\xff\xd8J")
    client.post("/spaces/model-a/capture",
                files={"archive": ("c.zip", io.BytesIO(buf.getvalue()), "application/zip")})

    from app import registry
    meta = json.loads((registry.registry_dir / "model-a" / "meta.json").read_text())
    assert meta["capture"] == [
        {"path": "sid/yaw000.jpg", "sha": hashlib.sha256(b"\xff\xd8J").hexdigest()}
    ]

    # manifest endpoint
    res = client.get("/spaces/model-a/capture/manifest")
    assert res.status_code == 200
    assert res.json()["capture"] == meta["capture"]

    # bez captures → manifest endpoint není
    client.post("/spaces/model-b", json=_inventory_fixture())
    assert client.get("/spaces/model-b/capture/manifest").status_code == 404


def test_capture_without_space_404():
    assert client.post(
        "/spaces/neexistuje/capture",
        files={"archive": ("c.zip", io.BytesIO(b"PK"), "application/zip")},
    ).status_code == 404


def test_saved_at_metadata_sidecar():
    client.post("/spaces/model-a", json=_inventory_fixture())
    from app import registry
    meta = json.loads((registry.registry_dir / "model-a" / "meta.json").read_text())
    assert meta["model_id"] == "model-a"
    assert meta["instances"] == 1
    assert meta["sha256"]  # obsahový hash — synchronizace srovnává dle něj


def test_meta_sha_matches_pushed_content():
    data = _inventory_fixture()
    client.post("/spaces/model-a", json=data)
    from app.registry_sync import sha_of
    from app import registry
    meta = json.loads((registry.registry_dir / "model-a" / "meta.json").read_text())
    assert meta["sha256"] == sha_of(data)
