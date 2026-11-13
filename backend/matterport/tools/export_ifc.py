"""Standalone IFC4 BuildingSMART exporter for Matterport object inventory."""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path
from typing import Any

from ..config import MODEL_ID, resolve_paths
from ..objects import ObjectStore, normalize_label

CATEGORY_TO_IFC_TYPE: dict[str, tuple[str, str]] = {
    "dvere": ("IfcDoor", "DOOR"),
    "okno": ("IfcWindow", "WINDOW"),
    "radiator": ("IfcSpaceHeater", "RADIATOR"),
    "hasici_pristroj": ("IfcFireSuppressionTerminal", "FIRE_EXTINGUISHER"),
    "hydrant": ("IfcFireSuppressionTerminal", "HOSE_REEL"),
    "rozvadec": ("IfcElectricDistributionBoard", "DISTRIBUTION_BOARD"),
    "zasuvka": ("IfcOutlet", "POWER_OUTLET"),
    "vypinac": ("IfcSwitchingDevice", "TOGGLE_SWITCH"),
    "svitidlo": ("IfcLightFixture", "CEILING_LIGHT"),
    "nouzove_osvetleni": ("IfcLightFixture", "EXIT_SIGN"),
    "kamera": ("IfcAudioVisualAppliance", "SECURITY_CAMERA"),
    "detektor_koure": ("IfcSensor", "SMOKE_SENSOR"),
    "klimatizace": ("IfcUnitaryEquipment", "AIR_CONDITIONER"),
    "ventilace": ("IfcAirTerminal", "DIFFUSER"),
    "kotel": ("IfcBoiler", "BOILER"),
    "potrubi": ("IfcPipeSegment", "PIPE"),
    "umyvadlo": ("IfcSanitaryTerminal", "WASHHANDBASIN"),
    "wc": ("IfcSanitaryTerminal", "TOILET_PAN"),
    "sprcha": ("IfcSanitaryTerminal", "SHOWER"),
    "stul": ("IfcFurniture", "DESK"),
    "zidle": ("IfcFurniture", "CHAIR"),
    "skrin": ("IfcFurniture", "CABINET"),
    "monitor": ("IfcAudioVisualAppliance", "DISPLAY"),
    "schody": ("IfcStair", "STAIR"),
    "zabradli": ("IfcRailing", "RAILING"),
}


def _guid() -> str:
    import ifcopenshell

    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def _to_ifc_position(anchor: dict[str, Any]) -> tuple[float, float, float]:
    """Convert Matterport Y-up (x, y, z) to IFC Z-up (x, -z, y)."""
    x = float(anchor.get("x", 0.0))
    y = float(anchor.get("y", 0.0))
    z = float(anchor.get("z", 0.0))
    return (x, -z, y)


def _make_box_shape(ifc: Any, body_ctx: Any, size: float = 0.25) -> Any:
    half = size / 2.0
    origin = ifc.createIfcAxis2Placement3D(
        ifc.createIfcCartesianPoint((0.0, 0.0, -half)), None, None
    )
    rect = ifc.createIfcRectangleProfileDef("AREA", None, ifc.createIfcAxis2Placement2D(ifc.createIfcCartesianPoint((0.0, 0.0)), None), size, size)
    solid = ifc.createIfcExtrudedAreaSolid(
        rect,
        origin,
        ifc.createIfcDirection((0.0, 0.0, 1.0)),
        size,
    )
    shape_rep = ifc.createIfcShapeRepresentation(body_ctx, "Body", "SweptSolid", [solid])
    return ifc.createIfcProductDefinitionShape(None, None, [shape_rep])


def export_to_ifc(
    objects_path: Path | str,
    out_path: Path | str,
    model_id: str = MODEL_ID,
) -> dict[str, Any]:
    """Generate an IFC4 file from ``objects.json`` clustered instances."""
    import ifcopenshell
    import ifcopenshell.api

    store = ObjectStore(path=Path(objects_path))
    instances = store.instances()

    ifc = ifcopenshell.file(schema="IFC4")
    project = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcProject", name=f"Matterport_{model_id}")
    ifcopenshell.api.run("unit.assign_unit", ifc, length={"is_metric": True, "raw": "METERS"})
    ctx = ifcopenshell.api.run("context.add_context", ifc, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context",
        ifc,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=ctx,
    )

    site = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcBuilding", name=model_id)
    storey = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcBuildingStorey", name="All_Levels")
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=project, products=[site])
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=site, products=[building])
    ifcopenshell.api.run("aggregate.assign_object", ifc, relating_object=building, products=[storey])

    exported = 0
    for inst in instances:
        anchor = inst.get("anchor")
        if not isinstance(anchor, dict):
            continue
        label = normalize_label(inst.get("label", "other"))
        ifc_cls, tag_type = CATEGORY_TO_IFC_TYPE.get(label, ("IfcBuildingElementProxy", "USERDEFINED"))
        name = f"{label}_{inst.get('instance_id', exported)}"
        try:
            elem = ifcopenshell.api.run("root.create_entity", ifc, ifc_class=ifc_cls, name=name)
        except Exception:
            elem = ifcopenshell.api.run("root.create_entity", ifc, ifc_class="IfcBuildingElementProxy", name=name)

        px, py, pz = _to_ifc_position(anchor)
        placement = ifc.createIfcLocalPlacement(
            None,
            ifc.createIfcAxis2Placement3D(ifc.createIfcCartesianPoint((px, py, pz)), None, None),
        )
        elem.ObjectPlacement = placement
        elem.Representation = _make_box_shape(ifc, body, size=0.22)
        if hasattr(elem, "Tag"):
            elem.Tag = inst.get("instance_id")
        ifcopenshell.api.run("spatial.assign_container", ifc, relating_structure=storey, products=[elem])

        pset = ifcopenshell.api.run("pset.add_pset", ifc, product=elem, name="Matterport")
        ifcopenshell.api.run(
            "pset.edit_pset",
            ifc,
            pset=pset,
            properties={
                "InstanceId": str(inst.get("instance_id", "")),
                "Label": label,
                "SemanticType": tag_type,
                "MaxScore": float(inst.get("max_score", 0.0)),
                "ObservationCount": int(inst.get("observation_count", 1)),
                "SweepIds": ", ".join(inst.get("sweep_ids", [])),
            },
        )
        exported += 1

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    ifc.write(str(out))
    return {"path": str(out), "instances_exported": exported, "model_id": model_id}


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Matterport objects.json to IFC4")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--objects", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    paths = resolve_paths(args.model_id)
    obj_path = Path(args.objects) if args.objects else paths["objects"]
    out_path = Path(args.out) if args.out else paths["base"] / f"{args.model_id}_matterport.ifc"
    res = export_to_ifc(obj_path, out_path, model_id=args.model_id)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()

