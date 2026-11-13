"""Testy remote režimu — /captures static + config hint (Task 7)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_captures_static_serves_qa_image():
    """main.py mountuje /captures → data/<model>/capture/ (reálná data)."""
    r = client.get("/captures/n3u8e7wq4itw5wqciazmdynkd/qa_yaw000.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")


def test_config_remote_hint_env(monkeypatch):
    from app import config

    hint = "docker compose up -d; ssh -N -L 8017:localhost:8017 <server>"
    monkeypatch.setenv("MP_REMOTE_HINT", hint)
    assert config.remote_hint_env() == hint
    monkeypatch.delenv("MP_REMOTE_HINT", raising=False)
    assert config.remote_hint_env() is None


def test_objects_summary_carries_rotation(tmp_path, monkeypatch):
    """Remote režim potřebuje yaw skenu — /objects nese rotation."""
    from app import main
    from app.objects import ObjectStore

    data = {
        "sweeps": {
            "sid-a": {
                "position": {"x": 1.0, "y": 2.0, "z": 3.0},
                "rotation": {"x": 0.0, "y": 90.0, "z": 0.0},
                "views": {
                    "0": {
                        "objects": [
                            {"label": "dveře", "conf": 0.9, "bbox": [0.4, 0.4, 0.6, 0.6]}
                        ]
                    }
                },
            }
        }
    }
    monkeypatch.setattr(main, "object_store", ObjectStore(tmp_path / "objects.json"))
    main.object_store.save(data)
    r = client.get("/objects")
    assert r.status_code == 200
    sw = r.json()["sweeps"]["sid-a"]
    assert sw["rotation"] == {"x": 0.0, "y": 90.0, "z": 0.0}
    assert sw["position"] == {"x": 1.0, "y": 2.0, "z": 3.0}


def test_cors_allows_remote_localhost_check():
    """Remote UI checkuje localhost:8017/health z IP originu — server musí CORS."""
    r = client.get("/health", headers={"Origin": "http://127.0.0.2:8017"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"


# ---------------------------------------------------------------------------
# Task 8 — „kde jsou" pole bodů + prohlídka vybraných
# ---------------------------------------------------------------------------
@pytest.fixture
def inv_store(tmp_path, monkeypatch):
    """objects.json fixture se 2 hasicími (conf .9/.7, sweepy) + 1 dveře."""
    from app import main
    from app.objects import ObjectStore

    data = {
        "sweeps": {},
        "instances": [
            {
                "id": "inst-0001", "label": "hasicí přístroj", "kategorie": "požární",
                "ikona": "🧯", "pozice": {"x": 1.0, "y": 0.0, "z": 0.0},
                "sweeps": [{"sweep": "s-a", "bearing": 12.0, "conf": 0.7, "views": [0]},
                           {"sweep": "s-b", "bearing": 90.0, "conf": 0.9, "views": [0]}],
                "max_conf": 0.9, "hits": 2,
            },
            {
                "id": "inst-0002", "label": "hasicí přístroj", "kategorie": "požární",
                "ikona": "🧯", "pozice": {"x": 5.0, "y": 0.0, "z": 0.0},
                "sweeps": [{"sweep": "s-c", "bearing": 42.0, "conf": 0.8, "views": [0]}],
                "max_conf": 0.8, "hits": 1,
            },
            {
                "id": "inst-0003", "label": "dveře", "kategorie": "přístup",
                "ikona": "🚪", "pozice": {"x": 9.0, "y": 0.0, "z": 0.0},
                "sweeps": [{"sweep": "s-d", "bearing": 5.0, "conf": 0.9, "views": [0]}],
                "max_conf": 0.9, "hits": 1,
            },
        ],
    }
    store = ObjectStore(tmp_path / "objects.json")
    store.save(data)
    monkeypatch.setattr(main, "object_store", store)
    return store


def test_inventory_where_points_format(inv_store):
    r = client.get("/inventory/where/hasic%C3%AD%20p%C5%99%C3%ADstroj")
    assert r.status_code == 200
    pts = r.json()["points"]
    assert len(pts) == 2
    p0 = pts[0]
    assert set(p0) >= {"name", "sweep", "position", "rotation"}
    assert p0["name"] == "hasicí přístroj 1"
    assert p0["sweep"] == "s-b"           # nejvyšší conf sweep
    assert p0["position"] == {"x": 1.0, "y": 0.0, "z": 0.0}
    assert p0["rotation"] == {"x": 0, "y": 90.0}
    assert pts[1]["name"] == "hasicí přístroj 2"


def test_inventory_where_unknown_label_404(inv_store):
    assert client.get("/inventory/where/nejsem-tady").status_code == 404


def test_inventory_where_near_sorted_with_dist(inv_store):
    near = "4,0,0"
    r = client.get("/inventory/where/hasic%C3%AD%20p%C5%99%C3%ADstroj", params={"near": near})
    assert r.status_code == 200
    pts = r.json()["points"]
    assert [p["name"] for p in pts] == ["hasicí přístroj 2", "hasicí přístroj 1"]
    assert pts[0]["dist"] == 1.0 and pts[1]["dist"] == 3.0


def test_save_as_points_creates_points(inv_store, tmp_path, monkeypatch):
    from app import main
    from app.points import PointStore

    pts_store = PointStore(tmp_path / "points.json")
    monkeypatch.setattr(main, "store", pts_store)

    r = client.post("/inventory/save-as-points/hasic%C3%AD%20p%C5%99%C3%ADstroj")
    assert r.status_code == 201  # body se tváří jako vytvořené (jako POST /points)
    body = r.json()
    assert body["saved"] == 2
    names = [p["name"] for p in pts_store.list()]
    assert names == ["hasicí přístroj 1", "hasicí přístroj 2"]
    # body se tváří jako uložené body — mají sweep + position (jako /points)
    assert all(p["sweep"] for p in pts_store.list())

    r2 = client.post("/inventory/save-as-points/dve%C5%99e")
    assert r2.json()["saved"] == 1
