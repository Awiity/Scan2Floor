"""Testy parseru odpovědí detektoru (tools/detect_objects.parse_objects)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.detect_objects import parse_objects


def test_parse_plain_json():
    objs = parse_objects('{"objects":[{"label":"dveře","bbox":[0.1,0.2,0.4,0.9],"conf":0.9}]}', 1280, 720)
    assert len(objs) == 1
    assert objs[0]["label_norm"] == "dveře"
    assert objs[0]["bbox"] == [0.1, 0.2, 0.4, 0.9]
    assert objs[0]["conf"] == 0.9


def test_parse_with_code_fence_and_text():
    text = '```json\n{"objects":[{"label":"okno","bbox":[0.2,0.2,0.3,0.5],"conf":0.7}]}\n```'
    objs = parse_objects(text, 1280, 720)
    assert len(objs) == 1
    assert objs[0]["label_norm"] == "okno"


def test_parse_pixel_coords_normalized():
    objs = parse_objects(
        '{"objects":[{"label":"okno","bbox":[128, 144, 384, 576],"conf":0.8}]}', 1280, 720
    )
    assert objs[0]["bbox"] == [0.1, 0.2, 0.3, 0.8]


def test_parse_clamps_and_sorts_bbox():
    objs = parse_objects(
        '{"objects":[{"label":"stůl","bbox":[0.9, 1.2, 0.3, 0.4],"conf":0.5}]}', 1280, 720
    )
    assert objs[0]["bbox"] == [0.3, 0.4, 0.9, 1.0]


def test_parse_dedupes_same_label_same_spot():
    objs = parse_objects(
        '{"objects":[{"label":"dveře","bbox":[0.4,0.1,0.6,0.9],"conf":0.9},'
        '{"label":"dveře","bbox":[0.41,0.11,0.61,0.91],"conf":0.85}]}',
        1280,
        720,
    )
    assert len(objs) == 1


def test_parse_drops_tiny_boxes_and_missing_label():
    objs = parse_objects(
        '{"objects":[{"label":"","bbox":[0.1,0.1,0.2,0.2],"conf":0.9},'
        '{"label":"okno","bbox":[0.5,0.5,0.505,0.51],"conf":0.9},'
        '{"label":"rack","bbox":[0.1,0.1,0.4,0.8],"conf":0.9}]}',
        1280,
        720,
    )
    assert len(objs) == 1
    assert objs[0]["label_norm"] == "serverový rack"


def test_parse_malformed_returns_empty():
    assert parse_objects("", 1280, 720) == []
    assert parse_objects("nějaký text bez json", 1280, 720) == []
    assert parse_objects('{"objects": []}', 1280, 720) == []
    assert parse_objects('{"objects": "ne seznam"}', 1280, 720) == []


def test_parse_conf_missing_defaults():
    objs = parse_objects('{"objects":[{"label":"dveře","bbox":[0.1,0.2,0.4,0.9]}]}', 1280, 720)
    assert objs[0]["conf"] == 0.5
