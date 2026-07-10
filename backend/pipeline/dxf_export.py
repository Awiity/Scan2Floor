"""
dxf_export.py — Converts detected wall + opening data to layered DXF + SVG.

DXF Layers
----------
A-WALL    — wall line segments  (white, 0.5 mm)
A-DOOR    — door openings  (green)  : gap line + swing arc
A-WINDOW  — window openings  (cyan) : double parallel tick
A-TEXT    — title / annotation  (yellow)
A-GRID    — bounding-box reference  (grey)

Each floor → processed/floor_<N>.dxf + floor_<N>.svg
"""
import os
import json
import math
import ezdxf
from ezdxf.enums import TextEntityAlignment

LAYER_WALL   = "A-WALL"
LAYER_DOOR   = "A-DOOR"
LAYER_WINDOW = "A-WINDOW"
LAYER_TEXT   = "A-TEXT"
LAYER_GRID   = "A-GRID"
LAYER_ROOM   = "A-ROOM"


# ── DXF helpers ──────────────────────────────────────────────────────────────

def _add_door_symbol(msp, opening: dict):
    """
    Draw a standard architectural door symbol:
      - opening gap line (on A-DOOR layer)
      - quarter-circle arc from one jamb, radius = door width
    All in the XZ → XY 2-D CAD plane.
    """
    hx, hz   = opening["hinge_x"], opening["hinge_z"]
    x1w, z1w = opening["wall_x1"], opening["wall_z1"]
    x2w, z2w = opening["wall_x2"], opening["wall_z2"]
    width    = opening["width"]
    wall_len = opening["wall_len"]

    # Unit vector along wall
    ux = (x2w - x1w) / wall_len
    uz = (z2w - z1w) / wall_len

    # Door leaf end point (along wall from hinge by width)
    leaf_x = hx + ux * width
    leaf_z = hz + uz * width

    dxf = {"layer": LAYER_DOOR}

    # Gap line (the opening itself)
    msp.add_line((hx, hz), (leaf_x, leaf_z), dxfattribs=dxf)

    # Arc: centre = hinge, radius = width, 0° → 90° in local wall coords
    wall_angle_deg = math.degrees(math.atan2(uz, ux))
    start_angle    = wall_angle_deg
    end_angle      = wall_angle_deg + 90.0

    msp.add_arc(
        center=(hx, hz),
        radius=width,
        start_angle=start_angle,
        end_angle=end_angle,
        dxfattribs=dxf,
    )


def _add_window_symbol(msp, opening: dict):
    """
    Draw an architectural window symbol:
      two short parallel lines centred on the opening mid-point.
    """
    cx, cz   = opening["x"], opening["z"]
    x1w, z1w = opening["wall_x1"], opening["wall_z1"]
    x2w, z2w = opening["wall_x2"], opening["wall_z2"]
    wall_len  = opening["wall_len"]
    width     = opening["width"]

    ux = (x2w - x1w) / wall_len
    uz = (z2w - z1w) / wall_len

    # Perpendicular (normal) direction in XZ plane
    nx, nz = -uz, ux

    half = width / 2
    off  = 0.05   # 5 cm offset between the two parallel lines

    for sign in (-1, 1):
        px = cx + sign * nx * off
        pz = cz + sign * nz * off
        msp.add_line(
            (px - ux * half, pz - uz * half),
            (px + ux * half, pz + uz * half),
            dxfattribs={"layer": LAYER_WINDOW},
        )


# ── Main export ──────────────────────────────────────────────────────────────

def export_floor_dxf(floor_idx: int, processed_dir: str) -> str:
    """
    Read walls_floor_<N>.json + openings_floor_<N>.json (optional) and
    export a DXF + companion SVG.  Returns the DXF file path.
    """
    wall_path    = os.path.join(processed_dir, f"walls_floor_{floor_idx}.json")
    opening_path = os.path.join(processed_dir, f"openings_floor_{floor_idx}.json")
    room_path    = os.path.join(processed_dir, f"rooms_floor_{floor_idx}.json")

    if not os.path.exists(wall_path):
        raise FileNotFoundError(f"Wall data not found: {wall_path}")

    with open(wall_path) as f:
        wall_data = json.load(f)

    lines  = wall_data.get("lines", [])
    x_min  = wall_data.get("x_min", 0)
    z_min  = wall_data.get("z_min", 0)

    openings = []
    if os.path.exists(opening_path):
        with open(opening_path) as f:
            op_data = json.load(f)
        openings = op_data.get("openings", [])

    rooms = []
    if os.path.exists(room_path):
        with open(room_path) as f:
            room_data = json.load(f)
        rooms = room_data.get("rooms", [])

    # ── DXF document ─────────────────────────────────────────────────────────
    doc = ezdxf.new(dxfversion="R2010")
    doc.header["$INSUNITS"]   = 6   # metres
    doc.header["$MEASUREMENT"] = 1  # metric

    msp = doc.modelspace()

    # Layers
    doc.layers.add(LAYER_WALL,   color=7,  lineweight=50)   # white, 0.5 mm
    doc.layers.add(LAYER_DOOR,   color=3,  lineweight=35)   # green, 0.35 mm
    doc.layers.add(LAYER_WINDOW, color=4,  lineweight=25)   # cyan,  0.25 mm
    doc.layers.add(LAYER_TEXT,   color=2)                   # yellow
    doc.layers.add(LAYER_GRID,   color=8,  lineweight=13)   # grey, 0.13 mm
    doc.layers.add(LAYER_ROOM,   color=6,  lineweight=13)   # magenta, dashed

    # Wall segments
    for seg in lines:
        p1, p2 = seg
        msp.add_line((p1[0], p1[1]), (p2[0], p2[1]),
                     dxfattribs={"layer": LAYER_WALL})

    # Openings
    doors   = [o for o in openings if o["type"] == "door"]
    windows = [o for o in openings if o["type"] == "window"]

    for op in doors:
        try:
            _add_door_symbol(msp, op)
        except Exception:
            pass   # skip malformed opening silently

    for op in windows:
        try:
            _add_window_symbol(msp, op)
        except Exception:
            pass

    # ── Rooms (bounding boxes + area labels) ─────────────────────────────────
    for room in rooms:
        bb = room["bbox"]
        rx1, rz1 = bb["x_min"], bb["z_min"]
        rx2, rz2 = bb["x_max"], bb["z_max"]
        room_dxf = {"layer": LAYER_ROOM}
        # Draw closed bounding-box rectangle
        msp.add_lwpolyline(
            [(rx1, rz1), (rx2, rz1), (rx2, rz2), (rx1, rz2)],
            close=True,
            dxfattribs=room_dxf,
        )
        # Centroid label
        cx, cz = room["centroid_x"], room["centroid_z"]
        label = f"R{room['id']}  {room['area_m2']:.1f} m\u00b2"
        msp.add_text(label, dxfattribs={"layer": LAYER_TEXT, "height": 0.25}) \
           .set_placement((cx, cz), align=TextEntityAlignment.MIDDLE_CENTER)

    # ── Title ─────────────────────────────────────────────────────────────────
    n_doors   = len(doors)
    n_windows = len(windows)
    title = (
        f"Floor {floor_idx}  —  {len(lines)} walls"
        + (f"  ·  {n_doors} doors  ·  {n_windows} windows" if openings else "")
    )
    msp.add_text(title, dxfattribs={"layer": LAYER_TEXT, "height": 0.4}) \
       .set_placement((x_min, z_min - 2), align=TextEntityAlignment.LEFT)

    # Save DXF
    dxf_path = os.path.join(processed_dir, f"floor_{floor_idx}.dxf")
    doc.saveas(dxf_path)

    # Companion SVG
    svg_path = os.path.join(processed_dir, f"floor_{floor_idx}.svg")
    _write_svg(svg_path, lines, openings, rooms)

    return dxf_path


# ── SVG preview ───────────────────────────────────────────────────────────────

def _write_svg(path: str, lines: list, openings: list = None, rooms: list = None):
    """Write an SVG preview with rooms (semi-transparent), walls (cyan), doors (green), windows (magenta)."""
    openings = openings or []
    rooms = rooms or []

    if not lines:
        with open(path, "w") as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
                    '<text x="10" y="20" fill="white">No walls detected</text></svg>')
        return

    all_x = [p[0] for seg in lines for p in seg]
    all_y = [p[1] for seg in lines for p in seg]
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    w = max_x - min_x or 1
    h = max_y - min_y or 1

    SVG_W, SVG_H = 900, 900
    pad   = 30
    scale = min((SVG_W - 2 * pad) / w, (SVG_H - 2 * pad) / h)

    def tx(x): return pad + (x - min_x) * scale
    def ty(y): return SVG_H - pad - (y - min_y) * scale

    parts = []

    # ── Rooms (semi-transparent fills, rendered first / behind walls) ───────
    room_colours = [
        "#7c3aed", "#2563eb", "#059669", "#b45309",
        "#db2777", "#0891b2", "#65a30d", "#9333ea",
        "#0284c7", "#16a34a", "#d97706", "#dc2626",
    ]
    for room in rooms:
        bb = room["bbox"]
        rx1_s = tx(bb["x_min"])
        rz1_s = ty(bb["z_max"])   # ty is Y-flipped: z_max → top in SVG
        rw_s  = (bb["x_max"] - bb["x_min"]) * scale
        rh_s  = (bb["z_max"] - bb["z_min"]) * scale
        col   = room_colours[(room["id"] - 1) % len(room_colours)]
        cx_s  = tx(room["centroid_x"])
        cz_s  = ty(room["centroid_z"])
        parts.append(
            f'<rect x="{rx1_s:.1f}" y="{rz1_s:.1f}" '
            f'width="{rw_s:.1f}" height="{rh_s:.1f}" '
            f'fill="{col}" fill-opacity="0.18" '
            f'stroke="{col}" stroke-width="0.8" stroke-dasharray="5,3"/>'
        )
        parts.append(
            f'<text x="{cx_s:.1f}" y="{cz_s:.1f}" '
            f'text-anchor="middle" dominant-baseline="middle" '
            f'fill="{col}" font-size="11" font-family="sans-serif" '
            f'font-weight="bold">'
            f'R{room["id"]} {room["area_m2"]:.0f}m\u00b2</text>'
        )

    # ── Walls ──────────────────────────────────────────────────────────────
    for seg in lines:
        x1, y1 = seg[0];  x2, y2 = seg[1]
        parts.append(
            f'<line x1="{tx(x1):.1f}" y1="{ty(y1):.1f}" '
            f'x2="{tx(x2):.1f}" y2="{ty(y2):.1f}" '
            f'stroke="#00d4ff" stroke-width="1.5"/>'
        )

    # ── Doors ──────────────────────────────────────────────────────────────
    for op in openings:
        if op["type"] != "door":
            continue

        hx, hz   = op["hinge_x"], op["hinge_z"]
        wl       = op["wall_len"]
        x1w, z1w = op["wall_x1"], op["wall_z1"]
        x2w, z2w = op["wall_x2"], op["wall_z2"]
        width    = op["width"] * scale      # in SVG px

        ux = (x2w - x1w) / wl
        uz = (z2w - z1w) / wl

        leaf_x  = hx + ux * op["width"]
        leaf_z  = hz + uz * op["width"]

        # Opening gap (thick green)
        parts.append(
            f'<line x1="{tx(hx):.1f}" y1="{ty(hz):.1f}" '
            f'x2="{tx(leaf_x):.1f}" y2="{ty(leaf_z):.1f}" '
            f'stroke="#22c55e" stroke-width="3"/>'
        )

        # Arc representing door swing — drawn as SVG arc
        # wall angle in screen coords (Y is flipped)
        wall_ang = math.atan2(-(uz), ux)   # screen Y flipped
        r = width
        cx_svg, cy_svg = tx(hx), ty(hz)
        # Start point: hinge + r along wall direction
        sx = cx_svg + r * math.cos(wall_ang)
        sy = cy_svg + r * math.sin(wall_ang)
        # End point: hinge + r perpendicular to wall (90° CCW in screen)
        ex = cx_svg + r * math.cos(wall_ang - math.pi / 2)
        ey = cy_svg + r * math.sin(wall_ang - math.pi / 2)

        parts.append(
            f'<path d="M {sx:.1f},{sy:.1f} A {r:.1f},{r:.1f} 0 0,1 {ex:.1f},{ey:.1f}" '
            f'stroke="#22c55e" stroke-width="1" fill="none" stroke-dasharray="4,3"/>'
        )

    # ── Windows ────────────────────────────────────────────────────────────
    for op in openings:
        if op["type"] != "window":
            continue

        cx_m, cz_m = op["x"], op["z"]
        wl = op["wall_len"]
        x1w, z1w = op["wall_x1"], op["wall_z1"]
        x2w, z2w = op["wall_x2"], op["wall_z2"]
        ux = (x2w - x1w) / wl
        uz = (z2w - z1w) / wl
        nx, nz = -uz, ux

        half  = op["width"] / 2
        off_m = 0.06  # 6 cm physical offset

        for sign in (-1, 1):
            px_m = cx_m + sign * nx * off_m
            pz_m = cz_m + sign * nz * off_m
            parts.append(
                f'<line x1="{tx(px_m - ux*half):.1f}" y1="{ty(pz_m - uz*half):.1f}" '
                f'x2="{tx(px_m + ux*half):.1f}" y2="{ty(pz_m + uz*half):.1f}" '
                f'stroke="#e879f9" stroke-width="2.5"/>'
            )

    # Legend
    n_doors   = sum(1 for o in openings if o["type"] == "door")
    n_windows = sum(1 for o in openings if o["type"] == "window")
    legend_items = [
        f'<rect x="{SVG_W-180}" y="14" width="12" height="3" fill="#00d4ff"/>',
        f'<text x="{SVG_W-163}" y="20" fill="#00d4ff" font-size="11">Walls</text>',
    ]
    if n_doors:
        legend_items += [
            f'<rect x="{SVG_W-180}" y="32" width="12" height="3" fill="#22c55e"/>',
            f'<text x="{SVG_W-163}" y="38" fill="#22c55e" font-size="11">Doors ({n_doors})</text>',
        ]
    if n_windows:
        legend_items += [
            f'<rect x="{SVG_W-180}" y="50" width="12" height="3" fill="#e879f9"/>',
            f'<text x="{SVG_W-163}" y="56" fill="#e879f9" font-size="11">Windows ({n_windows})</text>',
        ]

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{SVG_W}" height="{SVG_H}" '
        f'style="background:#070b18">\n'
        + "\n".join(parts)
        + "\n"
        + "\n".join(legend_items)
        + "\n</svg>"
    )

    with open(path, "w") as f:
        f.write(svg)
