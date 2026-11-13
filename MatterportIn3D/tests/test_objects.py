"""Testy rozpoznávání objektů (app/objects.py) a endpointů /objects."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.objects import ObjectStore, bearing_for, normalize_label, tags_for_sweep

client = TestClient(app)


@pytest.fixture(autouse=True)
def temp_store(tmp_path, monkeypatch):
    store = ObjectStore(tmp_path / "objects.json")
    monkeypatch.setattr(main, "object_store", store)
    return store


# ---------------------------------------------------------------------------
# Normalizace štítků
# ---------------------------------------------------------------------------
def test_normalize_label_czech():
    assert normalize_label("hasicí přístroj")[0] == "hasicí přístroj"
    assert normalize_label("Hasicí přístroj")[1] == "požární"


def test_normalize_label_variants():
    assert normalize_label("Fire Extinguisher")[0] == "hasicí přístroj"
    assert normalize_label("dvere")[0] == "dveře"
    assert normalize_label("Serverový rack")[0] == "serverový rack"


def test_normalize_label_unknown_keeps_category():
    label, cat, _ = normalize_label("krbová komínovka")
    assert label == "jiné"
    assert cat == "jiné"


# ---------------------------------------------------------------------------
# Geometrie
# ---------------------------------------------------------------------------
def test_bearing_center_is_yaw():
    assert bearing_for(0.0, 0.5) == pytest.approx(0.0)


def test_bearing_right_side_turns_right():
    # sign=-1: objekt na pravé části obrázku (x=1) → yaw klesne o hfov/2
    assert bearing_for(0.0, 1.0, hfov=90, sign=-1) == pytest.approx(315.0)


def test_bearing_wraps():
    assert bearing_for(30.0, 1.0, hfov=90, sign=-1) == pytest.approx(345.0)


# ---------------------------------------------------------------------------
# Agregace tagů
# ---------------------------------------------------------------------------
def _entry(views: dict[float, list[dict]]) -> dict:
    return {"views": {str(k): {"objects": v} for k, v in views.items()}}


def test_tags_merge_same_label_nearby():
    entry = _entry(
        {
            0.0: [{"label": "dveře", "bbox": [0.4, 0.1, 0.6, 0.9], "conf": 0.9}],
            10.0: [{"label": "dveře", "bbox": [0.55, 0.1, 0.75, 0.9], "conf": 0.8}],
        }
    )
    tags = tags_for_sweep(entry)
    assert len(tags) == 1
    tag = tags[0]
    assert tag["label"] == "dveře"
    assert tag["views"] == [0.0, 10.0]
    assert tag["hits"] == 2
    assert tag["conf"] > 0.9  # opakovaný nález zvýšil jistotu


def test_tags_keep_same_label_far_apart():
    entry = _entry(
        {
            0.0: [{"label": "dveře", "bbox": [0.1, 0.1, 0.3, 0.9], "conf": 0.9}],
            90.0: [{"label": "dveře", "bbox": [0.1, 0.1, 0.3, 0.9], "conf": 0.9}],
        }
    )
    tags = tags_for_sweep(entry)
    assert len(tags) == 2


def test_tags_different_labels_never_merge():
    entry = _entry(
        {
            0.0: [
                {"label": "dveře", "bbox": [0.4, 0.1, 0.6, 0.9], "conf": 0.9},
                {"label": "okno", "bbox": [0.42, 0.2, 0.58, 0.8], "conf": 0.9},
            ]
        }
    )
    assert len(tags_for_sweep(entry)) == 2


def test_tags_skip_bad_bbox():
    entry = _entry(
        {
            0.0: [
                {"label": "dveře", "bbox": [0.1, 0.1], "conf": 0.9},  # neúplný bbox
                {"label": "okno", "bbox": [0.2, 0.2, 0.3, 0.3], "conf": 0.1},
            ]
        }
    )
    # neúplný bbox se zahodí, slabá jistota projde jen bez filtru
    assert len(tags_for_sweep(entry, min_conf=0.0)) == 1
    assert len(tags_for_sweep(entry, min_conf=0.3)) == 0


# ---------------------------------------------------------------------------
# Endpointy
# ---------------------------------------------------------------------------
def test_objects_empty():
    res = client.get("/objects")
    assert res.status_code == 200
    assert res.json()["sweeps"] == {}


def test_objects_summary_counts(temp_store):
    temp_store.path.parent.mkdir(parents=True, exist_ok=True)
    temp_store.save(
        {
            "model": "test",
            "updated": "now",
            "sweeps": {
                "s1": {
                    "position": {"x": 1, "y": 2, "z": 3},
                    "views": {
                        "0": {"objects": [{"label": "dveře", "bbox": [0.4, 0.1, 0.6, 0.9], "conf": 0.9}]},
                        "180": {"objects": [{"label": "okno", "bbox": [0.2, 0.2, 0.4, 0.6], "conf": 0.7}]},
                    },
                }
            },
        }
    )
    body = client.get("/objects").json()
    assert body["sweep_count"] == 1
    assert body["counts"] == {"dveře": 1, "okno": 1}
    tags = body["sweeps"]["s1"]["tags"]
    assert [t["label"] for t in tags] == ["dveře", "okno"]
    assert tags[0]["bearing"] is not None


def test_objects_for_sweep(temp_store):
    temp_store.save(
        {
            "sweeps": {
                "s1": {
                    "views": {"90": {"objects": [{"label": "dveře", "bbox": [0.4, 0.1, 0.6, 0.9], "conf": 0.8}]}}
                }
            }
        }
    )
    res = client.get("/objects/s1")
    assert res.status_code == 200
    assert res.json()["tags"][0]["label"] == "dveře"


def test_objects_unknown_sweep():
    assert client.get("/objects/neexistujici").json() == {"sweep": "neexistujici", "tags": []}


def test_objects_survive_reload(tmp_path):
    path = tmp_path / "objects.json"
    ObjectStore(path).save({"sweeps": {"s1": {"views": {}}}})
    assert list(ObjectStore(path).load()["sweeps"]) == ["s1"]


# ---------------------------------------------------------------------------
# Kalibrace směru (měřeno na modelu přes Pointer.intersection — viz plan)
# ---------------------------------------------------------------------------
def test_forward_vector_plan_hypothesis():
    # forward(yaw) = (−sin yaw, 0, −cos yaw) — ověřeno paprsky 0/36/90/180/270/324
    from app.objects import forward_vector
    assert forward_vector(0.0) == pytest.approx((0.0, 0.0, -1.0), abs=1e-9)
    assert forward_vector(90.0) == pytest.approx((-1.0, 0.0, 0.0), abs=1e-9)
    assert forward_vector(180.0) == pytest.approx((0.0, 0.0, 1.0), abs=1e-9)
    assert forward_vector(270.0) == pytest.approx((1.0, 0.0, 0.0), abs=1e-9)


def test_bearing_atan_calibrated_rack():
    # rack na xc 0.8 — měřený paprsek: bearing 324.2° (viz kalibrace v plánu)
    assert bearing_for(0.0, 0.8) == pytest.approx(324.2, abs=0.05)


def test_bearing_atan_mid_offset():
    # rack na xc 0.565 (px 723) — měřený paprsek: 351.13°
    assert bearing_for(0.0, 0.565) == pytest.approx(351.13, abs=0.05)


def test_ray_direction_measured_rack_ray():
    # měřený rack paprsek (yaw 0, px 723/439): jednotkový směr (0.1543, −0.0576, −0.9880)
    from app.objects import ray_direction
    d = ray_direction(0.0, 0.565, 439.2, tan_half=1.2024)
    assert d == pytest.approx((0.1543, -0.0576, -0.9880), abs=0.003)


def test_ray_direction_center_and_up():
    # střed obrazu = paprsek přímo dopředu; výš nad středem → paprsek nahoru
    from app.objects import ray_direction
    assert ray_direction(0.0, 0.5, 408, tan_half=1.2024) == pytest.approx(
        (0.0, 0.0, -1.0), abs=1e-9
    )
    d = ray_direction(0.0, 0.5, 208, tan_half=1.2024)  # 200 px nad středem
    assert d == pytest.approx((0.0, 0.3520, -0.9359), abs=0.003)


# ---------------------------------------------------------------------------
# Anchor pass (Task 3): validace průsečíku + fallback vzdálenost + přenos tagů
# ---------------------------------------------------------------------------
def test_validate_anchor_accepts_measured_rack_ray():
    from app.objects import validate_anchor
    pose = {"x": -0.2698, "y": -1.9093, "z": -0.0858}
    hit = {"position": {"x": 0.4327, "y": -2.1717, "z": -4.5862}}  # měřeno probe_pixels
    angle, dist = validate_anchor(pose, hit, 0.0, 0.565, 439.2, tan_half=1.2024)
    assert angle == pytest.approx(0.0, abs=0.3)
    assert dist == pytest.approx(4.56, abs=0.05)


def test_validate_anchor_rejects_stale_event():
    # event odpovídá jinému pixelu (střed obrazu) než požadovaný rack střed
    from app.objects import validate_anchor
    pose = {"x": -0.2698, "y": -1.9093, "z": -0.0858}
    hit = {"position": {"x": -0.2698, "y": -1.9093, "z": -32.22}}
    angle, _dist = validate_anchor(pose, hit, 0.0, 0.565, 439.2, tan_half=1.2024)
    assert angle > 5.0


def test_estimate_distance_wider_bbox_is_closer():
    from app.objects import estimate_distance
    d1 = estimate_distance("serverový rack", [0.72, 0.05, 0.88, 0.98], tan_half=1.2024)
    d2 = estimate_distance("serverový rack", [0.4, 0.05, 0.88, 0.98], tan_half=1.2024)
    assert d1 > d2 > 0


def test_tags_carry_anchor_from_best_view():
    entry = {
        "views": {
            "0": {
                "objects": [
                    {
                        "label": "hasicí přístroj",
                        "label_norm": "hasicí přístroj",
                        "bbox": [0.53, 0.42, 0.6, 0.8],
                        "conf": 0.9,
                        "anchor": {"x": 1.0, "y": -2.0, "z": -4.0},
                        "anchor_dist": 4.5,
                    }
                ]
            }
        }
    }
    tags = tags_for_sweep(entry)
    assert tags[0]["anchor"] == {"x": 1.0, "y": -2.0, "z": -4.0}
    assert tags[0]["anchor_dist"] == 4.5


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Parkoviště myši (tools/anchor_objects.py — čistá funkce)
# ---------------------------------------------------------------------------
def test_park_for_moves_away_when_pixel_near_park():
    from tools.anchor_objects import PARK_A, PARK_B, park_for
    assert park_for((5, 6)) == PARK_B        # pixel u PARK_A → park na PARK_B
    assert park_for((1024, 371)) == PARK_A   # běžný pixel → PARK_A


def test_park_for_moves_away_when_pixel_near_park_b():
    from tools.anchor_objects import PARK_A, PARK_B, park_for
    assert park_for(PARK_B) == PARK_A


# ---------------------------------------------------------------------------
# Merge instancí (Fáze 2): poloměry, greedy clustering, cap průměru
# ---------------------------------------------------------------------------
def test_merge_radius_per_category():
    from app.objects import merge_radius
    assert merge_radius("serverový rack") == 0.4
    assert merge_radius("hasicí přístroj") == 0.6
    assert merge_radius("hlásič") == 0.6
    assert merge_radius("světlo / zářivka") == 0.8
    assert merge_radius("úplně cizí štítek") == 0.8  # default


def test_cluster_close_same_label_merges():
    from app.objects import cluster_anchor_objects
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 1.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
            "s2": {"position": {"x": 1, "y": 0, "z": 0}, "views": {"90": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.8,
                 "anchor": {"x": 1.2, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
        }
    }
    inst = cluster_anchor_objects(data)
    assert len(inst) == 1
    assert inst[0]["hits"] == 2
    assert inst[0]["pozice"] == pytest.approx({"x": 1.1, "y": 0.0, "z": 0.0})
    assert {e["sweep"] for e in inst[0]["sweeps"]} == {"s1", "s2"}


def test_cluster_far_same_label_stays_two():
    from app.objects import cluster_anchor_objects
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "dveře", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 0.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "dveře", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.8,
                 "anchor": {"x": 5.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
        }
    }
    assert len(cluster_anchor_objects(data)) == 2


def test_cluster_radius_respected_rack():
    from app.objects import cluster_anchor_objects
    # dva racky 0,6 m od sebe (poloměr racku 0,4) → 2 instance
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "serverový rack", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 0.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "serverový rack", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.85,
                 "anchor": {"x": 0.6, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
        }
    }
    assert len(cluster_anchor_objects(data)) == 2


def test_cluster_cap_prevents_chaining():
    from app.objects import cluster_anchor_objects
    # hasicí (r 0.6, cap 1.2): řetěz 0 / 0.55 / 1.1 / 1.65 — první tři v clusteru
    # (průměr 1.1 ≤ cap), čtvrtý už cap zamítne (1.65 > 1.2) → 2 instance
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 0.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.85,
                 "anchor": {"x": 0.55, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.8,
                 "anchor": {"x": 1.1, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.75,
                 "anchor": {"x": 1.65, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
        }
    }
    inst = cluster_anchor_objects(data)
    assert len(inst) == 2
    assert inst[0]["hits"] == 3  # A+B+C
    assert inst[1]["hits"] == 1  # D zamítnut capem


def test_cluster_instance_fields_and_ids():
    from app.objects import cluster_anchor_objects
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 1.0, "y": 0.0, "z": 0.0}, "anchor_estimated": True},
                {"label": "východ", "bbox": [0.3, 0.4, 0.7, 0.9], "conf": 0.7,
                 "anchor": {"x": 2.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}, "90": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.75,
                 "anchor": {"x": 1.05, "y": 0.0, "z": 0.0}, "anchor_estimated": True},
            ]}}},
        }
    }
    inst = cluster_anchor_objects(data)
    assert len(inst) == 2
    first = inst[0]
    assert first["id"] == "inst-0001"
    assert inst[1]["id"] == "inst-0002"
    assert first["label"] == "hasicí přístroj"
    assert first["kategorie"] == "požární"
    assert first["hits"] == 2
    assert first["max_conf"] == 0.9
    assert len(first["sweeps"]) == 1
    e = first["sweeps"][0]
    assert e["sweep"] == "s1"
    assert e["views"] == [0, 90]
    assert e["conf"] == 0.9  # max conf pohledů
    assert isinstance(e["bearing"], (int, float))


def test_merge_tool_writes_instances(tmp_path):
    import json
    from types import SimpleNamespace

    from tools.merge_objects import run
    out = tmp_path / "objects.json"
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.9,
                 "anchor": {"x": 1.0, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
                {"label": "hasicí přístroj", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.8,
                 "anchor": {"x": 1.1, "y": 0.0, "z": 0.0}, "anchor_estimated": False},
            ]}}},
        }
    }
    out.write_text(json.dumps(data), encoding="utf-8")

    assert run(SimpleNamespace(out=str(out))) == 0
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["instances"][0]["hits"] == 2
    assert saved["sweeps"]["s1"]["views"]["0"]["objects"][0]["label"] == "hasicí přístroj"  # raw zůstává


def test_anchor_from_event_converts_mm_event_to_meters():
    # SDK event pro intersectedobject.unknown je v mm (reálný bug: 22 anchorů
    # v mm → instance v mm → IFC souřadnice ±8 451 m). anchor_from_event musí
    # mm pozici konvertovat na metry a vrátit anchor v m.
    from app.config import CAPTURE_TAN_HALF
    from app.objects import ray_direction
    from tools.anchor_objects import anchor_from_event

    bbox = [0.5, 0.4, 0.6, 0.7]
    job = {"sid": "s1", "yaw": 0, "idx": 0, "bbox": bbox, "label_raw": "okno"}
    pose = {"position": {"x": 0.0, "y": 0.0, "z": -22.0}}
    xc = (bbox[0] + bbox[2]) / 2
    yc_px = ((bbox[1] + bbox[3]) / 2) * 720
    direction = ray_direction(0.0, xc, yc_px, CAPTURE_TAN_HALF)
    dist = 20.0
    m_pos = {
        "x": pose["position"]["x"] + dist * direction[0],
        "y": pose["position"]["y"] + dist * direction[1],
        "z": pose["position"]["z"] + dist * direction[2],
    }
    # mm event = legitimní m pozice × 1000 (paprsek na rayi → úhel 0°)
    mm_event = {
        "position": {k: v * 1000 for k, v in m_pos.items()},
        "object": "intersectedobject.unknown",
    }
    anchor, angle = anchor_from_event(job, pose, mm_event)
    assert not anchor["anchor_estimated"]
    assert anchor["anchor"]["x"] == pytest.approx(m_pos["x"], abs=1e-3)
    assert anchor["anchor"]["y"] == pytest.approx(m_pos["y"], abs=1e-3)
    assert anchor["anchor"]["z"] == pytest.approx(m_pos["z"], abs=1e-3)
    assert anchor["anchor_dist"] == pytest.approx(dist, abs=0.05)


def test_cluster_excludes_out_of_range_anchor(caplog):
    # anchor v mm (reálný bug) se vyloučí z clusteringu — žádná instance v mm
    from app.objects import cluster_anchor_objects
    data = {
        "sweeps": {
            "s1": {"position": {"x": 0, "y": 0, "z": 0}, "views": {"0": {"objects": [
                {"label": "okno", "bbox": [0.5, 0.4, 0.6, 0.7], "conf": 0.95,
                 "anchor": {"x": 7100.5, "y": 1265.4, "z": -8451.0},
                 "anchor_estimated": False},
            ]}}},
        }
    }
    with caplog.at_level("WARNING"):
        instances = cluster_anchor_objects(data)
    assert instances == []
    assert "mimo rozsah" in caplog.text
