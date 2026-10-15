"""
ifc_export.py -- Converts detected wall / opening / room data to IFC 2x3 format.

IFC Spatial Hierarchy (Tree View in FreeCAD / BlenderBIM / BIMVision)
---------------------------------------------------------------------
  IfcProject
    IfcSite
      IfcBuilding
        IfcBuildingStorey                (IfcRelAggregates)
          IfcSpace Room_0                (IfcRelAggregates under storey)
            IfcWallStandardCase Wall_A   (IfcRelContainedInSpatialStructure -> Room_0)
            IfcDoor Door_0               (IfcRelContainedInSpatialStructure -> Room_0)
            IfcWindow Window_0           (IfcRelContainedInSpatialStructure -> Room_0)
          IfcSpace Room_1
            IfcWallStandardCase Wall_B   (IfcRelContainedInSpatialStructure -> Room_1)
          [Unassigned / Exterior Elements] (Fallback -> IfcBuildingStorey)

Note on Shared Walls & IFC Standard:
  IFC2x3 rule WR31 on IfcElement dictates that an element can only be placed in
  ONE spatial structure container (IfcRelContainedInSpatialStructure).
  Therefore, each wall/door/window is placed inside its primary/closest IfcSpace
  in the tree, while IfcRelSpaceBoundary is still emitted for all rooms it touches.

Note on FreeCAD SectionPlane -> Shape2DView:
  Each door and window now creates an IfcOpeningElement that booleans out the
  host wall via IfcRelVoidsElement (and fills it via IfcRelFillsElement).
  This ensures horizontal section planes cut clean openings in Shape2DView.
"""

from __future__ import annotations

import glob
import json
import math
import os
import time
import uuid
from typing import Optional

try:
    import ifcopenshell
    import ifcopenshell.guid
    _IFC_AVAILABLE = True
except ImportError:
    _IFC_AVAILABLE = False


WALL_HEIGHT_M     = 2.80
WALL_THICKNESS_M  = 0.20
DOOR_HEIGHT_M     = 2.10
WINDOW_HEIGHT_M   = 1.20
WINDOW_SILL_M     = 0.90

# How far outside a room polygon to search when matching walls/openings to rooms.
_ROOM_TOLERANCE_M = 0.35


def _guid() -> str:
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def _wall_height(floor_idx: int, floor_levels: list) -> float:
    if len(floor_levels) > floor_idx + 1:
        return abs(floor_levels[floor_idx + 1] - floor_levels[floor_idx])
    if len(floor_levels) > floor_idx and floor_idx > 0:
        return abs(floor_levels[floor_idx] - floor_levels[floor_idx - 1])
    return WALL_HEIGHT_M


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _polygon_signed_area(polygon: list) -> float:
    """Shoelace formula: > 0 for CCW, < 0 for CW."""
    n = len(polygon)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += polygon[i][0] * polygon[j][1]
        area -= polygon[j][0] * polygon[i][1]
    return area / 2.0


def _point_in_polygon(px: float, py: float, polygon: list) -> bool:
    """Ray-casting PiP test. polygon = list of [x, z] (open loop)."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > py) != (yj > py)) and (
            px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _point_to_segment_dist(px: float, py: float,
                           x1: float, y1: float,
                           x2: float, y2: float) -> float:
    """Minimum Euclidean distance from point (px, py) to segment (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 < 1e-12:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _point_to_polygon_dist(px: float, py: float, polygon: list) -> float:
    """0.0 if inside polygon, otherwise minimum distance to any polygon edge."""
    if _point_in_polygon(px, py, polygon):
        return 0.0
    n = len(polygon)
    return min(
        _point_to_segment_dist(
            px, py,
            polygon[i][0], polygon[i][1],
            polygon[(i + 1) % n][0], polygon[(i + 1) % n][1],
        )
        for i in range(n)
    )


def _expand_polygon(polygon: list, amount: float) -> list:
    """Outward-expand every vertex along its averaged outward normal (winding-aware)."""
    n = len(polygon)
    if n < 3:
        return polygon
    # For CCW (area > 0), outward normal of edge (dx, dy) is (dy, -dx).
    # For CW  (area < 0), outward normal of edge (dx, dy) is (-dy, dx).
    sign = 1.0 if _polygon_signed_area(polygon) >= 0.0 else -1.0
    result = []
    for i in range(n):
        prev = polygon[(i - 1) % n]
        curr = polygon[i]
        nxt  = polygon[(i + 1) % n]

        e1x, e1y = curr[0] - prev[0], curr[1] - prev[1]
        e2x, e2y = nxt[0]  - curr[0], nxt[1]  - curr[1]

        l1 = math.hypot(e1x, e1y) or 1.0
        l2 = math.hypot(e2x, e2y) or 1.0

        n1x, n1y = sign * (e1y / l1), sign * (-e1x / l1)
        n2x, n2y = sign * (e2y / l2), sign * (-e2x / l2)

        avg_nx = n1x + n2x
        avg_ny = n1y + n2y
        avg_l  = math.hypot(avg_nx, avg_ny) or 1.0

        result.append([
            curr[0] + (avg_nx / avg_l) * amount,
            curr[1] + (avg_ny / avg_l) * amount,
        ])
    return result


def _segment_polygon_score(x1: float, y1: float, x2: float, y2: float,
                           polygon: list, tolerance: float,
                           n_samples: int = 7) -> tuple[bool, float]:
    """
    Evaluate whether a wall segment belongs to a room polygon.
    Returns (is_member, average_distance_to_polygon).
    """
    expanded = _expand_polygon(polygon, tolerance)
    hits = 0
    total_dist = 0.0
    for i in range(n_samples):
        t = i / max(n_samples - 1, 1)
        sx = x1 + t * (x2 - x1)
        sy = y1 + t * (y2 - y1)
        d = _point_to_polygon_dist(sx, sy, polygon)
        total_dist += d
        if d <= tolerance or _point_in_polygon(sx, sy, expanded):
            hits += 1
    avg_dist = total_dist / n_samples
    return (hits > 0, avg_dist)


# ---------------------------------------------------------------------------
# IFC geometry primitives
# ---------------------------------------------------------------------------

def _ifc_axis2placement3d(f, location=(0., 0., 0.),
                           axis=(0., 0., 1.), ref_direction=(1., 0., 0.)):
    return f.createIfcAxis2Placement3D(
        f.createIfcCartesianPoint([float(c) for c in location]),
        f.createIfcDirection([float(c) for c in axis]),
        f.createIfcDirection([float(c) for c in ref_direction]),
    )


def _ifc_local_placement(f, relative_to=None,
                          location=(0., 0., 0.),
                          axis=(0., 0., 1.),
                          ref_direction=(1., 0., 0.)):
    return f.createIfcLocalPlacement(
        relative_to, _ifc_axis2placement3d(f, location, axis, ref_direction)
    )


def _ifc_extruded_area_solid(f, profile, height: float, extrusion_dir=(0., 0., 1.)):
    placement = _ifc_axis2placement3d(f, (0., 0., 0.), (0., 0., 1.), (1., 0., 0.))
    return f.createIfcExtrudedAreaSolid(
        profile, placement,
        f.createIfcDirection([float(c) for c in extrusion_dir]),
        float(height),
    )


def _box_repr(f, width: float, depth: float, height: float, ctx):
    rect = f.createIfcRectangleProfileDef(
        "AREA", None,
        f.createIfcAxis2Placement2D(
            f.createIfcCartesianPoint([0., 0.]),
            f.createIfcDirection([1., 0.]),
        ),
        float(width), float(depth),
    )
    solid = _ifc_extruded_area_solid(f, rect, float(height))
    return f.createIfcShapeRepresentation(ctx, "Body", "SweptSolid", [solid])


def _space_repr(f, polygon: list, height: float, ctx):
    if not polygon or len(polygon) < 3:
        return None
    pts = [f.createIfcCartesianPoint([float(p[0]), float(p[1])]) for p in polygon]
    pts.append(pts[0])
    profile = f.createIfcArbitraryClosedProfileDef(
        "AREA", None, f.createIfcPolyline(pts)
    )
    solid = _ifc_extruded_area_solid(f, profile, float(height))
    return f.createIfcShapeRepresentation(ctx, "Body", "SweptSolid", [solid])


# ---------------------------------------------------------------------------
# Boilerplate
# ---------------------------------------------------------------------------

def _build_ifc_boilerplate(f):
    org     = f.createIfcOrganization(None, "Scan2Floor", None, None, None)
    person  = f.createIfcPerson(None, None, "Scan2Floor", None, None, None, None, None)
    p_and_o = f.createIfcPersonAndOrganization(person, org, None)
    app     = f.createIfcApplication(org, "0.4.0", "Scan2Floor", "Scan2Floor")
    owner   = f.createIfcOwnerHistory(
        p_and_o, app, "READWRITE", None, None, p_and_o, app, int(time.time())
    )
    unit_assign = f.createIfcUnitAssignment([
        f.createIfcSIUnit(None, "LENGTHUNIT",     None, "METRE"),
        f.createIfcSIUnit(None, "AREAUNIT",       None, "SQUARE_METRE"),
        f.createIfcSIUnit(None, "VOLUMEUNIT",     None, "CUBIC_METRE"),
        f.createIfcSIUnit(None, "PLANEANGLEUNIT", None, "RADIAN"),
    ])
    wcs = _ifc_axis2placement3d(f, (0., 0., 0.), (0., 0., 1.), (1., 0., 0.))
    model_ctx = f.createIfcGeometricRepresentationContext(
        "Model", "Model", 3, 1e-5, wcs, f.createIfcDirection([0., 1.])
    )
    body_sub = f.createIfcGeometricRepresentationSubContext(
        "Body", "Model", None, None, None, None,
        model_ctx, None, "MODEL_VIEW", None
    )
    return owner, unit_assign, model_ctx, body_sub


# ---------------------------------------------------------------------------
# Element builders
# ---------------------------------------------------------------------------

def _build_spaces(f, owner, body_sub, floor_idx: int, storey_placement,
                  rooms: list, storey_height: float):
    """Returns [(ifc_space, space_placement, polygon_list, room_dict), ...]"""
    result = []
    for room in rooms:
        try:
            poly = room.get("polygon", [])
            if poly and len(poly) >= 3:
                # Invert Z to restore true CAD/BIM Y (y = -z)
                ifc_poly = [[float(p[0]), -float(p[1])] for p in poly]
            else:
                bb = room["bbox"]
                x_min, x_max = float(bb["x_min"]), float(bb["x_max"])
                y_min, y_max = -float(bb["z_max"]), -float(bb["z_min"])
                ifc_poly = [
                    [x_min, y_min],
                    [x_max, y_min],
                    [x_max, y_max],
                    [x_min, y_max],
                ]
            # Ensure counter-clockwise winding in IFC (X, Y) space
            if _polygon_signed_area(ifc_poly) < 0.0:
                ifc_poly = ifc_poly[::-1]

            area = float(room.get("area_m2", 0.))
            rid  = room.get("id", 0)
            shape = _space_repr(f, ifc_poly, storey_height, body_sub)
            if shape is None:
                continue
            sp_pl = _ifc_local_placement(f, storey_placement, location=(0., 0., 0.))
            sp = f.createIfcSpace(
                _guid(), owner,
                f"Room_{floor_idx}_{rid:04d}",
                f"Room {rid} ({area:.1f} m\u00b2)",
                None,
                sp_pl,
                f.createIfcProductDefinitionShape(None, None, [shape]),
                None, "INTERNAL", None, None,
            )
            result.append((sp, sp_pl, ifc_poly, room))
        except Exception:
            continue
    return result


def _build_walls(f, owner, body_sub, floor_idx: int, storey_placement,
                 lines: list, storey_height: float, wall_thickness: float):
    """Returns list of dicts with wall metadata & IFC entities."""
    result = []
    for idx, seg in enumerate(lines):
        try:
            x1, y1 = float(seg[0][0]), -float(seg[0][1])
            x2, y2 = float(seg[1][0]), -float(seg[1][1])
        except (IndexError, TypeError, ValueError):
            continue
        length = math.hypot(x2 - x1, y2 - y1)
        if length < 0.001:
            continue
        angle = math.atan2(y2 - y1, x2 - x1)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0

        placement = _ifc_local_placement(
            f, storey_placement,
            location=(x1, y1, 0.),
            axis=(0., 0., 1.),
            ref_direction=(cos_a, sin_a, 0.),
        )
        rect = f.createIfcRectangleProfileDef(
            "AREA", None,
            f.createIfcAxis2Placement2D(
                f.createIfcCartesianPoint([length / 2.0, 0.]),
                f.createIfcDirection([1., 0.]),
            ),
            length, wall_thickness,
        )
        solid = _ifc_extruded_area_solid(f, rect, storey_height)
        shape = f.createIfcShapeRepresentation(body_sub, "Body", "SweptSolid", [solid])
        wall  = f.createIfcWallStandardCase(
            _guid(), owner, f"Wall_{floor_idx}_{idx:04d}", None, None,
            placement, f.createIfcProductDefinitionShape(None, None, [shape]), None,
        )
        result.append({
            "ifc_elem": wall,
            "placement": placement,
            "mx": mx, "my": my,
            "x1": x1, "y1": y1,
            "x2": x2, "y2": y2,
            "length": length,
            "angle": angle,
        })
    return result


def _find_host_wall(cx: float, cy: float, w_m: float,
                    walls: list, max_dist: float) -> Optional[dict]:
    """Find the closest wall segment that can host an opening at (cx, cy)."""
    best_wall = None
    best_d = max_dist
    for w in walls:
        d = _point_to_segment_dist(cx, cy, w["x1"], w["y1"], w["x2"], w["y2"])
        if d < best_d:
            best_d = d
            best_wall = w
    return best_wall


def _build_openings(f, owner, body_sub, floor_idx: int, storey_placement,
                    all_openings: list, walls: list, wall_thickness: float):
    """
    Build IfcDoor / IfcWindow elements AND cut boolean IfcOpeningElement voids
    in their host walls so FreeCAD's SectionPlane + Shape2DView slices cleanly.
    """
    result = []
    for idx, op in enumerate(all_openings):
        op_type = str(op.get("type", "door")).lower()
        if op_type not in ("door", "window"):
            continue
        try:
            cx  = float(op.get("x", 0.))
            cy  = -float(op.get("z", 0.))
            w_m = float(op.get("width_m") or op.get("width") or
                        (0.9 if op_type == "door" else 0.8))
            x1w = float(op.get("wall_x1", cx - w_m / 2.0))
            y1w = -float(op.get("wall_z1", -cy))
            x2w = float(op.get("wall_x2", cx + w_m / 2.0))
            y2w = -float(op.get("wall_z2", -cy))
            wl  = math.hypot(x2w - x1w, y2w - y1w)
            angle = math.atan2(y2w - y1w, x2w - x1w) if wl >= 0.001 else 0.0

            # Match to host wall for boolean cutout and exact wall alignment
            host_wall = _find_host_wall(cx, cy, w_m, walls, max_dist=wall_thickness + 0.35)
            if host_wall is not None:
                angle = host_wall["angle"]

            cos_a, sin_a = math.cos(angle), math.sin(angle)
            sill_z = 0.0 if op_type == "door" else WINDOW_SILL_M
            op_h   = DOOR_HEIGHT_M if op_type == "door" else WINDOW_HEIGHT_M

            # 1. Create boolean void (IfcOpeningElement) in the host wall
            opening_elem = None
            if host_wall is not None:
                wx1, wy1 = host_wall["x1"], host_wall["y1"]
                w_len    = host_wall["length"]
                dx, dy   = ( host_wall["x2"] - wx1 ) / w_len, ( host_wall["y2"] - wy1 ) / w_len
                # Project opening center onto host wall's local X axis
                local_x  = (cx - wx1) * dx + (cy - wy1) * dy
                local_x  = max(w_m / 2.0, min(w_len - w_m / 2.0, local_x))

                void_pl = _ifc_local_placement(
                    f, host_wall["placement"],
                    location=(local_x, 0., sill_z),
                    axis=(0., 0., 1.),
                    ref_direction=(1., 0., 0.),
                )
                # Slightly thicker than wall so OCCT boolean subtraction has no coplanar artifacts
                void_shape = _box_repr(f, w_m, wall_thickness * 1.25, op_h, body_sub)
                opening_elem = f.createIfcOpeningElement(
                    _guid(), owner,
                    f"Opening_{floor_idx}_{idx:04d}", None, None,
                    void_pl,
                    f.createIfcProductDefinitionShape(None, None, [void_shape]),
                    None,
                )
                f.createIfcRelVoidsElement(
                    _guid(), owner, None, None, host_wall["ifc_elem"], opening_elem
                )

            # 2. Create physical Door / Window element
            elem_pl = _ifc_local_placement(
                f, storey_placement,
                location=(cx, cy, sill_z),
                axis=(0., 0., 1.),
                ref_direction=(cos_a, sin_a, 0.),
            )
            # Use thin panel representation so 2D section shows clean jambs/frame
            frame_depth = min(wall_thickness * 0.4, 0.08)
            if op_type == "door":
                elem = f.createIfcDoor(
                    _guid(), owner, f"Door_{floor_idx}_{idx:04d}", None, None,
                    elem_pl,
                    f.createIfcProductDefinitionShape(
                        None, None, [_box_repr(f, w_m, frame_depth, op_h, body_sub)]
                    ),
                    op_h, w_m,
                )
            else:
                elem = f.createIfcWindow(
                    _guid(), owner, f"Window_{floor_idx}_{idx:04d}", None, None,
                    elem_pl,
                    f.createIfcProductDefinitionShape(
                        None, None, [_box_repr(f, w_m, frame_depth, op_h, body_sub)]
                    ),
                    op_h, w_m,
                )

            if opening_elem is not None:
                f.createIfcRelFillsElement(
                    _guid(), owner, None, None, opening_elem, elem
                )

            result.append({
                "ifc_elem": elem,
                "cx": cx,
                "cy": cy,
                "type": op_type,
                "host_wall": host_wall["ifc_elem"] if host_wall else None,
            })
        except Exception:
            continue
    return result


# ---------------------------------------------------------------------------
# Spatial assignment: Building -> Floors -> Rooms -> (Walls + Doors + Windows)
# ---------------------------------------------------------------------------

def _assign_elements_to_rooms(walls: list, openings: list,
                              spaces: list, wall_thickness: float):
    """
    Assigns every wall, door, and window to:
      1. Its primary IfcSpace for tree grouping (IfcRelContainedInSpatialStructure).
         Note: IFC requires each element to be in at most ONE spatial container.
      2. All bordering IfcSpaces for semantic boundary links (IfcRelSpaceBoundary).
    Any element not within tolerance of any room is returned in `unassigned` so
    it can be placed directly under the IfcBuildingStorey as a fallback.
    """
    tol = wall_thickness / 2.0 + _ROOM_TOLERANCE_M

    # Primary containment mapping: {ifc_space: [ifc_elem, ...]}
    primary_room_elements = {sp: [] for sp, _, _, _ in spaces}
    # Boundary mapping (can be many-to-many): {ifc_space: [ifc_elem, ...]}
    boundary_room_elements = {sp: [] for sp, _, _, _ in spaces}
    # Map host wall -> primary room so doors/windows stay grouped with their host wall
    wall_primary_room = {}
    unassigned_elements = []

    # 1. Match walls to rooms
    for w in walls:
        w_elem = w["ifc_elem"]
        best_sp = None
        best_dist = float("inf")

        for sp, _, poly, _ in spaces:
            is_member, avg_dist = _segment_polygon_score(
                w["x1"], w["y1"], w["x2"], w["y2"], poly, tol
            )
            if is_member:
                boundary_room_elements[sp].append(w_elem)
                if avg_dist < best_dist:
                    best_dist = avg_dist
                    best_sp = sp

        if best_sp is not None:
            primary_room_elements[best_sp].append(w_elem)
            wall_primary_room[w_elem] = best_sp
        else:
            unassigned_elements.append(w_elem)

    # 2. Match openings (doors & windows) to rooms
    for op in openings:
        op_elem = op["ifc_elem"]
        cx, cy  = op["cx"], op["cy"]
        best_sp = None
        best_dist = float("inf")

        for sp, _, poly, _ in spaces:
            d = _point_to_polygon_dist(cx, cy, poly)
            if d <= tol:
                boundary_room_elements[sp].append(op_elem)
                if d < best_dist:
                    best_dist = d
                    best_sp = sp

        # Fallback: if the opening's host wall is already assigned to a room, use it
        if best_sp is None and op["host_wall"] in wall_primary_room:
            best_sp = wall_primary_room[op["host_wall"]]
            boundary_room_elements[best_sp].append(op_elem)

        if best_sp is not None:
            primary_room_elements[best_sp].append(op_elem)
        else:
            unassigned_elements.append(op_elem)

    return primary_room_elements, boundary_room_elements, unassigned_elements


# ---------------------------------------------------------------------------
# Main storey assembler
# ---------------------------------------------------------------------------

def _add_storey_elements(ifc_file, owner, body_sub,
                         floor_idx: int, storey, storey_placement,
                         lines: list, all_openings: list, rooms: list,
                         storey_height: float, wall_thickness: float):
    """
    Wires the exact tree hierarchy for FreeCAD & IFC viewers:
      IfcBuilding
        -> IfcBuildingStorey ("Floor X", CompositionType="ELEMENT")
             -> IfcBuildingStorey ("Room X", CompositionType="PARTIAL")
                  -> IfcSpace (3D room volume)
                  -> IfcWallStandardCase (Walls of this room)
                  -> IfcDoor (Doors of this room)
                  -> IfcWindow (Windows of this room)

    Why PARTIAL IfcBuildingStorey for Room containers?
      In FreeCAD's IFC importer, IfcSpace is imported as an Arch.Space volume,
      which cannot hold child objects in the FreeCAD Model Tree.
      By wrapping each room in a PARTIAL spatial container aggregated under the
      Floor, FreeCAD creates a real Arch.BuildingPart folder for every Room
      under the Floor, containing its Walls, Doors, Windows, and Space volume.
      This also allows FreeCAD's Arch SectionPlane to target either an entire
      Floor or an individual Room directly!
    """
    f = ifc_file

    # 1. Build rooms, walls, and openings (with boolean wall cutouts)
    spaces   = _build_spaces(f, owner, body_sub, floor_idx, storey_placement,
                             rooms, storey_height)
    walls    = _build_walls(f, owner, body_sub, floor_idx, storey_placement,
                            lines, storey_height, wall_thickness)
    openings = _build_openings(f, owner, body_sub, floor_idx, storey_placement,
                               all_openings, walls, wall_thickness)

    if spaces:
        primary_map, boundary_map, unassigned = _assign_elements_to_rooms(
            walls, openings, spaces, wall_thickness
        )

        room_containers = []
        for sp, sp_pl, _, room in spaces:
            rid  = room.get("id", 0)
            area = float(room.get("area_m2", 0.))

            # Create a spatial sub-container for the Room so FreeCAD makes a
            # collapsible BuildingPart folder under the Floor
            room_container = f.createIfcBuildingStorey(
                _guid(), owner,
                f"Room_{floor_idx}_{rid:04d}",
                f"Room {rid} ({area:.1f} m\u00b2)",
                None,
                sp_pl,
                None, None,
                "PARTIAL",
                storey.Elevation,
            )
            room_containers.append(room_container)

            # Aggregate the IfcSpace volume inside the Room container
            sp.Name = f"Space_{floor_idx}_{rid:04d}"
            f.createIfcRelAggregates(
                _guid(), owner,
                f"Room_{floor_idx}_{rid:04d}_Space", None,
                room_container, [sp],
            )

            # Contain the Room's Walls + Doors + Windows inside the Room container
            elems = primary_map[sp]
            if elems:
                f.createIfcRelContainedInSpatialStructure(
                    _guid(), owner,
                    f"Room_{floor_idx}_{rid:04d}_Elements",
                    "Walls, doors, and windows belonging to this room",
                    elems, room_container,
                )

            # Keep semantic IfcRelSpaceBoundary links for all bordering elements
            for elem in boundary_map[sp]:
                try:
                    f.createIfcRelSpaceBoundary(
                        _guid(), owner, "SpaceBoundary", None,
                        sp, elem, None, "PHYSICAL", "INTERNAL",
                    )
                except Exception:
                    pass

        # Aggregate all Room containers under the Floor (Storey -> Rooms)
        if room_containers:
            f.createIfcRelAggregates(
                _guid(), owner, f"Floor_{floor_idx}_Rooms", None,
                storey, room_containers,
            )

        # Any unassigned exterior walls/openings stay under the Floor
        if unassigned:
            f.createIfcRelContainedInSpatialStructure(
                _guid(), owner, f"Floor_{floor_idx}_UnassignedElements", None,
                unassigned, storey,
            )
    else:
        # No rooms detected: place all elements directly under the Floor
        all_elements = [w["ifc_elem"] for w in walls] + [o["ifc_elem"] for o in openings]
        if all_elements:
            f.createIfcRelContainedInSpatialStructure(
                _guid(), owner, f"Floor_{floor_idx}_Elements", None,
                all_elements, storey,
            )


# ---------------------------------------------------------------------------
# Public Export API
# ---------------------------------------------------------------------------

def export_floor_ifc(
    floor_idx: int,
    processed_dir: str,
    output_path: Optional[str] = None,
    wall_thickness: float = WALL_THICKNESS_M,
) -> str:
    """Export a single floor to an IFC 2x3 file."""
    if not _IFC_AVAILABLE:
        raise ImportError("ifcopenshell is not installed. Run: pip install ifcopenshell")

    wall_path    = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    opening_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
    room_path    = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")
    info_path    = os.path.join(processed_dir, "info.json")

    if not os.path.exists(wall_path):
        raise FileNotFoundError(f"Wall data not found: {wall_path}")

    with open(wall_path) as fh:
        lines = json.load(fh).get("lines", [])

    floor_levels: list = []
    if os.path.exists(info_path):
        with open(info_path) as fh:
            info = json.load(fh)
        floor_levels = [
            lv.get("y", lv) if isinstance(lv, dict) else float(lv)
            for lv in info.get("floor_levels", [])
        ]

    elevation     = float(floor_levels[floor_idx]) if floor_idx < len(floor_levels) else 0.0
    storey_height = _wall_height(floor_idx, floor_levels)

    all_openings: list = []
    if os.path.exists(opening_path):
        with open(opening_path) as fh:
            op_data = json.load(fh)
        all_openings = op_data.get("openings", []) + op_data.get("user_openings", [])

    rooms: list = []
    if os.path.exists(room_path):
        with open(room_path) as fh:
            rooms = json.load(fh).get("rooms", [])

    ifc_file = ifcopenshell.file(schema="IFC2X3")
    owner, unit_assign, model_context, body_sub = _build_ifc_boilerplate(ifc_file)

    project = ifc_file.createIfcProject(
        _guid(), owner, f"Floor {floor_idx} \u2014 Scan2Floor", None,
        None, None, None, [model_context], unit_assign,
    )
    site_pl = _ifc_local_placement(ifc_file)
    site    = ifc_file.createIfcSite(
        _guid(), owner, "Site", None, None, site_pl, None, None,
        "ELEMENT", None, None, None, None, None,
    )
    bldg_pl  = _ifc_local_placement(ifc_file, site_pl)
    building = ifc_file.createIfcBuilding(
        _guid(), owner, "Building", None, None, bldg_pl, None, None,
        "ELEMENT", None, None, None,
    )
    storey_pl = _ifc_local_placement(ifc_file, bldg_pl, location=(0., 0., elevation))
    storey    = ifc_file.createIfcBuildingStorey(
        _guid(), owner, f"Floor {floor_idx}", None, None, storey_pl, None, None,
        "ELEMENT", elevation,
    )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, project,  [site])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, site,     [building])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, building, [storey])

    _add_storey_elements(
        ifc_file, owner, body_sub,
        floor_idx, storey, storey_pl,
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
    """Export ALL floors into a single combined IFC 2x3 file."""
    if not _IFC_AVAILABLE:
        raise ImportError("ifcopenshell is not installed. Run: pip install ifcopenshell")

    info_path    = os.path.join(processed_dir, "info.json")
    floor_levels: list = []
    if os.path.exists(info_path):
        with open(info_path) as fh:
            info = json.load(fh)
        floor_levels = [
            lv.get("y", lv) if isinstance(lv, dict) else float(lv)
            for lv in info.get("floor_levels", [])
        ]

    wall_files = sorted(glob.glob(os.path.join(processed_dir, "walls_floor_*.json")))
    if not wall_files:
        raise FileNotFoundError(f"No walls_floor_*.json files found in {processed_dir}")

    floor_indices = []
    for wf in wall_files:
        try:
            idx = int(os.path.basename(wf)
                      .replace("walls_floor_", "").replace(".json", ""))
            floor_indices.append(idx)
        except ValueError:
            continue

    ifc_file = ifcopenshell.file(schema="IFC2X3")
    owner, unit_assign, model_context, body_sub = _build_ifc_boilerplate(ifc_file)

    project = ifc_file.createIfcProject(
        _guid(), owner, "Building \u2014 Scan2Floor", None,
        None, None, None, [model_context], unit_assign,
    )
    site_pl = _ifc_local_placement(ifc_file)
    site    = ifc_file.createIfcSite(
        _guid(), owner, "Site", None, None, site_pl, None, None,
        "ELEMENT", None, None, None, None, None,
    )
    bldg_pl  = _ifc_local_placement(ifc_file, site_pl)
    building = ifc_file.createIfcBuilding(
        _guid(), owner, "Building", None, None, bldg_pl, None, None,
        "ELEMENT", None, None, None,
    )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, project, [site])
    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, site,    [building])

    storeys = []
    for floor_idx in floor_indices:
        elevation     = (float(floor_levels[floor_idx])
                         if floor_idx < len(floor_levels)
                         else float(floor_idx) * 3.0)
        storey_height = _wall_height(floor_idx, floor_levels)

        storey_pl = _ifc_local_placement(ifc_file, bldg_pl, location=(0., 0., elevation))
        storey    = ifc_file.createIfcBuildingStorey(
            _guid(), owner, f"Floor {floor_idx}", None, None, storey_pl, None, None,
            "ELEMENT", elevation,
        )
        storeys.append(storey)

        wall_path    = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
        opening_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
        room_path    = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")

        with open(wall_path) as fh:
            lines = json.load(fh).get("lines", [])

        all_openings: list = []
        if os.path.exists(opening_path):
            with open(opening_path) as fh:
                op_data = json.load(fh)
            all_openings = op_data.get("openings", []) + op_data.get("user_openings", [])

        rooms: list = []
        if os.path.exists(room_path):
            with open(room_path) as fh:
                rooms = json.load(fh).get("rooms", [])

        _add_storey_elements(
            ifc_file, owner, body_sub,
            floor_idx, storey, storey_pl,
            lines, all_openings, rooms,
            storey_height, wall_thickness,
        )

    ifc_file.createIfcRelAggregates(_guid(), owner, None, None, building, storeys)

    if output_path is None:
        output_path = os.path.join(processed_dir, "building.ifc")
    ifc_file.write(output_path)
    return output_path


# ---------------------------------------------------------------------------
# FreeCAD SectionPlane -> Shape2DView Helper (Run inside FreeCAD Python)
# ---------------------------------------------------------------------------

def create_freecad_section_and_2dview(
    doc=None,
    cut_height_m: float = 1.20,
    include_spaces: bool = False,
):
    """
    Creates an Arch SectionPlane per floor (IfcBuildingStorey) and generates
    both 'Solid' (projected) and 'Cutfaces' (sectioned) Draft Shape2DViews
    in an active FreeCAD document.

    Usage inside FreeCAD Python console or macro after importing the IFC:
        import ifc_export
        ifc_export.create_freecad_section_and_2dview()
    """
    import FreeCAD
    import Arch
    import Draft

    if doc is None:
        doc = FreeCAD.ActiveDocument
    if doc is None:
        raise RuntimeError("No active FreeCAD document found.")

    # Find floor storeys (or fall back to the Building object)
    storeys = [
        obj for obj in doc.Objects
        if getattr(obj, "IfcType", "") == "Building Storey"
        or obj.Name.startswith("Floor")
    ]
    if not storeys:
        storeys = [
            obj for obj in doc.Objects
            if getattr(obj, "IfcType", "") == "Building"
        ]

    created_views = []
    for storey in storeys:
        # Gather physical elements (Walls, Doors, Windows) recursively inside Rooms
        targets = []
        stack = list(getattr(storey, "Group", []) or getattr(storey, "OutList", []))
        visited = set()
        while stack:
            item = stack.pop()
            if item.Name in visited:
                continue
            visited.add(item.Name)
            ifc_type = getattr(item, "IfcType", "")
            if ifc_type == "Space" or item.Name.startswith("Room_"):
                if include_spaces:
                    targets.append(item)
                stack.extend(getattr(item, "Group", []) or getattr(item, "OutList", []))
            elif hasattr(item, "Shape") and not item.Shape.isNull():
                targets.append(item)

        if not targets:
            targets = [storey]

        bb = storey.Shape.BoundBox if hasattr(storey, "Shape") and not storey.Shape.isNull() else doc.Objects[0].Shape.BoundBox
        base_z = storey.Placement.Base.z if hasattr(storey, "Placement") else bb.ZMin
        cut_z_mm = base_z + (cut_height_m * 1000.0)

        # 1. Create Arch SectionPlane looking straight down (-Z)
        section = Arch.makeSectionPlane(targets, name=f"Section_{storey.Label}")
        section.Placement.Base = FreeCAD.Vector(bb.Center.x, bb.Center.y, cut_z_mm)
        section.Placement.Rotation = FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), 0)
        if hasattr(section, "OnlySolids"):
            section.OnlySolids = True
        doc.recompute()

        # 2. Create Draft Shape2DView (projected lines below the cut plane)
        view_solid = Draft.make_shape2dview(section)
        view_solid.Label = f"Plan2D_Projection_{storey.Label}"
        view_solid.ProjectionMode = "Solid"

        # 3. Create Draft Shape2DView (cut faces at the section plane)
        view_cut = Draft.make_shape2dview(section)
        view_cut.Label = f"Plan2D_Cut_{storey.Label}"
        view_cut.ProjectionMode = "Cutfaces"

        created_views.append((section, view_solid, view_cut))

    doc.recompute()
    return created_views