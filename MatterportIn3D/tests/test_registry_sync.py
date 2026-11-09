"""Testy auto synchronizace (app/registry_sync.py) — compare + pull/push + hook."""
from __future__ import annotations

import io
import json
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient

from app.registry import app as registry_app
from app.registry_sync import compare_versions, sha_of, sync_once


@pytest.fixture(autouse=True)
def temp_env(tmp_path, monkeypatch):
    from app import registry

    monkeypatch.setenv("MP_REGISTRY_DIR", str(tmp_path / "registry"))
    registry.registry_dir = tmp_path / "registry"
    registry.registry_dir.mkdir(exist_ok=True)


def make_client(base_url: str):
    return TestClient(registry_app, base_url=base_url)


def _inv() -> dict:
    return {"sweeps": {}, "instances": [{"id": "inst-0001", "label": "hasicí přístroj"}]}


def test_compare_versions_missing_local():
    # lokální timestamp chybí (stará data bez saved_at) → lokál vyhrává
    assert compare_versions(None, "2026-01-01T00:00:00+00:00") == "local"


def test_compare_versions_missing_remote():
    assert compare_versions("2026-01-01T00:00:00+00:00", None) == "remote"


def test_compare_versions_both_missing_equal():
    assert compare_versions(None, None) == "equal"


def test_compare_versions_newer_remote():
    local = "2026-01-01T00:00:00+00:00"
    remote = "2026-02-01T00:00:00+00:00"
    assert compare_versions(local, remote) == "remote"
    assert compare_versions(remote, local) == "local"


def test_compare_versions_equal():
    assert compare_versions("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00") == "equal"


def test_sha_of_stable():
    data = {"a": 1, "b": [1, 2, 3]}
    assert sha_of(data) == sha_of(json.loads(json.dumps(data)))  # serializace stabilní
    assert sha_of({"a": 2}) != sha_of({"a": 1})


def test_sync_once_pull_when_local_missing(tmp_path):
    objects = tmp_path / "objects.json"
    registry = TestClient(registry_app)
    registry.post("/spaces/testmodel", json=_inv())

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "pull"
    assert json.loads(objects.read_text())["instances"][0]["id"] == "inst-0001"


def test_sync_once_push_when_remote_missing(tmp_path):
    objects = tmp_path / "objects.json"
    objects.write_text(json.dumps(_inv()), encoding="utf-8")

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "push"
    # remote teď má prostor; opakovaný sync je bez akce (obsah stejný)
    action2 = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action2 == "none"


def test_sync_once_none_when_content_equal(tmp_path):
    data = json.dumps(_inv())
    (tmp_path / "objects.json").write_text(data, encoding="utf-8")
    client = TestClient(registry_app)
    client.post("/spaces/testmodel", json=_inv())
    # remote uložen ze stejným obsahem — sha stejné → none (bez timestampové flaky)
    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "none"


def test_sync_once_pull_when_remote_newer(tmp_path):
    # lokální starý obsah (má staré saved_at), remote novější → pull
    old = {"sweeps": {}, "instances": [{"id": "old"}],
           "saved_at": "2026-01-01T00:00:00+00:00"}
    (tmp_path / "objects.json").write_text(json.dumps(old), encoding="utf-8")
    registry = TestClient(registry_app)
    registry.post("/spaces/testmodel", json={"sweeps": {}, "instances": [{"id": "new"}]})

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "pull"
    assert json.loads((tmp_path / "objects.json").read_text())["instances"][0]["id"] == "new"


def test_sync_once_local_without_saved_at_wins(tmp_path):
    # lokální data bez saved_at (např. vlastní pipeline uživatele) → vyhrávají (push)
    (tmp_path / "objects.json").write_text(
        json.dumps({"sweeps": {}, "instances": [{"id": "local"}]}), encoding="utf-8"
    )
    client = TestClient(registry_app)
    client.post("/spaces/testmodel", json={"sweeps": {}, "instances": [{"id": "remote"}]})

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "push"
    assert client.get("/spaces/testmodel").json()["instances"][0]["id"] == "local"


def test_sync_once_push_when_local_newer(tmp_path):
    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")
    client = TestClient(registry_app)
    client.post("/spaces/testmodel", json={"sweeps": {}, "instances": [{"id": "old"}]})

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "push"
    got = client.get("/spaces/testmodel").json()
    assert got["instances"][0]["id"] == "inst-0001"


def test_pull_fetches_missing_captures(tmp_path):
    # objects.json obsahově stejný (sha equal → "none"), ale captures chybí —
    # synchronizace i pak stáhne chybějící snímky (ruling: captures diff probíhá vždy)
    registry = TestClient(registry_app)
    registry.post("/spaces/testmodel", json=_inv())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("sid/yaw000.jpg", b"\xff\xd8J")
    buf.seek(0)
    registry.post("/spaces/testmodel/capture", files={"archive": ("c.zip", buf, "application/zip")})

    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")
    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "none"
    cap = tmp_path / "capture" / "sid" / "yaw000.jpg"
    assert cap.is_file() and cap.read_bytes() == b"\xff\xd8J"


def test_pull_never_overwrites_local_capture(tmp_path):
    # lokální snímek s JINÝM obsahem (např. přegenerovaná qa_*.jpg) — pull ho
    # nesmí přepsat (ruling: lokální vyhrává, dle hash-first pravidla)
    registry = TestClient(registry_app)
    registry.post("/spaces/testmodel", json=_inv())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("sid/qa_yaw000.jpg", b"remote")
    buf.seek(0)
    registry.post("/spaces/testmodel/capture", files={"archive": ("c.zip", buf, "application/zip")})

    local = tmp_path / "capture" / "sid" / "qa_yaw000.jpg"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"local")
    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "none"
    assert local.read_bytes() == b"local"  # lokální obsah zachován


def test_push_creates_space_and_uploads_captures(tmp_path):
    # capture-first přes push: lokální objects existuje, prostor v registraci
    # ještě ne → push objects vytvoří prostor a snímky se pošlou za ním
    registry = TestClient(registry_app)
    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")
    cap = tmp_path / "capture" / "sid"
    cap.mkdir(parents=True)
    (cap / "yaw000.jpg").write_bytes(b"\xff\xd8Y")

    action = sync_once(
        registry_url="http://testserver",
        model_id="testmodel",
        data_dir=tmp_path,
        client_factory=make_client,
    )
    assert action == "push"
    m = TestClient(registry_app).get("/spaces/testmodel/capture/manifest")
    assert m.status_code == 200
    assert any(e["path"] == "sid/yaw000.jpg" for e in m.json()["capture"])


def test_startup_hook_noop_without_env(tmp_path, monkeypatch):
    from app import registry_sync

    called = {"n": 0}

    def fake_run(*args, **kwargs):
        called["n"] += 1

    monkeypatch.setattr(registry_sync, "sync_once", fake_run)
    registry_sync.run_startup_sync()  # bez MP_REGISTRY_URL → bez akce
    assert called["n"] == 0


# ---------------------------------------------------------------------------
# Push po merge/capture + startup hook
# ---------------------------------------------------------------------------
def test_push_after_change_pushes_with_env(tmp_path, monkeypatch):
    from app import registry_sync

    monkeypatch.setenv("MP_REGISTRY_URL", "http://testserver")
    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")
    monkeypatch.setattr(
        registry_sync, "get_client", lambda base: TestClient(registry_app, base_url=base)
    )

    res = registry_sync.push_after_change(tmp_path, model_id="testmodel")
    assert res == "push"
    assert TestClient(registry_app).get("/spaces/testmodel").json()["instances"][0][
        "id"
    ] == "inst-0001"


def test_push_after_change_noop_without_env(tmp_path, monkeypatch):
    from app import registry_sync

    monkeypatch.delenv("MP_REGISTRY_URL", raising=False)
    (tmp_path / "objects.json").write_text(json.dumps(_inv()), encoding="utf-8")
    assert registry_sync.push_after_change(tmp_path, model_id="testmodel") is None


def test_merge_adds_saved_at_and_pushes(tmp_path, monkeypatch):
    import tools.merge_objects as merge

    data = {
        "sweeps": {
            "s1": {
                "position": {"x": 0, "y": 0, "z": 0},
                "views": {
                    "0": {
                        "objects": [
                            {
                                "label": "hasicí přístroj",
                                "conf": 0.9,
                                "anchor": {"x": 1.0, "y": 0.0, "z": 0.0},
                            }
                        ]
                    }
                },
            }
        }
    }
    out = tmp_path / "objects.json"
    out.write_text(json.dumps(data), encoding="utf-8")

    from argparse import Namespace

    args = Namespace(out=str(out))

    monkeypatch.setenv("MP_REGISTRY_URL", "http://testserver")
    monkeypatch.setenv("MP_MODEL_ID", "testmodel")
    import app.registry_sync as _rs

    monkeypatch.setattr(
        _rs, "get_client", lambda base: TestClient(registry_app, base_url=base)
    )
    merge.run(args)

    saved = json.loads(out.read_text())
    assert saved["saved_at"]  # merge data označí saved_at — sync dle něj rozhoduje
    pushed = TestClient(registry_app).get("/spaces/testmodel").json()
    assert pushed["instances"][0]["label"] == "hasicí přístroj"


def test_main_startup_hook_runs_with_env(monkeypatch, tmp_path):
    from app import main, registry_sync

    called = {"n": 0}
    monkeypatch.setenv("MP_REGISTRY_URL", "http://testserver")
    monkeypatch.setenv("MP_OBJECTS_FILE", str(tmp_path / "objects.json"))
    monkeypatch.setattr(
        registry_sync, "run_startup_sync", lambda: called.__setitem__("n", 1)
    )
    with TestClient(main.app) as c:
        c.get("/health")
    assert called["n"] == 1


def test_main_startup_hook_noop_without_env(monkeypatch):
    from app import main, registry_sync

    called = {"n": 0}
    monkeypatch.delenv("MP_REGISTRY_URL", raising=False)
    monkeypatch.setattr(
        registry_sync, "sync_once", lambda *a, **kw: called.__setitem__("n", 1)
    )
    with TestClient(main.app) as c:
        c.get("/health")
    assert called["n"] == 0
