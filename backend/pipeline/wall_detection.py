import os
import struct
import json
import numpy as np
import cv2

def load_slice(bin_path, y_min, y_max):
    with open(bin_path, 'rb') as f:
        buf = f.read()
    N = struct.unpack('<I', buf[:4])[0]
    pos = np.frombuffer(buf, dtype=np.float32, count=N*3, offset=4).reshape(N, 3)
    
    mask = (pos[:, 1] >= y_min) & (pos[:, 1] <= y_max)
    return pos[mask]

def snap_lines_to_manhattan(lines, angle_tolerance=10.0):
    snapped = []
    tol_rad = np.radians(angle_tolerance)
    
    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = x2 - x1
        dy = y2 - y1
        angle = np.abs(np.arctan2(dy, dx))
        
        is_horiz = (angle < tol_rad) or (np.abs(angle - np.pi) < tol_rad)
        is_vert = np.abs(angle - np.pi/2) < tol_rad
        
        if is_horiz:
            avg_y = int(np.round((y1 + y2) / 2))
            snapped.append([[x1, avg_y, x2, avg_y]])
        elif is_vert:
            avg_x = int(np.round((x1 + x2) / 2))
            snapped.append([[avg_x, y1, avg_x, y2]])
        else:
            snapped.append([[x1, y1, x2, y2]])
            
    return np.array(snapped)

def _segment_length(seg):
    """Euclidean length of a [[x1,z1],[x2,z2]] segment in metres."""
    dx = seg[1][0] - seg[0][0]
    dz = seg[1][1] - seg[0][1]
    return (dx*dx + dz*dz) ** 0.5


def merge_collinear_segments(lines_px, gap_px=15, angle_tolerance=5.0):
    """
    Merge line segments that are nearly collinear and close together.
    Works in pixel space. Returns merged list.
    """
    if len(lines_px) == 0:
        return lines_px

    from itertools import combinations

    tol = np.radians(angle_tolerance)
    merged = list(lines_px)

    changed = True
    while changed:
        changed = False
        used = [False] * len(merged)
        result = []

        for i in range(len(merged)):
            if used[i]:
                continue
            x1, y1, x2, y2 = merged[i][0]
            ang_i = np.arctan2(y2 - y1, x2 - x1)
            group = [merged[i][0]]

            for j in range(i + 1, len(merged)):
                if used[j]:
                    continue
                x3, y3, x4, y4 = merged[j][0]
                ang_j = np.arctan2(y4 - y3, x4 - x3)

                # Angle similar?
                da = abs(ang_i - ang_j) % np.pi
                if da > tol and abs(da - np.pi) > tol:
                    continue

                # Gap small enough?
                # Check min distance between the two segments (endpoint heuristic)
                pts = [(x1,y1),(x2,y2),(x3,y3),(x4,y4)]
                min_gap = min(
                    ((a[0]-b[0])**2+(a[1]-b[1])**2)**0.5
                    for a in pts[:2] for b in pts[2:]
                )
                if min_gap > gap_px:
                    continue

                group.extend([(x3,y3),(x4,y4)])
                used[j] = True
                changed = True

            # Fit a single segment spanning all grouped points
            if len(group) > 2:
                all_x = [p[0] for p in group]
                all_y = [p[1] for p in group]
                result.append([[min(all_x), min(all_y), max(all_x), max(all_y)]])
            else:
                result.append([[x1, y1, x2, y2]])

        merged = result

    return merged


def detect_walls_for_floor(floor_idx: int, config):
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    processed_dir = os.path.join(base_dir, 'processed')
    bin_path = os.path.join(processed_dir, 'pointcloud.bin')
    info_path = os.path.join(processed_dir, 'info.json')

    with open(info_path, 'r') as f:
        info = json.load(f)

    levels = info.get('floor_levels', [])
    if floor_idx >= len(levels):
        raise ValueError(f"Floor {floor_idx} not found.")

    # Slice from floor level +0.3m to +2.2m (skip floor clutter and ceiling)
    y_min = levels[floor_idx] + 0.3
    y_max = levels[floor_idx] + 2.2

    slice_pos = load_slice(bin_path, y_min, y_max)
    if len(slice_pos) == 0:
        return []

    xz = slice_pos[:, [0, 2]]
    x_min, z_min = np.min(xz, axis=0)
    x_max, z_max = np.max(xz, axis=0)

    grid_size = config.get('grid_size', 0.05)
    width  = int(np.ceil((x_max - x_min) / grid_size))
    height = int(np.ceil((z_max - z_min) / grid_size))

    img = np.zeros((height, width), dtype=np.int32)
    px  = np.clip(np.round((xz[:, 0] - x_min) / grid_size).astype(int), 0, width  - 1)
    py  = np.clip(np.round((xz[:, 1] - z_min) / grid_size).astype(int), 0, height - 1)
    np.add.at(img, (py, px), 1)

    # Require ≥3 points per cell to count as solid wall
    binary = np.where(img >= 3, 255, 0).astype(np.uint8)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    edges  = cv2.Canny(closed, 50, 150, apertureSize=3)

    # minLineLength: 0.8 m minimum wall segment to ignore furniture / trees
    min_len_px = max(8, int(0.8 / grid_size))
    max_gap_px = max(5, int(0.3 / grid_size))

    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180,
        threshold=40,
        minLineLength=min_len_px,
        maxLineGap=max_gap_px
    )

    if lines is None:
        return []

    # Merge collinear close segments (reduces duplicate parallel lines)
    lines = merge_collinear_segments(list(lines), gap_px=max_gap_px * 2)

    if config.get('snap_to_axis', True):
        lines = snap_lines_to_manhattan(lines, angle_tolerance=10.0)

    # Convert pixel → metric, filter by minimum real-world length
    real_lines = []
    min_real_m = 0.8  # reject walls shorter than 0.8 m
    for line in lines:
        x1_px, y1_py, x2_px, y2_py = line[0]
        rx1 = float(x1_px * grid_size + x_min)
        rz1 = float(y1_py * grid_size + z_min)
        rx2 = float(x2_px * grid_size + x_min)
        rz2 = float(y2_py * grid_size + z_min)
        seg = [[rx1, rz1], [rx2, rz2]]
        if _segment_length(seg) >= min_real_m:
            real_lines.append(seg)

    out_path = os.path.join(processed_dir, f'walls_floor_{floor_idx}.json')
    result = {
        'floor_idx': floor_idx,
        'grid_size': grid_size,
        'x_min': float(x_min),
        'z_min': float(z_min),
        'lines': real_lines
    }
    with open(out_path, 'w') as f:
        json.dump(result, f)

    return real_lines
