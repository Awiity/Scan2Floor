"""Testy IFC exportu (tools/export_ifc.py) — IFC 4, katalogové proxy + body.

Klikatelné produkty: instance inventáře (mapované kategorie → IFC typy) +
uložené body (points.json) — vše s IfcPropertySet „Matterport"."""
from __future__ import annotations

import json
from pathlib import Path

import ifcopenshell
import pytest

from tools.export_ifc import export_to_ifc  # noqa

MIN_OBJ = {
    "sweeps": {},
    "instances": [
        {
            "id": "inst-0011", "label": "extinguisher", "kategorie": "požární",
            "max_conf": 0.95, "hits": 9, "estimated": False, "ikona": "🧯",
            "pozice": {"x": -9.65, "y": 4.118, "z": -21.527},
            "sweeps": [{"sweep": "2nfue9", "bearing": 194.2, "conf": 0.9, "views": [180]}],
        },
        {
            "id": "inst-0002", "label": "rack", "kategorie": "IT",
            "max_conf": 0.7, "hits": 3, "estimated": True, "ikona": "🖥️",
            "pozice": {"x": 1.0, "y": 2.0, "z": 3.0},
            "sweeps": [],
        },
        {
            "id": "inst-0003", "label": "table", "kategorie": "nábytek",
            "max_conf": 0.6, "hits": 1, "estimated": False, "ikona": "🪑",
            "pozice": {"x": 2.0, "y": 2.0, "z": 3.0},
            "sweeps": [],
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

IFC_TYPES = (
    "IfcBuildingElementProxy", "IfcDiscreteAccessory", "IfcDistributionFlowElement",
    "IfcLightFixture", "IfcSanitaryTerminal", "IfcFurniture",
)


@pytest.fixture
def data_dir(tmp_path):
    (tmp_path / "objects.json").write_text(json.dumps(MIN_OBJ), encoding="utf-8")
    (tmp_path / "points.json").write_text(json.dumps(MIN_PTS), encoding="utf-8")
    return tmp_path


def open_export(data_dir):
    return ifcopenshell.open(export_to_ifc(data_dir, model_id="testmodel"))


def read_pset(obj) -> dict:
    """Property setu „Matterport" na produktu — {name: value}."""
    props: dict = {}
    for rel in obj.IsDefinedBy:
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        pset = rel.RelatingPropertyDefinition
        if not pset.is_a("IfcPropertySet") or pset.Name != "Matterport":
            continue
        for p in pset.HasProperties:
            if p.is_a("IfcPropertySingleValue") and p.NominalValue:
                props[p.Name] = p.NominalValue.wrappedValue
    return props


def all_products(f) -> dict:
    out: dict = {}
    for t in IFC_TYPES:
        for e in f.by_type(t):
            out[e.Tag] = e
    return out


def test_export_creates_valid_ifc4(data_dir):
    out = export_to_ifc(data_dir, model_id="testmodel")
    assert out.is_file() and out.name == "export.ifc"
    f = ifcopenshell.open(out)
    assert f.schema == "IFC4"


def test_project_site_building_exists(data_dir):
    f = open_export(data_dir)
    assert f.by_type("IfcProject") and f.by_type("IfcSite") and f.by_type("IfcBuilding")


def test_product_count_matches_instances_and_points(data_dir):
    f = open_export(data_dir)
    products = all_products(f)
    # 3 instance + 1 bod (body jsou proxy taky)
    assert set(products) == {"inst-0011", "inst-0002", "inst-0003", "pt_a1b2"}


def test_position_mm_and_z_up(data_dir):
    # model Y-up (y = výška) → IFC Z-up: IFC = (x, z, y), m → mm
    f = open_export(data_dir)
    products = all_products(f)
    inst = products["inst-0011"]
    loc = inst.ObjectPlacement.RelativePlacement.Location.Coordinates
    assert loc == pytest.approx((-9650.0, -21527.0, 4118.0))


def test_minimal_sphere_geometry(data_dir):
    # klikatelný bod — proxy bez geometrie by v Revit nebyl viditelný
    f = open_export(data_dir)
    products = all_products(f)
    inst = products["inst-0011"]
    assert inst.Representation is not None
    items = [it for shape in inst.Representation.Representations for it in shape.Items]
    assert any(it.is_a("IfcSphere") and it.Radius == 100.0 for it in items)


def test_category_maps_to_ifc_type(data_dir):
    f = open_export(data_dir)
    products = all_products(f)
    # požární → IfcDiscreteAccessory, IT → IfcDistributionFlowElement
    # (IfcDistributionElement je v IFC 4 deprecated pro instanciaci),
    # nábytek → IfcFurniture (mapovací tabulka)
    assert products["inst-0011"].is_a("IfcDiscreteAccessory")
    assert products["inst-0002"].is_a("IfcDistributionFlowElement")
    assert products["inst-0003"].is_a("IfcFurniture")


def test_property_set_carries_data(data_dir):
    f = open_export(data_dir)
    products = all_products(f)
    props = read_pset(products["inst-0011"])
    assert props["label"] == "extinguisher"
    assert props["kategorie"] == "požární"
    assert props["jistota"] == 95
    assert props["hits"] == 9
    assert props["bearing"] == pytest.approx(194.2)
    assert props["sweep"] == "2nfue9"
    assert props["anchor_estimated"] is False


def test_points_as_proxies(data_dir):
    f = open_export(data_dir)
    products = all_products(f)
    pt = products["pt_a1b2"]
    assert pt.is_a("IfcBuildingElementProxy")
    props = read_pset(pt)
    assert props["name"] == "s1"
    assert props["sweep"] == "zhf83pe"
    assert props["yaw"] == pytest.approx(0.0)


def test_real_data_counts(tmp_path):
    data = Path(__file__).resolve().parent.parent / "data" / "yQPhyaCwigp"
    if not data.is_dir():  # fresh clone / CI bez reálných dat
        pytest.skip("reálná data prostoru yQPhyaCwigp nejsou přítomná")
    out = export_to_ifc(data, model_id="yQPhyaCwigp")
    f = ifcopenshell.open(out)
    obj = json.load(open(data / "objects.json"))
    pts = json.load(open(data / "points.json"))
    products = all_products(f)
    assert len(products) == len(obj["instances"]) + len(pts)
    assert len(f.by_type("IfcDiscreteAccessory")) >= 15  # požární (včetně 15 hasicích)
    assert len(f.by_type("IfcDistributionFlowElement")) >= 30  # IT + elektro + zabezpečení


def test_export_validates_against_ifc4_rules(data_dir):
    """Oficiální validátor ifcopenshell (schema + express WHERE rules) — 0 chyb.

    Revit je přísný parser — formální porušení (deprecated typy, povinné
    atributy, WHERE pravidla) by import rozbily.
    """
    import ifcopenshell.validate as validate
    from ifcopenshell.validate import json_logger

    out = export_to_ifc(data_dir, model_id="testmodel")
    lg = json_logger()
    validate.validate(ifcopenshell.open(out), lg, express_rules=True)
    assert not [s for s in lg.statements if s.get("level") == "error"], lg.statements


def test_export_without_points_json(data_dir):
    """Bez points.json (žádné uložené body) — export projde, jen instancí."""
    (data_dir / "points.json").unlink()
    f = open_export(data_dir)
    products = all_products(f)
    assert set(products) == {"inst-0011", "inst-0002", "inst-0003"}


def test_export_with_empty_inventory(data_dir):
    """Prázdný inventář i bez bodů — soubor vznikne, jen s Project/Site/Building."""
    (data_dir / "objects.json").write_text(
        json.dumps({"sweeps": {}, "instances": []}), encoding="utf-8"
    )
    (data_dir / "points.json").write_text(json.dumps([]), encoding="utf-8")
    out = export_to_ifc(data_dir, model_id="testmodel")
    f = ifcopenshell.open(out)
    assert f.by_type("IfcProject") and f.by_type("IfcSite") and f.by_type("IfcBuilding")
    assert not all_products(f)
