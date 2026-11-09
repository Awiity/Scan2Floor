"""Testy ukládání bodů (points.json) a endpointů /points."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.points import PointStore

client = TestClient(app)


@pytest.fixture(autouse=True)
def temp_store(tmp_path, monkeypatch):
    """Každý test dostane prázdné úložiště v tmp_path."""
    store = PointStore(tmp_path / "points.json")
    monkeypatch.setattr(main, "store", store)
    return store


POINT = {
    "name": "Vstup",
    "sweep": "4k1q3tsgryi9z76ybhmdp370d",
    "position": {"x": -12.69, "y": 1.13, "z": -21.79},
    "rotation": {"x": -4.64, "y": -36.96},
    "mode": "mode.inside",
}


def test_list_empty():
    res = client.get("/points")
    assert res.status_code == 200
    assert res.json() == {"points": []}


def test_create_and_list(temp_store):
    res = client.post("/points", json=POINT)
    assert res.status_code == 201
    body = res.json()
    assert body["id"].startswith("pt_")
    assert body["name"] == "Vstup"
    assert body["sweep"] == POINT["sweep"]
    assert body["created"]

    listed = client.get("/points").json()["points"]
    assert [p["id"] for p in listed] == [body["id"]]

    # data jsou opravdu v souboru
    on_disk = json.loads((temp_store.path).read_text(encoding="utf-8"))
    assert on_disk[0]["name"] == "Vstup"


def test_create_minimal_point():
    """Bez sweepu/rotace — bod z dollhouse pohledu."""
    res = client.post(
        "/points", json={"name": "Přehled", "position": {"x": 0, "y": 0, "z": 0}}
    )
    assert res.status_code == 201
    body = res.json()
    assert body["sweep"] == ""
    assert body["rotation"] == {"x": 0.0, "y": 0.0}


def test_create_rejects_empty_name():
    res = client.post("/points", json={**POINT, "name": ""})
    assert res.status_code == 400
    assert res.json()["error"] == "invalid_message"


def test_create_rejects_blank_name():
    res = client.post("/points", json={**POINT, "name": "   "})
    assert res.status_code == 400


def test_create_rejects_missing_position():
    res = client.post("/points", json={"name": "Bez pozice"})
    assert res.status_code == 400


def test_delete_point():
    pid = client.post("/points", json=POINT).json()["id"]
    assert client.delete(f"/points/{pid}").status_code == 204
    assert client.get("/points").json()["points"] == []
    assert client.delete(f"/points/{pid}").status_code == 404


def test_goto_unknown_point():
    assert client.post("/points/pt_neexistuje/goto").status_code == 404


def test_goto_broadcasts_to_browsers():
    pid = client.post("/points", json=POINT).json()["id"]
    with client.websocket_connect("/ws") as ws:
        res = client.post(f"/points/{pid}/goto")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "accepted"
        assert body["sent_to"] == 1
        msg = ws.receive_json()
    assert msg["type"] == "goto"
    assert msg["point"]["id"] == pid


def test_points_survive_restart(tmp_path):
    """Nový PointStore na stejné cestě načte dříve uložené body."""
    path = tmp_path / "points.json"
    PointStore(path).add(
        {"name": "A", "sweep": "s1", "position": {"x": 1, "y": 2, "z": 3}}
    )
    assert [p["name"] for p in PointStore(path).list()] == ["A"]
