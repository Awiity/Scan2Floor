"""Testy config — data per prostor: data/<model_id>/ (Task 3)."""
from __future__ import annotations

import pytest

from app import config


def test_default_paths_per_model(monkeypatch):
    monkeypatch.delenv("MP_DATA_DIR", raising=False)
    monkeypatch.delenv("MP_OBJECTS_FILE", raising=False)
    monkeypatch.delenv("MP_POINTS_FILE", raising=False)
    monkeypatch.delenv("MP_CAPTURE_DIR", raising=False)
    paths = config.resolve_paths("testmodel-xyz")
    root = config._PROJECT / "data" / "testmodel-xyz"
    assert paths["data_dir"] == root
    assert paths["objects_file"] == root / "objects.json"
    assert paths["points_file"] == root / "points.json"
    assert paths["capture_dir"] == root / "capture"


def test_env_overrides_win(monkeypatch, tmp_path):
    monkeypatch.setenv("MP_OBJECTS_FILE", str(tmp_path / "obj.json"))
    monkeypatch.setenv("MP_POINTS_FILE", str(tmp_path / "pts.json"))
    monkeypatch.setenv("MP_CAPTURE_DIR", str(tmp_path / "cap"))
    paths = config.resolve_paths("testmodel-xyz")
    assert paths["objects_file"] == tmp_path / "obj.json"
    assert paths["points_file"] == tmp_path / "pts.json"
    assert paths["capture_dir"] == tmp_path / "cap"


def test_data_dir_override(monkeypatch, tmp_path):
    monkeypatch.setenv("MP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("MP_OBJECTS_FILE", raising=False)
    monkeypatch.delenv("MP_POINTS_FILE", raising=False)
    monkeypatch.delenv("MP_CAPTURE_DIR", raising=False)
    paths = config.resolve_paths("mid-abc")
    assert paths["data_dir"] == tmp_path / "data" / "mid-abc"
    assert paths["objects_file"] == tmp_path / "data" / "mid-abc" / "objects.json"


def test_model_id_from_env_used_as_default(monkeypatch):
    monkeypatch.delenv("MP_DATA_DIR", raising=False)
    monkeypatch.setenv("MP_MODEL_ID", "mid-from-env")
    paths = config.resolve_paths()
    assert paths["data_dir"].name == "mid-from-env"
