"""Testy API — validace zpráv a broadcast přes WebSocket."""
from __future__ import annotations

import json

import pytest

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def temp_store(tmp_path, monkeypatch):
    """Všechny testy mají vlastní objects.json — nikdy nesaháme na reálný soubor."""
    from app import main
    from app.objects import ObjectStore

    store = ObjectStore(tmp_path / "objects.json")
    monkeypatch.setattr(main, "object_store", store)
    return store


def _msg(**overrides):
    msg = {
        "position": {"x": 1.0, "y": 2.0, "z": 3.0},
        "view": {"mode": "angles", "yaw": 90.0, "pitch": 0.0},
        "mode": "smooth",
    }
    msg.update(overrides)
    return msg


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "clients" in data


def test_config():
    res = client.get("/config")
    assert res.status_code == 200
    data = res.json()
    assert data["modelId"]
    assert set(data["axisMap"]) == {"x", "y", "z"}


def test_move_valid_angles():
    res = client.post("/move", json=_msg())
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "accepted"
    # bez kalibrace se souřadnice nemění
    assert data["model_position"] == {"x": 1.0, "y": 2.0, "z": 3.0}


def test_move_valid_lookat():
    res = client.post(
        "/move",
        json={
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "view": {"mode": "lookAt", "x": 0.0, "y": 0.0, "z": 0.0},
        },
    )
    assert res.status_code == 200


def test_move_missing_yaw():
    res = client.post(
        "/move",
        json={
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "view": {"mode": "angles"},
        },
    )
    assert res.status_code == 400
    assert res.json()["error"] == "invalid_message"


def test_move_missing_lookat_fields():
    res = client.post(
        "/move",
        json={
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "view": {"mode": "lookAt", "x": 1.0},
        },
    )
    assert res.status_code == 400


def test_move_bad_position():
    res = client.post(
        "/move",
        json={"position": {"x": 1.0}, "view": {"mode": "angles", "yaw": 0}},
    )
    assert res.status_code == 400


def test_move_bad_mode():
    res = client.post("/move", json=_msg(mode="teleport"))
    assert res.status_code == 400


def test_move_broadcast_over_ws():
    """POST /move rozesílá zprávu připojeným prohlížečům (s aplikovanou kalibrací)."""
    with client.websocket_connect("/ws") as ws:
        res = client.post("/move", json=_msg())
        assert res.status_code == 200
        received = ws.receive_json()
        assert received["position"] == {"x": 1.0, "y": 2.0, "z": 3.0}
        assert received["mode"] == "smooth"
        assert received["view"]["mode"] == "angles"


def test_calibration_applied(monkeypatch):
    """Kalibrace (remap os + offset) se aplikuje na odesílané souřadnice."""
    from app import config

    monkeypatch.setattr(config, "AXIS_MAP", {"x": "x", "y": "z", "z": "y"})
    monkeypatch.setattr(config, "COORD_OFFSET", {"x": 10.0, "y": 0.0, "z": -1.0})

    res = client.post(
        "/move",
        json={
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "view": {"mode": "angles", "yaw": 0.0},
        },
    )
    assert res.status_code == 200
    # y (model) = z (mrak) = 3.0; z (model) = y (mrak) - 1 = 1.0; x = 1 + 10 = 11
    assert res.json()["model_position"] == {"x": 11.0, "y": 3.0, "z": 1.0}


def test_index_page_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "__MP_CONFIG__" not in res.text
    assert "Matterport In3D" in res.text


# ---------------------------------------------------------------------------
# Inventář instancí (Fáze 3)
# ---------------------------------------------------------------------------
def _inventory_fixture() -> dict:
    return {
        "sweeps": {},
        "instances": [
            {"id": "inst-0001", "label": "hasicí přístroj", "kategorie": "požární",
             "ikona": "🧯", "pozice": {"x": 1.0, "y": 0.0, "z": 0.0},
             "sweeps": [{"sweep": "s1", "bearing": 12.0, "conf": 0.9, "views": [0]}],
             "max_conf": 0.9, "hits": 3},
            {"id": "inst-0002", "label": "hasicí přístroj", "kategorie": "požární",
             "ikona": "🧯", "pozice": {"x": 4.0, "y": 0.0, "z": 2.0},
             "sweeps": [{"sweep": "s2", "bearing": 200.0, "conf": 0.8, "views": [90]}],
             "max_conf": 0.8, "hits": 1},
            {"id": "inst-0003", "label": "východ", "kategorie": "navigace",
             "ikona": "🚪", "pozice": {"x": 9.0, "y": 0.0, "z": 0.0},
             "sweeps": [{"sweep": "s3", "bearing": 45.0, "conf": 0.7, "views": [180]}],
             "max_conf": 0.7, "hits": 2},
        ],
    }


def test_inventory_counts_by_category():
    from app import main

    main.object_store.save(_inventory_fixture())
    res = client.get("/inventory")
    assert res.status_code == 200
    data = res.json()
    assert data["counts"] == {"požární": 2, "navigace": 1}
    assert [i["id"] for i in data["instances"]] == ["inst-0001", "inst-0002", "inst-0003"]


def test_inventory_by_label_near_sorts_by_distance():
    from app import main

    main.object_store.save(_inventory_fixture())
    res = client.get(
        "/inventory/hasic%C3%AD%20p%C5%99%C3%ADstroj",  # „hasicí přístroj“
        params={"near": "0,0,0"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["label"] == "hasicí přístroj"
    ids = [i["id"] for i in data["instances"]]
    assert ids == ["inst-0001", "inst-0002"]  # seřazeno dle vzdálenosti od (0,0,0)
    assert data["instances"][0]["dist"] == 1.0


def test_inventory_unknown_label_404():
    from app import main

    main.object_store.save(_inventory_fixture())
    res = client.get("/inventory/neexistujici")
    assert res.status_code == 404


def test_goto_instance_broadcasts():
    from app import main

    main.object_store.save(_inventory_fixture())
    with client.websocket_connect("/ws") as ws:
        res = client.post("/goto-instance/inst-0001")
        assert res.status_code == 200
        assert res.json()["status"] == "accepted"
        msg = ws.receive_json()
        assert msg["type"] == "goto-instance"
        assert msg["instance"]["id"] == "inst-0001"


def test_goto_instance_unknown_404():
    from app import main

    main.object_store.save(_inventory_fixture())
    res = client.post("/goto-instance/inst-9999")
    assert res.status_code == 404
