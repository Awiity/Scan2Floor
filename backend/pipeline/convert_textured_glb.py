"""
Convert a Matterport matterpak textured OBJ (+ MTL + jpg atlases) into a single
textured GLB (``mesh_textured.glb``) that the frontend can drape over the point
cloud / BIM layers as a photo "texture" layer.

The OBJ keeps Matterport's Z-up coordinates (same frame as cloud.xyz), so the
frontend applies the exact same transform it uses for the point cloud.

Usage:
    python backend/pipeline/convert_textured_glb.py data/matterpak_3
    python backend/pipeline/convert_textured_glb.py data/matterpak_3 --tex-size 1024 --quality 80
"""
import argparse
import glob
import io
import os
import sys
import time

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals


def parse_mtl(mtl_path):
    """Return {material_name: texture filename (map_Kd)}."""
    mats, cur = {}, None
    with open(mtl_path, "r", errors="ignore") as fh:
        for line in fh:
            parts = line.strip().split(None, 1)
            if len(parts) < 2:
                continue
            if parts[0] == "newmtl":
                cur = parts[1]
            elif parts[0] == "map_Kd" and cur:
                mats[cur] = parts[1]
    return mats


def parse_obj(obj_path):
    """Fast OBJ parse (v, vt, f with v/vt[/vn]) -> verts, uvs, {mat: [face rows]}."""
    verts, uvs = [], []
    faces = {}  # mat -> list of (3,2) int arrays flattened
    cur = None
    with open(obj_path, "r", errors="ignore") as fh:
        for line in fh:
            if line.startswith("v "):
                verts.append(line[2:].split()[:3])
            elif line.startswith("vt "):
                uvs.append(line[3:].split()[:2])
            elif line.startswith("usemtl "):
                cur = line[7:].strip()
                faces.setdefault(cur, [])
            elif line.startswith("f "):
                toks = line[2:].split()
                idx = []
                for t in toks:
                    p = t.split("/")
                    idx.append((int(p[0]), int(p[1]) if len(p) > 1 and p[1] else 0))
                # fan triangulation for quads/ngons
                for i in range(1, len(idx) - 1):
                    faces[cur].append((idx[0], idx[i], idx[i + 1]))
    return (
        np.asarray(verts, dtype=np.float64),
        np.asarray(uvs, dtype=np.float64),
        {m: np.asarray(f, dtype=np.int64) for m, f in faces.items() if f},
    )


def load_texture(path, size, quality):
    img = Image.open(path).convert("RGB")
    if max(img.size) > size:
        img.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    return Image.open(buf)


def convert(src_dir, out_path=None, tex_size=1024, quality=80):
    obj_path = sorted(glob.glob(os.path.join(src_dir, "*.obj")))
    if not obj_path:
        raise FileNotFoundError(f"No .obj in {src_dir}")
    obj_path = obj_path[0]
    mtl_path = os.path.splitext(obj_path)[0] + ".mtl"
    out_path = out_path or os.path.join(src_dir, "mesh_textured.glb")

    t0 = time.time()
    print(f"Parsing {obj_path} ...")
    v, vt, faces = parse_obj(obj_path)
    mats = parse_mtl(mtl_path)
    print(f"  {len(v)} verts, {len(vt)} uvs, {sum(len(f) for f in faces.values())} tris, "
          f"{len(faces)} materials ({time.time()-t0:.1f}s)")

    scene = trimesh.Scene()
    for name, f in faces.items():
        tex_file = mats.get(name)
        tex_path = os.path.join(src_dir, tex_file) if tex_file else None
        if not tex_path or not os.path.isfile(tex_path):
            print(f"  ! missing texture for {name}, skipped")
            continue
        # unique (vertex, uv) pairs -> compact per-material mesh
        flat = f.reshape(-1, 2) - 1
        uniq, inv = np.unique(flat, axis=0, return_inverse=True)
        pos = v[uniq[:, 0]]
        uv = vt[uniq[:, 1]].copy()
        tri = inv.reshape(-1, 3)
        material = PBRMaterial(
            baseColorTexture=load_texture(tex_path, tex_size, quality),
            metallicFactor=0.0,
            roughnessFactor=1.0,
            doubleSided=True,
        )
        mesh = trimesh.Trimesh(vertices=pos, faces=tri, process=False)
        mesh.visual = TextureVisuals(uv=uv, material=material)
        scene.add_geometry(mesh, geom_name=name, node_name=name)

    print(f"Exporting {out_path} ...")
    scene.export(out_path, file_type="glb")
    print(f"Done: {os.path.getsize(out_path)/1e6:.1f} MB in {time.time()-t0:.1f}s")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src_dir", help="matterpak directory containing .obj/.mtl/.jpg")
    ap.add_argument("--out", default=None)
    ap.add_argument("--tex-size", type=int, default=1024)
    ap.add_argument("--quality", type=int, default=80)
    a = ap.parse_args()
    sys.exit(0 if convert(a.src_dir, a.out, a.tex_size, a.quality) else 1)

