"""
ifc_export.py — Converts detected wall / opening / room data to IFC 2x3 format.

IFC Elements produced
---------------------
IfcProject            — root project container
IfcSite               — site
IfcBuilding           — building
IfcBuildingStorey     — one per floor (uses floor_levels from info.json)
IfcWallStandardCase   — one per wall segment  (A-WALL layer)
IfcDoor               — one per door opening  (A-DOOR layer)
IfcWindow             — one per window opening (A-WINDOW layer)
IfcSpace              — one per detected room  (A-ROOM layer)

Coordinate system
-----------------
Scan2floor uses a right-handed XZ plane (Y up) for horizontal positions.
IFC uses XY plane (Z up). The converter maps:  IFC-X = scan-X, IFC-Y = scan-Z, IFC-Z = elevation.

Units: metres (SI).
"""

from __future__ import annotations

import math
import os
import json
import time
import uuid
from typing import Optional

try:
    import ifcopenshell
    import ifcopenshell.guid
    _IFC_AVAILABLE = True
except ImportError:
    _IFC_AVAILABLE = False


# ── Default building parameters ───────────────────────────────────────────────

WALL_HEIGHT_M     = 2.80   # default storey height if not derivable from floor levels
WALL_THICKNESS_M  = 0.20   # default wall thickness for 3D extrusion
DOOR_HEIGHT_M     = 2.10
WINDOW_HEIGHT_M   = 1.20
WINDOW_SILL_M     = 0.90   # sill height above floor


# ── Helpers ───────────────────────────────────────────────────────────────────

def _guid() -> str:
    """Return a valid IFC GlobalId (22-char base64-encoded UUID)."""
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def _wall_height(floor_idx: int, floor_levels: list) -> float:
    """Estimate storey height from adjacent floor_levels entries."""
    if len(floor_levels) > floor_idx + 1:
        return abs(floor_levels[floor_idx + 1] - floor_levels[floor_idx])
    if len(floor_levels) > floor_idx and floor_idx > 0:
        return abs(floor_levels[floor_idx] - floor_levels[floor_idx - 1])
    return WALL_HEIGHT_M


# ── IFC geometry primitives ───────────────────────────────────────────────────

def _ifc_axis2placement3d(ifc_file, location=(0.0, 0.0, 0.0),
                           axis=(0.0, 0.0, 1.0), ref_direction=(1.0, 0.0, 0.0)):
    """Create an IfcAxis2Placement3D."""
    return ifc_file.createIfcAxis2Placement3D(
        ifc_file.createIfcCartesianPoint(list(location)),
        ifc_file.createIfcDirection(list(axis)),
        ifc_file.createIfcDirection(list(ref_direction)),
    )


def _ifc_local_placement(ifc_file, relative_to=None,
                          location=(0.0, 0.0, 0.0),
                          axis=(0.0, 0.0, 1.0),
                          ref_direction=(1.0, 0.0, 0.0)):
    """Create an IfcLocalPlacement."""
    placement = _ifc_axis2placement3d(ifc_file, location, axis, ref_direction)
    return ifc_file.createIfcLocalPlacement(relative_to, placement)


def _ifc_extruded_area_solid(ifc_file, profile, extrusion_height: float,
                              extrusion_dir=(0.0, 0.0, 1.0)):
    """Wrap a profile in an IfcExtrudedAreaSolid."""
    placement = ifc_file.createIfcAxis2Placement3D(
        ifc_file.createIfcCartesianPoint([0.0, 0.0, 0.0]),
        ifc_file.createIfcDirection([0.0, 0.0, 1.0]),
        ifc_file.createIfcDirection([1.0, 0.0, 0.0]),
    )
    return ifc_file.createIfcExtrudedAreaSolid(
        profile,
        placement,
        ifc_file.createIfcDirection(list(extrusion_dir)),
        extrusion_height,
    )


def _create_box_representation(ifc_file, width: float, depth: float,
                                height: float, context):
    """Simple box profile for doors/windows."""
    rect = ifc_file.createIfcRectangleProfileDef(
        "AREA",
        None,
        ifc_file.createIfcAxis2Placement2D(
            ifc_file.createIfcCartesianPoint([0.0, 0.0]),
            ifc_file.createIfcDirection([1.0, 0.0]),
        ),
        width,
        depth,
    )
    solid = _ifc_extruded_area_solid(ifc_file, rect, height)
    return ifc_file.createIfcShapeRepresentation(context, "Body", "SweptSolid", [solid])


def _create_space_representation(ifc_file, polygon: list, height: float, context):
    """Create IfcShapeRepresentation for an IfcSpace using a polygon footprint."""
    if not polygon or len(polygon) < 3:
        return None

    pts_2d = [ifc_file.createIfcCartesianPoint([float(p[0]), float(p[1])]) for p in polygon]
    pts_2d.append(pts_2d[0])   # close the loop
    poly_loop = ifc_file.createIfcPolyline(pts_2d)
    profile = ifc_file.createIfcArbitraryClosedProfileDef("AREA", None, poly_loop)
    solid = _ifc_extruded_area_solid(ifc_file, profile, height)
    return ifc_file.createIfcShapeRepresentation(context, "Body", "SweptSolid", [solid])


def _build_ifc_boilerplate(ifc_file):
    """
    Create the standard IFC boilerplate: OwnerHistory, Units, ModelContext.
    Returns (owner, unit_assign, model_context, body_sub).
    """
    org     = ifc_file.createIfcOrganization(None, "Scan2Floor", None, None, None)
    person  = ifc_file.createIfcPerson(None, None, "Scan2Floor", None, None, None, None, None)
    p_and_o = ifc_file.createIfcPersonAndOrganization(person, org, None)
    app     = ifc_file.createIfcApplication(org, "0.3.0", "Scan2Floor", "Scan2Floor")
    owner   = ifc_file.createIfcOwnerHistory(
        p_and_o, app, "READWRITE", None, None, p_and_o, app,
        int(time.time()),
    )

    si_unit     = ifc_file.createIfcSIUnit(None, "LENGTHUNIT",     None, "METRE")
    area_unit   = ifc_file.createIfcSIUnit(None, "AREAUNIT",       None, "SQUARE_METRE")
    vol_unit    = ifc_file.createIfcSIUnit(None, "VOLUMEUNIT",     None, "CUBIC_METRE")
    plane_unit  = ifc_file.createIfcSIUnit(None, "PLANEANGLEUNIT", None, "RADIAN")
    unit_assign = ifc_file.createIfcUnitAssignment([si_unit, area_unit, vol_unit, plane_unit])

    world_origin  = ifc_file.createIfcCartesianPoint([0.0, 0.0, 0.0])
    true_north    = ifc_file.createIfcDirection([0.0, 1.0])
    wcs           = ifc_file.createIfcAxis2Placement3D(
        world_origin,
        ifc_file.createIfcDirection([0.0, 0.0, 1.0]),
        ifc_file.createIfcDirection([1.0, 0.0, 0.0]),
    )
    model_context = ifc_file.createIfcGeometricRepresentationContext(
        "Model", "Model", 3, 1.0e-5, wcs, true_north
    )
    body_sub = ifc_file.createIfcGeometricRepresentationSubContext(
        "Body", "Model", None, None, None, None,
        model_context, None, "MODEL_VIEW", None
    )

    return owner, unit_assign, model_context, body_sub


def _add_storey_elements(ifc_file, owner, body_sub,
                         floor_idx: int, storey, storey_placement,
                         lines, all_openings, rooms,
                         storey_height: float, wall_thickness: float):
    """
    Create walls, doors, windows, spaces for one storey and link them.
    Returns the list of IfcProduct instances added.
    """
    contained: list = []

    # ── Walls ─────────────────────────────────────────────────────────────────
    for seg_idx, seg in enumerate(lines):
        try:
            x1, z1 = float(seg[0][0]), float(seg[0][1])
            x2, z2 = float(seg[1][0]), float(seg[1][1])
        except (IndexError, TypeError, ValueError):
            continue

        length = math.hypot(x2 - x1, z2 - z1)
        if length < 0.001:
            continue

        angle = math.atan2(z2 - z1, x2 - x1)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        mx = (x1 + x2) / 2.0
        my = (z1 + z2) / 2.0

        wall_placement = _ifc_local_placement(
            ifc_file, storey_placement,
            location=(mx, my, 0.0),
            axis=(0.0, 0.0, 1.0),
            ref_direction=(cos_a, sin_a, 0.0),
        )
        rect = ifc_file.createIfcRectangleProfileDef(
            "AREA", None,
            ifc_file.createIfcAxis2Placement2D(
                ifc_file.createIfcCartesianPoint([0.0, 0.0]),
                ifc_file.createIfcDirection([1.0, 0.0]),
            ),
            length, wall_thickness,
        )
        solid    = _ifc_extruded_area_solid(ifc_file, rect, storey_height)
        shape    = ifc_file.createIfcShapeRepresentation(body_sub, "Body", "SweptSolid", [solid])
        prod_repr = ifc_file.createIfcProductDefinitionShape(None, None, [shape])

        wall = ifc_file.createIfcWallStandardCase(
            _guid(), owner,
            f"Wall_{floor_idx}_{seg_idx:04d}", None, None,
            wall_placement, prod_repr, None,
        )
        contained.append(wall)

    # ── Doors ─────────────────────────────────────────────────────────────────
    for op_idx, op in enumerate(all_openings):
        if op.get("type", "door") != "door":
            continue
        try:
            cx  = float(op.get("x", 0.0))
            cz  = float(op.get("z", 0.0))
            w_m = float(op.get("width_m") or op.get("width") or 0.9)
            x1w = float(op.get("wall_x1", cx - w_m / 2))
            z1w = float(op.get("wall_z1", cz))
            x2w = float(op.get("wall_x2", cx + w_m / 2))
            z2w = float(op.get("wall_z2", cz))
            wl  = math.hypot(x2w - x1w, z2w - z1w)
            if wl < 0.001:
                continue
            angle = math.atan2(z2w - z1w, x2w - x1w)
            cos_a, sin_a = math.cos(angle), math.sin(angle)

            door_placement = _ifc_local_placement(
                ifc_file, storey_placement,
                location=(cx, cz, 0.0),
                axis=(0.0, 0.0, 1.0),
                ref_direction=(cos_a, sin_a, 0.0),
            )
            box_repr  = _create_box_representation(ifc_file, w_m, wall_thickness, DOOR_HEIGHT_M, body_sub)
            prod_repr = ifc_file.createIfcProductDefinitionShape(None, None, [box_repr])
            door = ifc_file.createIfcDoor(
                _guid(), owner,
                f"Door_{floor_idx}_{op_idx:04d}", None, None,
                door_placement, prod_repr, DOOR_HEIGHT_M, w_m,
            )
            contained.append(door)
        except Exception:
            continue

    # ── Windows ───────────────────────────────────────────────────────────────
    for op_idx, op in enumerate(all_openings):
        if op.get("type", "door") != "window":
            continue
        try:
            cx  = float(op.get("x", 0.0))
            cz  = float(op.get("z", 0.0))
            w_m = float(op.get("width_m") or op.get("width") or 0.8)
            x1w = float(op.get("wall_x1", cx - w_m / 2))
            z1w = float(op.get("wall_z1", cz))
            x2w = float(op.get("wall_x2", cx + w_m / 2))
            z2w = float(op.get("wall_z2", cz))
            wl  = math.hypot(x2w - x1w, z2w - z1w)
            if wl < 0.001:
                continue
            angle = math.atan2(z2w - z1w, x2w - x1w)
            cos_a, sin_a = math.cos(angle), math.sin(angle)

            win_placement = _ifc_local_placement(
                ifc_file, storey_placement,
                location=(cx, cz, WINDOW_SILL_M),
                axis=(0.0, 0.0, 1.0),
                ref_direction=(cos_a, sin_a, 0.0),
            )
            box_repr  = _create_box_representation(ifc_file, w_m, wall_thickness, WINDOW_HEIGHT_M, body_sub)
            prod_repr = ifc_file.createIfcProductDefinitionShape(None, None, [box_repr])
            win = ifc_file.createIfcWindow(
                _guid(), owner,
                f"Window_{floor_idx}_{op_idx:04d}", None, None,
                win_placement, prod_repr, WINDOW_HEIGHT_M, w_m,
            )
            contained.append(win)
        except Exception:
            continue

    # ── Spaces (rooms) ────────────────────────────────────────────────────────
    for room in rooms:
        try:
            poly = room.get("polygon", [])
            if not poly or len(poly) < 3:
                bb = room["bbox"]
                poly = [
                    [bb["x_min"], bb["z_min"]],
                    [bb["x_max"], bb["z_min"]],
                    [bb["x_max"], bb["z_max"]],
                    [bb["x_min"], bb["z_max"]],
                ]

            area = float(room.get("area_m2", 0.0))
            rid  = room.get("id", 0)

            space_placement = _ifc_local_placement(
                ifc_file, storey_placement, location=(0.0, 0.0, 0.0)
            )
            ifc_poly    = [[float(p[0]), float(p[1])] for p in poly]
            space_shape = _create_space_representation(ifc_file, ifc_poly, storey_height, body_sub)
            if space_shape is None:
                continue

            prod_repr = ifc_file.createIfcProductDefinitionShape(None, None, [space_shape])
            space = ifc_file.createIfcSpace(
                _guid(), owner,
                f"Room_{floor_idx}_{rid:04d}",
                f"Room {rid}  {area:.1f} m\u00b2",
                None,
                space_placement, prod_repr, None, "INTERNAL",
            )
            contained.append(space)
        except Exception:
            continue

    # Spatial containment
    if contained:
        ifc_file.createIfcRelContainedInSpatialStructure(
            _guid(), owner,
            "BuildingElementsInStorey", None,
            contained, storey,
        )

    return contained


# ── Public API ────────────────────────────────────────────────────────────────

def export_floor_ifc(
    floor_idx: int,
    processed_dir: str,
    output_path: Optional[str] = None,
    wall_thickness: float = WALL_THICKNESS_M,
) -> str:
    """
    Export a single floor to an IFC 2x3 file.

    Parameters
    ----------
    floor_idx     : 0-based floor index
    processed_dir : directory containing the JSON data files
    output_path   : explicit output path (default: processed_dir/floor_<N>.ifc)
    wall_thickness: wall thickness for 3D extrusion in metres

    Returns
    -------
    str  absolute path to the written .ifc file
    """
    if not _IFC_AVAILABLE:
        raise ImportError(
            "ifcopenshell is not installed. "
            "Run: pip install ifcopenshell"
        )

    # ── Load data ─────────────────────────────────────────────────────────────
    wall_path    = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    opening_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
    room_path    = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")
    info_path    = os.path.join(processed_dir, "info.json")

    if not os.path.exists(wall_path):
        raise FileNotFoundError(f"Wall data not found: {wall_path}")

    with open(wall_path) as f:
        wall_data = json.load(f)
    lines = wall_data.get("lines", [])

    floor_levels: list = []
    if os.path.exists(info_path):
        with open(info_path) as f:
            info = json.load(f)
        floor_levels = [
            lv.get("y", lv) if isinstance(lv, dict) else float(lv)
            for lv in info.get("floor_levels", [])
        ]

    elevation     = float(floor_levels[floor_idx]) if floor_idx < len(floor_levels) else 0.0
    storey_height = _wall_height(floor_idx, floor_levels)

    all_openings: list = []
    if os.path.exists(opening_path):
        with open(opening_path) as f:
            op_data = json.load(f)
        all_openings = op_data.get("openings", []) + op_data.get("user_openings", [])

    rooms: list = []
    if os.path.exists(room_path):
        with open(room_path) as f:
            room_data = json.load(f)
        rooms = room_data.get("rooms", [])

    # ── Create IFC file ───────────────────────────────────────────────────────
    ifc_file = ifcopenshell.file(schema="IFC2X3")
    owner, unit_assign, model_context, body_sub = _build_ifc_boilerplate(ifc_file)

    project = ifc_file.createIfcProject(
        _guid(), owner, f"Floor {floor_idx} \u2014 Scan2Floor", None,
        None, None, None, [model_context], unit_assign,
    )

    site_placement = _ifc_local_placement(ifc_file)
    site = ifc_file.createIfcSite(
        _guid(), owner, "Site", None, None,
        site_placement, None, None, "ELEMENT", None, None, None, None, None,
    )

    bldg_placement = _ifc_local_placement(ifc_file, site_placement)
    building = ifc_file.createIfcBuilding(
        _guid(), owner, "Building", None, None,
        bldg_placement, None, None, "ELEMENT", None, None, None,
    )

    storey_placement = _ifc_local_placement(
        ifc_file, bldg_placement, location=(0.0, 0.0, elevation)
    )
    storey = ifc_file.createIfcBuildingStorey(
        _guid(), owner, f"Floor {floor_idx}", None, None,
        storey_placement, None, None, "ELEMENT", elevation,
    )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, project, [site])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, site, [building])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, building, [storey])

    _add_storey_elements(
        ifc_file, owner, body_sub,
        floor_idx, storey, storey_placement,
        lines, all_openings, rooms,
        storey_height, wall_thickness,
    )

    if output_path is None:
        output_path = os.path.join(processed_dir, f"floor_{floor_idx}.ifc")

    ifc_file.write(output_path)
    return output_path


def export_all_floors_ifc(
    processed_dir: str,
    output_path: Optional[str] = None,
    wall_thickness: float = WALL_THICKNESS_M,
) -> str:
    """
    Export ALL detected floors into a single combined IFC 2x3 file.

    Parameters
    ----------
    processed_dir : directory containing walls_floor_N.json files
    output_path   : explicit output path (default: processed_dir/building.ifc)
    wall_thickness: wall thickness for 3D extrusion in metres

    Returns
    -------
    str  absolute path to the written .ifc file
    """
    if not _IFC_AVAILABLE:
        raise ImportError(
            "ifcopenshell is not installed. "
            "Run: pip install ifcopenshell"
        )

    import glob

    info_path    = os.path.join(processed_dir, "info.json")
    floor_levels: list = []
    if os.path.exists(info_path):
        with open(info_path) as f:
            info = json.load(f)
        floor_levels = [
            lv.get("y", lv) if isinstance(lv, dict) else float(lv)
            for lv in info.get("floor_levels", [])
        ]

    wall_files = sorted(glob.glob(os.path.join(processed_dir, "walls_floor_*.json")))
    if not wall_files:
        raise FileNotFoundError(f"No walls_floor_*.json files found in {processed_dir}")

    floor_indices = []
    for wf in wall_files:
        base = os.path.basename(wf)
        try:
            idx = int(base.replace("walls_floor_", "").replace(".json", ""))
            floor_indices.append(idx)
        except ValueError:
            continue

    # ── Create IFC file ───────────────────────────────────────────────────────
    ifc_file = ifcopenshell.file(schema="IFC2X3")
    owner, unit_assign, model_context, body_sub = _build_ifc_boilerplate(ifc_file)

    project = ifc_file.createIfcProject(
        _guid(), owner, "Building \u2014 Scan2Floor", None,
        None, None, None, [model_context], unit_assign,
    )

    site_placement = _ifc_local_placement(ifc_file)
    site = ifc_file.createIfcSite(
        _guid(), owner, "Site", None, None,
        site_placement, None, None, "ELEMENT", None, None, None, None, None,
    )

    bldg_placement = _ifc_local_placement(ifc_file, site_placement)
    building = ifc_file.createIfcBuilding(
        _guid(), owner, "Building", None, None,
        bldg_placement, None, None, "ELEMENT", None, None, None,
    )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, project, [site])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, site, [building])

    storeys: list = []

    for floor_idx in floor_indices:
        elevation     = float(floor_levels[floor_idx]) if floor_idx < len(floor_levels) else float(floor_idx) * 3.0
        storey_height = _wall_height(floor_idx, floor_levels)

        storey_placement = _ifc_local_placement(
            ifc_file, bldg_placement, location=(0.0, 0.0, elevation)
        )
        storey = ifc_file.createIfcBuildingStorey(
            _guid(), owner, f"Floor {floor_idx}", None, None,
            storey_placement, None, None, "ELEMENT", elevation,
        )
        storeys.append(storey)

        wall_path    = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
        opening_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
        room_path    = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")

        with open(wall_path) as f:
            lines = json.load(f).get("lines", [])

        all_openings: list = []
        if os.path.exists(opening_path):
            with open(opening_path) as f:
                op_data = json.load(f)
            all_openings = op_data.get("openings", []) + op_data.get("user_openings", [])

        rooms: list = []
        if os.path.exists(room_path):
            with open(room_path) as f:
                rooms = json.load(f).get("rooms", [])

        _add_storey_elements(
            ifc_file, owner, body_sub,
            floor_idx, storey, storey_placement,
            lines, all_openings, rooms,
            storey_height, wall_thickness,
        )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, building, storeys)

    if output_path is None:
        output_path = os.path.join(processed_dir, "building.ifc")

    ifc_file.write(output_path)
    return output_path
