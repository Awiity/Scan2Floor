/**
 * FloorPlanViewer.jsx — Interactive HTML5 Canvas Floor Plan Renderer + Editor
 *
 * Rendering:  wall vectors, room fills, opening symbols, scale bar, compass
 * Editing:    Pan/Add Wall/Delete Wall/Hide modes, snap-to-endpoint, undo/redo,
 *             save edits to backend (auto re-runs room detection)
 *
 * Dark-mode palette
 *   background   #070b18   walls     #00c8e0  (cyan)
 *   grid         #0a2050   algo wall #00c8e0  user wall #fbbf24 (amber)
 *   doors        #fbbf24   windows   #818cf8  hovered   #ff6b6b (red)
 *   hidden wall  #4a5568  (slate-grey, dashed, excluded from room recalc)
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Colour constants — theme-aware ────────────────────────────────────────────
// Returns a palette matching the current data-theme on the root .app element.
function getTheme() {
  const isDark = !document.querySelector('[data-theme="light"]');
  return isDark ? {
    bg:          "#0f0f0f",
    gridLine:    "#1e1e1e",
    wall:        "#00c8e0",      wallGlow: "rgba(0,200,224,0.18)",
    wallUser:    "#fbbf24",      wallUserGlow: "rgba(251,191,36,0.20)",
    wallHover:   "#ff6b6b",     wallHoverGlow: "rgba(255,107,107,0.25)",
    wallHidden:  "#4a6080",     wallHiddenGlow: "rgba(74,96,128,0.15)",
    wallPreview: "#fbbf24",
    door:        "#fbbf24",
    window:      "#818cf8",
    snapEp:      "#fbbf24",
    snapGrid:    "rgba(200,220,255,0.5)",
    roomFills: [
      "rgba(0,200,224,0.07)","rgba(129,140,248,0.07)",
      "rgba(251,191,36,0.07)","rgba(52,211,153,0.07)",
      "rgba(251,113,133,0.07)","rgba(167,139,250,0.07)",
      "rgba(34,211,238,0.07)","rgba(251,146,60,0.07)",
      "rgba(74,222,128,0.07)","rgba(248,113,113,0.07)",
    ],
    roomBorder:  "rgba(255,255,255,0.08)",
    labelRoom:   "rgba(200,230,255,0.6)",
    scaleStroke: "rgba(255,255,255,0.6)",
    scaleFill:   "rgba(255,255,255,0.7)",
  } : {
    bg:          "#f5f5f5",
    gridLine:    "#e0e0e0",
    wall:        "#0066cc",      wallGlow: "rgba(0,102,204,0.12)",
    wallUser:    "#d97706",      wallUserGlow: "rgba(217,119,6,0.15)",
    wallHover:   "#dc2626",     wallHoverGlow: "rgba(220,38,38,0.18)",
    wallHidden:  "#94a3b8",     wallHiddenGlow: "rgba(148,163,184,0.12)",
    wallPreview: "#d97706",
    door:        "#d97706",
    window:      "#6366f1",
    snapEp:      "#d97706",
    snapGrid:    "rgba(30,60,120,0.35)",
    roomFills: [
      "rgba(0,102,204,0.07)","rgba(99,102,241,0.07)",
      "rgba(217,119,6,0.07)","rgba(22,163,74,0.07)",
      "rgba(220,38,38,0.07)","rgba(124,58,237,0.07)",
      "rgba(6,182,212,0.07)","rgba(234,88,12,0.07)",
      "rgba(74,222,128,0.07)","rgba(248,113,113,0.07)",
    ],
    roomBorder:  "rgba(0,0,0,0.06)",
    labelRoom:   "rgba(30,50,80,0.7)",
    scaleStroke: "rgba(0,0,0,0.55)",
    scaleFill:   "rgba(0,0,0,0.65)",
  };
}

// Legacy alias used in non-canvas JSX parts (badge colours etc.)
const C = {
  wall:       "#00c8e0",
  wallUser:   "#fbbf24",
  wallHover:  "#ff6b6b",
  wallHidden: "#4a6080",
  door:       "#fbbf24",
  window:     "#818cf8",
  snapEp:     "#fbbf24",
  snapGrid:   "rgba(200,220,255,0.5)",
  roomFills: [
    "rgba(0,200,224,0.07)","rgba(129,140,248,0.07)",
    "rgba(251,191,36,0.07)","rgba(52,211,153,0.07)",
    "rgba(251,113,133,0.07)","rgba(167,139,250,0.07)",
    "rgba(34,211,238,0.07)","rgba(251,146,60,0.07)",
    "rgba(74,222,128,0.07)","rgba(248,113,113,0.07)",
  ],
  roomBorder: "rgba(255,255,255,0.08)",
  labelRoom:  "rgba(200,230,255,0.6)",
};

// ── Coordinate utilities ───────────────────────────────────────────────────────

function toCanvas(wx, wz, cam) {
  return [cam.ox + wx * cam.scale, cam.oy + wz * cam.scale];
}

function toWorld(cx, cy, cam) {
  return [(cx - cam.ox) / cam.scale, (cy - cam.oy) / cam.scale];
}

function wallsBoundsFromEdited(editedLines) {
  if (!editedLines || editedLines.length === 0)
    return { xMin: -25, xMax: 25, zMin: -25, zMax: 25 };
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const { pts: [[x1, z1], [x2, z2]] } of editedLines) {
    xMin = Math.min(xMin, x1, x2); xMax = Math.max(xMax, x1, x2);
    zMin = Math.min(zMin, z1, z2); zMax = Math.max(zMax, z1, z2);
  }
  return { xMin, xMax, zMin, zMax };
}

function fitCamera(bounds, canvasW, canvasH, padding = 0.05) {
  const bw = bounds.xMax - bounds.xMin, bh = bounds.zMax - bounds.zMin;
  if (bw === 0 || bh === 0) return { scale: 8, ox: canvasW / 2, oy: canvasH / 2 };
  const px = canvasW * padding, py = canvasH * padding;
  const scale = Math.min((canvasW - 2 * px) / bw, (canvasH - 2 * py) / bh);
  const cx = (bounds.xMin + bounds.xMax) / 2, cz = (bounds.zMin + bounds.zMax) / 2;
  return { scale, ox: canvasW / 2 - cx * scale, oy: canvasH / 2 - cz * scale };
}

// ── Geometry helpers for editing ───────────────────────────────────────────────

function distPointToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - x1, pz - z1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

/** Snap world point to nearest endpoint (within pixThresh px) or 0.5m grid. */
function computeSnap(wx, wz, editedLines, cam, pixThresh = 14) {
  const worldThresh = pixThresh / cam.scale;
  let best = worldThresh, snapped = null;
  for (const { pts: [[x1, z1], [x2, z2]] } of editedLines) {
    const d1 = Math.hypot(wx - x1, wz - z1);
    const d2 = Math.hypot(wx - x2, wz - z2);
    if (d1 < best) { best = d1; snapped = { pt: [x1, z1], kind: "endpoint" }; }
    if (d2 < best) { best = d2; snapped = { pt: [x2, z2], kind: "endpoint" }; }
  }
  if (snapped) return snapped;
  const g = 0.5;
  return { pt: [Math.round(wx / g) * g, Math.round(wz / g) * g], kind: "grid" };
}

/**
 * Projects (wx, wz) onto the nearest 45° axis emanating from (fromX, fromZ).
 * Returns { pt, angle, dist } — the constrained world point, the snapped angle
 * in radians, and the distance from fromX/fromZ.
 */
function applyAngleConstraint(wx, wz, fromX, fromZ) {
  const dx = wx - fromX, dz = wz - fromZ;
  const raw = Math.atan2(dz, dx);
  const snapAngle = Math.round(raw / (Math.PI / 4)) * (Math.PI / 4);
  const dist = Math.hypot(dx, dz);
  return {
    pt:    [fromX + Math.cos(snapAngle) * dist, fromZ + Math.sin(snapAngle) * dist],
    angle: snapAngle,
    dist,
  };
}

/**
 * Like computeSnap but after applying an angle constraint from `fromPt`.
 * Endpoint snapping is restricted to points within `epPixThresh` of the
 * constrained ray (so you can still snap-to-endpoint along the axis).
 */
function computeSnapConstrained(wx, wz, editedLines, cam, fromX, fromZ, pixThresh = 14) {
  const { pt: [cx, cz], angle, dist } = applyAngleConstraint(wx, wz, fromX, fromZ);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  // Try to find an endpoint close to the constrained ray
  const worldEpThresh = pixThresh / cam.scale;
  let bestEp = worldEpThresh, epPt = null;
  for (const { pts: [[x1, z1], [x2, z2]] } of editedLines) {
    for (const [ex, ez] of [[x1, z1], [x2, z2]]) {
      // Project endpoint onto the constrained axis
      const tPt = (ex - fromX) * cosA + (ez - fromZ) * sinA; // scalar along ray
      if (tPt < 0) continue; // behind start point
      const projX = fromX + tPt * cosA;
      const projZ = fromZ + tPt * sinA;
      const perpDist = Math.hypot(ex - projX, ez - projZ);
      if (perpDist < worldEpThresh && perpDist < bestEp) {
        // Snap to the endpoint projected onto the ray (keeps the angle exact)
        bestEp = perpDist;
        epPt = [projX, projZ]; // stay on the constrained axis
      }
    }
  }
  const finalPt = epPt ?? cx !== undefined ? (epPt ?? [cx, cz]) : [cx, cz];
  // Grid-snap along the constrained ray when no endpoint found
  let snappedPt;
  if (epPt) {
    snappedPt = epPt;
  } else {
    const g = 0.5;
    const tSnapped = Math.round(dist / g) * g;
    snappedPt = [fromX + Math.cos(angle) * tSnapped, fromZ + Math.sin(angle) * tSnapped];
  }
  return {
    pt:   snappedPt,
    kind: epPt ? "endpoint" : "angle",
    angle,
    dist: Math.hypot(snappedPt[0] - fromX, snappedPt[1] - fromZ),
    fromPt: [fromX, fromZ],
  };
}

/** Find index of line closest to (wx,wz) within pixThresh px, or -1. */
function findNearestLine(wx, wz, editedLines, cam, pixThresh = 10) {
  const worldThresh = pixThresh / cam.scale;
  let best = worldThresh, idx = -1;
  for (let i = 0; i < editedLines.length; i++) {
    const [[x1, z1], [x2, z2]] = editedLines[i].pts;
    const d = distPointToSeg(wx, wz, x1, z1, x2, z2);
    if (d < best) { best = d; idx = i; }
  }
  return idx;
}

/**
 * Returns true if segment (x1,z1)→(x2,z2) intersects or lies within the
 * axis-aligned world-space rectangle [rxMin,rxMax] × [rzMin,rzMax].
 */
function segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax) {
  // Both endpoints inside? → fully contained
  const p1In = x1 >= rxMin && x1 <= rxMax && z1 >= rzMin && z1 <= rzMax;
  const p2In = x2 >= rxMin && x2 <= rxMax && z2 >= rzMin && z2 <= rzMax;
  if (p1In || p2In) return true;
  // Cohen-Sutherland clip test — check if segment crosses any of the 4 edges
  const dx = x2 - x1, dz = z2 - z1;
  const tests = [
    [rzMin, dz, z1, dx, x1, rxMin, rxMax],   // bottom edge (z = rzMin)
    [rzMax, dz, z1, dx, x1, rxMin, rxMax],   // top edge
    [rxMin, dx, x1, dz, z1, rzMin, rzMax],   // left edge
    [rxMax, dx, x1, dz, z1, rzMin, rzMax],   // right edge
  ];
  for (const [edge, dPar, startPar, dPerp, startPerp, perpMin, perpMax] of tests) {
    if (dPar === 0) continue;
    const t = (edge - startPar) / dPar;
    if (t < 0 || t > 1) continue;
    const perp = startPerp + t * dPerp;
    if (perp >= perpMin && perp <= perpMax) return true;
  }
  return false;
}

// ── Draw functions ─────────────────────────────────────────────────────────────

/** Draw the drag-selection box overlay (canvas-space coords). */
function drawBoxSelect(ctx, box, mode) {
  if (!box) return;
  const { cx1, cy1, cx2, cy2 } = box;
  const x = Math.min(cx1, cx2), y = Math.min(cy1, cy2);
  const w = Math.abs(cx2 - cx1), h = Math.abs(cy2 - cy1);
  if (w < 2 && h < 2) return;
  const isDelete = mode === "delete";
  const strokeCol = isDelete ? "rgba(255,80,80,0.9)"   : "rgba(74,160,220,0.9)";
  const fillCol   = isDelete ? "rgba(255,60,60,0.08)"  : "rgba(74,140,220,0.08)";
  const glowCol   = isDelete ? "rgba(255,80,80,0.25)"  : "rgba(74,160,220,0.25)";
  ctx.save();
  // Glow layer
  ctx.strokeStyle = glowCol;
  ctx.lineWidth = 4;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h);
  // Fill
  ctx.fillStyle = fillCol;
  ctx.fillRect(x, y, w, h);
  // Sharp border
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = strokeCol;
  ctx.shadowBlur = 6;
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  // Corner ticks
  const tick = 8;
  ctx.shadowBlur = 0;
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 2;
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  const dirs = [[ 1, 1], [-1, 1], [ 1,-1], [-1,-1]];
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = corners[i];
    const [dx, dy] = dirs[i];
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * tick, cy);
    ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + dy * tick);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGrid(ctx, cam, w, h, TC) {
  const step = 5 * cam.scale;
  if (step < 10) return;
  ctx.save();
  ctx.strokeStyle = TC.gridLine; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.5;
  let x = ((cam.ox % step) + step) % step;
  for (; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  let y = ((cam.oy % step) + step) % step;
  for (; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.restore();
}

function drawRooms(ctx, rooms, cam, highlightedRoomId, TC) {
  if (!rooms?.length) return;
  const hasHighlight = highlightedRoomId != null;
  ctx.save();
  for (const room of rooms) {
    const isHighlighted = room.id === highlightedRoomId;
    const baseAlpha = isHighlighted ? 0.30 : hasHighlight ? 0.03 : 0.07;
    const fill = TC.roomFills[room.id % TC.roomFills.length].replace(/[\d.]+\)$/, `${baseAlpha})`);

    // Build the room boundary path — prefer true polygon, fall back to bbox rect
    ctx.beginPath();
    const poly = room.polygon;
    if (poly && poly.length >= 3) {
      const [sx, sy] = toCanvas(poly[0][0], poly[0][1], cam);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < poly.length; i++) {
        const [px, py] = toCanvas(poly[i][0], poly[i][1], cam);
        ctx.lineTo(px, py);
      }
    } else {
      // Legacy fallback: bounding-box rectangle
      const { x_min, z_min, x_max, z_max } = room.bbox;
      const [cx1, cy1] = toCanvas(x_min, z_min, cam);
      const [cx2, cy2] = toCanvas(x_max, z_max, cam);
      ctx.rect(cx1, cy1, cx2 - cx1, cy2 - cy1);
    }
    ctx.closePath();

    ctx.fillStyle = fill;
    ctx.fill();

    if (isHighlighted) {
      ctx.save();
      ctx.strokeStyle = TC.wall;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = TC.wall;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = TC.roomBorder;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    const fontSize = Math.max(9, Math.min(13, cam.scale * 0.7));
    if (cam.scale > 3) {
      const [centX, centY] = toCanvas(room.centroid_x, room.centroid_z, cam);
      ctx.font = `${fontSize}px "Inter", sans-serif`;
      ctx.fillStyle = isHighlighted ? TC.wall : TC.labelRoom;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`R${room.id}  ${room.area_m2.toFixed(1)} m²`, centX, centY);
    }
  }
  ctx.restore();
}

function drawEditedWalls(ctx, editedLines, cam, hoveredIdx, addStart, snapInfo, editMode, TC) {
  // Thinner lines — scale * 0.09 (was 0.18), min 1px
  const lw = Math.max(1.0, cam.scale * 0.09);

  // Draw hidden walls first (below active walls)
  for (let i = 0; i < editedLines.length; i++) {
    const line = editedLines[i];
    if (!line.hidden) continue;
    const [[x1, z1], [x2, z2]] = line.pts;
    const isHovered = i === hoveredIdx && (editMode === "delete" || editMode === "hide");
    const color = isHovered ? TC.wallHover : TC.wallHidden;
    const glow  = isHovered ? TC.wallHoverGlow : TC.wallHiddenGlow;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save();
    ctx.globalAlpha = isHovered ? 0.85 : 0.45;
    ctx.lineCap = "round";
    if (!isHovered) ctx.setLineDash([5, 6]);
    ctx.strokeStyle = glow; ctx.lineWidth = lw + 5;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = isHovered ? lw * 1.8 : lw;
    ctx.shadowColor = color; ctx.shadowBlur = isHovered ? 8 : 2;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Draw visible walls on top
  for (let i = 0; i < editedLines.length; i++) {
    const line = editedLines[i];
    if (line.hidden) continue;
    const { pts: [[x1, z1], [x2, z2]], source } = line;
    const isHovered = i === hoveredIdx && (editMode === "delete" || editMode === "hide");
    const color     = isHovered ? TC.wallHover : source === "user" ? TC.wallUser : TC.wall;
    const glow      = isHovered ? TC.wallHoverGlow : source === "user" ? TC.wallUserGlow : TC.wallGlow;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = glow; ctx.lineWidth = lw + 6;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = isHovered ? lw * 2 : lw;
    ctx.shadowColor = color; ctx.shadowBlur = isHovered ? 10 : 3;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.restore();
  }

  // In-progress wall preview (add mode with first point placed)
  if (editMode === "add" && addStart && snapInfo) {
    const [ax, az] = addStart, [sx, sz] = snapInfo.pt;
    const [cax, cay] = toCanvas(ax, az, cam), [csx, csy] = toCanvas(sx, sz, cam);

    // ── Angle-constraint ghost guide line ───────────────────────────────────
    if (snapInfo.kind === "angle" || snapInfo.kind === "endpoint" && snapInfo.angle != null) {
      const angle = snapInfo.angle;
      // Extend the axis line far beyond the canvas in both directions
      const FAR = 4000;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      // Convert axis direction to canvas scale
      const cdx = cosA * cam.scale, cdz = sinA * cam.scale;
      ctx.save();
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = TC.wall + "30";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cax - cdx * FAR, cay - cdz * FAR);
      ctx.lineTo(cax + cdx * FAR, cay + cdz * FAR);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Angle badge (e.g. "90°  4.5 m")
      const angleDeg = Math.round(((angle * 180 / Math.PI) % 360 + 360) % 360);
      const dist = snapInfo.dist ?? Math.hypot(sx - ax, sz - az);
      const label = `${angleDeg}°  ${dist.toFixed(2)} m`;
      // Position label near the cursor
      const midCx = (cax + csx) / 2, midCy = (cay + csy) / 2;
      ctx.save();
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(20,20,20,0.85)" : "rgba(245,245,245,0.9)";
      ctx.fillRect(midCx - tw / 2 - 5, midCy - 9, tw + 10, 18);
      ctx.fillStyle = TC.wall;
      ctx.fillText(label, midCx, midCy);
      ctx.restore();
    } else {
      // Free snap — show length readout
      const dist = Math.hypot(sx - ax, sz - az);
      if (dist > 0.01) {
        const rawAngle = Math.atan2(sz - az, sx - ax);
        const angleDeg = Math.round(((rawAngle * 180 / Math.PI) % 360 + 360) % 360);
        const label = `${angleDeg}°  ${dist.toFixed(2)} m`;
        const midCx = (cax + csx) / 2, midCy = (cay + csy) / 2;
        ctx.save();
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(20,20,20,0.85)" : "rgba(245,245,245,0.9)";
        ctx.fillRect(midCx - tw / 2 - 4, midCy - 8, tw + 8, 16);
        ctx.fillStyle = TC.wallUser;
        ctx.fillText(label, midCx, midCy);
        ctx.restore();
      }
    }

    // Wall preview line
    ctx.save();
    ctx.setLineDash([6, 4]); ctx.lineCap = "round";
    ctx.strokeStyle = TC.wallPreview; ctx.lineWidth = lw;
    ctx.shadowColor = TC.wallPreview; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(cax, cay); ctx.lineTo(csx, csy); ctx.stroke();
    ctx.setLineDash([]);
    // Start point dot
    ctx.fillStyle = TC.wallPreview;
    ctx.beginPath(); ctx.arc(cax, cay, Math.max(3, lw * 1.5), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Snap indicator
  if (snapInfo && editMode !== "select") {
    const [sx, sz] = snapInfo.pt;
    const [csx, csy] = toCanvas(sx, sz, cam);
    const isAngle = snapInfo.kind === "angle";
    const r = snapInfo.kind === "endpoint" ? 7 : 5;
    const color = snapInfo.kind === "endpoint" ? TC.snapEp : isAngle ? TC.wall : TC.snapGrid;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = snapInfo.kind === "endpoint" ? 2 : 1;
    const cross = r + 4;
    ctx.beginPath();
    ctx.moveTo(csx - cross, csy); ctx.lineTo(csx + cross, csy);
    ctx.moveTo(csx, csy - cross); ctx.lineTo(csx, csy + cross);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(csx, csy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// Low-confidence threshold must match backend LOW_CONFIDENCE_THRESHOLD
const LOW_CONF_THRESHOLD = 0.45;

function drawDoor(ctx, op, cam) {
  const lowConf = (op.confidence ?? 1) < LOW_CONF_THRESHOLD;
  const colour  = lowConf ? "#fbbf24" : C.door;   // amber vs green
  const lw      = Math.max(1, cam.scale * 0.08);
  const [cx, cy] = toCanvas(op.x, op.z, cam);
  const [hx, hy] = toCanvas(op.hinge_x, op.hinge_z, cam);
  const radius   = Math.hypot(cx - hx, cy - hy);
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth   = lw;
  if (lowConf) ctx.setLineDash([5, 4]);
  ctx.shadowColor = colour; ctx.shadowBlur = lowConf ? 3 : 6;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(cx, cy); ctx.stroke();
  const a0 = Math.atan2(cy - hy, cx - hx);
  ctx.beginPath(); ctx.arc(hx, hy, radius, a0, a0 + Math.PI / 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.arc(hx, hy, Math.max(2, cam.scale * 0.06), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawWindow(ctx, op, cam) {
  const lowConf  = (op.confidence ?? 1) < LOW_CONF_THRESHOLD;
  const colour   = lowConf ? "#fbbf24" : C.window;  // amber vs indigo
  const [cx1, cz1] = toCanvas(op.wall_x1, op.wall_z1, cam);
  const [cx2, cz2] = toCanvas(op.wall_x2, op.wall_z2, cam);
  const dx = cx2 - cx1, dz = cz2 - cz1;
  const t1 = op.u_start / op.wall_len, t2 = op.u_end / op.wall_len;
  const wx1 = cx1 + dx * t1, wy1 = cz1 + dz * t1;
  const wx2 = cx1 + dx * t2, wy2 = cz1 + dz * t2;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth   = Math.max(1.5, cam.scale * 0.12);
  ctx.setLineDash(lowConf ? [3, 4] : [4, 3]);
  ctx.shadowColor = colour; ctx.shadowBlur = lowConf ? 2 : 4;
  ctx.beginPath(); ctx.moveTo(wx1, wy1); ctx.lineTo(wx2, wy2); ctx.stroke();
  ctx.restore();
}

function drawOpenings(ctx, openings, cam) {
  if (!openings?.length) return;
  // Draw high-confidence openings first so low-conf amber sits on top
  const sorted = [...openings].sort((a, b) =>
    ((b.confidence ?? 1) >= LOW_CONF_THRESHOLD ? 1 : 0) -
    ((a.confidence ?? 1) >= LOW_CONF_THRESHOLD ? 1 : 0)
  );
  for (const op of sorted) {
    if (op.type === "door")   drawDoor(ctx, op, cam);
    if (op.type === "window") drawWindow(ctx, op, cam);
  }
}

function drawScale(ctx, cam, w, h, TC) {
  const candidates = [1, 2, 5, 10, 20];
  let chosen = 5;
  for (const c of candidates) { if (c * cam.scale >= 80) { chosen = c; break; } }
  const barPx = chosen * cam.scale, bx = 20, by = h - 28;
  ctx.save();
  ctx.strokeStyle = TC.scaleStroke; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
  ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
  ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4);
  ctx.stroke();
  ctx.fillStyle = TC.scaleFill;
  ctx.font = '11px "Inter", sans-serif'; ctx.textAlign = "center";
  ctx.fillText(`${chosen} m`, bx + barPx / 2, by - 8);
  ctx.restore();
}

function drawCompass(ctx, w) {
  const cx = w - 30, cy = 30, r = 14;
  ctx.save();
  ctx.font = 'bold 10px "Inter", sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#ef4444";
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath(); ctx.moveTo(cx, cy + r); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#ef4444";
  ctx.fillText("N", cx, cy - r - 9);
  ctx.restore();
}

// ── EditToolbar ────────────────────────────────────────────────────────────────

const TOOLS = [
  { id: "select", icon: "✋", label: "Pan",       key: "S", title: "Pan & Zoom (S)" },
  { id: "add",    icon: "✏️",  label: "Add Wall",  key: "A", title: "Add Wall (A)" },
  { id: "delete", icon: "✂️",  label: "Delete",    key: "D", title: "Delete Wall (D)" },
  { id: "hide",   icon: "👁",  label: "Hide",      key: "H", title: "Hide/Show Wall (H) — hides from room recalc" },
];

function EditToolbar({ mode, onMode, canUndo, canRedo, onUndo, onRedo, isDirty, onSave, onReset, saveState, wallCount, userCount, hiddenCount }) {
  const toolBtn = (id, icon, label, title) => {
    const isHide = id === "hide";
    return (
      <button
        key={id}
        onClick={() => onMode(id)}
        title={title}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "4px 9px", borderRadius: 5, fontSize: 11,
          fontWeight: mode === id ? 700 : 400,
          background:  mode === id
            ? (isHide ? "rgba(74,96,128,0.22)" : "rgba(251,191,36,0.15)")
            : "rgba(255,255,255,0.04)",
          border:      mode === id
            ? (isHide ? "1px solid rgba(74,96,128,0.7)" : "1px solid rgba(251,191,36,0.5)")
            : "1px solid rgba(255,255,255,0.1)",
          color:       mode === id
            ? (isHide ? "#94a3b8" : "#fbbf24")
            : "rgba(200,220,255,0.6)",
          cursor: "pointer", transition: "all 0.15s",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <span>{icon}</span><span style={{ fontSize: 10.5 }}>{label}</span>
      </button>
    );
  };

  const iconBtn = (label, onClick, disabled, title) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "4px 8px", borderRadius: 5, fontSize: 13,
        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
        color: disabled ? "rgba(150,160,180,0.3)" : "rgba(200,220,255,0.7)",
        cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      padding: "6px 10px", flexShrink: 0,
      background: "rgba(0,0,0,0.25)",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      flexWrap: "wrap",
    }}>
      {TOOLS.map(t => toolBtn(t.id, t.icon, t.label, t.title))}

      <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)", margin: "0 2px" }} />

      {iconBtn("↩", onUndo, !canUndo, "Undo (Ctrl+Z)")}
      {iconBtn("↪", onRedo, !canRedo, "Redo (Ctrl+Y)")}

      <div style={{ flex: 1 }} />

      <span style={{ fontSize: 10, color: "rgba(200,220,255,0.35)", fontFamily: "JetBrains Mono, monospace", display: "flex", gap: 6, alignItems: "center" }}>
        <span>{wallCount}W</span>
        {userCount > 0 && <span style={{ color: "#fbbf24" }}>+{userCount}</span>}
        {hiddenCount > 0 && (
          <span style={{ color: "#94a3b8", display: "inline-flex", alignItems: "center", gap: 2 }}>
            <span style={{ opacity: 0.7 }}>👁</span>{hiddenCount} hidden
          </span>
        )}
      </span>

      {isDirty && (
        <button
          onClick={onReset}
          title="Discard all edits"
          style={{
            padding: "4px 8px", borderRadius: 5, fontSize: 11,
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)",
            color: "#ef4444", cursor: "pointer", fontFamily: "Inter, sans-serif",
          }}
        >↺ Discard</button>
      )}

      <button
        onClick={onSave}
        disabled={!isDirty || saveState === "saving"}
        title="Save edits and recalculate rooms (Ctrl+S) — hidden walls excluded"
        style={{
          padding: "4px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700,
          background:   isDirty && saveState !== "saving" ? "rgba(0,200,80,0.15)" : "rgba(255,255,255,0.04)",
          border:       isDirty && saveState !== "saving" ? "1px solid rgba(0,200,80,0.4)"  : "1px solid rgba(255,255,255,0.1)",
          color:        isDirty && saveState !== "saving" ? "#00c850" : "rgba(150,160,180,0.4)",
          cursor:       isDirty && saveState !== "saving" ? "pointer" : "not-allowed",
          transition: "all 0.15s", fontFamily: "Inter, sans-serif",
        }}
      >
        {saveState === "saving" ? "⏳ Saving…" : saveState === "saved" ? "✓ Saved" : "💾 Save"}
      </button>
    </div>
  );
}

// ── Mode hint bar ──────────────────────────────────────────────────────────────

const MODE_HINTS = {
  select: "Drag to pan · Scroll to zoom · Double-click to fit · Click room to select",
  add:    "Click to place first point → click again to draw wall · Esc to cancel",
  delete: "Click a wall to delete · Hold & drag to box-delete all walls in area · Esc to exit",
  hide:   "Click a wall to hide/unhide · Hold & drag to box-hide all walls in area · Esc to exit",
};
const ADD_HINT_FREE    = "Click to set first point  ·  then click to finish wall  ·  Esc to cancel";
const ADD_HINT_PLACED  = "Click to finish  ·  Hold Shift → lock to 0°/45°/90°/135° axis  ·  Esc to cancel";
const ADD_HINT_LOCKED  = "🔒 Angle locked — click to place wall  ·  Release Shift to free-draw  ·  Esc to cancel";

function ModeHint({ mode, addStep, angleConstrained }) {
  let text;
  if (mode === "add") {
    if (!addStep)          text = ADD_HINT_FREE;
    else if (angleConstrained) text = ADD_HINT_LOCKED;
    else                   text = ADD_HINT_PLACED;
  } else {
    text = MODE_HINTS[mode];
  }
  const isLocked = mode === "add" && angleConstrained;
  return (
    <div style={{
      position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)",
      background: isLocked ? "var(--surface-3)" : "var(--surface-1)",
      border: isLocked ? "1px solid var(--border-hi)" : "1px solid var(--border)",
      borderRadius: 6, padding: "4px 12px",
      fontSize: 10,
      color: isLocked ? "var(--accent)" : mode === "select" ? "var(--text-3)" : "#f59e0b",
      fontFamily: "Inter, sans-serif", whiteSpace: "nowrap", pointerEvents: "none",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      transition: "all 0.15s",
    }}>
      {text}
    </div>
  );
}

// ── Legend ─────────────────────────────────────────────────────────────────────

function Legend({ wallCount, doorCount, windowCount, roomCount, userCount, hiddenCount, lowConfCount }) {
  const visibleAlgo = wallCount - userCount - hiddenCount;
  const TC = getTheme();
  const items = [
    { color: TC.wall,     label: `Algo walls (${Math.max(0, visibleAlgo)})` },
    ...(userCount > 0 ? [{ color: TC.wallUser, label: `Added walls (${userCount})` }] : []),
    { color: TC.door,   label: `Doors (${doorCount})` },
    { color: TC.window, label: `Windows (${windowCount})` },
    { color: TC.roomFills[0], label: `Rooms (${roomCount})`, fill: true },
  ];
  return (
    <div style={{
      position: "absolute", bottom: 10, right: 10,
      background: "var(--surface-1)",
      border: "1px solid var(--border)", borderRadius: 8,
      padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5, minWidth: 165,
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    }}>
      {items.map(({ color, label, fill }) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {fill
            ? <div style={{ width: 14, height: 10, background: color + "33", border: `1px solid ${color}`, borderRadius: 2 }} />
            : <div style={{ width: 14, height: 2.5, background: color, borderRadius: 2 }} />
          }
          <span style={{ fontSize: 10.5, color: "var(--text-2)", fontFamily: "Inter,sans-serif" }}>{label}</span>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 2 }}>
          <div style={{ width: 14, height: 2, background: TC.wallHidden, borderRadius: 2, opacity: 0.6,
            backgroundImage: `repeating-linear-gradient(90deg,${TC.wallHidden} 0 5px,transparent 5px 9px)` }} />
          <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "Inter,sans-serif", fontWeight: 600 }}>👁 {hiddenCount} hidden</span>
        </div>
      )}
      {lowConfCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 2 }}>
          <div style={{ width: 14, height: 2.5, background: "#fbbf24", borderRadius: 2, backgroundImage: "repeating-linear-gradient(90deg,#fbbf24 0 4px,transparent 4px 7px)" }} />
          <span style={{ fontSize: 10.5, color: "#fbbf24", fontFamily: "Inter,sans-serif", fontWeight: 600 }}>⚠ {lowConfCount} low-confidence</span>
        </div>
      )}
    </div>
  );
}

// ── FloorTab ───────────────────────────────────────────────────────────────────

function Badge({ colour, children }) {
  const S = {
    cyan:   { background: "var(--surface-3)", color: "var(--accent)", border: "1px solid var(--border-hi)" },
    green:  { background: "var(--surface-3)", color: "#10b981", border: "1px solid var(--border-hi)"  },
    orange: { background: "var(--surface-3)", color: "#f59e0b", border: "1px solid var(--border-hi)" },
    amber:  { background: "var(--surface-3)", color: "#f59e0b", border: "1px solid var(--border-hi)"},
    grey:   { background: "var(--surface-3)", color: "var(--text-3)", border: "1px solid var(--border)"},
  };
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:4, padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:600, ...(S[colour]??S.grey) }}>
      {children}
    </span>
  );
}

function FloorTab({ active, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 5, fontFamily: "Inter, sans-serif",
      border: active ? "1px solid var(--border-hi)" : "1px solid var(--border)",
      background: active ? "var(--surface-3)" : "var(--surface-1)",
      color: active ? "var(--text-1)" : "var(--text-3)",
      fontSize: 12, fontWeight: active ? 700 : 400, cursor: "pointer", transition: "all 0.18s",
    }}>
      {label}
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

// ── Room height helper ─────────────────────────────────────────────────────────
function deriveRoomHeight(modelInfo, floorIdx) {
  const levels = modelInfo?.floor_levels;
  if (!levels || levels.length < 2) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  // Find gap adjacent to floorIdx
  const idx = Math.min(floorIdx, sorted.length - 2);
  const h = Math.abs(sorted[idx + 1] - sorted[idx]);
  return h > 0.5 ? h : null;
}

// ── RoomInfoChip ───────────────────────────────────────────────────────────────
function RoomInfoChip({ room, floorIdx, modelInfo }) {
  if (!room) return null;
  const height = deriveRoomHeight(modelInfo, floorIdx);
  // Derive dimensions from bbox (length = Z span, width = X span)
  const roomLen = Math.abs(room.bbox.z_max - room.bbox.z_min);
  const roomW   = Math.abs(room.bbox.x_max - room.bbox.x_min);
  // Orient so the larger value is shown first
  const dimA = Math.max(roomLen, roomW);
  const dimB = Math.min(roomLen, roomW);
  return (
    <div style={{
      position: "absolute", top: 12, left: 12,
      background: "var(--surface-1)",
      border: "1px solid var(--border-hi)", borderRadius: 8,
      padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6,
      boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
      pointerEvents: "none", minWidth: 160,
      animation: "fadeIn 0.18s ease",
    }}>
      {/* Badge row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          background: "var(--surface-3)", color: "var(--text-1)",
          border: "1px solid var(--border-hi)", borderRadius: 5,
          padding: "2px 8px", fontSize: 11, fontWeight: 700, fontFamily: "Inter,sans-serif",
        }}>R{room.id}</span>
        <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "JetBrains Mono, monospace" }}>selected</span>
      </div>
      {/* Metrics */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "Inter,sans-serif", textTransform: "uppercase", letterSpacing: "0.5px" }}>Area</span>
          <span style={{ fontSize: 11, color: "var(--text-1)", fontFamily: "JetBrains Mono, monospace", fontWeight: 600 }}>{room.area_m2.toFixed(1)} m²</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "Inter,sans-serif", textTransform: "uppercase", letterSpacing: "0.5px" }}>Size</span>
          <span style={{ fontSize: 11, color: "var(--text-1)", fontFamily: "JetBrains Mono, monospace", fontWeight: 600 }}>
            {dimA.toFixed(2)} × {dimB.toFixed(2)} m
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "Inter,sans-serif", textTransform: "uppercase", letterSpacing: "0.5px" }}>Height</span>
          <span style={{ fontSize: 11, fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
            color: height ? "var(--text-1)" : "var(--text-3)" }}>
            {height ? `≈ ${height.toFixed(2)} m` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function FloorPlanViewer({ modelInfo, dataVersion = 0, onClose, highlightedRoomId, onSelectRoom, onSelectFloor, roomMode = "polygon", saveName = null }) {
  const canvasRef = useRef(null);
  const camRef    = useRef({ scale: 8, ox: 300, oy: 300 });
  const rafRef    = useRef(null);

  // Base URL prefix — either live API or a saved output
  const apiBase = saveName ? `/api/saves/${encodeURIComponent(saveName)}` : "/api";

  // ── Save info (when viewing a saved output) ─────────────────────────────────
  const [saveInfo, setSaveInfo] = useState(null);

  useEffect(() => {
    if (!saveName) {
      setSaveInfo(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/saves/${encodeURIComponent(saveName)}/info`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!cancelled && d) setSaveInfo(d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [saveName]);

  const activeModelInfo = saveName ? (saveInfo || modelInfo) : modelInfo;
  const rawFloors = activeModelInfo?.floor_levels;
  // If viewing a save and floor_levels is not available yet or empty, default to at least [0]
  const floors = (rawFloors && rawFloors.length > 0)
    ? rawFloors
    : (saveName ? [0] : (modelInfo?.floor_levels ?? []));

  // ── Data fetch state ────────────────────────────────────────────────────────
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [roomsData,     setRoomsData]     = useState(null);
  const [openingsData,  setOpeningsData]  = useState(null);
  const [loadState,     setLoadState]     = useState("idle");

  // Keep selected floor in bounds if number of floors changes
  useEffect(() => {
    const numFloors = floors.length || 1;
    if (selectedFloor >= numFloors) {
      setSelectedFloor(0);
    }
  }, [floors, selectedFloor]);

  // ── Edit state ──────────────────────────────────────────────────────────────
  // editedLines: [{pts: [[x1,z1],[x2,z2]], source: 'algo'|'user', hidden?: true}]
  const [editedLines,  setEditedLines]  = useState([]);
  const [editMode,     setEditMode]     = useState("select");
  const [addStep,      setAddStep]      = useState(null);   // first point of new wall
  const [hoveredLine,  setHoveredLine]  = useState(-1);
  const [isDirty,      setIsDirty]      = useState(false);
  const [saveState,    setSaveState]    = useState("idle"); // idle|saving|saved|error
  const [undoStack,    setUndoStack]    = useState([]);
  const [redoStack,    setRedoStack]    = useState([]);

  // Refs for event handlers (avoid stale closures)
  const editModeRef    = useRef("select");
  const editedLinesRef = useRef([]);
  const addStepRef     = useRef(null);
  const hoveredLineRef = useRef(-1);
  const snapRef        = useRef(null);
  const dragRef        = useRef(null);
  // Box-select drag state for delete/hide modes
  // { startCx, startCy, cx1, cy1, cx2, cy2, moved }
  const boxSelectRef   = useRef(null);
  // Tracks whether Shift is currently held (for angle-snap in add mode)
  const shiftRef       = useRef(false);
  const [angleConstrained, setAngleConstrained] = useState(false);

  useEffect(() => { editModeRef.current    = editMode;    }, [editMode]);
  useEffect(() => { editedLinesRef.current = editedLines; }, [editedLines]);
  useEffect(() => { addStepRef.current     = addStep;     }, [addStep]);
  useEffect(() => { hoveredLineRef.current = hoveredLine; }, [hoveredLine]);

  // ── Fetch floor data ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setEditedLines([]); setRoomsData(null); setOpeningsData(null);
    setIsDirty(false); setUndoStack([]); setRedoStack([]);
    setAddStep(null); addStepRef.current = null; snapRef.current = null;
    setHoveredLine(-1); hoveredLineRef.current = -1;

    Promise.all([
      fetch(`${apiBase}/walls/${selectedFloor}`).then(r => r.json()),
      fetch(`${apiBase}/rooms/${selectedFloor}`).then(r => r.json()),
      fetch(`${apiBase}/openings/${selectedFloor}`).then(r => r.json()),
    ])
      .then(([w, r, o]) => {
        if (cancelled) return;
        const converted = (w?.lines ?? []).map(pts => ({ pts, source: "algo" }));
        setEditedLines(converted); editedLinesRef.current = converted;
        setRoomsData(r); setOpeningsData(o);
        setLoadState("ready");
        const cvs = canvasRef.current;
        if (cvs && converted.length) {
          const b = wallsBoundsFromEdited(converted);
          camRef.current = fitCamera(b, cvs.clientWidth || cvs.width, cvs.clientHeight || cvs.height);
          scheduleDraw();
        }
      })
      .catch(() => { if (!cancelled) setLoadState("error"); });

    return () => { cancelled = true; };
  }, [selectedFloor, dataVersion, saveName]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Undo / Redo ─────────────────────────────────────────────────────────────
  const pushHistory = useCallback((snapshot) => {
    setUndoStack(prev => [...prev.slice(-49), snapshot]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    setUndoStack(prev => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setRedoStack(r => [editedLinesRef.current, ...r.slice(0, 49)]);
      setEditedLines(last); editedLinesRef.current = last;
      setIsDirty(true); scheduleDraw();
      return prev.slice(0, -1);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    setRedoStack(prev => {
      if (!prev.length) return prev;
      const next = prev[0];
      setUndoStack(u => [...u.slice(-49), editedLinesRef.current]);
      setEditedLines(next); editedLinesRef.current = next;
      setIsDirty(true); scheduleDraw();
      return prev.slice(1);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save to backend ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    setSaveState("saving");
    try {
      // Hidden walls are excluded — they are suppressed from room recalculation
      const lines = editedLinesRef.current
        .filter(l => !l.hidden)
        .map(l => l.pts);
      // Route to save-specific endpoint if viewing a save
      const putUrl = `${apiBase}/walls/${selectedFloor}`;
      const r = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, polygon_rooms: roomMode === "polygon" }),
      });
      const d = await r.json();
      if (!r.ok) { setSaveState("error"); return; }
      setSaveState("saved");
      setIsDirty(false);
      // Refresh rooms from updated backend (save or live)
      fetch(`${apiBase}/rooms/${selectedFloor}`).then(r => r.json()).then(setRoomsData).catch(() => {});
      setTimeout(() => setSaveState("idle"), 3000);
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  }, [isDirty, selectedFloor]);

  // ── Draw loop ───────────────────────────────────────────────────────────────
  // Keep a ref for highlightedRoomId to avoid stale closures in scheduleDraw
  const highlightedRoomIdRef = useRef(highlightedRoomId);
  useEffect(() => { highlightedRoomIdRef.current = highlightedRoomId; }, [highlightedRoomId]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext("2d");
      const { width: w, height: h } = cvs;
      const cam = camRef.current;
      const TC = getTheme(); // read current theme each frame
      ctx.fillStyle = TC.bg; ctx.fillRect(0, 0, w, h);
      drawGrid(ctx, cam, w, h, TC);
      drawRooms(ctx, roomsData?.rooms, cam, highlightedRoomIdRef.current, TC);
      drawEditedWalls(
        ctx, editedLinesRef.current, cam,
        hoveredLineRef.current, addStepRef.current, snapRef.current,
        editModeRef.current, TC,
      );
      drawOpenings(ctx, openingsData?.openings, cam);
      drawBoxSelect(ctx, boxSelectRef.current, editModeRef.current);
      drawScale(ctx, cam, w, h, TC);
      drawCompass(ctx, w);
    });
  }, [roomsData, openingsData]);

  // redraw when data changes
  useEffect(() => { scheduleDraw(); }, [editedLines, roomsData, openingsData, highlightedRoomId, scheduleDraw]);

  // ── Center camera on selected room ──────────────────────────────────────────
  useEffect(() => {
    if (highlightedRoomId == null || !roomsData?.rooms?.length) return;
    const room = roomsData.rooms.find(r => r.id === highlightedRoomId);
    if (!room) return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const cw = cvs.clientWidth || cvs.width;
    const ch = cvs.clientHeight || cvs.height;
    const cam = camRef.current;
    // Target: room centroid at canvas centre
    const targetOx = cw / 2 - room.centroid_x * cam.scale;
    const targetOy = ch / 2 - room.centroid_z * cam.scale;
    const startOx = cam.ox, startOy = cam.oy;
    const duration = 300; // ms
    const startTime = performance.now();
    const ease = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOut
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const e = ease(t);
      camRef.current = { ...camRef.current, ox: startOx + (targetOx - startOx) * e, oy: startOy + (targetOy - startOy) * e };
      scheduleDraw();
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [highlightedRoomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas resize ───────────────────────────────────────────────────────────
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ro = new ResizeObserver(() => {
      cvs.width = cvs.clientWidth; cvs.height = cvs.clientHeight;
      scheduleDraw();
    });
    ro.observe(cvs);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Z")) { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); return; }
      if (e.key === "Escape") {
        if (addStepRef.current) {
          addStepRef.current = null; setAddStep(null); snapRef.current = null; scheduleDraw();
        } else {
          setEditMode("select"); editModeRef.current = "select";
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "s" || e.key === "S") { setEditMode("select"); editModeRef.current = "select"; }
        if (e.key === "a" || e.key === "A") { setEditMode("add");    editModeRef.current = "add"; }
        if (e.key === "d" || e.key === "D") { setEditMode("delete"); editModeRef.current = "delete"; }
        if (e.key === "h" || e.key === "H") { setEditMode("hide");   editModeRef.current = "hide"; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, handleSave, scheduleDraw]);

  // ── Helper: get world pos from mouse event ──────────────────────────────────
  const getWorldFromEvent = useCallback((e) => {
    const cvs = canvasRef.current;
    if (!cvs) return [0, 0];
    const rect = cvs.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top, camRef.current);
  }, []);

  const getWorldFromCanvas = useCallback((cx, cy) => {
    return toWorld(cx, cy, camRef.current);
  }, []);

  // ── Pointer events ──────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const mode = editModeRef.current;
    if (mode === "select") {
      dragRef.current = { startX: e.clientX, startY: e.clientY, ox: camRef.current.ox, oy: camRef.current.oy };
    } else if (mode === "delete" || mode === "hide") {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      boxSelectRef.current = { startCx: cx, startCy: cy, cx1: cx, cy1: cy, cx2: cx, cy2: cy, moved: false };
    }
  }, []);

  const onMouseMove = useCallback((e) => {
    const mode = editModeRef.current;

    // Pan in select mode
    if (mode === "select" && dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      camRef.current = { ...camRef.current, ox: dragRef.current.ox + dx, oy: dragRef.current.oy + dy };
      scheduleDraw();
      return;
    }

    // Box-select drag in delete/hide modes
    if ((mode === "delete" || mode === "hide") && boxSelectRef.current) {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { startCx, startCy } = boxSelectRef.current;
      const moved = Math.hypot(cx - startCx, cy - startCy) > 5;
      boxSelectRef.current = { startCx, startCy, cx1: startCx, cy1: startCy, cx2: cx, cy2: cy, moved };
      // Suppress individual hover highlight while box-selecting
      hoveredLineRef.current = -1;
      setHoveredLine(-1);
      scheduleDraw();
      return;
    }

    // Snap indicator and hover highlight in edit modes
    if (mode !== "select") {
      const [wx, wz] = getWorldFromEvent(e);
      const shiftHeld = e.shiftKey;
      shiftRef.current = shiftHeld;

      if (mode === "add" && addStepRef.current && shiftHeld) {
        // Angle-constrained snap
        const [ax, az] = addStepRef.current;
        snapRef.current = computeSnapConstrained(wx, wz, editedLinesRef.current, camRef.current, ax, az);
        if (!angleConstrained) setAngleConstrained(true);
      } else {
        snapRef.current = computeSnap(wx, wz, editedLinesRef.current, camRef.current);
        if (angleConstrained) setAngleConstrained(false);
      }

      if (mode === "delete" || mode === "hide") {
        const idx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current);
        hoveredLineRef.current = idx;
        setHoveredLine(idx);   // for cursor CSS
      }
      scheduleDraw();
    } else {
      // Reset angle lock when not in add mode
      if (angleConstrained) setAngleConstrained(false);
    }
  }, [scheduleDraw, getWorldFromEvent, angleConstrained]);

  const onMouseUp = useCallback((e) => {
    // Pan drag end
    if (dragRef.current) { dragRef.current = null; return; }

    // Box-select commit
    const box = boxSelectRef.current;
    if (box && box.moved) {
      boxSelectRef.current = null;
      const cam = camRef.current;
      // Convert canvas-space box to world-space rect
      const [wx1, wz1] = toWorld(Math.min(box.cx1, box.cx2), Math.min(box.cy1, box.cy2), cam);
      const [wx2, wz2] = toWorld(Math.max(box.cx1, box.cx2), Math.max(box.cy1, box.cy2), cam);
      const rxMin = Math.min(wx1, wx2), rxMax = Math.max(wx1, wx2);
      const rzMin = Math.min(wz1, wz2), rzMax = Math.max(wz1, wz2);

      const mode = editModeRef.current;
      const lines = editedLinesRef.current;
      const hits = lines.filter(({ pts: [[x1, z1], [x2, z2]] }) =>
        segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax)
      );
      if (hits.length > 0) {
        pushHistory(lines);
        let newLines;
        if (mode === "delete") {
          newLines = lines.filter(({ pts: [[x1, z1], [x2, z2]] }) =>
            !segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax)
          );
        } else {
          // hide: toggle hidden flag on all intersecting walls
          // Determine majority state — if most are visible, hide all; otherwise unhide all
          const hiddenHits = hits.filter(l => l.hidden).length;
          const shouldHide = hiddenHits < hits.length / 2;
          newLines = lines.map(line => {
            const [[x1, z1], [x2, z2]] = line.pts;
            if (segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax)) {
              return { ...line, hidden: shouldHide };
            }
            return line;
          });
        }
        setEditedLines(newLines); editedLinesRef.current = newLines;
        setIsDirty(true);
      }
      hoveredLineRef.current = -1; setHoveredLine(-1);
      scheduleDraw();
      return;
    }

    // No drag box (or tiny move) — clear it so onClick fires normally
    if (box) {
      boxSelectRef.current = null;
      scheduleDraw();
    }
  }, [pushHistory, scheduleDraw]);

  const onClick = useCallback((e) => {
    const mode = editModeRef.current;

    // Suppress click if a box-select drag just committed (onMouseUp already handled it)
    // We detect this by checking that boxSelectRef is now null but was a moved drag.
    // Since onMouseUp clears it before onClick fires, we use a tiny flag instead.
    if (mode === "delete" || mode === "hide") {
      // If box was moved (and handled in onMouseUp), boxSelectRef is already null.
      // We rely on hoveredLineRef being reset to -1 during a box drag — which means
      // a click on nothing is a no-op anyway. Just need to avoid double-acting.
      // A safe guard: if the box ref still exists here it means it was NOT a drag.
    }

    if (mode === "add") {
      const snap = snapRef.current;
      const [wx, wz] = snap ? snap.pt : getWorldFromEvent(e);
      if (!addStepRef.current) {
        // Place first point
        addStepRef.current = [wx, wz];
        setAddStep([wx, wz]);
        scheduleDraw();
      } else {
        // Place second point → commit
        const newLine = { pts: [addStepRef.current, [wx, wz]], source: "user" };
        const newLines = [...editedLinesRef.current, newLine];
        pushHistory(editedLinesRef.current);
        setEditedLines(newLines); editedLinesRef.current = newLines;
        addStepRef.current = null; setAddStep(null);
        setIsDirty(true);
        scheduleDraw();
      }
      return;
    }

    if (mode === "delete") {
      // Skip if a box-select drag was just completed (boxSelectRef cleared in onMouseUp)
      if (boxSelectRef.current !== null) return; // still active (shouldn't happen)
      const idx = hoveredLineRef.current;
      if (idx >= 0) {
        const newLines = editedLinesRef.current.filter((_, i) => i !== idx);
        pushHistory(editedLinesRef.current);
        setEditedLines(newLines); editedLinesRef.current = newLines;
        hoveredLineRef.current = -1; setHoveredLine(-1);
        snapRef.current = null;
        setIsDirty(true);
        scheduleDraw();
      }
      return;
    }

    if (mode === "hide") {
      if (boxSelectRef.current !== null) return;
      const idx = hoveredLineRef.current;
      if (idx >= 0) {
        // Toggle hidden flag on the wall
        const newLines = editedLinesRef.current.map((line, i) =>
          i === idx ? { ...line, hidden: !line.hidden } : line
        );
        pushHistory(editedLinesRef.current);
        setEditedLines(newLines); editedLinesRef.current = newLines;
        setIsDirty(true);
        scheduleDraw();
      }
      return;
    }

    // In select mode, check if click falls inside a room bbox → toggle selection
    if (mode === "select" && !dragRef.current && onSelectRoom && roomsData?.rooms?.length) {
      const [wx, wz] = getWorldFromEvent(e);
      for (const room of roomsData.rooms) {
        const { x_min, z_min, x_max, z_max } = room.bbox;
        if (wx >= x_min && wx <= x_max && wz >= z_min && wz <= z_max) {
          onSelectRoom(highlightedRoomIdRef.current === room.id ? null : room.id);
          return;
        }
      }
      // Clicked outside any room — deselect
      if (highlightedRoomIdRef.current != null) {
        onSelectRoom(null);
      }
    }
  }, [pushHistory, scheduleDraw, getWorldFromEvent, onSelectRoom, roomsData]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const cam = camRef.current;
    const newScale = Math.max(1, Math.min(400, cam.scale * factor));
    const ratio = newScale / cam.scale;
    camRef.current = { scale: newScale, ox: mx - ratio * (mx - cam.ox), oy: my - ratio * (my - cam.oy) };
    scheduleDraw();
  }, [scheduleDraw]);

  const onDoubleClick = useCallback(() => {
    if (editModeRef.current !== "select") return; // don't accidentally fit in edit modes
    const cvs = canvasRef.current;
    if (!cvs || !editedLinesRef.current.length) return;
    const b = wallsBoundsFromEdited(editedLinesRef.current);
    camRef.current = fitCamera(b, cvs.width, cvs.height);
    scheduleDraw();
  }, [scheduleDraw]);

  // Touch support
  const lastTouchRef = useRef(null);
  const onTouchStart = (e) => {
    if (e.touches.length === 1)
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: camRef.current.ox, oy: camRef.current.oy };
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 1 && lastTouchRef.current) {
      const dx = e.touches[0].clientX - lastTouchRef.current.x;
      const dy = e.touches[0].clientY - lastTouchRef.current.y;
      camRef.current = { ...camRef.current, ox: lastTouchRef.current.ox + dx, oy: lastTouchRef.current.oy + dy };
      scheduleDraw();
    }
  };
  const onTouchEnd = () => { lastTouchRef.current = null; };

  // Switch floor → cancel any pending add
  const switchFloor = (i) => {
    addStepRef.current = null; setAddStep(null); snapRef.current = null;
    setEditMode("select"); editModeRef.current = "select";
    setSelectedFloor(i);
  };

  // Discard all edits
  const handleReset = useCallback(() => {
    fetch(`${apiBase}/walls/${selectedFloor}`).then(r => r.json()).then(w => {
      const converted = (w?.lines ?? []).map(pts => ({ pts, source: "algo" }));
      setEditedLines(converted); editedLinesRef.current = converted;
      setUndoStack([]); setRedoStack([]);
      setIsDirty(false); setAddStep(null); addStepRef.current = null;
      scheduleDraw();
    }).catch(() => {});
  }, [selectedFloor, scheduleDraw]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived metrics ─────────────────────────────────────────────────────────
  const wallCount    = editedLines.length;
  const userCount    = editedLines.filter(l => l.source === "user" && !l.hidden).length;
  const hiddenCount  = editedLines.filter(l => l.hidden).length;
  const roomCount    = roomsData?.rooms?.length ?? 0;
  const openings     = openingsData?.openings ?? [];
  const doorCount    = openings.filter(o => o.type === "door").length;
  const windowCount  = openings.filter(o => o.type === "window").length;
  const lowConfCount = openings.filter(o => (o.confidence ?? 1) < LOW_CONF_THRESHOLD).length;
  const nWallsAnalysed     = openingsData?.n_walls_analysed ?? null;
  const nWallsWithOpenings = openingsData?.n_walls_with_openings ?? null;

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  // Highlighted room object (for the info chip)
  const highlightedRoom = highlightedRoomId != null
    ? (roomsData?.rooms ?? []).find(r => r.id === highlightedRoomId) ?? null
    : null;

  // Cursor style
  const cursorStyle = editMode === "select"
    ? (dragRef.current ? "grabbing" : "grab")
    : editMode === "add"
    ? "crosshair"
    : (boxSelectRef.current?.moved
        ? "crosshair"
        : hoveredLine >= 0 ? "pointer" : "crosshair");

  const floorLabel = (i) => {
    if (!floors.length) return `Floor ${i}`;
    const lvl = floors[i];
    if (lvl == null) return `Floor ${i}`;
    if (lvl < -0.5) return `Floor ${i} (B${Math.abs(Math.round(lvl))})`;
    return `Floor ${i}  (${lvl >= 0 ? "+" : ""}${lvl.toFixed(1)} m)`;
  };

  const dxfUrl = saveName
    ? `${apiBase}/download/${selectedFloor}`
    : `${apiBase}/walls/${selectedFloor}/download`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="floorplan-viewer" style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="fpv-header">
        <div className="fpv-title">
          <span className="fpv-icon">{saveName ? "💾" : "📐"}</span>
          <span>{saveName ? `Saved: ${saveName}` : "Vector Floor Plan"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {loadState === "loading" && <Badge colour="orange">⏳ Loading…</Badge>}
          {loadState === "ready"   && <Badge colour="cyan">{wallCount}W · {doorCount}D · {windowCount}W · {roomCount}R</Badge>}
          {isDirty                 && <Badge colour="amber">✎ Unsaved edits</Badge>}
          {loadState === "error"   && <Badge colour="grey">⚠ API error</Badge>}
          <button className="fpv-close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* ── Floor tabs + quality bar ─────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {floors.length > 0
            ? floors.map((_, i) => <FloorTab key={i} active={selectedFloor === i} label={floorLabel(i)} onClick={() => { setSelectedFloor(i); onSelectFloor?.(i); }} />)
            : <span style={{ fontSize: 11, color: "var(--text-3)" }}>No floors detected</span>
          }
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <button
            onClick={() => { const cvs = canvasRef.current; if (!cvs || !editedLinesRef.current.length) return; camRef.current = fitCamera(wallsBoundsFromEdited(editedLinesRef.current), cvs.width, cvs.height); scheduleDraw(); }}
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, color: "rgba(200,220,255,0.7)", fontSize: 12, padding: "4px 8px", cursor: "pointer", fontFamily: "Inter,sans-serif" }}
          >⊞ Fit</button>
          <a href={dxfUrl} download={`floor_${selectedFloor}.dxf`}
            style={{ background: "rgba(0,200,224,0.12)", border: "1px solid rgba(0,200,224,0.3)", borderRadius: 5, color: C.wall, fontSize: 12, fontWeight: 600, padding: "4px 10px", textDecoration: "none", fontFamily: "Inter,sans-serif" }}
          >↓ DXF</a>
        </div>
      </div>

      {/* ── Opening quality summary bar ──────────────────────────────────────── */}
      {loadState === "ready" && openingsData && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "4px 14px", flexShrink: 0,
          background: lowConfCount > 0 ? "rgba(251,191,36,0.06)" : "rgba(0,200,80,0.04)",
          borderBottom: `1px solid ${ lowConfCount > 0 ? "rgba(251,191,36,0.18)" : "rgba(0,200,80,0.12)"}`,
          fontSize: 10.5, fontFamily: "JetBrains Mono, monospace",
        }}>
          <span style={{ color: "rgba(200,220,255,0.45)" }}>
            {nWallsAnalysed != null ? `${nWallsAnalysed} walls analysed` : ""}
            {nWallsWithOpenings != null ? ` · ${nWallsWithOpenings} with openings` : ""}
          </span>
          <span style={{ marginLeft: "auto",
            color: lowConfCount > 0 ? "#fbbf24" : "#00c850",
            fontWeight: 600,
          }}>
            {lowConfCount > 0
              ? `⚠ ${lowConfCount} low-confidence opening${lowConfCount > 1 ? "s" : ""} (shown in amber)`
              : openings.length > 0 ? "✓ All openings verified" : "ℹ No openings detected"}
          </span>
        </div>
      )}

      {/* ── Edit Toolbar ─────────────────────────────────────────────────────── */}
      <EditToolbar
        mode={editMode}
        onMode={(m) => {
          setEditMode(m); editModeRef.current = m;
          if (m !== "add") { addStepRef.current = null; setAddStep(null); scheduleDraw(); }
          if (m !== "delete" && m !== "hide") { hoveredLineRef.current = -1; setHoveredLine(-1); scheduleDraw(); }
          snapRef.current = null;
        }}
        canUndo={canUndo} canRedo={canRedo}
        onUndo={undo} onRedo={redo}
        isDirty={isDirty}
        onSave={handleSave}
        onReset={handleReset}
        saveState={saveState}
        wallCount={wallCount}
        userCount={userCount}
        hiddenCount={hiddenCount}
      />

      {/* ── Canvas area ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: C.bg }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block", cursor: cursorStyle }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={(e) => {
            // Cancel box-select if mouse leaves canvas
            if (boxSelectRef.current) { boxSelectRef.current = null; scheduleDraw(); }
            onMouseUp(e);
          }}
          onClick={onClick}
          onWheel={onWheel}
          onDoubleClick={() => {
            if (editModeRef.current === "select") {
              const cvs = canvasRef.current;
              if (!cvs || !editedLinesRef.current.length) return;
              camRef.current = fitCamera(wallsBoundsFromEdited(editedLinesRef.current), cvs.width, cvs.height);
              scheduleDraw();
            }
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        />

        {/* Empty state */}
        {loadState === "idle" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "rgba(200,220,255,0.35)", fontSize: 13, gap: 8, fontFamily: "Inter,sans-serif" }}>
            <span style={{ fontSize: 36 }}>📐</span><span>Select a floor to preview</span>
          </div>
        )}

        {/* Loading spinner */}
        {loadState === "loading" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--surface-1)", opacity: 0.9, color: "var(--text-1)", gap: 12, fontFamily: "Inter,sans-serif" }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", border: `3px solid var(--border)`, borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Loading floor {selectedFloor}…</span>
          </div>
        )}

        {/* Error state */}
        {loadState === "error" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#ef4444", gap: 8, fontFamily: "Inter,sans-serif" }}>
            <span style={{ fontSize: 28 }}>⚠</span>
            <span style={{ fontSize: 12 }}>Could not load floor data. Run <strong>Detect Walls</strong> in the sidebar first.</span>
          </div>
        )}

        {/* No walls */}
        {loadState === "ready" && wallCount === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "rgba(200,220,255,0.4)", gap: 8, fontFamily: "Inter,sans-serif" }}>
            <span style={{ fontSize: 28 }}>🧱</span>
            <span style={{ fontSize: 12 }}>No walls for floor {selectedFloor}.<br />Run <strong>🧱 Detect Walls + Rooms</strong> in the Cloud2BIM panel.</span>
          </div>
        )}

        {/* Save status toast */}
        {saveState === "saved" && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "rgba(0,200,80,0.15)", border: "1px solid rgba(0,200,80,0.4)", borderRadius: 8, padding: "8px 16px", color: "#00c850", fontSize: 12, fontWeight: 700, fontFamily: "Inter,sans-serif", animation: "fadeIn 0.2s ease" }}>
            ✓ Saved — rooms recalculated
          </div>
        )}
        {saveState === "error" && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, padding: "8px 16px", color: "#ef4444", fontSize: 12, fontWeight: 700, fontFamily: "Inter,sans-serif" }}>
            ✗ Save failed — check the backend
          </div>
        )}

        {/* Room info chip — selected room details */}
        {loadState === "ready" && highlightedRoom && (
          <RoomInfoChip room={highlightedRoom} floorIdx={selectedFloor} modelInfo={activeModelInfo} />
        )}

        {/* Legend */}
        {loadState === "ready" && wallCount > 0 && (
          <Legend wallCount={wallCount} doorCount={doorCount} windowCount={windowCount} roomCount={roomCount} userCount={userCount} hiddenCount={hiddenCount} lowConfCount={lowConfCount} />
        )}

        {/* Mode hint bar */}
        {loadState === "ready" && wallCount > 0 && (
          <ModeHint mode={editMode} addStep={addStep} angleConstrained={angleConstrained} />
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes fadeIn { from { opacity:0; transform: translateX(-50%) translateY(-6px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`}</style>
    </div>
  );
}
