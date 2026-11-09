"""Export inventáře instancí + uložených bodů do IFC 4 (katalogové proxy).

Výstup: data/<model_id>/export.ifc — IfcProject → IfcSite → IfcBuilding,
produkty (IfcBuildingElementProxy nebo typovaný element dle kategorie) na
pozici anchor centroidu, minimální klikatelná geometrie (IfcSphere r 0,1 m)
a IfcPropertySet „Matterport" s daty detekce.

Souřadnice: pozice instancí i bodů jsou v model coords (SDK, Y-up) — převod
do IFC: IFC_X = x·1000, IFC_Y = z·1000, IFC_Z = y·1000 (Y-up → Z-up, m → mm).

CLI: python tools/export_ifc.py          # data/<model_id>/export.ifc
     python tools/export_ifc.py --out <dir> [--model <id>]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import ifcopenshell
from ifcopenshell.guid import new as ifc_guid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa

# Mapování kategorií → IFC typy (IFC 4 nemá IfcFireExtinguisher — požární
# zařízení jsou IfcDiscreteAccessory; filtrace v Revit/Blender přes property
# set „Matterport.Kategorie"). IfcDistributionElement je v IFC 4 deprecated
# pro instanciaci → IfcDistributionFlowElement (ne-deprecated subtype).
CATEGORY_TO_IFC_TYPE: dict[str, str] = {
    "požární": "IfcDiscreteAccessory",
    "elektro": "IfcDistributionFlowElement",
    "IT": "IfcDistributionFlowElement",
    "zabezpečení": "IfcDistributionFlowElement",
    "osvětlení": "IfcLightFixture",
    "hygiena": "IfcSanitaryTerminal",
    "nábytek": "IfcFurniture",
}
DEFAULT_IFC_TYPE = "IfcBuildingElementProxy"
# Klikatelný bod — proxy bez geometrie by v Revit nebyl viditelný.
SPHERE_RADIUS_MM = 100.0
PSET_NAME = "Matterport"

PRODUCT_IFC_TYPES = (
    DEFAULT_IFC_TYPE,
    "IfcDiscreteAccessory",
    "IfcDistributionFlowElement",
    "IfcLightFixture",
    "IfcSanitaryTerminal",
    "IfcFurniture",
)


def _to_ifc_position(pos: dict) -> tuple:
    """Model coords (Y-up, m) → IFC coords (Z-up, mm)."""
    return (
        float(pos.get("x", 0.0)) * 1000.0,
        float(pos.get("z", 0.0)) * 1000.0,  # hloubka → IFC Y
        float(pos.get("y", 0.0)) * 1000.0,  # výška → IFC Z
    )


def _owner_history(f):
    person = f.create_entity("IfcPerson", Identification="MatterportIn3D")
    org = f.create_entity(
        "IfcOrganization", Name="MatterportIn3D"  # Name povinný v IFC 4
    )
    pao = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app = f.create_entity(
        "IfcApplication", ApplicationIdentifier="matterport-in3d",
        ApplicationDeveloper=org, ApplicationFullName="Matterport In3D", Version="1.0",
    )
    now = int(time.time())
    return f.create_entity(
        "IfcOwnerHistory", OwningUser=pao, OwningApplication=app,
        State=None, ChangeAction="ADDED",
        # IFC 4: IfcTimeStamp je INTEGER; OriginalCreationDate byl v 2x3,
        # CreationDate povinný; ADDED vyžaduje i LastModifiedDate (WHERE rule)
        CreationDate=now, LastModifiedDate=now,
    )


def _units(f) -> dict:
    mm = f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE")
    rad = f.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
    area = f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE")
    vol = f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    return {"mm": mm, "rad": rad, "area": area, "vol": vol}


def _geom_context(f, units):
    ctx = f.create_entity(
        "IfcGeometricRepresentationContext", ContextIdentifier="Model",
        ContextType="Model", Precision=1e-6,
        CoordinateSpaceDimension=3,  # povinný IfcDimensionCount v IFC 4
        WorldCoordinateSystem=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        ),
    )
    return ctx


def _project(f, owner, units, ctx, name):
    project = f.create_entity(
        "IfcProject", GlobalId=ifc_guid(), Name=name, OwnerHistory=owner,
        Description="Inventář detekovaných objektů — Matterport In3D.",
        RepresentationContexts=[ctx],
        UnitsInContext=f.create_entity(
            "IfcUnitAssignment",
            Units=[units["mm"], units["rad"], units["area"], units["vol"]],
        ),
    )
    return project


def _site_building(f, owner, model_id):
    site = f.create_entity(
        "IfcSite", GlobalId=ifc_guid(), Name=str(model_id or "site"),
        OwnerHistory=owner, CompositionType="ELEMENT",
    )
    building = f.create_entity(
        "IfcBuilding", GlobalId=ifc_guid(), Name=str(model_id or "building"),
        OwnerHistory=owner, CompositionType="ELEMENT",
    )
    f.create_entity(
        "IfcRelAggregates", GlobalId=ifc_guid(),
        RelatingObject=site, RelatedObjects=[building],
    )
    # Site je v počátku (placement relativní k světu), Building relativní k Site
    site_plc = f.create_entity(
        "IfcLocalPlacement",
        RelativePlacement=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        ),
    )
    site.ObjectPlacement = site_plc
    building_plc = f.create_entity(
        "IfcLocalPlacement", PlacementRelTo=site_plc,
        RelativePlacement=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        ),
    )
    building.ObjectPlacement = building_plc
    return site, building, building_plc


def _nominal_value(f, value):
    """IfcValue dle typu — bool → IfcBoolean, int → IfcInteger, float →
    IfcReal, text → IfcLabel."""
    if value is None:
        return None
    if isinstance(value, bool):
        return f.create_entity("IfcBoolean", wrappedValue=bool(value))
    if isinstance(value, int):
        return f.create_entity("IfcInteger", wrappedValue=int(value))
    if isinstance(value, float):
        return f.create_entity("IfcReal", wrappedValue=float(value))
    return f.create_entity("IfcLabel", wrappedValue=str(value))


def _product(f, ifc_class, tag, name, owner, building, building_plc, ctx, position, props):
    """Proxy/element na pozici + IfcSphere r 0,1 m + property set „Matterport"."""
    placement = f.create_entity(
        "IfcLocalPlacement", PlacementRelTo=building_plc,
        RelativePlacement=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=_to_ifc_position(position)),
        ),
    )
    sphere = f.create_entity(
        "IfcSphere", Radius=SPHERE_RADIUS_MM,
        Position=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        ),
    )
    shape = f.create_entity(
        "IfcShapeRepresentation", ContextOfItems=ctx, RepresentationIdentifier="Body",
        # IfcSphere je IfcCsgPrimitive3D — v IFC 4 už není IfcSolidModel → "CSG"
        RepresentationType="CSG", Items=[sphere],
    )
    representation = f.create_entity("IfcProductDefinitionShape", Representations=[shape])
    obj = f.create_entity(
        ifc_class, GlobalId=ifc_guid(), Tag=tag,
        Name=name or tag,  # HasObjectName WHERE rule — Name nesmí být ''
        OwnerHistory=owner, ObjectPlacement=placement, Representation=representation,
    )
    # PropertySet „Matterport" — data detekce
    pset = f.create_entity("IfcPropertySet", GlobalId=ifc_guid(), Name=PSET_NAME)
    pprops = []
    for key, value in props:
        nominal = _nominal_value(f, value)
        if nominal is not None:
            pprops.append(
                f.create_entity("IfcPropertySingleValue", Name=key, NominalValue=nominal)
            )
    pset.HasProperties = pprops
    f.create_entity(
        "IfcRelDefinesByProperties", GlobalId=ifc_guid(),
        RelatedObjects=[obj], RelatingPropertyDefinition=pset,
    )
    f.create_entity(
        "IfcRelContainedInSpatialStructure", GlobalId=ifc_guid(),
        RelatedElements=[obj], RelatingStructure=building,
    )
    return obj


def export_to_ifc(data_dir: str | Path, model_id: str | None = None) -> Path:
    """Export inventáře + bodů do IFC 4 — výstup data/<model_id>/export.ifc."""
    data_dir = Path(data_dir)
    obj_path = data_dir / "objects.json"
    pts_path = data_dir / "points.json"

    obj = json.loads(obj_path.read_text(encoding="utf-8"))
    insts = obj.get("instances", [])
    points = json.loads(pts_path.read_text(encoding="utf-8")) if pts_path.is_file() else []

    f = ifcopenshell.file(schema="IFC4")
    owner = _owner_history(f)
    units = _units(f)
    ctx = _geom_context(f, units)
    project = _project(f, owner, units, ctx, f"Matterport {model_id or ''}".strip())
    site, building, building_plc = _site_building(f, owner, model_id)
    f.create_entity(
        "IfcRelAggregates", GlobalId=ifc_guid(),
        RelatingObject=project, RelatedObjects=[site],
    )

    made = 0
    for inst in insts:
        cat = inst.get("kategorie", "")
        ifc_class = CATEGORY_TO_IFC_TYPE.get(cat, DEFAULT_IFC_TYPE)
        props: list[tuple[str, object]] = [
            ("label", str(inst.get("label", ""))),
            ("kategorie", cat),
            ("jistota", round(inst.get("max_conf", 0.0) * 100, 1)),
            ("hits", int(inst.get("hits", 0))),
            ("anchor_estimated", bool(inst.get("estimated", False))),
        ]
        sweeps = inst.get("sweeps") or []
        if sweeps:
            best = max(sweeps, key=lambda s: s.get("conf") or 0.0)  # nejlepší sken
            props.append(("sweep", str(best.get("sweep", ""))))
            props.append(("bearing", float(best.get("bearing", 0.0))))
        _product(
            f, ifc_class, inst["id"], inst.get("label", ""), owner,
            building, building_plc, ctx, inst.get("pozice", {}), props,
        )
        made += 1

    for pt in points:
        props = [
            ("name", str(pt.get("name", ""))),
            ("sweep", str(pt.get("sweep", ""))),
            ("yaw", float((pt.get("rotation") or {}).get("y", 0.0))),
            ("pitch", float((pt.get("rotation") or {}).get("x", 0.0))),
        ]
        _product(
            f, DEFAULT_IFC_TYPE, pt.get("id", ""), pt.get("name", ""), owner,
            building, building_plc, ctx, pt.get("position", {}), props,
        )
        made += 1

    out = data_dir / "export.ifc"
    f.write(str(out))
    print(f"IFC 4 export: {out} — {made} produktů ({len(insts)} instancí + {len(points)} bodů)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Export inventáře + bodů do IFC 4.")
    ap.add_argument("--out", default=None, help="data dir (default: data/<MP_MODEL_ID>)")
    ap.add_argument("--model", default=None, help="model_id (default: config.MODEL_ID)")
    args = ap.parse_args()
    paths = config.resolve_paths(args.model)
    export_to_ifc(args.out or paths["data_dir"], model_id=args.model or config.MODEL_ID)


if __name__ == "__main__":
    main()
