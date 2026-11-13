"""Testy endpointu GET /export/ifc — on-demand export inventáře + bodů do IFC 4.

Endpoint generuje export.ifc na požadavek (čerstvý soubor — i v Docker slim
image) a servíruje ho jako attachment (model/ifc).
"""
from __future__ import annotations

import json

import ifcopenshell
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

MIN_OBJ = {
    "sweeps": {},
    "instances": [
        {
            "id": "inst-0011", "label": "extinguisher", "kategorie": "požární",
            "max_conf": 0.95, "hits": 9, "estimated": False, "ikona": "🧯",
            "pozice": {"x": -9.65, "y": 4.118, "z": -21.527},
            "sweeps": [{"sweep": "2nfue9", "bearing": 194.2, "conf": 0.9, "views": [180]}],
        },
    ],
}
MIN_PTS = [
    {
        "id": "pt_a1b2", "name": "s1", "sweep": "zhf83pe",
        "position": {"x": -6.96, "y": 1.13, "z": -25.04},
        "rotation": {"x": -25.1, "y": 0.0}, "mode": "mode.inside", "created": "2026-10-01",
    },
]


@pytest.fixture(autouse=True)
def temp_store(tmp_path, monkeypatch):
    """Všechny testy mají vlastní data dir — nikdy nesaháme na reálný model."""
    from app import config, main
    from app.objects import ObjectStore

    store = ObjectStore(tmp_path / "objects.json")
    monkeypatch.setattr(main, "object_store", store)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "MODEL_ID", "testmodel")
    return tmp_path


def _write_data(tmp_path, obj=MIN_OBJ, pts=MIN_PTS) -> None:
    if obj is not None:
        (tmp_path / "objects.json").write_text(json.dumps(obj), encoding="utf-8")
    if pts is not None:
        (tmp_path / "points.json").write_text(json.dumps(pts), encoding="utf-8")


def test_export_ifc_download(tmp_path):
    _write_data(tmp_path)
    res = client.get("/export/ifc")
    assert res.status_code == 200
    assert "attachment" in res.headers.get("content-disposition", "")
    assert "export.ifc" in res.headers.get("content-disposition", "")
    assert res.headers["content-type"].startswith("model/ifc")
    assert res.content[:13] == b"ISO-10303-21;"
    # on-demand — soubor se vygeneroval do data diru
    assert (tmp_path / "export.ifc").is_file()
    f = ifcopenshell.open(tmp_path / "export.ifc")
    assert f.schema == "IFC4"


def test_export_ifc_404_without_inventory(tmp_path):
    res = client.get("/export/ifc")
    assert res.status_code == 404
