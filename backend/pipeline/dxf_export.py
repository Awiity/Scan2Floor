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
      - door leaf line swung open 90° into the room
      - opening frame line along wall
      - 90° quarter-circle swing arc connecting jamb to open leaf tip
    All in the XZ → XY 2-D CAD plane on LAYER_DOOR.
    """
    hx, hz   = opening["hinge_x"], opening["hinge_z"]
    x1w, z1w = opening["wall_x1"], opening["wall_z1"]
    x2w, z2w = opening["wall_x2"], opening["wall_z2"]
    width    = float(opening["width"])
    wall_len = float(opening["wall_len"])

    if wall_len < 0.001 or width < 0.05:
        return

    ux = (x2w - x1w) / wall_len
    uz = (z2w - z1w) / wall_len

    hinge_side = int(opening.get("side", 1))
    swing_dir  = int(opening.get("swing_dir", 1))

    # Direction along wall from hinge to strike jamb
    # side=1: hinge at start of opening -> closed leaf goes in +u direction
    # side=-1: hinge at end of opening -> closed leaf goes in -u direction
    if hinge_side == -1:
        c_ux, c_uz = -ux, -uz
    else:
        c_ux, c_uz = ux, uz

    # Strike jamb position (closed door tip)
    sx = hx + c_ux * width
    sz = hz + c_uz * width

    # Normal vector for open door leaf (perpendicular to wall, oriented by swing_dir)
    nx = -c_uz * swing_dir
    nz =  c_ux * swing_dir

    # Tip of open door leaf
    tx = hx + nx * width
    tz = hz + nz * width

    dxf = {"layer": LAYER_DOOR}

    # 1. Closed opening line along wall (threshold / opening frame)
    msp.add_line((hx, hz), (sx, sz), dxfattribs=dxf)

    # 2. Open door leaf panel
    msp.add_line((hx, hz), (tx, tz), dxfattribs=dxf)

    # 3. 90° swing arc connecting strike jamb (sx, sz) to leaf tip (tx, tz)
    # DXF arcs ALWAYS sweep counter-clockwise (CCW) from start_angle to end_angle.
    a_closed = math.degrees(math.atan2(sz - hz, sx - hx)) % 360.0
    a_open   = math.degrees(math.atan2(tz - hz, tx - hx)) % 360.0

    diff = (a_open - a_closed) % 360.0
    if diff < 180.0:
        start_ang, end_ang = a_closed, a_open
    else:
        start_ang, end_ang = a_open, a_closed

    msp.add_arc(
        center=(hx, hz),
        radius=width,
        start_angle=start_ang,
        end_angle=end_ang,
        dxfattribs=dxf,
    )


def _add_window_symbol(msp, opening: dict):
    """
    Draw an architectural window symbol:
      - two parallel outer frame lines
      - central glazing line
      - jamb end caps
    """
    cx, cz   = opening["x"], opening["z"]
    x1w, z1w = opening["wall_x1"], opening["wall_z1"]
    x2w, z2w = opening["wall_x2"], opening["wall_z2"]
    wall_len = float(opening["wall_len"])
    width    = float(opening["width"])

    if wall_len < 0.001 or width < 0.05:
        return

    ux = (x2w - x1w) / wall_len
    uz = (z2w - z1w) / wall_len

    # Normal direction perpendicular to wall
    nx, nz = -uz, ux

    half = width / 2.0
    off  = 0.08   # 8 cm offset for outer frame lines

    p1_a = (cx - ux * half + nx * off, cz - uz * half + nz * off)
    p2_a = (cx + ux * half + nx * off, cz + uz * half + nz * off)
    p1_b = (cx - ux * half - nx * off, cz - uz * half - nz * off)
    p2_b = (cx + ux * half - nx * off, cz + uz * half - nz * off)

    dxf = {"layer": LAYER_WINDOW}

    # Parallel frame lines
    msp.add_line(p1_a, p2_a, dxfattribs=dxf)
    msp.add_line(p1_b, p2_b, dxfattribs=dxf)

    # Centre sill / glass line
    msp.add_line(
        (cx - ux * half, cz - uz * half),
        (cx + ux * half, cz + uz * half),
        dxfattribs=dxf,
    )

    # Jamb end caps
    msp.add_line(p1_a, p1_b, dxfattribs=dxf)
    msp.add_line(p2_a, p2_b, dxfattribs=dxf)


# ── Opening geometry conversion ───────────────────────────────────────────────

def _user_opening_to_dxf(op: dict, wall_lines: list) -> dict | None:
    """
    Convert a manually-placed opening (Room Editor format) into the geometry
    dict consumed by _add_door_symbol / _add_window_symbol.

    Resilient to wall edits/deletions: uses stored wall coordinates or finds
    the best matching segment in wall_lines rather than crashing on shifted wall_idx.
    """
    x1 = op.get("wall_x1")
    z1 = op.get("wall_z1")
    x2 = op.get("wall_x2")
    z2 = op.get("wall_z2")

    wi = op.get("wall_idx", -1)
    seg = None
    if isinstance(wi, int) and 0 <= wi < len(wall_lines):
        seg = wall_lines[wi]

    # If coordinates are missing, take from wall_lines[wi]
    if (x1 is None or x2 is None) and seg is not None:
        x1, z1 = seg[0]
        x2, z2 = seg[1]

    # If still missing, find closest wall in wall_lines
    if x1 is None or x2 is None:
        ox = op.get("x")
        oz = op.get("z")
        if ox is not None and oz is not None and wall_lines:
            best_dist = float("inf")
            best_seg = None
            for s in wall_lines:
                mx = (s[0][0] + s[1][0]) / 2.0
                mz = (s[0][1] + s[1][1]) / 2.0
                d = math.hypot(float(ox) - mx, float(oz) - mz)
                if d < best_dist:
                    best_dist = d
                    best_seg = s
            if best_seg is not None and best_dist < 5.0:
                x1, z1 = best_seg[0]
                x2, z2 = best_seg[1]

    if x1 is None or x2 is None:
        return None

    x1, z1 = float(x1), float(z1)
    x2, z2 = float(x2), float(z2)
    wall_len = math.hypot(x2 - x1, z2 - z1)
    if wall_len < 0.01:
        return None

    ux = (x2 - x1) / wall_len
    uz = (z2 - z1) / wall_len

    t = float(op.get("position_t", 0.5))
    w_m = float(op.get("width_m") or op.get("width") or 0.9)
    half_w = w_m / 2.0

    if op.get("x") is not None and op.get("z") is not None:
        cx = float(op["x"])
        cz = float(op["z"])
    else:
        cx = x1 + t * (x2 - x1)
        cz = z1 + t * (z2 - z1)

    hinge_side = int(op.get("side", 1))
    swing_dir  = int(op.get("swing_dir", 1))
    if hinge_side == -1:
        hx = cx + ux * half_w
        hz = cz + uz * half_w
    else:
        hx = cx - ux * half_w
        hz = cz - uz * half_w

    return {
        "type":      op.get("type", "door"),
        "width":     w_m,
        "wall_len":  wall_len,
        "x":         cx,         "z":        cz,
        "wall_x1":   x1,         "wall_z1":  z1,
        "wall_x2":   x2,         "wall_z2":  z2,
        "hinge_x":   hx,         "hinge_z":  hz,
        "side":      hinge_side,
        "swing_dir": swing_dir,
        "u_start":   t * wall_len - half_w,
        "u_end":     t * wall_len + half_w,
    }


# ── Main export ──────────────────────────────────────────────────────────────

def export_floor_dxf(floor_idx: int, processed_dir: str) -> str:
    """
    Read walls_floor_<N>.json + openings_floor_<N>.json (optional) and
    export a DXF + companion SVG.  Returns the DXF file path.

    Supports both manually placed (user_openings) and any existing openings.
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

    # Load openings: user_openings (manual) + any existing openings
    openings = []
    if os.path.exists(opening_path):
        with open(opening_path) as f:
            op_data = json.load(f)

        # 1. Manually-placed user openings
        for raw in op_data.get("user_openings", []):
            converted = _user_opening_to_dxf(raw, lines)
            if converted is not None:
                openings.append(converted)

        # 2. Existing / imported openings from "openings" field
        for raw in op_data.get("openings", []):
            if "hinge_x" in raw and "wall_len" in raw:
                raw_copy = dict(raw)
                if "side" not in raw_copy:
                    raw_copy["side"] = 1
                if "swing_dir" not in raw_copy:
                    raw_copy["swing_dir"] = 1
                openings.append(raw_copy)
            else:
                converted = _user_opening_to_dxf(raw, lines)
                if converted is not None:
                    openings.append(converted)

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

    # ── Rooms (polygon outlines + area labels) ────────────────────────────────
    for room in rooms:
        room_dxf = {"layer": LAYER_ROOM}
        poly = room.get("polygon", [])
        if poly and len(poly) >= 3:
            # True non-rectangular polygon
            pts = [(p[0], p[1]) for p in poly]
            msp.add_lwpolyline(pts, close=True, dxfattribs=room_dxf)
        else:
            # Fallback: axis-aligned bounding-box rectangle
            bb = room["bbox"]
            msp.add_lwpolyline(
                [(bb["x_min"], bb["z_min"]),
                 (bb["x_max"], bb["z_min"]),
                 (bb["x_max"], bb["z_max"]),
                 (bb["x_min"], bb["z_max"])],
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
        poly  = room.get("polygon", [])
        col   = room_colours[(room["id"] - 1) % len(room_colours)]
        cx_s  = tx(room["centroid_x"])
        cz_s  = ty(room["centroid_z"])

        if poly and len(poly) >= 3:
            # True polygon path
            d = "M " + " L ".join(f"{tx(p[0]):.1f},{ty(p[1]):.1f}" for p in poly) + " Z"
            parts.append(
                f'<path d="{d}" '
                f'fill="{col}" fill-opacity="0.18" '
                f'stroke="{col}" stroke-width="0.8" stroke-dasharray="5,3"/>'
            )
        else:
            # Fallback: bounding-box rectangle
            bb = room["bbox"]
            rx1_s = tx(bb["x_min"])
            rz1_s = ty(bb["z_max"])   # ty is Y-flipped: z_max → top in SVG
            rw_s  = (bb["x_max"] - bb["x_min"]) * scale
            rh_s  = (bb["z_max"] - bb["z_min"]) * scale
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
