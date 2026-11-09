"""Ověření IFC exportu importem v Blenderu (headless, rozšíření Bonsai).

Spustí Blender 4.2 LTS (s nainstalovaným rozšířením Bonsai — extensions.
blender.org, vyžaduje Blender 4.2, v 5.x Bonsai nefunguje) na pozadí a:

1. importuje export.ifc přes bpy.ops.bim.load_project,
2. spočítá mesh objekty (čekáno: instance + body) a kolekce Project/Site/
   Building,
3. porovná pozice všech proxy proti IFC (přes ifc_definition_id = číslo
   entity, tolerace 5 mm),
4. vyrenderuje QA screenshot (kamera 3/4 pohled na robustní jádro modelu —
   outlieři detekce se na zaměření neberou).

Použití (uvnitř Blenderu, ne přes venv — Blender má vlastní Python):

    blender --background --python tools/blender_ifc_check.py -- \
        --ifc data/<model_id>/export.ifc --png qa_blender.png

Výstup: report na stdout (LOAD / SUM / COLLECTIONS / RENDER-DONE) + PNG.
"""
from __future__ import annotations

import argparse
import sys
import time

import bpy  # noqa — spouští se uvnitř Blenderu
import mathutils

import addon_utils


def _args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ifc", required=True)
    ap.add_argument("--png", default="qa_blender.png")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    return ap.parse_args(argv)


def main() -> None:
    args = _args()
    addon_utils.enable("bl_ext.user_default.bonsai", default_set=True, persistent=False)
    import bonsai  # noqa — registrace operátorů Bonsai
    import ifcopenshell

    t0 = time.time()
    bpy.ops.bim.load_project(filepath=args.ifc)
    print(f"LOAD: {round(time.time() - t0, 1)} s")

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    collections = [c.name for c in bpy.data.collections]
    print(f"SUM: mesh={len(meshes)} collections={collections}")

    # pozice proti IFC — ifc_definition_id = číslo entity (#N)
    f = ifcopenshell.open(args.ifc)
    id_pos: dict = {}
    for t in (
        "IfcBuildingElementProxy", "IfcDiscreteAccessory", "IfcDistributionElement",
        "IfcLightFixture", "IfcSanitaryTerminal", "IfcFurniture",
    ):
        for e in f.by_type(t):
            id_pos[e.id()] = e.ObjectPlacement.RelativePlacement.Location.Coordinates
    checked = bad = 0
    max_err = 0.0
    for o in meshes:
        try:
            gid = o["BIMObjectProperties"]["ifc_definition_id"]
        except (KeyError, TypeError):
            bad += 1
            continue
        loc = id_pos.get(gid)
        if loc is None:
            bad += 1
            continue
        bl = (o.location.x * 1000, o.location.y * 1000, o.location.z * 1000)
        err = max(abs(bl[i] - loc[i]) for i in range(3))
        max_err = max(max_err, err)
        checked += 1
        if err > 5.0:
            bad += 1
            print(f"MISMATCH: {o.name} blender={[round(c) for c in bl]} ifc={[round(c) for c in loc]}")
    print(f"POSITIONS: checked={checked} bad={bad} max_err_mm={round(max_err, 2)}")

    # QA screenshot — kamera na robustní jádro (bez outlierů detekce)
    core = [o for o in meshes if max(abs(o.location.x), abs(o.location.y), abs(o.location.z)) <= 100]
    if not core:
        core = meshes
    xs = [o.location.x for o in core]
    ys = [o.location.y for o in core]
    zs = [o.location.z for o in core]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys))

    scene = bpy.context.scene
    cam = bpy.data.objects.new("QA-Camera", bpy.data.cameras.new("QA"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    dist = span * 1.15
    cam.location = (cx + dist * 0.35, cy - dist * 0.8, cz + dist * 0.5)
    direction = mathutils.Vector((cx, cy, cz)) - mathutils.Vector(cam.location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 35
    cam.data.clip_start = 0.001
    cam.data.clip_end = dist * 5

    sun = bpy.data.objects.new("QA-Sun", bpy.data.lights.new("QA-Sun", type="SUN"))
    scene.collection.objects.link(sun)
    sun.location = (cx, cy, cz + span)
    sun.rotation_euler = (0, 0, 0)

    mat = bpy.data.materials.new("QA-Mat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs[0].default_value = (0.9, 0.7, 0.25, 1.0)
    for o in meshes:
        if not o.material_slots:
            o.data.materials.append(mat)

    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.filepath = args.png
    bpy.ops.render.render(write_still=True)
    print("RENDER-DONE")


main()
