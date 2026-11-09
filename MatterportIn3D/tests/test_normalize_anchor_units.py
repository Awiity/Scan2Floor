"""Testy jednorázové migrace jednotek anchorů (tools/normalize_anchor_units.py)."""
from __future__ import annotations

import json

import pytest


def _write(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def test_converts_mm_anchor_and_keeps_m(tmp_path):
    from tools.normalize_anchor_units import run

    f = tmp_path / "objects.json"
    _write(f, {"sweeps": {"s1": {"views": {"0": {"objects": [
        {"label": "okno", "anchor": {"x": 7100.5, "y": 1265.4, "z": -8451.0},
         "anchor_dist": 8090.9, "anchor_obj": "intersectedobject.unknown",
         "anchor_estimated": False},
        {"label": "světlo", "anchor": {"x": 2.1, "y": -0.2, "z": -26.1},
         "anchor_dist": 2.5, "anchor_estimated": False},
    ]}}}}})
    changed, total = run(f)
    assert changed == 1
    assert total == 2
    saved = json.loads(f.read_text(encoding="utf-8"))
    objs = saved["sweeps"]["s1"]["views"]["0"]["objects"]
    assert objs[0]["anchor"] == pytest.approx({"x": 7.1005, "y": 1.2654, "z": -8.4510})
    assert objs[0]["anchor_dist"] == pytest.approx(8.0909, abs=1e-3)
    assert objs[1]["anchor"] == {"x": 2.1, "y": -0.2, "z": -26.1}


def test_idempotent_second_run_changes_nothing(tmp_path):
    from tools.normalize_anchor_units import run

    f = tmp_path / "objects.json"
    _write(f, {"sweeps": {"s1": {"views": {"0": {"objects": [
        {"label": "okno", "anchor": {"x": 8451.0, "y": 0.0, "z": 0.0},
         "anchor_dist": 8451.0},
    ]}}}}})
    run(f)
    first = json.loads(f.read_text(encoding="utf-8"))
    changed, _ = run(f)
    assert changed == 0
    assert json.loads(f.read_text(encoding="utf-8")) == first


def test_backup_created_before_write(tmp_path):
    from tools.normalize_anchor_units import run

    f = tmp_path / "objects.json"
    _write(f, {"sweeps": {"s1": {"views": {"0": {"objects": [
        {"label": "okno", "anchor": {"x": 8451.0, "y": 0.0, "z": 0.0}},
    ]}}}}})
    run(f)
    backup = f.with_suffix(f.suffix + ".pre-units")
    assert backup.exists()
    # backup musí obsahovat PŮVODNÍ mm hodnoty (pre-migrace), ne konvertované
    saved = json.loads(backup.read_text(encoding="utf-8"))
    assert saved["sweeps"]["s1"]["views"]["0"]["objects"][0]["anchor"] == {
        "x": 8451.0, "y": 0.0, "z": 0.0,
    }


def test_instances_section_recomputed_by_merge(tmp_path):
    # instance pozice se NEpřepočítávají ve skriptu — merge_objects z raw views
    from tools.merge_objects import run as merge_run
    from types import SimpleNamespace

    f = tmp_path / "objects.json"
    _write(f, {"sweeps": {"s1": {"position": {"x": 0, "y": 0, "z": 0},
     "views": {"0": {"objects": [
        {"label": "okno", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.95,
         "anchor": {"x": 7100.5, "y": 1265.4, "z": -8451.0},
         "anchor_estimated": False},
    ]}}}}})
    from tools.normalize_anchor_units import run

    run(f)
    merge = merge_run(SimpleNamespace(out=str(f)))
    assert merge == 0
    saved = json.loads(f.read_text(encoding="utf-8"))
    # merge přegeneruje instanci z konvertovaného anchoru — pozice v m
    assert len(saved["instances"]) == 1
    assert saved["instances"][0]["pozice"] == pytest.approx(
        {"x": 7.101, "y": 1.265, "z": -8.451}, abs=1e-3
    )
