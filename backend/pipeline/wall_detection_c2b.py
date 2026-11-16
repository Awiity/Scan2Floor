"""
wall_detection_c2b.py  —  variable-thickness wall detector for Scan2Floor (v2)

Why a rewrite
-------------
The previous detector traced *contours* of a thresholded density image and then
tried to pair the resulting segments.  A thin scanned wall face gives a contour
that runs down one side and back up the other, so every wall appeared twice
("walls inside walls"); any blob with a tall-enough point column became a wall
(furniture, door leaves, noise); and thickness was never stored.

Algorithm
---------
1. Load full-density wall slice (wall_slice_floor_N.npy) and make heights
   relative to the *local* floor (floor heightmap), so ramps/uneven floors work.
2. Height-zone evidence per XZ cell.  Three zones above the local floor:
       LOW  0.15–0.90 m     MID  0.90–1.90 m     HIGH 2.00 m – ceiling-0.4 m
   A cell is "wall" only if it has points in HIGH **and** in LOW or MID:
       • wall            → points everywhere                      ✔
       • window in wall  → LOW (sill wall) + HIGH (above window)  ✔
       • open doorway    → only HIGH (lintel)                     ✘  (door ≠ wall)
       • door leaf/arcs, furniture, cars, stairs, plants → no HIGH ✘
3. Estimate dominant wall directions (gradient-orientation histogram) – not only
   0°/90°, so rotated building wings are supported.
4. Per direction: close scan holes along the direction, fuse the two faces of a
   wall across its thickness, then open with a long line kernel so that only
   elongated structures survive (this removes perpendicular stubs and blobs).
5. Every surviving component is profiled along its length (perpendicular
   extent + centre-line offset per cell) and split into pieces of constant
   thickness / offset  →  walls with e.g. 10 cm on the first half and 25 cm on
   the second.
6. Pieces are checked for scan support and de-duplicated: pieces that lie inside
   a better piece are removed, partial overlaps are trimmed.
7. Collinear pieces separated by a door-sized gap are reported as
   ``door_gaps`` (room detection uses them to keep rooms closed).

Output (walls_floor_N.json) is backward compatible:
    lines               [[ [x1,z1], [x2,z2] ], …]   centre-lines, metres
    thicknesses         [t, …]                      same order as ``lines``
    thickness_source    ["measured"|"default", …]   same order
    door_gaps           [[ [x1,z1], [x2,z2] ], …]

Coordinate system: wall_slice is Y-up (Three.js): col0 = x, col1 = height,
col2 = z.  Everything here happens in the XZ plane.
"""

from __future__ import annotations

import json
import math
import os

import cv2
import numpy as np

# ── Optional GPU acceleration via CuPy ───────────────────────────────────────
try:
    import cupy as cp
    _GPU = True
except ImportError:
    _GPU = False


def _json_default(obj):
    if isinstance(obj, (np.floating, np.integer)):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


# ═════════════════════════════════════════════════════════════════════════════
# Small helpers
# ═════════════════════════════════════════════════════════════════════════════

def _dist(p1, p2) -> float:
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def _line_kernel(length_px: int, theta: float) -> np.ndarray:
    """1-px wide line kernel of ~length_px at angle theta (radians, image coords)."""
    n = max(3, int(length_px) | 1)
    c = n // 2
    k = np.zeros((n, n), np.uint8)
    dx, dy = math.cos(theta) * c, math.sin(theta) * c
    cv2.line(k, (int(round(c - dx)), int(round(c - dy))),
             (int(round(c + dx)), int(round(c + dy))), 1, 1)
    return k


def _grid_count(px, py, mask, width, height):
    flat = py[mask].astype(np.int64) * width + px[mask].astype(np.int64)
    return np.bincount(flat, minlength=height * width).reshape(height, width)


def _local_floor(pts, floor_y, info, processed_dir, floor_idx):
    """Per-point local floor elevation (falls back to the global floor level)."""
    hm_path = os.path.join(processed_dir, f"floor_heightmap_{floor_idx}.npy")
    hm_meta = info.get("wall_slices", {}).get(f"floor_heightmap_{floor_idx}")
    if os.path.exists(hm_path) and hm_meta:
        hm = np.load(hm_path)
        cell = float(hm_meta["cell_size"])
        rows, cols = int(hm_meta["rows"]), int(hm_meta["cols"])
        cx = np.clip(np.floor((pts[:, 0] - float(hm_meta["x_min"])) / cell).astype(np.int32), 0, cols - 1)
        cz = np.clip(np.floor((pts[:, 2] - float(hm_meta["z_min"])) / cell).astype(np.int32), 0, rows - 1)
        return hm[cz, cx].astype(np.float32)
    print(f"[c2b floor {floor_idx}] WARNING: no heightmap — using global floor level")
    return np.full(len(pts), floor_y, np.float32)


# ═════════════════════════════════════════════════════════════════════════════
# Step 2 — wall evidence from height zones
# ═════════════════════════════════════════════════════════════════════════════

def _wall_evidence(pts, rel_h, storey_h, gs, x_min, z_min, width, height, cfg):
    low = (cfg["low_lo"], cfg["low_hi"])
    mid = (cfg["low_hi"], cfg["mid_hi"])
    hi_lo = cfg["high_lo"]
    hi_hi = min(storey_h - cfg["ceiling_margin"], cfg["high_hi_max"])
    hi_hi = max(hi_hi, hi_lo + 0.3)

    px = np.clip(np.floor((pts[:, 0] - x_min) / gs).astype(np.int32), 0, width - 1)
    py = np.clip(np.floor((pts[:, 2] - z_min) / gs).astype(np.int32), 0, height - 1)

    def zone(lo, hi):
        m = (rel_h >= lo) & (rel_h < hi)
        return _grid_count(px, py, m, width, height).astype(np.float32)

    c_low, c_mid, c_high = zone(*low), zone(*mid), zone(hi_lo, hi_hi)

    k3 = np.ones((3, 3), np.uint8)
    k5 = np.ones((5, 5), np.uint8)
    p_low = cv2.dilate((c_low > 0).astype(np.uint8), k3)
    p_mid = cv2.dilate((c_mid > 0).astype(np.uint8), k3)
    p_high = cv2.dilate((c_high > 0).astype(np.uint8), k5)

    wall = (p_high & (p_low | p_mid)).astype(np.uint8)

    # Drop speckle
    n, lab, stats, _ = cv2.connectedComponentsWithStats(wall, connectivity=8)
    small = np.where(stats[:, cv2.CC_STAT_AREA] < cfg["min_blob_px"])[0]
    if len(small):
        wall[np.isin(lab, small[small != 0])] = 0

    density = (c_low + c_mid + c_high)
    return wall, density, (c_low > 0), (c_mid > 0), (c_high > 0), (low, mid, (hi_lo, hi_hi))


# ═════════════════════════════════════════════════════════════════════════════
# Step 3 — dominant directions
# ═════════════════════════════════════════════════════════════════════════════

def _dominant_directions(wall: np.ndarray, gs: float, snap_deg: float, max_dirs: int = 5) -> list[float]:
    """
    Dominant wall directions (radians in [0, pi)).

    Long Hough segments vote for their angle (weighted by length) in a 1 deg
    histogram.  Local maxima that carry enough wall length become directions, so
    rotated building wings (or slightly drifted scans) get their own pass while
    wobble around a main axis does not.  0 deg / 90 deg always come as a pair.
    """
    min_len = max(10, int(round(1.2 / gs)))
    segs = cv2.HoughLinesP(wall * 255, 1, math.radians(0.5), threshold=int(min_len * 0.8),
                           minLineLength=min_len, maxLineGap=max(2, int(round(0.15 / gs))))
    if segs is None or len(segs) == 0:
        return [0.0, math.pi / 2]
    hist = np.zeros(180)
    for x1, y1, x2, y2 in np.asarray(segs).reshape(-1, 4):   # OpenCV 4: (N,1,4), OpenCV 5: (N,4)
        a = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
        hist[int(round(a)) % 180] += math.hypot(x2 - x1, y2 - y1) * gs      # metres
    peaks = []
    for i in range(180):
        w = [(i + k) % 180 for k in (-2, -1, 1, 2)]
        if hist[i] > 0 and all(hist[i] >= hist[j] for j in w):
            peaks.append((hist[i], float(i)))
    peaks.sort(reverse=True)
    top = peaks[0][0] if peaks else 0.0
    chosen: list[float] = []
    for wgt, a in peaks:
        if wgt < max(0.04 * top, 3.0) and chosen:
            break
        if all(min(abs(a - c), 180 - abs(a - c)) > 2.5 for c in chosen):
            chosen.append(a)
        if len(chosen) >= max_dirs:
            break
    if not chosen:
        chosen = [0.0]

    def near(a, b, tol=6.0):
        return min(abs(a - b), 180 - abs(a - b)) <= tol

    # snap near-axis directions
    out: list[float] = []
    for a in chosen:
        for ax in (0.0, 90.0, 180.0):
            if abs(a - ax) <= snap_deg:
                a = ax % 180.0
        out.append(a % 180.0)
    # axis pair: if one of 0/90 is present, make sure the other is as well
    has0 = any(near(a, 0.0, 6.0) for a in out)
    has90 = any(near(a, 90.0, 6.0) for a in out)
    if has0 and not has90:
        out.append(90.0)
    if has90 and not has0:
        out.append(0.0)
    return sorted(set(round(math.radians(a), 6) for a in out))


# ═════════════════════════════════════════════════════════════════════════════
# Steps 4–5 — per-direction extraction + variable thickness split
# ═════════════════════════════════════════════════════════════════════════════

def _split_profile(t, c, tol_t, tol_c, hold, min_len):
    """
    Split a per-cell (thickness, centre offset) profile into constant pieces.
    t, c : 1-D float arrays (pixels).  Returns list of (i0, i1) index ranges (i1 exclusive).
    """
    n = len(t)
    if n == 0:
        return []
    ref_n = max(3, hold)
    starts = [0]
    i = 0
    while i < n:
        s = starts[-1]
        ref_t = np.median(t[s:min(n, s + ref_n)])
        ref_c = np.median(c[s:min(n, s + ref_n)])
        # advance while profile matches the current piece
        j = max(i, s)
        brk = None
        while j < n:
            dev = abs(t[j] - ref_t) > tol_t or abs(c[j] - ref_c) > tol_c
            if dev and j + hold <= n:
                seg_t = t[j:j + hold]
                seg_c = c[j:j + hold]
                med_t, med_c = np.median(seg_t), np.median(seg_c)
                sustained = abs(med_t - ref_t) > tol_t or abs(med_c - ref_c) > tol_c
                # the deviating run must itself be stable, otherwise it is noise
                stable = (np.ptp(seg_t) <= 1.5 * tol_t + 1) and (np.ptp(seg_c) <= 1.5 * tol_c + 1)
                if sustained and stable:
                    brk = j
                    break
            j += 1
        if brk is None:
            break
        starts.append(brk)
        i = brk + 1
    bounds = starts + [n]
    pieces = [(bounds[k], bounds[k + 1]) for k in range(len(starts))]

    # absorb pieces shorter than min_len into the longer neighbour
    changed = True
    while changed and len(pieces) > 1:
        changed = False
        for k, (a, b) in enumerate(pieces):
            if b - a < min_len:
                left = pieces[k - 1] if k > 0 else None
                right = pieces[k + 1] if k + 1 < len(pieces) else None
                if left is None:
                    pieces[k + 1] = (a, right[1])
                elif right is None or (left[1] - left[0]) >= (right[1] - right[0]):
                    pieces[k - 1] = (left[0], b)
                else:
                    pieces[k + 1] = (a, right[1])
                pieces.pop(k)
                changed = True
                break
    return pieces


def _extract_direction(wall, theta, gs, x_min, z_min, cfg):
    """Extract (variable-thickness) wall pieces whose direction is *theta*."""
    c_, s_ = math.cos(theta), math.sin(theta)

    gap_px = max(3, int(round(cfg["scan_gap_m"] / gs)))
    fuse_px = max(3, int(round(cfg["face_fuse_m"] / gs)))
    run_px = max(5, int(round(cfg["min_run_m"] / gs)))

    k_along = _line_kernel(gap_px, theta)
    k_perp = _line_kernel(fuse_px, theta + math.pi / 2)
    k_run = _line_kernel(run_px, theta)

    m = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, k_along)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k_perp)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k_run)

    n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    pieces = []
    tol_t = max(1.0, cfg["thickness_tol_m"] / gs)
    tol_c = max(1.0, cfg["offset_tol_m"] / gs)
    hold = max(3, int(round(cfg["min_piece_m"] * 0.5 / gs)))
    min_piece_px = int(round(cfg["min_piece_m"] / gs))

    for li in range(1, n_lab):
        x0, y0, w, h, area = stats[li]
        if max(w, h) < run_px:
            continue
        sub = (lab[y0:y0 + h, x0:x0 + w] == li)
        ys, xs = np.nonzero(sub)
        xs = xs + x0
        ys = ys + y0
        u = xs * c_ + ys * s_
        v = -xs * s_ + ys * c_
        ui = np.floor(u).astype(np.int64)
        u_min, u_max = int(ui.min()), int(ui.max())
        nb = u_max - u_min + 1
        if nb * gs < cfg["min_wall_m"]:
            continue
        idx = ui - u_min
        v_lo = np.full(nb, np.inf)
        v_hi = np.full(nb, -np.inf)
        np.minimum.at(v_lo, idx, v)
        np.maximum.at(v_hi, idx, v)
        # raw wall support per u-cell (before gap filling)
        raw = wall[ys, xs] > 0
        sup = np.zeros(nb, bool)
        sup[idx[raw]] = True

        have = np.isfinite(v_lo)
        if have.sum() < 3:
            continue
        # interpolate cells with no pixel (diagonal stair-stepping)
        xi = np.arange(nb)
        v_lo = np.interp(xi, xi[have], v_lo[have])
        v_hi = np.interp(xi, xi[have], v_hi[have])
        t = v_hi - v_lo + 1.0
        cen = 0.5 * (v_hi + v_lo)

        # light median filtering against rasterisation jitter
        k = 5
        if nb > k:
            pad = k // 2
            tp = np.pad(t, pad, mode="edge")
            cp_ = np.pad(cen, pad, mode="edge")
            t = np.array([np.median(tp[i:i + k]) for i in range(nb)])
            cen = np.array([np.median(cp_[i:i + k]) for i in range(nb)])

        for a, b in _split_profile(t, cen, tol_t, tol_c, hold, min_piece_px):
            length_m = (b - a) * gs
            if length_m < cfg["min_wall_m"]:
                continue
            support = float(sup[a:b].mean())
            t_px = float(np.median(t[a:b]))
            c_px = float(np.median(cen[a:b]))
            # piece end-points (pixel space → metres)
            ua, ub = u_min + a, u_min + b
            p0 = (ua * c_ - c_px * s_, ua * s_ + c_px * c_)
            p1 = (ub * c_ - c_px * s_, ub * s_ + c_px * c_)
            thick_raw = t_px * gs - cfg["thickness_bias_m"]
            pieces.append({
                "p0": [p0[0] * gs + x_min, p0[1] * gs + z_min],
                "p1": [p1[0] * gs + x_min, p1[1] * gs + z_min],
                "thick_raw": thick_raw,
                "support": support,
                "theta": theta,
            })
    return pieces


# ═════════════════════════════════════════════════════════════════════════════
# Step 6 — de-duplication
# ═════════════════════════════════════════════════════════════════════════════

def _piece_len(p):
    return _dist(p["p0"], p["p1"])


def _in_rect(pt, a, half_w, extra):
    """Is point pt inside oriented rectangle of wall a (inflated by extra)?"""
    ax, az = a["p0"]
    dx, dz = a["p1"][0] - ax, a["p1"][1] - az
    L = math.hypot(dx, dz)
    if L < 1e-9:
        return False
    ux, uz = dx / L, dz / L
    rx, rz = pt[0] - ax, pt[1] - az
    u = rx * ux + rz * uz
    v = -rx * uz + rz * ux
    return (-extra <= u <= L + extra) and (abs(v) <= half_w + extra)


def _ang_diff(a, b):
    d = abs(a - b) % math.pi
    return min(d, math.pi - d)


def _dedupe(pieces, cfg):
    """Remove pieces lying inside better pieces, trim parallel overlaps."""
    # priority: scan support × length (long, well supported walls win)
    order = sorted(pieces, key=lambda p: _piece_len(p) * (0.5 + p["support"]) * (1.0 + p["thick"]), reverse=True)
    kept: list[dict] = []
    par_tol = math.radians(12.0)
    step = 0.03
    for p in order:
        L = _piece_len(p)
        ux, uz = (p["p1"][0] - p["p0"][0]) / L, (p["p1"][1] - p["p0"][1]) / L
        n_s = max(2, int(L / step))
        covered = np.zeros(n_s, bool)
        for a in kept:
            if _ang_diff(a["theta"], p["theta"]) > par_tol:
                continue
            hw = max(a["thick"], p["thick"]) / 2.0 + cfg["dedupe_dist_m"]
            for i in range(n_s):
                if covered[i]:
                    continue
                t = (i + 0.5) / n_s
                pt = (p["p0"][0] + ux * L * t, p["p0"][1] + uz * L * t)
                if _in_rect(pt, a, hw, 0.0):
                    covered[i] = True
        if covered.mean() >= 0.85:
            continue
        if covered.any():
            # keep uncovered runs that are long enough
            i = 0
            while i < n_s:
                if covered[i]:
                    i += 1
                    continue
                j = i
                while j < n_s and not covered[j]:
                    j += 1
                if (j - i) * L / n_s >= cfg["min_wall_m"]:
                    t0, t1 = i / n_s, j / n_s
                    q = dict(p)
                    q["p0"] = [p["p0"][0] + ux * L * t0, p["p0"][1] + uz * L * t0]
                    q["p1"] = [p["p0"][0] + ux * L * t1, p["p0"][1] + uz * L * t1]
                    kept.append(q)
                i = j
        else:
            kept.append(p)
    return kept


def _merge_collinear(pieces, cfg, gap_m=0.25, perp_m=0.07, thick_m=0.05):
    """Merge same-direction pieces on the same axis with (almost) equal thickness."""
    pieces = [dict(p) for p in pieces]
    changed = True
    while changed:
        changed = False
        for i in range(len(pieces)):
            a = pieces[i]
            L = _piece_len(a)
            if L < 1e-9:
                continue
            ux, uz = (a["p1"][0] - a["p0"][0]) / L, (a["p1"][1] - a["p0"][1]) / L
            nx, nz = -uz, ux
            a0 = 0.0
            a1 = L
            for j in range(i + 1, len(pieces)):
                b = pieces[j]
                if _ang_diff(a["theta"], b["theta"]) > math.radians(4.0):
                    continue
                if abs(a["thick"] - b["thick"]) > thick_m:
                    continue
                bs = [((e[0] - a["p0"][0]) * ux + (e[1] - a["p0"][1]) * uz,
                       (e[0] - a["p0"][0]) * nx + (e[1] - a["p0"][1]) * nz) for e in (b["p0"], b["p1"])]
                if max(abs(bs[0][1]), abs(bs[1][1])) > perp_m:
                    continue
                b0, b1 = min(bs[0][0], bs[1][0]), max(bs[0][0], bs[1][0])
                if max(b0 - a1, a0 - b1) > gap_m:
                    continue
                lb = _piece_len(b)
                lo, hi = min(a0, b0), max(a1, b1)
                voff = (bs[0][1] * lb + 0.0) / max(lb, 1e-9)   # offset of b relative to a's axis
                voff = 0.5 * (bs[0][1] + bs[1][1])
                w = L + lb
                shift = voff * lb / w
                a["thick"] = (a["thick"] * L + b["thick"] * lb) / w
                if b["thick_src"] == "measured":
                    a["thick_src"] = "measured"
                a["support"] = (a["support"] * L + b["support"] * lb) / w
                a["p0"] = [a["p0"][0] + ux * lo + nx * shift, a["p0"][1] + uz * lo + nz * shift]
                a["p1"] = [a["p0"][0] + ux * (hi - lo), a["p0"][1] + uz * (hi - lo)]
                pieces.pop(j)
                changed = True
                break
            if changed:
                break
    return pieces


def _near_other(p, others, dist):
    for o in others:
        if o is p:
            continue
        for e in (p["p0"], p["p1"]):
            if _in_rect(e, o, o["thick"] / 2.0 + dist, dist):
                return True
    return False


def _find_door_gaps(walls, cfg):
    """Collinear wall pairs separated by a door-sized gap."""
    gaps = []
    lo, hi = cfg["door_gap_min_m"], cfg["door_gap_max_m"]
    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            a, b = walls[i], walls[j]
            if _ang_diff(a["theta"], b["theta"]) > math.radians(6):
                continue
            best = None
            for ea in (a["p0"], a["p1"]):
                for eb in (b["p0"], b["p1"]):
                    d = _dist(ea, eb)
                    if lo <= d <= hi and (best is None or d < best[0]):
                        best = (d, ea, eb)
            if best is None:
                continue
            d, ea, eb = best
            gx, gz = eb[0] - ea[0], eb[1] - ea[1]
            gl = math.hypot(gx, gz)
            # gap direction must follow the wall direction
            wx, wz = math.cos(a["theta"]), math.sin(a["theta"])
            if abs((gx * wx + gz * wz) / gl) < 0.96:
                continue
            # lateral offset between the two wall axes must be small (truly collinear)
            nx, nz = -wz, wx
            if abs(gx * nx + gz * nz) > 0.10 + 0.5 * abs(a["thick"] - b["thick"]):
                continue
            gaps.append([[ea[0], ea[1]], [eb[0], eb[1]]])
    return gaps


def _verify_gaps(gaps, p_high, p_body, x_min, z_min, gs):
    """
    Keep only gaps that really look like a doorway: a lintel (HIGH points) bridges
    the gap while the body of the opening (LOW/MID) is empty.
    """
    k5 = np.ones((5, 5), np.uint8)
    high = cv2.dilate(p_high.astype(np.uint8), k5)
    body = cv2.dilate(p_body.astype(np.uint8), k5)
    h, w = high.shape
    out = []
    for g in gaps:
        n = max(4, int(_dist(g[0], g[1]) / gs))
        xs = np.linspace(g[0][0], g[1][0], n)
        zs = np.linspace(g[0][1], g[1][1], n)
        lo, hi = int(n * 0.15), max(int(n * 0.15) + 1, int(n * 0.85))
        px = np.clip(((xs[lo:hi] - x_min) / gs).astype(int), 0, w - 1)
        py = np.clip(((zs[lo:hi] - z_min) / gs).astype(int), 0, h - 1)
        if body[py, px].mean() <= 0.25 and high[py, px].mean() >= 0.50:
            out.append(g)
    return out


# ═════════════════════════════════════════════════════════════════════════════
# Debug helpers
# ═════════════════════════════════════════════════════════════════════════════

def _save_png(arr: np.ndarray, path: str) -> None:
    try:
        a = arr.astype(np.float32)
        if a.max() > a.min():
            a = (a - a.min()) / (a.max() - a.min()) * 255.0
        cv2.imwrite(path, cv2.flip(a.astype(np.uint8), 0))
    except Exception:
        pass


def _save_walls_png(base, walls, gaps, x_min, z_min, gs, path):
    """Overlay walls as true-thickness rectangles (blue outline, red centre-line)."""
    try:
        h, w = base.shape[:2]
        rgb = cv2.cvtColor((base > 0).astype(np.uint8) * 90, cv2.COLOR_GRAY2BGR)

        def px(p):
            return ((p[0] - x_min) / gs, (p[1] - z_min) / gs)

        for wl in walls:
            a, b = px(wl["p0"]), px(wl["p1"])
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if L < 1e-6:
                continue
            ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            hw = wl["thick"] / gs / 2.0
            nx, ny = -uy * hw, ux * hw
            poly = np.array([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
                             [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], np.float32)
            col = (255, 160, 0) if wl["thick_src"] == "measured" else (200, 200, 60)
            cv2.polylines(rgb, [poly.astype(np.int32)], True, col, 1)
            cv2.line(rgb, tuple(int(round(v)) for v in a), tuple(int(round(v)) for v in b), (0, 0, 255), 1)
        for g in gaps:
            a, b = px(g[0]), px(g[1])
            cv2.line(rgb, tuple(int(round(v)) for v in a), tuple(int(round(v)) for v in b), (0, 255, 0), 1)
        cv2.imwrite(path, cv2.flip(rgb, 0))
    except Exception:
        pass


# ═════════════════════════════════════════════════════════════════════════════
# Public API
# ═════════════════════════════════════════════════════════════════════════════

def detect_walls_c2b_for_floor(floor_idx: int, config: dict) -> list:
    """
    Variable-thickness wall detection for one floor.

    Config keys (all optional)
    --------------------------
    grid_size            0.02   raster cell, metres
    min_wall_m           0.40   shortest wall piece kept
    max_wall_thickness   0.75   largest thickness considered a single wall (clamp)
    snap_to_axis         True   snap directions within 6° of 0/90° to the axis
    save_debug           True   write debug PNGs
    default_thickness    0.12   thickness assigned to walls seen from one side only
    min_support          0.50   min. fraction of a piece's length backed by real points
    (dp_tolerance / threshold_frac / wall_reach_frac are accepted for API
     compatibility but no longer used.)

    Returns list[[[x1,z1],[x2,z2]]] – wall centre-lines in metres.
    Also writes processed/walls_floor_N.json with per-wall ``thicknesses``.
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.environ.get("PROCESSED_DIR", os.path.join(base_dir, "processed"))
    with open(os.path.join(processed_dir, "info.json")) as fh:
        info = json.load(fh)

    levels = info.get("floor_levels", [])
    if floor_idx >= len(levels):
        raise ValueError(f"Floor index {floor_idx} out of range (info.json has {len(levels)} floor(s)).")
    floor_y = float(levels[floor_idx])

    gs = float(config.get("grid_size", 0.02))
    max_thick = float(config.get("max_wall_thickness", 0.75))
    save_debug = bool(config.get("save_debug", True))
    snap_to_axis = bool(config.get("snap_to_axis", True))
    min_support = float(config.get("min_support", 0.50))
    default_thick = float(config.get("default_thickness", 0.12))

    cfg = {
        # height zones above the local floor (metres)
        "low_lo": 0.15, "low_hi": 0.90, "mid_hi": 1.90,
        "high_lo": 2.00, "high_hi_max": 2.70, "ceiling_margin": 0.40,
        "min_blob_px": 25,
        # morphology (metres)
        "scan_gap_m": 0.14,
        "face_fuse_m": float(config.get("face_fuse_m", min(max_thick, 0.45))),
        "min_run_m": 0.34,
        # profile splitting
        "thickness_tol_m": float(config.get("thickness_tol_m", 0.045)),
        "offset_tol_m": float(config.get("offset_tol_m", 0.08)),
        "min_piece_m": float(config.get("min_piece_m", 0.40)),
        "min_wall_m": float(config.get("min_wall_m", 0.40)),
        # thickness calibration: 3×3 dilation of 5 cm voxel faces inflates by ~this
        "thickness_bias_m": float(config.get("thickness_bias_m", 0.06)),
        "dedupe_dist_m": 0.04,
        "door_gap_min_m": 0.55, "door_gap_max_m": 1.60,
    }
    min_wall_m = cfg["min_wall_m"]

    slice_path = os.path.join(processed_dir, f"wall_slice_floor_{floor_idx}.npy")
    if not os.path.exists(slice_path):
        raise FileNotFoundError(f"wall_slice_floor_{floor_idx}.npy not found. Run preprocess_walls.py first.")
    pts = np.load(slice_path)
    print(f"\n[c2b floor {floor_idx}] loaded slice: {len(pts):,} pts, floor_y={floor_y:+.3f}")

    storey_h = (float(levels[floor_idx + 1]) - floor_y) if floor_idx + 1 < len(levels) else 3.0
    storey_h = max(storey_h, 2.4)

    local_floor = _local_floor(pts, floor_y, info, processed_dir, floor_idx)
    rel_h = pts[:, 1] - local_floor

    # only points inside the evidence range matter
    keep = (rel_h >= cfg["low_lo"]) & (rel_h < storey_h)
    pts, rel_h = pts[keep], rel_h[keep]
    if len(pts) < 50:
        print(f"[c2b floor {floor_idx}] too few points — skipping")
        _write_empty(floor_idx, processed_dir, gs)
        return []

    # ── grid ────────────────────────────────────────────────────────────
    x_min, z_min = float(pts[:, 0].min()) - 0.2, float(pts[:, 2].min()) - 0.2
    x_max, z_max = float(pts[:, 0].max()) + 0.2, float(pts[:, 2].max()) + 0.2
    MAX_DIM = 4096
    gs = max(gs, (x_max - x_min) / MAX_DIM, (z_max - z_min) / MAX_DIM)
    width = int(math.ceil((x_max - x_min) / gs))
    height = int(math.ceil((z_max - z_min) / gs))
    print(f"[c2b floor {floor_idx}] grid {width}×{height} @ {gs * 100:.1f} cm")

    # Partially scanned storey (e.g. attic / cut-off cloud): squeeze the zones into
    # the height range that actually contains data.
    top = float(np.percentile(rel_h, 99.5))
    if top < cfg["high_lo"] + 0.3:
        top = max(top, 0.8)
        print(f"[c2b floor {floor_idx}] low scan height ({top:.2f} m) - scaling height zones")
        cfg["low_hi"] = 0.30 * top
        cfg["mid_hi"] = 0.60 * top
        cfg["high_lo"] = 0.65 * top
        cfg["high_hi_max"] = top + 0.05
        cfg["ceiling_margin"] = -10.0       # no ceiling cut-off
        cfg["low_lo"] = min(cfg["low_lo"], 0.10 * top)

    wall, density, p_low, p_mid, p_high, zones = _wall_evidence(
        pts, rel_h, storey_h, gs, x_min, z_min, width, height, cfg)
    print(f"[c2b floor {floor_idx}] zones LOW{zones[0]} MID{zones[1]} HIGH{tuple(round(z, 2) for z in zones[2])}"
          f" → wall pixels {int(wall.sum()):,}")

    # ── directions ──────────────────────────────────────────────────────
    thetas = _dominant_directions(wall, gs, 1.0 if snap_to_axis else 0.0)
    print(f"[c2b floor {floor_idx}] directions: {[round(math.degrees(t), 1) for t in thetas]}")

    pieces: list[dict] = []
    for th in thetas:
        got = _extract_direction(wall, th, gs, x_min, z_min, cfg)
        print(f"[c2b floor {floor_idx}]   θ={math.degrees(th):6.1f}°: {len(got)} pieces")
        pieces.extend(got)

    # ── thickness: measured vs. default, clamp ──────────────────────────
    for p in pieces:
        tr = p["thick_raw"]
        if tr < 0.07:      # single scanned face → true thickness unknown
            p["thick"], p["thick_src"] = default_thick, "default"
        else:
            p["thick"], p["thick_src"] = float(min(tr, max_thick)), "measured"

    # ── support filter ──────────────────────────────────────────────────
    n0 = len(pieces)
    pieces = [p for p in pieces if p["support"] >= min_support]
    print(f"[c2b floor {floor_idx}] support filter: {n0} → {len(pieces)}")

    # ── stitch scan-gap fragments, then dedupe (walls inside walls) ─────
    pieces = _merge_collinear(pieces, cfg)
    print(f"[c2b floor {floor_idx}] after collinear merge: {len(pieces)}")
    pieces = _dedupe(pieces, cfg)
    pieces = _merge_collinear(pieces, cfg)
    print(f"[c2b floor {floor_idx}] after de-duplication: {len(pieces)}")

    # ── drop isolated stubs (not touching anything, short) ──────────────
    min_iso = max(min_wall_m, float(config.get("min_isolated_m", 0.9)))
    pieces = [p for p in pieces if _piece_len(p) >= min_iso or _near_other(p, pieces, 0.30)]
    print(f"[c2b floor {floor_idx}] after isolated-stub filter: {len(pieces)}")

    gaps = _find_door_gaps(pieces, cfg)
    n_cand = len(gaps)
    gaps = _verify_gaps(gaps, p_high, p_low | p_mid, x_min, z_min, gs)
    print(f"[c2b floor {floor_idx}] door gaps: {len(gaps)} (of {n_cand} candidates)")

    # stable ordering: by position
    pieces.sort(key=lambda p: (round(p["p0"][1], 1), round(p["p0"][0], 1)))

    if save_debug:
        dbg = os.path.join(processed_dir, f"debug_c2b_floor{floor_idx}")
        _save_png(density, f"{dbg}_1_density.png")
        _save_png(wall, f"{dbg}_2_binary.png")
        _save_walls_png(wall, pieces, gaps, x_min, z_min, gs, f"{dbg}_5_wall_axes.png")

    real_lines = [[[float(p["p0"][0]), float(p["p0"][1])], [float(p["p1"][0]), float(p["p1"][1])]] for p in pieces]
    result = {
        "floor_idx": int(floor_idx),
        "grid_size": float(gs),
        "x_min": float(x_min),
        "z_min": float(z_min),
        "source": f"cloud2bim-c2b-v2 ({len(real_lines)} walls)",
        "lines": real_lines,
        "thicknesses": [round(float(p["thick"]), 3) for p in pieces],
        "thickness_source": [p["thick_src"] for p in pieces],
        "door_gaps": gaps,
    }
    with open(os.path.join(processed_dir, f"walls_floor_{floor_idx}.json"), "w") as fh:
        json.dump(result, fh, default=_json_default)

    ts = [p["thick"] for p in pieces if p["thick_src"] == "measured"]
    if ts:
        print(f"[c2b floor {floor_idx}] measured thickness: min={min(ts):.2f} median={float(np.median(ts)):.2f} max={max(ts):.2f}")
    print(f"[c2b floor {floor_idx}] final walls: {len(real_lines)}")
    return real_lines


# ── Internal utility ──────────────────────────────────────────────────────────

def _write_empty(floor_idx: int, processed_dir: str, grid_size: float) -> None:
    with open(os.path.join(processed_dir, f"walls_floor_{floor_idx}.json"), "w") as fh:
        json.dump({
            "floor_idx": int(floor_idx), "grid_size": float(grid_size),
            "x_min": 0.0, "z_min": 0.0, "source": "empty-c2b",
            "lines": [], "thicknesses": [], "thickness_source": [], "door_gaps": [],
        }, fh, default=_json_default)
