import os
import FreeCAD
import Arch
import Draft
import importDXF
import importSVG

doc = FreeCAD.ActiveDocument

out_dir = os.path.dirname(doc.FileName) if doc.FileName else os.path.expanduser("~")
base_name = doc.Label or "building"

# 1. Find all Floor (IfcBuildingStorey) objects
storeys = [
    obj for obj in doc.Objects
    if getattr(obj, "Class", getattr(obj, "IfcType", "")) in ("IfcBuildingStorey", "Building Storey")
    and not obj.Label.startswith("Room_")
]

if not storeys:
    storeys = [obj for obj in doc.Objects if obj.Label.startswith("Floor")]

created_2d_views = []

for idx, storey in enumerate(storeys):
    # Recursively gather all Walls, Doors, and Windows under this Floor (including inside Rooms)
    stack = list(getattr(storey, "Group", []) or getattr(storey, "OutList", []))
    visited = set()
    floor_elements = []

    while stack:
        item = stack.pop()
        if item.Name in visited:
            continue
        visited.add(item.Name)

        ifc_class = getattr(item, "Class", getattr(item, "IfcType", ""))
        if ifc_class in ("IfcWall", "IfcWallStandardCase", "IfcDoor", "IfcWindow", "Wall", "Door", "Window"):
            if hasattr(item, "Shape") and not item.Shape.isNull():
                floor_elements.append(item)
        stack.extend(getattr(item, "Group", []) or getattr(item, "OutList", []))

    if not floor_elements:
        continue

    bbox = FreeCAD.BoundBox()
    for el in floor_elements:
        bbox.add(el.Shape.BoundBox)

    cut_z = bbox.ZMin + 1200.0
    floor_tag = storey.Label.replace(" ", "_")

    # 2. Create SectionPlane for this floor
    section = Arch.makeSectionPlane(floor_elements, name=f"Section_{floor_tag}")
    section.Label = f"Section_{floor_tag}"
    section.Placement.Base = FreeCAD.Vector(bbox.Center.x, bbox.Center.y, cut_z)
    section.Placement.Rotation = FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), 0)

    if hasattr(section, "ViewObject") and section.ViewObject:
        section.ViewObject.DisplayLength = max(bbox.XLength * 1.2, 5000.0)
        section.ViewObject.DisplayHeight = max(bbox.YLength * 1.2, 5000.0)
        section.ViewObject.ArrowSize = 350.0

    doc.recompute()

    # 3. Create Per-Floor Shape2DView (Solid Projection only)
    view_solid = Draft.make_shape2dview(section)
    view_solid.Label = f"Plan2D_Solid_{floor_tag}"
    view_solid.ProjectionMode = "Solid"
    view_solid.Placement.Base = FreeCAD.Vector(bbox.XMax + 10000.0, idx * (bbox.YLength + 5000.0), 0.0)

    created_2d_views.append((floor_tag, view_solid))

doc.recompute()

# 4. Export each floor's 2D View to DXF and SVG
for floor_tag, view_solid in created_2d_views:
    dxf_path = os.path.join(out_dir, f"{base_name}_{floor_tag}.dxf")
    svg_path = os.path.join(out_dir, f"{base_name}_{floor_tag}.svg")
    importDXF.export([view_solid], dxf_path)
    importSVG.export([view_solid], svg_path)
    print(f"Exported 2D floor plan: {dxf_path} and {svg_path}")

# 5. Save the complete FreeCAD project
fcstd_path = os.path.join(out_dir, f"{base_name}_with_sections.FCStd")
doc.saveAs(fcstd_path)
print(f"Saved full project with sections & 2D views to: {fcstd_path}")