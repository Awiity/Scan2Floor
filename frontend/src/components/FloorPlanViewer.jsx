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

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { colorForMpLabel } from "./MpObjects3D";
import { getCanvasTheme, getRoomAccent, withAlpha } from "../theme";
import { fetchPointCloudOrtho, renderPhotoOrtho } from "../utils/orthoReference";

// ── Colour constants — theme-aware (mirrors src/theme.js) ─────────────────────
const getTheme = getCanvasTheme;
const C = new Proxy({}, { get: (_, k) => getCanvasTheme()[k] });

// ── Coordinate utilities ───────────────────────────────────────────────────────

function toCanvas(wx, wz, cam) {
  return [cam.ox + wx * cam.scale, cam.oy + wz * cam.scale];
}

function toWorld(cx, cy, cam) {
  return [(cx - cam.ox) / cam.scale, (cy - cam.oy) / cam.scale];
}

function isPointInRoom(wx, wz, room) {
  if (!room) return false;
  const poly = room.polygon;
  if (poly && poly.length >= 3) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i];
      const [xj, zj] = poly[j];
      if (zi > wz !== zj > wz && wx < ((xj - xi) * (wz - zi)) / (zj - zi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  const b = room.bbox;
  return Boolean(b && wx >= b.x_min && wx <= b.x_max && wz >= b.z_min && wz <= b.z_max);
}

function drawMpOverlays2D(
  ctx,
  cam,
  selectedFloor,
  {
    mpInstances = [],
    mpSweeps = {},
    mpPoints = [],
    livePose = null,
    fpvPose = null,
    rooms = [],
    showEquip = true,
    showSweeps = false,
    showAiHints = true,
    showPoints = true,
    showLive = true,
    hiddenMpLabels = [],
    selectedMpItem = null,
  }
) {
  const onFloor = (item) =>
    Boolean(item?.s2f_position) &&
    item.floor_idx != null &&
    Number(item.floor_idx) === Number(selectedFloor);

  // 1. 360° Sweep nodes
  if (showSweeps) {
    for (const sw of Object.values(mpSweeps || {})) {
      if (!onFloor(sw)) continue;
      const [sx, sy] = toCanvas(sw.s2f_position.x, sw.s2f_position.z, cam);
      const isSel = selectedMpItem?.kind === "sweep" && selectedMpItem?.data?.sweep_id === sw.sweep_id;
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, isSel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? "rgba(255,255,255,0.9)" : "rgba(96,165,250,0.28)";
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = isSel ? 2 : 1.2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // 2. AI Door/Window Hints & Equipment markers
  for (const inst of mpInstances || []) {
    if (!onFloor(inst)) continue;
    if (hiddenMpLabels.includes(inst.label)) continue;
    const isOpeningHint = inst.label === "dvere" || inst.label === "okno";
    if (isOpeningHint && !showAiHints) continue;
    if (!isOpeningHint && !showEquip) continue;

    const [cx, cy] = toCanvas(inst.s2f_position.x, inst.s2f_position.z, cam);
    const isSel =
      selectedMpItem?.kind === "instance" &&
      selectedMpItem?.data?.instance_id === inst.instance_id;

    ctx.save();
    if (isOpeningHint) {
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(cx, cy, isSel ? 8 : 6, 0, Math.PI * 2);
      ctx.strokeStyle = inst.label === "dvere" ? "#4ade80" : "#818cf8";
      ctx.lineWidth = isSel ? 2.4 : 1.6;
      ctx.stroke();
    } else {
      const col = colorForMpLabel(inst.label);
      ctx.beginPath();
      ctx.arc(cx, cy, isSel ? 6 : 4.2, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? "#ffffff" : col;
      ctx.strokeStyle = "#0b1120";
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
      if (cam.scale >= 22 || isSel) {
        ctx.font = "10px Inter, sans-serif";
        ctx.fillStyle = col;
        ctx.fillText(inst.label, cx + 6, cy + 3);
      }
    }
    ctx.restore();
  }

  // 3. Saved viewpoints
  if (showPoints) {
    for (const pt of mpPoints || []) {
      if (!onFloor(pt)) continue;
      const [px, py] = toCanvas(pt.s2f_position.x, pt.s2f_position.z, cam);
      const isSel = selectedMpItem?.kind === "point" && selectedMpItem?.data?.id === pt.id;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = isSel ? "#ffffff" : "#38bdf8";
      ctx.fillRect(-4, -4, 8, 8);
      ctx.restore();
    }
  }

  // 4. Live 360° Showcase camera wedge
  if (showLive && onFloor(livePose)) {
    const [kx, ky] = toCanvas(livePose.s2f_position.x, livePose.s2f_position.z, cam);
    const yawRad = ((Number(livePose.rotation?.y ?? 0) * Math.PI) / 180) + Math.PI / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(kx, ky);
    ctx.arc(kx, ky, 26, -yawRad - 0.55, -yawRad + 0.55);
    ctx.closePath();
    ctx.fillStyle = "rgba(251, 191, 36, 0.28)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(kx, ky, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fbbf24";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 5. Live / last FPV Free walk camera marker & current room highlight
  if (
    showLive &&
    fpvPose &&
    (fpvPose.floor_idx == null || Number(fpvPose.floor_idx) === Number(selectedFloor))
  ) {
    const fpvRoom = (rooms || []).find((r) => isPointInRoom(fpvPose.x, fpvPose.z, r)) ?? null;
    if (fpvRoom) {
      ctx.save();
      ctx.beginPath();
      if (fpvRoom.polygon && fpvRoom.polygon.length >= 3) {
        const [sx, sy] = toCanvas(fpvRoom.polygon[0][0], fpvRoom.polygon[0][1], cam);
        ctx.moveTo(sx, sy);
        for (let i = 1; i < fpvRoom.polygon.length; i++) {
          const [px, py] = toCanvas(fpvRoom.polygon[i][0], fpvRoom.polygon[i][1], cam);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else if (fpvRoom.bbox) {
        const [x1, y1] = toCanvas(fpvRoom.bbox.x_min, fpvRoom.bbox.z_min, cam);
        const [x2, y2] = toCanvas(fpvRoom.bbox.x_max, fpvRoom.bbox.z_max, cam);
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
      }
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    const [kx, ky] = toCanvas(fpvPose.x, fpvPose.z, cam);
    const heading = fpvPose.headingRad ?? Math.atan2(fpvPose.dirZ ?? -1, fpvPose.dirX ?? 0);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(kx, ky);
    ctx.arc(kx, ky, 28, heading - 0.52, heading + 0.52);
    ctx.closePath();
    ctx.fillStyle = fpvPose.active ? "rgba(34, 211, 238, 0.28)" : "rgba(34, 211, 238, 0.16)";
    ctx.fill();
    ctx.strokeStyle = fpvPose.active ? "rgba(34, 211, 238, 0.75)" : "rgba(34, 211, 238, 0.45)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(kx, ky, 8.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(kx, ky, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#22d3ee";
    ctx.strokeStyle = "#0b1120";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    const labelText = fpvRoom ? `FPV · R${fpvRoom.id}` : "FPV";
    ctx.font = "bold 10px Inter, sans-serif";
    const tw = ctx.measureText(labelText).width;
    const lx = kx + 12;
    const ly = ky - 9;
    const lw = tw + 10;
    const lh = 18;
    ctx.fillStyle = "rgba(11, 17, 32, 0.88)";
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx, ly, lw, lh, 4);
    else ctx.rect(lx, ly, lw, lh);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#22d3ee";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, lx + 5, ky);
    ctx.restore();
  }
}

function normalizeWallThickness(val) {
  const t = Number(val);
  return Number.isFinite(t) && t > 0.02 ? t : 0.20;
}

function wallJsonToEditedLines(w) {
  const lines = w?.lines ?? [];
  const thicks = Array.isArray(w?.thicknesses) ? w.thicknesses : [];
  const srcs = Array.isArray(w?.thickness_source) ? w.thickness_source : [];
  return lines.map((pts, i) => ({
    pts,
    source: "algo",
    thickness: normalizeWallThickness(thicks[i]),
    thicknessSource: srcs[i] || "default",
  }));
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

function projectPointToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return { x: x1, z: z1, t: 0, dist: Math.hypot(px - x1, pz - z1) };
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
  const x = x1 + t * dx, z = z1 + t * dz;
  return { x, z, t, dist: Math.hypot(px - x, pz - z) };
}

function distPointToSeg(px, pz, x1, z1, x2, z2) {
  return projectPointToSeg(px, pz, x1, z1, x2, z2).dist;
}

function getWallMetrics(line) {
  const [[x1, z1], [x2, z2]] = line.pts;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const mx = (x1 + x2) * 0.5, mz = (z1 + z2) * 0.5;
  const ux = len > 1e-6 ? dx / len : 1;
  const uz = len > 1e-6 ? dz / len : 0;
  const nx = -uz, nz = ux;
  const angleRad = Math.atan2(dz, dx);
  const angleDeg = ((angleRad * 180) / Math.PI + 360) % 360;
  const thickness = normalizeWallThickness(line.thickness);
  return { x1, z1, x2, z2, mx, mz, dx, dz, len, ux, uz, nx, nz, angleRad, angleDeg, thickness };
}

function syncOpeningsWithWalls(lines, openings) {
  if (!openings?.length) return { openings, changed: false };
  let changed = false;
  const next = openings.map((op) => {
    const wi = op.wall_idx;
    if (wi == null || wi < 0 || wi >= lines.length) return op;
    const [[x1, z1], [x2, z2]] = lines[wi].pts;
    const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
    const nx = x1 + t * (x2 - x1);
    const nz = z1 + t * (z2 - z1);
    if (
      Math.abs((op.wall_x1 ?? 0) - x1) > 1e-5 ||
      Math.abs((op.wall_z1 ?? 0) - z1) > 1e-5 ||
      Math.abs((op.wall_x2 ?? 0) - x2) > 1e-5 ||
      Math.abs((op.wall_z2 ?? 0) - z2) > 1e-5 ||
      Math.abs((op.x ?? 0) - nx) > 1e-5 ||
      Math.abs((op.z ?? 0) - nz) > 1e-5
    ) {
      changed = true;
      return { ...op, wall_x1: x1, wall_z1: z1, wall_x2: x2, wall_z2: z2, x: nx, z: nz };
    }
    return op;
  });
  return { openings: changed ? next : openings, changed };
}

/** Snap world point to nearest endpoint, midpoint, wall edge, alignment guide, or grid step. */
function computeSnap(wx, wz, editedLines, cam, pixThresh = 14, gridStep = 0.05, snapToVertices = true, excludeIdx = -1) {
  if (snapToVertices) {
    const epThresh = pixThresh / cam.scale;
    const subThresh = (pixThresh * 0.85) / cam.scale;

    let bestEp = epThresh, epSnapped = null;
    for (let i = 0; i < editedLines.length; i++) {
      if (i === excludeIdx || editedLines[i].hidden) continue;
      const [[x1, z1], [x2, z2]] = editedLines[i].pts;
      const d1 = Math.hypot(wx - x1, wz - z1);
      const d2 = Math.hypot(wx - x2, wz - z2);
      if (d1 < bestEp) { bestEp = d1; epSnapped = { pt: [x1, z1], kind: "endpoint" }; }
      if (d2 < bestEp) { bestEp = d2; epSnapped = { pt: [x2, z2], kind: "endpoint" }; }
    }
    if (epSnapped) return epSnapped;

    let bestMid = subThresh, midSnapped = null;
    for (let i = 0; i < editedLines.length; i++) {
      if (i === excludeIdx || editedLines[i].hidden) continue;
      const [[x1, z1], [x2, z2]] = editedLines[i].pts;
      const mx = (x1 + x2) * 0.5, mz = (z1 + z2) * 0.5;
      const dm = Math.hypot(wx - mx, wz - mz);
      if (dm < bestMid) { bestMid = dm; midSnapped = { pt: [mx, mz], kind: "midpoint" }; }
    }
    if (midSnapped) return midSnapped;

    let bestEdge = subThresh, edgeSnapped = null;
    for (let i = 0; i < editedLines.length; i++) {
      if (i === excludeIdx || editedLines[i].hidden) continue;
      const [[x1, z1], [x2, z2]] = editedLines[i].pts;
      const proj = projectPointToSeg(wx, wz, x1, z1, x2, z2);
      if (proj.t >= 0.03 && proj.t <= 0.97 && proj.dist < bestEdge) {
        bestEdge = proj.dist;
        let pt = [proj.x, proj.z];
        if (gridStep > 0) {
          const len = Math.hypot(x2 - x1, z2 - z1);
          if (len > 1e-4) {
            const snappedAlong = Math.round((proj.t * len) / gridStep) * gridStep;
            const tSnapped = Math.max(0.03, Math.min(0.97, snappedAlong / len));
            const sx = x1 + (x2 - x1) * tSnapped;
            const sz = z1 + (z2 - z1) * tSnapped;
            if (Math.hypot(sx - proj.x, sz - proj.z) <= Math.min(gridStep, subThresh * 1.25)) {
              pt = [sx, sz];
            }
          }
        }
        edgeSnapped = { pt, kind: "edge" };
      }
    }
    if (edgeSnapped) return edgeSnapped;
  }

  let sx = !gridStep || gridStep <= 0 ? wx : Math.round(wx / gridStep) * gridStep;
  let sz = !gridStep || gridStep <= 0 ? wz : Math.round(wz / gridStep) * gridStep;
  let alignX = null;
  let alignZ = null;

  if (snapToVertices) {
    const alignThresh = 6 / cam.scale;
    let bestDx = alignThresh, bestDz = alignThresh;
    for (let i = 0; i < editedLines.length; i++) {
      if (i === excludeIdx || editedLines[i].hidden) continue;
      for (const [ex, ez] of editedLines[i].pts) {
        const dx = Math.abs(wx - ex);
        const dz = Math.abs(wz - ez);
        if (dx < bestDx) { bestDx = dx; sx = ex; alignX = [ex, ez]; }
        if (dz < bestDz) { bestDz = dz; sz = ez; alignZ = [ex, ez]; }
      }
    }
  }

  if (!gridStep || gridStep <= 0) {
    return { pt: [sx, sz], kind: "free", alignX, alignZ };
  }
  return { pt: [sx, sz], kind: "grid", alignX, alignZ };
}

/**
 * Projects (wx, wz) onto the nearest 45° or 90° axis emanating from (fromX, fromZ).
 * Returns { pt, angle, dist }.
 */
function applyAngleConstraint(wx, wz, fromX, fromZ, angleMode = "45") {
  const dx = wx - fromX, dz = wz - fromZ;
  const raw = Math.atan2(dz, dx);
  const dist = Math.hypot(dx, dz);
  if (angleMode === "free") {
    return { pt: [wx, wz], angle: raw, dist };
  }
  const step = angleMode === "90" ? Math.PI / 2 : Math.PI / 4;
  const snapAngle = Math.round(raw / step) * step;
  return {
    pt: [fromX + Math.cos(snapAngle) * dist, fromZ + Math.sin(snapAngle) * dist],
    angle: snapAngle,
    dist,
  };
}

/**
 * Like computeSnap but after applying an angle constraint from `fromPt`.
 * Endpoint, midpoint, and edge-intersection snapping are restricted to points along the ray.
 */
function computeSnapConstrained(
  wx, wz, editedLines, cam, fromX, fromZ,
  pixThresh = 14, gridStep = 0.05, snapToVertices = true,
  angleMode = "45", excludeIdx = -1,
) {
  if (angleMode === "free") {
    return computeSnap(wx, wz, editedLines, cam, pixThresh, gridStep, snapToVertices, excludeIdx);
  }
  const { pt: [cx, cz], angle, dist } = applyAngleConstraint(wx, wz, fromX, fromZ, angleMode);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const worldEpThresh = pixThresh / cam.scale;

  let epPt = null, epKind = "endpoint";
  if (snapToVertices) {
    let bestEp = worldEpThresh;
    for (let i = 0; i < editedLines.length; i++) {
      if (i === excludeIdx || editedLines[i].hidden) continue;
      const [[x1, z1], [x2, z2]] = editedLines[i].pts;
      const cands = [
        { pt: [x1, z1], kind: "endpoint" },
        { pt: [x2, z2], kind: "endpoint" },
        { pt: [(x1 + x2) * 0.5, (z1 + z2) * 0.5], kind: "midpoint" },
      ];
      for (const cand of cands) {
        const [ex, ez] = cand.pt;
        const tPt = (ex - fromX) * cosA + (ez - fromZ) * sinA;
        if (tPt < 0) continue;
        const projX = fromX + tPt * cosA;
        const projZ = fromZ + tPt * sinA;
        const perpDist = Math.hypot(ex - projX, ez - projZ);
        const thresh = cand.kind === "midpoint" ? worldEpThresh * 0.85 : worldEpThresh;
        if (perpDist < thresh && perpDist < bestEp) {
          bestEp = perpDist;
          epPt = [projX, projZ];
          epKind = cand.kind;
        }
      }
    }

    if (!epPt) {
      let bestEdgeDist = worldEpThresh;
      for (let i = 0; i < editedLines.length; i++) {
        if (i === excludeIdx || editedLines[i].hidden) continue;
        const [[x1, z1], [x2, z2]] = editedLines[i].pts;
        const hit = lineIntersect(fromX, fromZ, fromX + cosA, fromZ + sinA, x1, z1, x2, z2);
        if (hit && hit.t > 0.01 && hit.s >= 0 && hit.s <= 1) {
          const dEdge = Math.hypot(cx - hit.pt[0], cz - hit.pt[1]);
          if (dEdge < bestEdgeDist) {
            bestEdgeDist = dEdge;
            epPt = hit.pt;
            epKind = "edge";
          }
        }
      }
    }
  }

  if (epPt) {
    return {
      pt: epPt,
      kind: epKind,
      angle,
      dist: Math.hypot(epPt[0] - fromX, epPt[1] - fromZ),
      fromPt: [fromX, fromZ],
    };
  }

  // Ortho alignment guide along horizontal or vertical ray
  let alignX = null, alignZ = null;
  if (snapToVertices) {
    const alignThresh = 6 / cam.scale;
    if (Math.abs(sinA) < 1e-4) {
      let bestDx = alignThresh, alignedXVal = null;
      for (let i = 0; i < editedLines.length; i++) {
        if (i === excludeIdx || editedLines[i].hidden) continue;
        for (const [ex, ez] of editedLines[i].pts) {
          const tAlong = (ex - fromX) * cosA;
          if (tAlong < 0) continue;
          const dx = Math.abs(cx - ex);
          if (dx < bestDx) { bestDx = dx; alignedXVal = ex; alignX = [ex, ez]; }
        }
      }
      if (alignedXVal != null) {
        const pt = [alignedXVal, fromZ];
        return { pt, kind: "angle", angle, dist: Math.abs(alignedXVal - fromX), fromPt: [fromX, fromZ], alignX };
      }
    } else if (Math.abs(cosA) < 1e-4) {
      let bestDz = alignThresh, alignedZVal = null;
      for (let i = 0; i < editedLines.length; i++) {
        if (i === excludeIdx || editedLines[i].hidden) continue;
        for (const [ex, ez] of editedLines[i].pts) {
          const tAlong = (ez - fromZ) * sinA;
          if (tAlong < 0) continue;
          const dz = Math.abs(cz - ez);
          if (dz < bestDz) { bestDz = dz; alignedZVal = ez; alignZ = [ex, ez]; }
        }
      }
      if (alignedZVal != null) {
        const pt = [fromX, alignedZVal];
        return { pt, kind: "angle", angle, dist: Math.abs(alignedZVal - fromZ), fromPt: [fromX, fromZ], alignZ };
      }
    }
  }

  if (!gridStep || gridStep <= 0) {
    return {
      pt: [cx, cz],
      kind: "angle",
      angle,
      dist,
      fromPt: [fromX, fromZ],
    };
  }

  // Grid-snap along the constrained ray when no endpoint/alignment found
  const g = gridStep;
  const tSnapped = Math.round(dist / g) * g;
  const snappedPt = [fromX + cosA * tSnapped, fromZ + sinA * tSnapped];
  return {
    pt: snappedPt,
    kind: "angle",
    angle,
    dist: Math.hypot(snappedPt[0] - fromX, snappedPt[1] - fromZ),
    fromPt: [fromX, fromZ],
  };
}

/** Find index of line closest to (wx,wz) within pixThresh px (or wall thickness), or -1. */
function findNearestLine(wx, wz, editedLines, cam, pixThresh = 10) {
  const worldThresh = pixThresh / cam.scale;
  let best = Infinity, idx = -1;
  for (let i = 0; i < editedLines.length; i++) {
    const [[x1, z1], [x2, z2]] = editedLines[i].pts;
    const d = distPointToSeg(wx, wz, x1, z1, x2, z2);
    const halfThick = normalizeWallThickness(editedLines[i].thickness) * 0.5;
    const hitThresh = Math.max(worldThresh, halfThick + 4 / cam.scale);
    if (d < hitThresh && d < best) { best = d; idx = i; }
  }
  return idx;
}

/**
 * Compute the intersection of two infinite lines defined by segments
 * (x1,z1)→(x2,z2) and (x3,z3)→(x4,z4).
 * Returns { pt: [ix, iz], t, s } where t and s are the parametric positions
 * along the first and second segment respectively, or null if parallel.
 */
function lineIntersect(x1, z1, x2, z2, x3, z3, x4, z4) {
  const d1x = x2 - x1, d1z = z2 - z1;
  const d2x = x4 - x3, d2z = z4 - z3;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-10) return null; // parallel
  const t = ((x3 - x1) * d2z - (z3 - z1) * d2x) / denom;
  const s = ((x3 - x1) * d1z - (z3 - z1) * d1x) / denom;
  return {
    pt: [x1 + t * d1x, z1 + t * d1z],
    t,
    s,
  };
}

/**
 * Given a wall segment and an intersection point, return which endpoint index
 * (0 or 1) is nearest to the intersection (i.e., the one to be extended).
 */
function nearestEndpointIdx([[x1, z1], [x2, z2]], [ix, iz]) {
  return Math.hypot(x1 - ix, z1 - iz) <= Math.hypot(x2 - ix, z2 - iz) ? 0 : 1;
}

/**
 * Find the nearest genuine 2-wall corner intersection near (wx, wz).
 * Orders (idxA, idxB) so idxB is the more horizontal wall (|ux| >= |uz|),
 * mapping W cleanly to horizontal width and D to vertical depth on orthogonal rooms.
 */
function findNearestWallCorner(wx, wz, editedLines, cam, pixThresh = 32) {
  const worldThresh = Math.max(pixThresh / cam.scale, 0.45);
  let bestDist = worldThresh;
  let best = null;

  for (let i = 0; i < editedLines.length; i++) {
    if (editedLines[i].hidden) continue;
    const [[ax1, az1], [ax2, az2]] = editedLines[i].pts;
    const lenA = Math.hypot(ax2 - ax1, az2 - az1);
    if (lenA < 0.08) continue;
    const uAx = (ax2 - ax1) / lenA, uAz = (az2 - az1) / lenA;

    for (let j = i + 1; j < editedLines.length; j++) {
      if (editedLines[j].hidden) continue;
      const [[bx1, bz1], [bx2, bz2]] = editedLines[j].pts;
      const lenB = Math.hypot(bx2 - bx1, bz2 - bz1);
      if (lenB < 0.08) continue;
      const uBx = (bx2 - bx1) / lenB, uBz = (bz2 - bz1) / lenB;

      // Require walls to meet at a meaningful angle (~>= 20 deg)
      if (Math.abs(uAx * uBz - uAz * uBx) < 0.35) continue;

      const hit = lineIntersect(ax1, az1, ax2, az2, bx1, bz1, bx2, bz2);
      if (!hit) continue;
      const [ix, iz] = hit.pt;

      const epA = nearestEndpointIdx([[ax1, az1], [ax2, az2]], [ix, iz]);
      const epB = nearestEndpointIdx([[bx1, bz1], [bx2, bz2]], [ix, iz]);
      const endDistA = Math.hypot(editedLines[i].pts[epA][0] - ix, editedLines[i].pts[epA][1] - iz);
      const endDistB = Math.hypot(editedLines[j].pts[epB][0] - ix, editedLines[j].pts[epB][1] - iz);

      // Require both walls to end at/near this corner so T-junction through-walls are never trimmed
      if (endDistA > 0.65 || endDistB > 0.65) continue;

      const dCursor = Math.hypot(wx - ix, wz - iz);
      if (dCursor < bestDist) {
        bestDist = dCursor;
        const bMoreHoriz = Math.abs(uBx) >= Math.abs(uAx);
        best = bMoreHoriz
          ? { idxA: i, idxB: j, cornerPt: [ix, iz], epA, epB }
          : { idxA: j, idxB: i, cornerPt: [ix, iz], epA: epB, epB: epA };
      }
    }
  }
  return best;
}

/**
 * Compute inner corner notch segments for two intersecting walls at cornerPt.
 * Returns ptA on wall idxA, ptB on wall idxB, and inner corner ptInner = corner + dA*uA + dB*uB.
 */
function computeCornerNotchGeometry(
  editedLines, idxA, idxB, cornerPt, targetWx, targetWz,
  fixedW = null, fixedD = null, dimStep = 0,
) {
  const lineA = editedLines[idxA], lineB = editedLines[idxB];
  if (!lineA || !lineB) return null;
  const [cx, cz] = cornerPt;
  const epA = nearestEndpointIdx(lineA.pts, cornerPt);
  const epB = nearestEndpointIdx(lineB.pts, cornerPt);
  const farA = lineA.pts[1 - epA];
  const farB = lineB.pts[1 - epB];
  const lenA = Math.hypot(farA[0] - cx, farA[1] - cz);
  const lenB = Math.hypot(farB[0] - cx, farB[1] - cz);
  if (lenA < 0.08 || lenB < 0.08) return null;

  const uxA = (farA[0] - cx) / lenA, uzA = (farA[1] - cz) / lenA;
  const uxB = (farB[0] - cx) / lenB, uzB = (farB[1] - cz) / lenB;
  const det = uxA * uzB - uzA * uxB;
  if (Math.abs(det) < 1e-4) return null;

  const vx = targetWx - cx, vz = targetWz - cz;
  let dA = (vx * uzB - vz * uxB) / det;
  let dB = (uxA * vz - uzA * vx) / det;

  if (dimStep > 0) {
    dA = Math.round(dA / dimStep) * dimStep;
    dB = Math.round(dB / dimStep) * dimStep;
  }
  if (Number.isFinite(fixedD) && fixedD > 0) dA = fixedD;
  if (Number.isFinite(fixedW) && fixedW > 0) dB = fixedW;

  dA = Math.max(0.04, Math.min(Math.max(0.05, lenA - 0.04), dA));
  dB = Math.max(0.04, Math.min(Math.max(0.05, lenB - 0.04), dB));

  const ptA = [cx + uxA * dA, cz + uzA * dA];
  const ptB = [cx + uxB * dB, cz + uzB * dB];
  const ptInner = [cx + uxA * dA + uxB * dB, cz + uzA * dA + uzB * dB];

  return { cornerPt, ptA, ptB, ptInner, dA, dB, epA, epB, idxA, idxB };
}

/**
 * Compute single-wall rectangular pillar bump-out (p1 -> p1In -> p2In -> p2).
 */
function computeWallPillarGeometry(
  editedLines, wallIdx, startPt, targetWx, targetWz,
  fixedW = null, fixedD = null, dimStep = 0,
) {
  const line = editedLines[wallIdx];
  if (!line) return null;
  const m = getWallMetrics(line);
  if (m.len < 0.08) return null;

  const t1 = Math.max(0.01, Math.min(0.99, ((startPt[0] - m.x1) * m.ux + (startPt[1] - m.z1) * m.uz) / m.len));
  const rawAlong2 = (targetWx - m.x1) * m.ux + (targetWz - m.z1) * m.uz;
  let along1 = t1 * m.len;
  let along2 = Math.max(0.01 * m.len, Math.min(0.99 * m.len, rawAlong2));
  let dPerp = (targetWx - m.x1) * m.nx + (targetWz - m.z1) * m.nz;

  if (dimStep > 0) {
    const wSnapped = Math.round((along2 - along1) / dimStep) * dimStep;
    along2 = Math.max(0.01 * m.len, Math.min(0.99 * m.len, along1 + wSnapped));
    dPerp = Math.round(dPerp / dimStep) * dimStep;
  }

  if (Number.isFinite(fixedW) && fixedW > 0) {
    const dir = along2 >= along1 ? 1 : -1;
    along2 = Math.max(0.01 * m.len, Math.min(0.99 * m.len, along1 + dir * fixedW));
  }
  if (Math.abs(along2 - along1) < 0.04) {
    const dir = along2 >= along1 ? 1 : -1;
    along2 = Math.max(0.01 * m.len, Math.min(0.99 * m.len, along1 + dir * 0.04));
  }

  const signPerp = dPerp >= 0 ? 1 : -1;
  if (Number.isFinite(fixedD) && fixedD > 0) {
    dPerp = signPerp * fixedD;
  } else if (Math.abs(dPerp) < 0.04) {
    dPerp = signPerp * 0.04;
  }

  const aMin = Math.min(along1, along2);
  const aMax = Math.max(along1, along2);
  const tMin = aMin / m.len;
  const tMax = aMax / m.len;
  const p1 = [m.x1 + m.ux * aMin, m.z1 + m.uz * aMin];
  const p2 = [m.x1 + m.ux * aMax, m.z1 + m.uz * aMax];
  const p1In = [p1[0] + m.nx * dPerp, p1[1] + m.nz * dPerp];
  const p2In = [p2[0] + m.nx * dPerp, p2[1] + m.nz * dPerp];

  return {
    wallIdx,
    p1,
    p2,
    p1In,
    p2In,
    width: aMax - aMin,
    depth: Math.abs(dPerp),
    tMin,
    tMax,
  };
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
  const strokeCol = isDelete ? "rgba(255,80,80,0.9)" : "rgba(74,160,220,0.9)";
  const fillCol = isDelete ? "rgba(255,60,60,0.08)" : "rgba(74,140,220,0.08)";
  const glowCol = isDelete ? "rgba(255,80,80,0.25)" : "rgba(74,160,220,0.25)";
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
  const dirs = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
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

function drawGrid(ctx, cam, w, h, TC, gridStep = 0.05) {
  ctx.save();

  // 1. Minor grid lines (matching configured snap resolution if zoomed in enough)
  if (gridStep > 0) {
    const minorStep = gridStep * cam.scale;
    if (minorStep >= 8) {
      ctx.strokeStyle = TC.gridLine;
      ctx.lineWidth = 0.5;
      ctx.globalAlpha = 0.20;
      let x = ((cam.ox % minorStep) + minorStep) % minorStep;
      for (; x < w; x += minorStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      let y = ((cam.oy % minorStep) + minorStep) % minorStep;
      for (; y < h; y += minorStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }
  }

  // 2. Major grid lines (1m if scale >= 18, 5m if scale >= 6, else 10m)
  let majorM = 1.0;
  if (cam.scale < 6) majorM = 10.0;
  else if (cam.scale < 18) majorM = 5.0;

  const majorStep = majorM * cam.scale;
  if (majorStep >= 10) {
    ctx.strokeStyle = TC.gridLine;
    ctx.lineWidth = majorM === 1.0 ? 0.75 : 1.0;
    ctx.globalAlpha = 0.55;
    let x = ((cam.ox % majorStep) + majorStep) % majorStep;
    for (; x < w; x += majorStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    let y = ((cam.oy % majorStep) + majorStep) % majorStep;
    for (; y < h; y += majorStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }

  ctx.restore();
}

function drawRooms(ctx, rooms, cam, highlightedRoomId, TC, { showFills = true, showLabels = true } = {}) {
  if (!rooms?.length) return;
  const hasHighlight = highlightedRoomId != null;
  ctx.save();
  for (const room of rooms) {
    const isHighlighted = room.id === highlightedRoomId;
    if (showFills) {
      const alpha = isHighlighted ? 0.30 : hasHighlight ? 0.05 : 0.14;
      const fill = withAlpha(getRoomAccent(room.id), alpha);

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
      } else if (room.bbox) {
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
        ctx.strokeStyle = TC.sel;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.strokeStyle = TC.roomBorder;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }

    if (showLabels && cam.scale > 3) {
      const fontSize = Math.max(9, Math.min(13, cam.scale * 0.7));
      const [centX, centY] = toCanvas(room.centroid_x, room.centroid_z, cam);
      ctx.font = `600 ${fontSize}px "Inter", sans-serif`;
      ctx.fillStyle = isHighlighted ? TC.sel : TC.labelRoom;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`R${room.id}  ${room.area_m2.toFixed(1)} m²`, centX, centY);
    }
  }
  ctx.restore();
}

function traceWallRect(ctx, cx1, cy1, cx2, cy2, wPx) {
  const dx = cx2 - cx1, dy = cy2 - cy1;
  const segPx = Math.hypot(dx, dy);
  if (segPx < 0.5) return false;
  const nx = (-dy / segPx) * (wPx * 0.5);
  const ny = (dx / segPx) * (wPx * 0.5);
  ctx.beginPath();
  ctx.moveTo(cx1 + nx, cy1 + ny);
  ctx.lineTo(cx2 + nx, cy2 + ny);
  ctx.lineTo(cx2 - nx, cy2 - ny);
  ctx.lineTo(cx1 - nx, cy1 - ny);
  ctx.closePath();
  return true;
}

function drawEditedWalls(
  ctx,
  editedLines,
  cam,
  hoveredIdx,
  addStart,
  snapInfo,
  editMode,
  TC,
  {
    selectedWallIdx = null,
    hoveredHandle = null,
    wallDragState = null,
    toolWallThickness = 0.20,
    typedLength = "",
  } = {},
) {
  const lw = Math.max(1.0, cam.scale * 0.09);

  // Draw hidden walls first (below active walls)
  for (let i = 0; i < editedLines.length; i++) {
    const line = editedLines[i];
    if (!line.hidden) continue;
    const [[x1, z1], [x2, z2]] = line.pts;
    const tM = normalizeWallThickness(line.thickness);
    const wPx = Math.max(1.8, tM * cam.scale);
    const isSelected = i === selectedWallIdx;
    const isHovered = !isSelected && i === hoveredIdx && (editMode === "delete" || editMode === "hide" || editMode === "select");
    const color = isSelected ? TC.sel : isHovered ? (editMode === "select" ? TC.text1 : TC.wallHover) : TC.wallHidden;
    const glow = isSelected ? TC.sel : isHovered ? TC.wallHoverGlow : TC.wallHiddenGlow;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save();
    ctx.globalAlpha = isSelected ? 0.85 : isHovered ? 0.80 : 0.45;
    ctx.lineCap = "butt";
    if (!isHovered && !isSelected) ctx.setLineDash([5, 6]);
    if (wPx >= 4.5 && traceWallRect(ctx, cx1, cy1, cx2, cy2, wPx)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.2 : isHovered ? 2.0 : 1.1;
      ctx.shadowColor = color; ctx.shadowBlur = isSelected ? 10 : isHovered ? 8 : 2;
      ctx.stroke();
    } else {
      ctx.strokeStyle = glow; ctx.lineWidth = wPx + 3;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = isSelected ? wPx + 2 : isHovered ? wPx + 2 : wPx;
      ctx.shadowColor = color; ctx.shadowBlur = isSelected ? 10 : isHovered ? 8 : 2;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Draw visible walls on top
  for (let i = 0; i < editedLines.length; i++) {
    const line = editedLines[i];
    if (line.hidden) continue;
    const { pts: [[x1, z1], [x2, z2]], source } = line;
    const isSelected = i === selectedWallIdx;
    const isDeleteHideHovered = !isSelected && i === hoveredIdx && (editMode === "delete" || editMode === "hide");
    const isSelectHovered = !isSelected && i === hoveredIdx && editMode === "select";
    const isHovered = isDeleteHideHovered || isSelectHovered;
    const color = isSelected
      ? TC.sel
      : isDeleteHideHovered
        ? TC.wallHover
        : source === "user"
          ? TC.wallUser
          : TC.wall;
    const glow = isSelected
      ? TC.sel
      : isDeleteHideHovered
        ? TC.wallHoverGlow
        : source === "user"
          ? TC.wallUserGlow
          : TC.wallGlow;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    const tM = normalizeWallThickness(line.thickness);
    const wPx = Math.max(1.8, tM * cam.scale);
    const segPx = Math.hypot(cx2 - cx1, cy2 - cy1);
    ctx.save();
    ctx.lineCap = "butt";
    if (wPx >= 4.5 && traceWallRect(ctx, cx1, cy1, cx2, cy2, wPx)) {
      ctx.globalAlpha = isSelected ? 0.42 : isDeleteHideHovered ? 0.55 : isSelectHovered ? 0.40 : 0.32;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.4 : isHovered ? 2.0 : 1.25;
      ctx.shadowColor = color; ctx.shadowBlur = isSelected ? 10 : isHovered ? 8 : 3;
      ctx.stroke();
      // Subtle centre-line
      ctx.shadowBlur = 0;
      ctx.globalAlpha = isSelected ? 0.7 : 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    } else {
      ctx.strokeStyle = glow; ctx.lineWidth = wPx + 3;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = isSelected ? wPx + 2.5 : isHovered ? wPx + 2 : wPx;
      ctx.shadowColor = color; ctx.shadowBlur = isSelected ? 10 : isHovered ? 8 : 3;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    }
    if (!isSelected && (isHovered || (cam.scale >= 32 && segPx >= 42))) {
      const mx = (cx1 + cx2) * 0.5;
      const my = (cy1 + cy2) * 0.5;
      const lbl = `${Math.round(tM * 100)} cm`;
      ctx.globalAlpha = 0.92;
      ctx.shadowBlur = 0;
      ctx.font = '600 9px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(lbl).width;
      ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(15,15,15,0.82)" : "rgba(245,245,245,0.88)";
      ctx.fillRect(mx - tw / 2 - 3, my - 6, tw + 6, 12);
      ctx.fillStyle = color;
      ctx.fillText(lbl, mx, my);
    }
    ctx.restore();
  }

  // Active drag ghost of original wall + delta readout
  if (wallDragState?.origPts) {
    const [[ox1, oz1], [ox2, oz2]] = wallDragState.origPts;
    const [ocx1, ocy1] = toCanvas(ox1, oz1, cam);
    const [ocx2, ocy2] = toCanvas(ox2, oz2, cam);
    const curLine = editedLines[wallDragState.wallIdx];
    const origT = normalizeWallThickness(curLine?.thickness);
    const origWPx = Math.max(1.8, origT * cam.scale);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = TC.text3 || "rgba(180,180,180,0.6)";
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.7;
    if (origWPx >= 4.5 && traceWallRect(ctx, ocx1, ocy1, ocx2, ocy2, origWPx)) {
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(ocx1, ocy1); ctx.lineTo(ocx2, ocy2); ctx.stroke();
    }

    if (curLine) {
      const m = getWallMetrics(curLine);
      const omx = (ox1 + ox2) * 0.5, omz = (oz1 + oz2) * 0.5;
      const [ocmx, ocmy] = toCanvas(omx, omz, cam);
      const [ccmx, ccmy] = toCanvas(m.mx, m.mz, cam);
      let dragLabel = null;
      let labelX = ccmx, labelY = ccmy - 26;

      if (wallDragState.kind === "body") {
        ctx.beginPath(); ctx.moveTo(ocmx, ocmy); ctx.lineTo(ccmx, ccmy); ctx.stroke();
        ctx.setLineDash([]);
        if (wallDragState.freeMove) {
          const dx = m.mx - omx, dz = m.mz - omz;
          dragLabel = `Δ (${dx >= 0 ? "+" : ""}${dx.toFixed(2)}, ${dz >= 0 ? "+" : ""}${dz.toFixed(2)}) m`;
        } else {
          const nCm = (wallDragState.normalOffset ?? 0) * 100;
          dragLabel = `Δ⊥ ${nCm >= 0 ? "+" : ""}${nCm.toFixed(1)} cm`;
        }
        labelX = (ocmx + ccmx) * 0.5;
        labelY = (ocmy + ccmy) * 0.5 - 16;
      } else {
        const origLen = Math.hypot(ox2 - ox1, oz2 - oz1);
        const dLen = m.len - origLen;
        dragLabel = `L ${m.len.toFixed(2)} m (${dLen >= 0 ? "+" : ""}${dLen.toFixed(2)} m) · ${Math.round(m.angleDeg)}°`;
        const [hx, hy] = toCanvas(
          wallDragState.kind === "p1" ? m.x1 : m.x2,
          wallDragState.kind === "p1" ? m.z1 : m.z2,
          cam,
        );
        labelX = hx;
        labelY = hy - 20;
      }

      if (dragLabel) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.font = 'bold 10.5px "JetBrains Mono", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(dragLabel).width;
        ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(15,15,15,0.92)" : "rgba(255,255,255,0.94)";
        ctx.fillRect(labelX - tw / 2 - 6, labelY - 9, tw + 12, 18);
        ctx.strokeStyle = TC.sel;
        ctx.lineWidth = 1;
        ctx.strokeRect(labelX - tw / 2 - 6, labelY - 9, tw + 12, 18);
        ctx.fillStyle = TC.sel;
        ctx.fillText(dragLabel, labelX, labelY);
      }
    }
    ctx.restore();
  }

  // Selected wall handles, normal (+) direction tick, and crisp dimension pill
  if (selectedWallIdx != null && selectedWallIdx >= 0 && selectedWallIdx < editedLines.length) {
    const selLine = editedLines[selectedWallIdx];
    const m = getWallMetrics(selLine);
    const [cx1, cy1] = toCanvas(m.x1, m.z1, cam);
    const [cx2, cy2] = toCanvas(m.x2, m.z2, cam);
    const [cmx, cmy] = toCanvas(m.mx, m.mz, cam);
    const segPx = Math.hypot(cx2 - cx1, cy2 - cy1);
    const wPx = Math.max(1.8, m.thickness * cam.scale);
    const snx = m.nx, sny = m.nz;

    ctx.save();
    // Normal (+) direction indicator arrow at midpoint
    if (segPx >= 16) {
      const tipDist = Math.max(14, wPx * 0.5 + 12);
      const ax = cmx + snx * tipDist;
      const ay = cmy + sny * tipDist;
      const uxScreen = m.ux, uyScreen = m.uz;
      ctx.strokeStyle = TC.sel;
      ctx.fillStyle = TC.sel;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cmx + snx * (wPx * 0.5 + 2), cmy + sny * (wPx * 0.5 + 2));
      ctx.lineTo(ax, ay);
      ctx.stroke();
      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - snx * 5 - uxScreen * 3.5, ay - sny * 5 - uyScreen * 3.5);
      ctx.lineTo(ax - snx * 5 + uxScreen * 3.5, ay - sny * 5 + uyScreen * 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("+", ax + snx * 8, ay + sny * 8);
    }

    // Endpoint handles (P1 and P2)
    for (const [key, hx, hy] of [["p1", cx1, cy1], ["p2", cx2, cy2]]) {
      const isHovHandle = hoveredHandle === key || wallDragState?.kind === key;
      const r = isHovHandle ? 7.5 : 5.5;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.fillStyle = isHovHandle ? "#ffffff" : TC.sel;
      ctx.fill();
      ctx.strokeStyle = TC.bg;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (segPx >= 36) {
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const pxLblX = hx - snx * 13, pxLblY = hy - sny * 13;
        ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(15,15,15,0.85)" : "rgba(255,255,255,0.9)";
        ctx.fillRect(pxLblX - 9, pxLblY - 6, 18, 12);
        ctx.fillStyle = TC.sel;
        ctx.fillText(key.toUpperCase(), pxLblX, pxLblY);
      }
    }

    // Midpoint body-move handle (diamond)
    const isBodyHov = hoveredHandle === "body" || wallDragState?.kind === "body";
    const dr = isBodyHov ? 7 : 5.5;
    ctx.beginPath();
    ctx.moveTo(cmx, cmy - dr);
    ctx.lineTo(cmx + dr, cmy);
    ctx.lineTo(cmx, cmy + dr);
    ctx.lineTo(cmx - dr, cmy);
    ctx.closePath();
    ctx.fillStyle = isBodyHov ? "#ffffff" : TC.sel;
    ctx.fill();
    ctx.strokeStyle = TC.bg;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Dimension readout pill on the -normal side (unless active drag badge is drawn)
    if (!wallDragState?.moved) {
      const pill = `${m.len.toFixed(2)} m · ${Math.round(m.angleDeg)}° · ${Math.round(m.thickness * 100)} cm`;
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(pill).width;
      const off = Math.max(20, wPx * 0.5 + 16);
      const px = cmx - snx * off;
      const py = cmy - sny * off;
      ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(15,15,15,0.90)" : "rgba(255,255,255,0.94)";
      ctx.fillRect(px - tw / 2 - 5, py - 8, tw + 10, 16);
      ctx.strokeStyle = TC.sel;
      ctx.lineWidth = 1;
      ctx.strokeRect(px - tw / 2 - 5, py - 8, tw + 10, 16);
      ctx.fillStyle = TC.sel;
      ctx.fillText(pill, px, py);
    }
    ctx.restore();
  }

  // In-progress wall preview (add mode with first point placed)
  if (editMode === "add" && addStart && snapInfo) {
    const [ax, az] = addStart, [sx, sz] = snapInfo.pt;
    const [cax, cay] = toCanvas(ax, az, cam), [csx, csy] = toCanvas(sx, sz, cam);
    const previewWPx = Math.max(1.8, normalizeWallThickness(toolWallThickness) * cam.scale);
    const isConstrained = snapInfo.kind === "angle" || ((snapInfo.kind === "endpoint" || snapInfo.kind === "midpoint" || snapInfo.kind === "edge") && snapInfo.angle != null);

    // ── Angle-constraint ghost guide line ───────────────────────────────────
    if (isConstrained) {
      const angle = snapInfo.angle;
      const FAR = 4000;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const cdx = cosA * cam.scale, cdz = sinA * cam.scale;
      ctx.save();
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = TC.wall + "35";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cax - cdx * FAR, cay - cdz * FAR);
      ctx.lineTo(cax + cdx * FAR, cay + cdz * FAR);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Wall preview body with actual configured thickness
    ctx.save();
    if (previewWPx >= 4.5 && traceWallRect(ctx, cax, cay, csx, csy, previewWPx)) {
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = TC.wallPreview;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = TC.wallPreview;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.setLineDash([6, 4]); ctx.lineCap = "round";
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = TC.wallPreview; ctx.lineWidth = Math.max(1.2, lw * 0.85);
    ctx.shadowColor = TC.wallPreview; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(cax, cay); ctx.lineTo(csx, csy); ctx.stroke();
    ctx.setLineDash([]);
    // Start point dot
    ctx.fillStyle = TC.wallPreview;
    ctx.beginPath(); ctx.arc(cax, cay, Math.max(3.5, lw * 1.6), 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Angle / length / typed length readout badge
    const dist = snapInfo.dist ?? Math.hypot(sx - ax, sz - az);
    const rawAngle = isConstrained ? snapInfo.angle : Math.atan2(sz - az, sx - ax);
    const angleDeg = Math.round(((rawAngle * 180 / Math.PI) % 360 + 360) % 360);
    if (dist > 0.01 || typedLength) {
      const lenStr = typedLength ? `⌨ ${typedLength} m ↵` : `${dist.toFixed(2)} m`;
      const label = `${angleDeg}° · ${lenStr} · ${Math.round(normalizeWallThickness(toolWallThickness) * 100)} cm`;
      const midCx = (cax + csx) / 2, midCy = (cay + csy) / 2;
      ctx.save();
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(20,20,20,0.88)" : "rgba(245,245,245,0.92)";
      ctx.fillRect(midCx - tw / 2 - 5, midCy - 9, tw + 10, 18);
      ctx.fillStyle = typedLength ? TC.sel : isConstrained ? TC.wall : TC.wallUser;
      ctx.fillText(label, midCx, midCy);
      ctx.restore();
    }
  }

  // Snap indicator + ortho alignment guide lines
  if (snapInfo && (editMode !== "select" || wallDragState)) {
    const [sx, sz] = snapInfo.pt;
    const [csx, csy] = toCanvas(sx, sz, cam);

    if (snapInfo.alignX || snapInfo.alignZ) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = TC.sel;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      if (snapInfo.alignX) {
        const [ax, az] = snapInfo.alignX;
        const [cax, caz] = toCanvas(ax, az, cam);
        ctx.beginPath(); ctx.moveTo(cax, caz); ctx.lineTo(csx, csy); ctx.stroke();
      }
      if (snapInfo.alignZ) {
        const [ax, az] = snapInfo.alignZ;
        const [cax, caz] = toCanvas(ax, az, cam);
        ctx.beginPath(); ctx.moveTo(cax, caz); ctx.lineTo(csx, csy); ctx.stroke();
      }
      ctx.restore();
    }

    const isAngle = snapInfo.kind === "angle";
    const isEp = snapInfo.kind === "endpoint";
    const isMid = snapInfo.kind === "midpoint";
    const isEdge = snapInfo.kind === "edge";
    const isFree = snapInfo.kind === "free";
    const r = isEp ? 7 : isMid ? 6 : isEdge ? 5.5 : isFree ? 3.5 : 5;
    const color = isEp
      ? TC.snapEp
      : isMid
        ? "#fbbf24"
        : isEdge
          ? "#38bdf8"
          : isAngle
            ? TC.wall
            : isFree
              ? "rgba(255,255,255,0.45)"
              : TC.snapGrid;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = (isEp || isMid || isEdge) ? 1.8 : 1;
    if (isFree) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(csx, csy, 2.5, 0, Math.PI * 2); ctx.fill();
    } else if (isMid) {
      const cross = r + 4;
      ctx.beginPath();
      ctx.moveTo(csx - cross, csy); ctx.lineTo(csx + cross, csy);
      ctx.moveTo(csx, csy - cross); ctx.lineTo(csx, csy + cross);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(csx, csy - r); ctx.lineTo(csx + r, csy);
      ctx.lineTo(csx, csy + r); ctx.lineTo(csx - r, csy);
      ctx.closePath(); ctx.stroke();
    } else if (isEdge) {
      ctx.strokeRect(csx - r, csy - r, r * 2, r * 2);
      ctx.beginPath(); ctx.arc(csx, csy, 2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    } else {
      const cross = r + 4;
      ctx.beginPath();
      ctx.moveTo(csx - cross, csy); ctx.lineTo(csx + cross, csy);
      ctx.moveTo(csx, csy - cross); ctx.lineTo(csx, csy + cross);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(csx, csy, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Draw the "corner" mode overlay: highlight selected wall, hover wall,
 * ghost extensions and intersection dot.
 */
function drawCornerMode(ctx, editedLines, cam, cornerState, TC) {
  if (!cornerState) return;
  const { firstIdx, hoverIdx, intersection } = cornerState;
  const lw = Math.max(1.0, cam.scale * 0.09);
  const CORNER_COLOR = "#a78bfa"; // violet
  const CORNER_GLOW = "rgba(167,139,250,0.30)";

  // Helper: draw a highlighted wall
  const hilite = (idx, color, glow, alpha = 1) => {
    if (idx < 0 || idx >= editedLines.length) return;
    const [[x1, z1], [x2, z2]] = editedLines[idx].pts;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.strokeStyle = glow; ctx.lineWidth = lw + 8;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = lw * 2;
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.restore();
  };

  // Highlight first selected wall
  if (firstIdx >= 0) hilite(firstIdx, CORNER_COLOR, CORNER_GLOW);
  // Highlight hover wall (second candidate)
  if (hoverIdx >= 0 && hoverIdx !== firstIdx) hilite(hoverIdx, TC.wallHover, TC.wallHoverGlow, 0.7);

  // Draw ghost extension lines and intersection dot
  if (intersection) {
    const [ix, iz] = intersection;
    const [cix, ciy] = toCanvas(ix, iz, cam);

    // Ghost extension for wall 1 → intersection
    if (firstIdx >= 0) {
      const pts1 = editedLines[firstIdx].pts;
      const epIdx1 = nearestEndpointIdx(pts1, [ix, iz]);
      const [epX1, epZ1] = pts1[epIdx1];
      const [cepX1, cepY1] = toCanvas(epX1, epZ1, cam);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = CORNER_COLOR; ctx.lineWidth = lw;
      ctx.globalAlpha = 0.55;
      ctx.shadowColor = CORNER_COLOR; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.moveTo(cepX1, cepY1); ctx.lineTo(cix, ciy); ctx.stroke();
      ctx.restore();
    }

    // Ghost extension for wall 2 → intersection
    if (hoverIdx >= 0 && hoverIdx !== firstIdx) {
      const pts2 = editedLines[hoverIdx].pts;
      const epIdx2 = nearestEndpointIdx(pts2, [ix, iz]);
      const [epX2, epZ2] = pts2[epIdx2];
      const [cepX2, cepY2] = toCanvas(epX2, epZ2, cam);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = TC.wallHover; ctx.lineWidth = lw;
      ctx.globalAlpha = 0.55;
      ctx.shadowColor = TC.wallHover; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.moveTo(cepX2, cepY2); ctx.lineTo(cix, ciy); ctx.stroke();
      ctx.restore();
    }

    // Intersection dot
    ctx.save();
    ctx.fillStyle = CORNER_COLOR;
    ctx.shadowColor = CORNER_COLOR; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(cix, ciy, Math.max(5, lw * 2), 0, Math.PI * 2); ctx.fill();
    // Small square inside to signal 90°
    const sq = Math.max(3, lw * 1.2);
    ctx.fillStyle = TC.bg;
    ctx.fillRect(cix - sq / 2, ciy - sq / 2, sq, sq);
    ctx.restore();

    // Distance label near the intersection dot
    if (firstIdx >= 0) {
      const pts1 = editedLines[firstIdx].pts;
      const epIdx1 = nearestEndpointIdx(pts1, [ix, iz]);
      const [epX1, epZ1] = pts1[epIdx1];
      const dist = Math.hypot(epX1 - ix, epZ1 - iz);
      if (dist > 0.01) {
        const label = `+${dist.toFixed(2)} m`;
        ctx.save();
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(20,20,20,0.88)" : "rgba(245,245,245,0.92)";
        ctx.fillRect(cix - tw / 2 - 5, ciy + 12, tw + 10, 17);
        ctx.fillStyle = CORNER_COLOR;
        ctx.fillText(label, cix, ciy + 20);
        ctx.restore();
      }
    }
  }
}

/**
 * Draw the "notch" mode preview: corner highlight, green L-notch or U-pillar segments,
 * trim indicators, and cm / m dimension readout.
 */
function drawNotchMode(ctx, editedLines, cam, notchPreview, TC, thickness = 0.12, trimCorner = true) {
  if (!notchPreview) return;
  const GREEN = "#22c55e";
  const GREEN_GLOW = "rgba(34,197,94,0.28)";
  const wPx = Math.max(2.0, normalizeWallThickness(thickness) * cam.scale);

  const hiliteWall = (idx, alpha = 0.75) => {
    if (idx == null || idx < 0 || idx >= editedLines.length) return;
    const [[x1, z1], [x2, z2]] = editedLines[idx].pts;
    const [cx1, cy1] = toCanvas(x1, z1, cam);
    const [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.strokeStyle = GREEN_GLOW;
    ctx.lineWidth = Math.max(6, wPx + 6);
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.restore();
  };

  const drawSegment = (pA, pB) => {
    const [cx1, cy1] = toCanvas(pA[0], pA[1], cam);
    const [cx2, cy2] = toCanvas(pB[0], pB[1], cam);
    ctx.save();
    if (wPx >= 4.5 && traceWallRect(ctx, cx1, cy1, cx2, cy2, wPx)) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = GREEN;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.shadowColor = GREEN; ctx.shadowBlur = 8;
      ctx.stroke();
    } else {
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = Math.max(2.2, wPx);
      ctx.shadowColor = GREEN; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    }
    ctx.restore();
  };

  const drawBadge = (cx, cy, text) => {
    ctx.save();
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = TC.bg === "#0f0f0f" ? "rgba(15,15,15,0.92)" : "rgba(255,255,255,0.94)";
    ctx.fillRect(cx - tw / 2 - 6, cy - 9, tw + 12, 18);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - tw / 2 - 6, cy - 9, tw + 12, 18);
    ctx.fillStyle = GREEN;
    ctx.fillText(text, cx, cy);
    ctx.restore();
  };

  const stage = notchPreview.stage;
  if (stage === "hover-corner") {
    hiliteWall(notchPreview.idxA, 0.7);
    hiliteWall(notchPreview.idxB, 0.7);
    const [cix, ciy] = toCanvas(notchPreview.cornerPt[0], notchPreview.cornerPt[1], cam);
    ctx.save();
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN_GLOW;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cix, ciy, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = GREEN;
    ctx.beginPath(); ctx.arc(cix, ciy, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    drawBadge(cix, ciy - 22, "┐ Click corner");
  } else if (stage === "hover-wall1") {
    hiliteWall(notchPreview.wallIdx, 0.85);
    if (notchPreview.pt) {
      const [cx, cy] = toCanvas(notchPreview.pt[0], notchPreview.pt[1], cam);
      drawBadge(cx, cy - 18, "┐ Pick 1st corner wall");
    }
  } else if (stage === "active-wall1") {
    hiliteWall(notchPreview.idxA, 0.95);
    if (notchPreview.hoverIdx >= 0 && notchPreview.hoverIdx !== notchPreview.idxA) {
      hiliteWall(notchPreview.hoverIdx, 0.65);
    }
  } else if (stage === "hover-pillar") {
    hiliteWall(notchPreview.wallIdx, 0.75);
    const [cx, cy] = toCanvas(notchPreview.startPt[0], notchPreview.startPt[1], cam);
    ctx.save();
    ctx.fillStyle = GREEN;
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    drawBadge(cx, cy - 18, "┌─┐ Click start");
  } else if (stage === "active-corner") {
    const { cornerPt, ptA, ptB, ptInner, dA, dB } = notchPreview;
    if (trimCorner) {
      const [ccx, ccy] = toCanvas(cornerPt[0], cornerPt[1], cam);
      const [cax, cay] = toCanvas(ptA[0], ptA[1], cam);
      const [cbx, cby] = toCanvas(ptB[0], ptB[1], cam);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = TC.wallHover || "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ccx, ccy); ctx.lineTo(cax, cay);
      ctx.moveTo(ccx, ccy); ctx.lineTo(cbx, cby);
      ctx.stroke();
      ctx.restore();
    }
    drawSegment(ptA, ptInner);
    drawSegment(ptInner, ptB);
    for (const pt of [ptA, ptInner, ptB]) {
      const [vx, vy] = toCanvas(pt[0], pt[1], cam);
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(vx, vy, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    const [ix, iy] = toCanvas(ptInner[0], ptInner[1], cam);
    drawBadge(ix, iy - 22, `${Math.round(dB * 100)} × ${Math.round(dA * 100)} cm (${dB.toFixed(2)} × ${dA.toFixed(2)} m)`);
  } else if (stage === "active-pillar") {
    const { p1, p2, p1In, p2In, width, depth } = notchPreview;
    if (trimCorner) {
      const [c1x, c1y] = toCanvas(p1[0], p1[1], cam);
      const [c2x, c2y] = toCanvas(p2[0], p2[1], cam);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = TC.wallHover || "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(c1x, c1y); ctx.lineTo(c2x, c2y); ctx.stroke();
      ctx.restore();
    }
    drawSegment(p1, p1In);
    drawSegment(p1In, p2In);
    drawSegment(p2In, p2);
    for (const pt of [p1, p1In, p2In, p2]) {
      const [vx, vy] = toCanvas(pt[0], pt[1], cam);
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(vx, vy, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    const [mx, my] = toCanvas((p1In[0] + p2In[0]) * 0.5, (p1In[1] + p2In[1]) * 0.5, cam);
    drawBadge(mx, my - 20, `${Math.round(width * 100)} × ${Math.round(depth * 100)} cm (${width.toFixed(2)} × ${depth.toFixed(2)} m)`);
  }
}

// Low-confidence threshold must match backend LOW_CONFIDENCE_THRESHOLD
const LOW_CONF_THRESHOLD = 0.45;

function drawDoor(ctx, op, cam) {
  const lowConf = (op.confidence ?? 1) < LOW_CONF_THRESHOLD;
  const colour = lowConf ? "#fbbf24" : C.door;   // amber vs green
  const lw = Math.max(1, cam.scale * 0.08);
  const [cx, cy] = toCanvas(op.x, op.z, cam);
  const [hx, hy] = toCanvas(op.hinge_x, op.hinge_z, cam);
  const radius = Math.hypot(cx - hx, cy - hy);
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lw;
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
  const lowConf = (op.confidence ?? 1) < LOW_CONF_THRESHOLD;
  const colour = lowConf ? "#fbbf24" : C.window;  // amber vs indigo
  const [cx1, cz1] = toCanvas(op.wall_x1, op.wall_z1, cam);
  const [cx2, cz2] = toCanvas(op.wall_x2, op.wall_z2, cam);
  const dx = cx2 - cx1, dz = cz2 - cz1;
  const t1 = op.u_start / op.wall_len, t2 = op.u_end / op.wall_len;
  const wx1 = cx1 + dx * t1, wy1 = cz1 + dz * t1;
  const wx2 = cx1 + dx * t2, wy2 = cz1 + dz * t2;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, cam.scale * 0.12);
  ctx.setLineDash(lowConf ? [3, 4] : [4, 3]);
  ctx.shadowColor = colour; ctx.shadowBlur = lowConf ? 2 : 4;
  ctx.beginPath(); ctx.moveTo(wx1, wy1); ctx.lineTo(wx2, wy2); ctx.stroke();
  ctx.restore();
}

function drawManualOpening(ctx, op, lines, cam, TC, isSelected = false, isHovered = false) {
  let wi = op.wall_idx;
  if (wi < 0 || wi >= lines.length) {
    if (op.wall_x1 != null && op.wall_z1 != null) {
      let bestDist = 1.0, foundIdx = -1;
      lines.forEach((l, i) => {
        const [[x1, z1], [x2, z2]] = l.pts;
        const d1 = Math.hypot(x1 - op.wall_x1, z1 - op.wall_z1) + Math.hypot(x2 - op.wall_x2, z2 - op.wall_z2);
        const d2 = Math.hypot(x2 - op.wall_x1, z2 - op.wall_z1) + Math.hypot(x1 - op.wall_x2, z1 - op.wall_z2);
        const minD = Math.min(d1, d2);
        if (minD < bestDist) { bestDist = minD; foundIdx = i; }
      });
      if (foundIdx >= 0) wi = foundIdx;
    }
  }
  if (wi < 0 || wi >= lines.length) return;
  const [[x1, z1], [x2, z2]] = lines[wi].pts;
  const wl = Math.hypot(x2 - x1, z2 - z1);
  if (wl < 0.001) return;

  const ux = (x2 - x1) / wl, uz = (z2 - z1) / wl;
  const nx = -uz, nz = ux;

  const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
  const mx = x1 + (x2 - x1) * t, mz = z1 + (z2 - z1) * t;

  const w_m = op.width_m ?? (op.type === "door" ? 0.9 : 1.2);
  const hw = w_m / 2;

  const jax = mx - ux * hw, jaz = mz - uz * hw;
  const jbx = mx + ux * hw, jbz = mz + uz * hw;

  const [cjax, cjay] = toCanvas(jax, jaz, cam);
  const [cjbx, cjby] = toCanvas(jbx, jbz, cam);
  const [cmx, cmy] = toCanvas(mx, mz, cam);

  const baseCol = op.type === "door" ? TC.door : TC.window;
  const strokeCol = isSelected ? "#38bdf8" : isHovered ? "#fbbf24" : baseCol;
  const glowCol = isSelected ? "rgba(56,189,248,0.5)" : isHovered ? "rgba(251,191,36,0.4)" : baseCol;

  if (op.type === "door") {
    const hingeSide = op.side === -1 ? -1 : 1;
    const swingDir = op.swing_dir === -1 ? -1 : 1;

    const hx = hingeSide === 1 ? jax : jbx;
    const hz = hingeSide === 1 ? jaz : jbz;
    const ex = hingeSide === 1 ? jbx : jax;
    const ez = hingeSide === 1 ? jbz : jaz;

    const tx = hx + swingDir * nx * w_m;
    const tz = hz + swingDir * nz * w_m;

    const [chx, chy] = toCanvas(hx, hz, cam);
    const [cex, cey] = toCanvas(ex, ez, cam);
    const [ctx_p, cty_p] = toCanvas(tx, tz, cam);

    ctx.save();
    ctx.lineCap = "round";

    ctx.strokeStyle = TC.wallHidden || "rgba(100,120,150,0.5)";
    ctx.lineWidth = Math.max(1, cam.scale * 0.04);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cjax, cjay);
    ctx.lineTo(cjbx, cjby);
    ctx.stroke();
    ctx.setLineDash([]);

    const tickLen = Math.max(3, cam.scale * 0.08);
    const cnx = - (cjby - cjay) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
    const cny = (cjbx - cjax) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = Math.max(1.5, cam.scale * 0.06);
    ctx.beginPath();
    ctx.moveTo(cjax - cnx * tickLen, cjay - cny * tickLen);
    ctx.lineTo(cjax + cnx * tickLen, cjay + cny * tickLen);
    ctx.moveTo(cjbx - cnx * tickLen, cjby - cny * tickLen);
    ctx.lineTo(cjbx + cnx * tickLen, cjby + cny * tickLen);
    ctx.stroke();

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = isSelected ? Math.max(2.5, cam.scale * 0.12) : Math.max(1.8, cam.scale * 0.09);
    ctx.shadowColor = glowCol;
    ctx.shadowBlur = isSelected ? 14 : isHovered ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(chx, chy);
    ctx.lineTo(ctx_p, cty_p);
    ctx.stroke();

    const r_px = w_m * cam.scale;
    const aClosed = Math.atan2(cey - chy, cex - chx);
    const aOpen = Math.atan2(cty_p - chy, ctx_p - chx);

    let dAngle = (aOpen - aClosed + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const ccw = dAngle < 0;

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = Math.max(1.2, cam.scale * 0.05);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(chx, chy, r_px, aClosed, aOpen, ccw);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = strokeCol;
    ctx.beginPath();
    ctx.arc(chx, chy, Math.max(3, cam.scale * 0.07), 0, Math.PI * 2);
    ctx.fill();

    if (isSelected || isHovered) {
      const dimLabel = `${w_m.toFixed(2)} m`;
      ctx.font = 'bold 10px "JetBrains Mono",monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(dimLabel).width;
      const lx = (chx + ctx_p) / 2 + cnx * 14;
      const ly = (chy + cty_p) / 2 + cny * 14;
      ctx.fillStyle = "rgba(10,14,26,0.85)";
      ctx.fillRect(lx - tw / 2 - 4, ly - 7, tw + 8, 14);
      ctx.fillStyle = strokeCol;
      ctx.fillText(dimLabel, lx, ly);
    }

    ctx.restore();
  } else if (op.type === "window") {
    const off_m = 0.05;
    const [cx1_a, cy1_a] = toCanvas(jax + nx * off_m, jaz + nz * off_m, cam);
    const [cx2_a, cy2_a] = toCanvas(jbx + nx * off_m, jbz + nz * off_m, cam);
    const [cx1_b, cy1_b] = toCanvas(jax - nx * off_m, jaz - nz * off_m, cam);
    const [cx2_b, cy2_b] = toCanvas(jbx - nx * off_m, jbz - nz * off_m, cam);

    ctx.save();
    ctx.lineCap = "square";
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = isSelected ? Math.max(2.5, cam.scale * 0.12) : Math.max(1.8, cam.scale * 0.09);
    ctx.shadowColor = glowCol;
    ctx.shadowBlur = isSelected ? 14 : isHovered ? 8 : 4;

    ctx.beginPath();
    ctx.moveTo(cx1_a, cy1_a); ctx.lineTo(cx2_a, cy2_a);
    ctx.moveTo(cx1_b, cy1_b); ctx.lineTo(cx2_b, cy2_b);
    ctx.moveTo(cx1_a, cy1_a); ctx.lineTo(cx1_b, cy1_b);
    ctx.moveTo(cx2_a, cy2_a); ctx.lineTo(cx2_b, cy2_b);
    ctx.stroke();

    ctx.strokeStyle = isSelected ? "#ffffff" : TC.window;
    ctx.lineWidth = Math.max(1.2, cam.scale * 0.06);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cjax, cjay); ctx.lineTo(cjbx, cjby);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isSelected || isHovered) {
      const dimLabel = `${w_m.toFixed(2)} m`;
      ctx.font = 'bold 10px "JetBrains Mono",monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(dimLabel).width;
      const cnx = - (cjby - cjay) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
      const cny = (cjbx - cjax) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
      const lx = cmx + cnx * 14;
      const ly = cmy + cny * 14;
      ctx.fillStyle = "rgba(10,14,26,0.85)";
      ctx.fillRect(lx - tw / 2 - 4, ly - 7, tw + 8, 14);
      ctx.fillStyle = strokeCol;
      ctx.fillText(dimLabel, lx, ly);
    }

    ctx.restore();
  }
}

function drawOpenings(ctx, openings, cam, TC, { showDoors = true, showWindows = true } = {}) {
  if (!openings?.length) return;
  // Draw high-confidence openings first so low-conf amber sits on top
  const sorted = [...openings].sort((a, b) =>
    ((b.confidence ?? 1) >= LOW_CONF_THRESHOLD ? 1 : 0) -
    ((a.confidence ?? 1) >= LOW_CONF_THRESHOLD ? 1 : 0)
  );
  for (const op of sorted) {
    if (op.type === "door" && showDoors) drawDoor(ctx, op, cam);
    if (op.type === "window" && showWindows) drawWindow(ctx, op, cam);
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

function drawCompass(ctx, w, TC) {
  const cx = w - 30, cy = 30, r = 14;
  ctx.save();
  ctx.font = 'bold 10px "Inter", sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = TC.danger || "#ef4444";
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = TC.text3 || "rgba(255,255,255,0.3)";
  ctx.beginPath(); ctx.moveTo(cx, cy + r); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = TC.danger || "#ef4444";
  ctx.fillText("N", cx, cy - r - 9);
  ctx.restore();
}

// ── EditToolbar ────────────────────────────────────────────────────────────────

const TOOLS = [
  { id: "select", icon: "✋", label: "Select / Pan", key: "S", title: "Select & Move Walls, Rooms, or Pan (S)" },
  { id: "add", icon: "✏️", label: "Add Wall", key: "A", title: "Add Wall (A)" },
  { id: "add-door", icon: "🚪", label: "Door", key: "Q", title: "Add Door — click wall (Q)" },
  { id: "add-window", icon: "🪟", label: "Window", key: "W", title: "Add Window — click wall (W)" },
  { id: "delete", icon: "✂️", label: "Delete", key: "D", title: "Delete Wall / Opening (D)" },
  { id: "hide", icon: "👁", label: "Hide", key: "H", title: "Hide/Show Wall (H) — hides from room recalc" },
  { id: "corner", icon: "⌐", label: "Corner", key: "C", title: "Extend to Corner (C) — extend two walls to their intersection" },
  { id: "notch", icon: "┐", label: "Notch", key: "N", title: "Box Corner / Pillar Notch (N) — add stepped room corners in 2 clicks" },
];

const SNAP_PRESETS = [
  { label: "Free", value: 0, title: "Free placement (no grid snap)" },
  { label: "1cm", value: 0.01, title: "1 cm precision snap (0.01 m)" },
  { label: "5cm", value: 0.05, title: "5 cm precision snap (0.05 m) — recommended" },
  { label: "10cm", value: 0.10, title: "10 cm grid snap (0.10 m)" },
  { label: "50cm", value: 0.50, title: "50 cm grid snap (0.50 m) — coarse" },
];

const ORTHO_MODES = [
  { id: "off", label: "Off", shortLabel: "Off", title: "Hide orthographic scan reference" },
  { id: "cloud-walls", label: "Cloud · Walls", shortLabel: "☁ Walls", title: "Full-density point cloud filtered to walls (floor & ceiling omitted)" },
  { id: "cloud-slice", label: "Cloud · Slice", shortLabel: "☁ Slice", title: "Point cloud horizontal slice with floor & ceiling omitted" },
  { id: "photo-walls", label: "Photo · Walls", shortLabel: "📷 Walls", title: "Photo-textured wall ribbons only (floor & ceiling omitted)" },
  { id: "photo-cutaway", label: "Photo · Omit Ceiling", shortLabel: "📷 Photo", title: "Photo-textured interior with ceiling omitted" },
];

function EditToolbar({
  mode, onMode, canUndo, canRedo, onUndo, onRedo,
  isDirty, onSave, onReset, saveState, wallCount, roomCount, userCount, hiddenCount, cornerStep,
  gridStep, onGridStep, snapToVertices, onToggleSnapToVertices,
  orthoMode, onOrthoMode, orthoLoading,
  onFit, dxfUrl, ifcUrl, ifcAllUrl, selectedFloor, saveName,
}) {
  const toolBtn = (id, icon, label, title) => {
    const isActive = mode === id;
    const isCorner = id === "corner";
    const cornerLabel = isCorner && isActive
      ? (cornerStep === 1 ? "Corner ①" : "Corner ②")
      : label;
    return (
      <button
        key={id}
        onClick={() => onMode(id)}
        title={title}
        className={`s2f-btn s2f-btn-sm${isActive ? " active" : ""}`}
        style={{
          padding: "4px 9px",
          fontSize: 11.5,
          borderColor: isActive ? "var(--sel)" : "var(--border)",
          background: isActive ? "var(--sel-dim)" : "var(--surface-2)",
          color: isActive ? "var(--sel)" : "var(--text-2)",
        }}
      >
        <span>{icon}</span><span>{cornerLabel}</span>
      </button>
    );
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "6px 12px", flexShrink: 0,
      background: "var(--surface)",
      borderBottom: "1px solid var(--border)",
      flexWrap: "wrap",
    }}>
      {TOOLS.map(t => toolBtn(t.id, t.icon, t.label, t.title))}

      <div style={{ width: 1, height: 18, background: "var(--border-hi)", margin: "0 2px" }} />

      <button className="s2f-iconbtn s2f-iconbtn-sm" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">↩</button>
      <button className="s2f-iconbtn s2f-iconbtn-sm" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">↪</button>

      <div style={{ width: 1, height: 18, background: "var(--border-hi)", margin: "0 2px" }} />

      {/* Snap controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600 }}>Grid</span>
        <div className="s2f-seg">
          {SNAP_PRESETS.map(p => (
            <button
              key={p.value}
              className={gridStep === p.value ? "active" : ""}
              onClick={() => onGridStep(p.value)}
              title={p.title}
              style={{ padding: "3px 8px", fontSize: 11 }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button
          onClick={onToggleSnapToVertices}
          title={snapToVertices ? "Vertex Snap ON (click to disable snapping to wall endpoints)" : "Vertex Snap OFF (click to enable snapping to wall endpoints)"}
          className="s2f-btn s2f-btn-sm"
          style={{
            padding: "4px 8px",
            fontSize: 11,
            borderColor: snapToVertices ? "var(--sel)" : "var(--border)",
            background: snapToVertices ? "var(--sel-dim)" : "var(--surface-2)",
            color: snapToVertices ? "var(--sel)" : "var(--text-3)",
          }}
        >
          {snapToVertices ? "⌖ Vertex ON" : "⌖ Vertex OFF"}
        </button>
      </div>

      <div style={{ width: 1, height: 18, background: "var(--border-hi)", margin: "0 2px" }} />

      {/* Orthographic scan reference selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600 }}>Scan</span>
        <div className="s2f-seg">
          {ORTHO_MODES.map(om => (
            <button
              key={om.id}
              type="button"
              className={orthoMode === om.id ? "active" : ""}
              onClick={() => onOrthoMode(om.id)}
              title={om.title}
              style={{ padding: "3px 7px", fontSize: 11 }}
            >
              {om.shortLabel}{orthoLoading && orthoMode === om.id ? " ⏳" : ""}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <span className="s2f-mono" style={{ fontSize: 11, color: "var(--text-3)", display: "flex", gap: 6, alignItems: "center" }}>
        <span>{wallCount}W · {roomCount}R</span>
        {userCount > 0 && <span style={{ color: "var(--sel)" }}>+{userCount}</span>}
        {hiddenCount > 0 && <span>· {hiddenCount} hidden</span>}
      </span>

      <button className="s2f-btn s2f-btn-sm" onClick={onFit} title="Fit plan to view">⌖ Fit</button>

      <a
        href={dxfUrl}
        download={`floor_${selectedFloor}.dxf`}
        className="s2f-btn s2f-btn-sm"
        style={{ textDecoration: "none", padding: "4px 9px", fontSize: 11.5 }}
      >
        ↓ DXF
      </a>
      <a
        href={ifcUrl}
        download={`floor_${selectedFloor}.ifc`}
        title={`Download IFC 2x3 for Floor ${selectedFloor}`}
        className="s2f-btn s2f-btn-sm"
        style={{ textDecoration: "none", padding: "4px 9px", fontSize: 11.5 }}
      >
        ↓ IFC
      </a>
      <a
        href={ifcAllUrl}
        download={saveName ? `${saveName}_building.ifc` : "building.ifc"}
        title="Download full-building IFC 2x3 (all floors)"
        className="s2f-btn s2f-btn-sm"
        style={{ textDecoration: "none", padding: "4px 9px", fontSize: 11.5 }}
      >
        ↓ IFC All
      </a>

      {isDirty && (
        <button className="s2f-btn s2f-btn-sm s2f-btn-danger" onClick={onReset} title="Discard all edits" style={{ padding: "4px 9px", fontSize: 11.5 }}>
          ↺ Discard
        </button>
      )}

      <button
        onClick={onSave}
        disabled={!isDirty || saveState === "saving"}
        title="Save edits and recalculate rooms (Ctrl+S) — hidden walls excluded"
        className={`s2f-btn s2f-btn-sm${isDirty && saveState !== "saving" ? " s2f-btn-primary" : ""}`}
        style={{ padding: "4px 10px", fontSize: 11.5 }}
      >
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : "Save"}
      </button>
    </div>
  );
}

// ── Mode hint bar ──────────────────────────────────────────────────────────────

const MODE_HINTS = {
  select: "Click wall to select & move · Drag handles to resize/offset · Arrows to nudge · Drag empty space to pan",
  add: "Click to place first point → click again or type length + Enter · Esc to end chain",
  delete: "Click a wall to delete · Hold & drag to box-delete all walls in area · Esc to exit",
  hide: "Click a wall to hide/unhide · Hold & drag to box-hide all walls in area · Esc to exit",
  corner: "Click first wall → click second wall → both extend to their intersection  ·  Esc to cancel",
  notch: "Hover & click a corner (or 2 walls) to notch/box it in  ·  Esc to exit",
};
const ADD_HINT_FREE = "Click to start wall  ·  T-snap / midpoint / vertex snap ON  ·  Alt: free snap";
const ADD_HINT_PLACED = "🔒 Angle lock  ·  Type length (m) + Enter  ·  Shift: free angle  ·  Alt: free snap  ·  Esc: end chain";
const ADD_HINT_FREE_DRAW = "✏ Free angle  ·  Type length (m) + Enter  ·  Alt: free snap  ·  Esc: end chain";
const CORNER_HINT_STEP1 = "⌐ Select first wall to extend  ·  Esc to cancel";
const CORNER_HINT_STEP2 = "⌐ Select second wall — both will extend to intersection  ·  Esc to cancel";
const CORNER_HINT_NONE = "⌐ No valid intersection found for these walls";

function ModeHint({ mode, addStep, freeDrawMode, cornerStep, cornerHasIntersection, notchStep, notchSubMode }) {
  let text;
  if (mode === "add") {
    if (!addStep) text = ADD_HINT_FREE;
    else if (freeDrawMode) text = ADD_HINT_FREE_DRAW;
    else text = ADD_HINT_PLACED;
  } else if (mode === "corner") {
    if (cornerStep === 0) text = CORNER_HINT_STEP1;
    else if (cornerStep === 1 && cornerHasIntersection) text = CORNER_HINT_STEP2;
    else if (cornerStep === 1) text = CORNER_HINT_NONE;
    else text = MODE_HINTS.corner;
  } else if (mode === "notch") {
    if (notchSubMode === "pillar") {
      text = notchStep === 0
        ? "┌─┐ Click wall where the pillar/bump-out starts  ·  Esc to exit"
        : "┌─┐ Move cursor to size width × depth (or enter W/D) → click to place  ·  Esc to cancel";
    } else {
      text = notchStep === 0
        ? "┐ Hover & click a corner (or 2 walls) to notch/box it in  ·  Esc to exit"
        : "┐ Move cursor inside room to size L-corner (or enter W/D) → click to place  ·  Esc to cancel";
    }
  } else {
    text = MODE_HINTS[mode] ?? "";
  }
  const isLocked = mode === "add" && addStep && !freeDrawMode;
  const isCorner = mode === "corner";
  const isNotch = mode === "notch";
  const isNoInter = mode === "corner" && cornerStep === 1 && !cornerHasIntersection;
  return (
    <div style={{
      position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)",
      background: "rgba(var(--panel-rgb), 0.92)",
      border: isLocked ? "1px solid var(--sel)"
        : isCorner ? "1px solid var(--layer-window)"
          : isNotch ? "1px solid var(--green)"
            : "1px solid var(--border-hi)",
      borderRadius: "var(--radius-sm)", padding: "4px 12px",
      fontSize: 10.5,
      color: isNoInter ? "var(--red)"
        : isCorner ? "var(--layer-window)"
          : isNotch ? "var(--green)"
            : isLocked ? "var(--sel)"
              : mode === "select" ? "var(--text-3)" : "var(--amber)",
      fontFamily: "Inter, sans-serif", whiteSpace: "nowrap", pointerEvents: "none",
      boxShadow: "0 4px 14px rgba(var(--shadow-rgb), 0.25)",
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
    { color: TC.wall, label: `Walls (${Math.max(0, visibleAlgo)})` },
    ...(userCount > 0 ? [{ color: TC.wallUser, label: `Added walls (${userCount})` }] : []),
    { color: TC.door, label: `Doors (${doorCount})` },
    { color: TC.window, label: `Windows (${windowCount})` },
    { color: TC.room, label: `Rooms (${roomCount})`, fill: true },
  ];
  return (
    <div style={{
      position: "absolute", bottom: 10, right: 10,
      background: "rgba(var(--panel-rgb), 0.92)",
      border: "1px solid var(--border-hi)", borderRadius: "var(--radius)",
      padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5, minWidth: 155,
      boxShadow: "0 8px 24px rgba(var(--shadow-rgb), 0.3)",
    }}>
      {items.map(({ color, label, fill }) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {fill
            ? <div style={{ width: 14, height: 10, background: withAlpha(color, 0.22), border: `1px solid ${color}`, borderRadius: 2 }} />
            : <div style={{ width: 14, height: 2.5, background: color, borderRadius: 2 }} />
          }
          <span style={{ fontSize: 10.5, color: "var(--text-2)", fontFamily: "Inter,sans-serif" }}>{label}</span>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 2 }}>
          <div style={{
            width: 14, height: 2, borderRadius: 2, opacity: 0.7,
            backgroundImage: `repeating-linear-gradient(90deg,${TC.wallHidden} 0 5px,transparent 5px 9px)`
          }} />
          <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "Inter,sans-serif", fontWeight: 600 }}>{hiddenCount} hidden</span>
        </div>
      )}
      {lowConfCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 2 }}>
          <div style={{ width: 14, height: 2.5, borderRadius: 2, backgroundImage: "repeating-linear-gradient(90deg,#fbbf24 0 4px,transparent 4px 7px)" }} />
          <span style={{ fontSize: 10.5, color: "var(--amber)", fontFamily: "Inter,sans-serif", fontWeight: 600 }}>⚠ {lowConfCount} low-confidence</span>
        </div>
      )}
    </div>
  );
}

// ── Room height helper ─────────────────────────────────────────────────────────
function deriveRoomHeight(modelInfo, floorIdx) {
  const levels = modelInfo?.floor_levels;
  if (!levels || levels.length < 2) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  const idx = Math.min(floorIdx, sorted.length - 2);
  const h = Math.abs(sorted[idx + 1] - sorted[idx]);
  return h > 0.5 ? h : null;
}

// ── RoomInfoChip ───────────────────────────────────────────────────────────────
function RoomInfoChip({ room, floorIdx, modelInfo, onOpenRoomEditor, onDeselect }) {
  if (!room) return null;
  const height = deriveRoomHeight(modelInfo, floorIdx);
  const roomLen = Math.abs(room.bbox.z_max - room.bbox.z_min);
  const roomW = Math.abs(room.bbox.x_max - room.bbox.x_min);
  const dimA = Math.max(roomLen, roomW);
  const dimB = Math.min(roomLen, roomW);
  return (
    <div style={{
      position: "absolute", bottom: 44, left: 12,
      background: "rgba(var(--panel-rgb), 0.94)",
      border: "1px solid var(--border-hi)", borderRadius: "var(--radius)",
      padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6,
      boxShadow: "0 8px 28px rgba(var(--shadow-rgb), 0.35)",
      pointerEvents: "auto", minWidth: 185,
      zIndex: 18,
      animation: "fadeIn 0.18s ease",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="badge badge-sel">Room {room.id}</span>
          <span className="s2f-mono" style={{ fontSize: 10, color: "var(--text-3)" }}>selected</span>
        </div>
        {onDeselect && (
          <button
            onClick={onDeselect}
            style={{
              background: "transparent", border: "none", color: "var(--text-3)",
              cursor: "pointer", fontSize: 12, padding: "2px 4px", borderRadius: 4,
            }}
            title="Deselect room"
          >✕</button>
        )}
      </div>
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
          <span style={{
            fontSize: 11, fontFamily: "JetBrains Mono, monospace", fontWeight: 600,
            color: height ? "var(--text-1)" : "var(--text-3)"
          }}>
            {height ? `≈ ${height.toFixed(2)} m` : "—"}
          </span>
        </div>
      </div>

      {onOpenRoomEditor && (
        <button
          onClick={onOpenRoomEditor}
          className="s2f-btn s2f-btn-sm s2f-btn-primary"
          style={{ marginTop: 4 }}
          title="Open isolated Room Editor panel"
        >
          Open Room Editor
        </button>
      )}
    </div>
  );
}

function DraftNumberInput({
  value,
  onCommit,
  step = 0.01,
  min,
  max,
  decimals = 2,
  style,
  className = "rep-subbar-input",
  title,
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const numVal = Number.isFinite(Number(value)) ? Number(value) : 0;
  const displayVal = focused ? draft : String(Number(numVal.toFixed(decimals)));

  const tryCommit = (raw) => {
    if (raw === "" || raw === "-" || raw === "." || raw === "-." || raw.endsWith(".")) return;
    let parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    if (min != null) parsed = Math.max(min, parsed);
    if (max != null) parsed = Math.min(max, parsed);
    if (Math.abs(parsed - numVal) > 1e-6) {
      onCommit(parsed);
    }
  };

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      title={title}
      className={className}
      style={style}
      value={displayVal}
      onFocus={() => {
        setFocused(true);
        setDraft(String(Number(numVal.toFixed(decimals))));
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        tryCommit(raw);
      }}
      onBlur={(e) => {
        tryCommit(e.target.value);
        setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          tryCommit(e.currentTarget.value);
          setFocused(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export default function FloorPlanViewer({
  modelInfo,
  dataVersion = 0,
  onClose,
  highlightedRoomId,
  onSelectRoom,
  onSelectFloor,
  activeFloor = 0,
  roomMode = "polygon",
  saveName = null,
  onWallsSaved,
  mpInstances = [],
  mpSweeps = {},
  mpPoints = [],
  mpInventory = [],
  livePose = null,
  fpvPoseStore = null,
  visible = true,
  selectedMpItem = null,
  onSelectMpItem,
  hiddenMpLabels: sharedHiddenMpLabels,
  setHiddenMpLabels: sharedSetHiddenMpLabels,
  // Optional shared layer state (synced with the 3D viewer). Falls back to local state.
  sharedShowMpEquip,
  sharedSetShowMpEquip,
  sharedShowMpSweeps,
  sharedSetShowMpSweeps,
  sharedShowMpAiHints,
  sharedSetShowMpAiHints,
  sharedShowMpPoints,
  sharedSetShowMpPoints,
  sharedShowMpLive,
  sharedSetShowMpLive,
  bimFilters,
  setBimFilters,
}) {
  const canvasRef = useRef(null);
  const camRef = useRef({ scale: 8, ox: 300, oy: 300 });
  const rafRef = useRef(null);

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
      .catch(() => { });
    return () => { cancelled = true; };
  }, [saveName]);

  const activeModelInfo = saveName ? (saveInfo || modelInfo) : modelInfo;
  const rawFloors = activeModelInfo?.floor_levels;
  // If viewing a save and floor_levels is not available yet or empty, default to at least [0]
  const floors = (rawFloors && rawFloors.length > 0)
    ? rawFloors
    : (saveName ? [0] : (modelInfo?.floor_levels ?? []));

  // ── Data fetch state ────────────────────────────────────────────────────────
  const [selectedFloor, setSelectedFloor] = useState(
    activeFloor === "all" || activeFloor == null ? 0 : Number(activeFloor)
  );
  const [roomsData, setRoomsData] = useState(null);
  const [openingsData, setOpeningsData] = useState(null);
  const [loadState, setLoadState] = useState("idle");

  // ── Layer & equipment filters (matching MiniPlan & 3D Viewer) ───────────────
  const [layersOpen, setLayersOpen] = useState(true);
  const [localLayerOpts, setLocalLayerOpts] = useState({
    walls: true,
    rooms: true,
    roomLabels: true,
    doors: true,
    windows: true,
    grid: true,
    scale: true,
  });
  const [localMpEquip, setLocalMpEquip] = useState(true);
  const [localMpSweeps, setLocalMpSweeps] = useState(false);
  const [localMpAiHints, setLocalMpAiHints] = useState(true);
  const [localMpPoints, setLocalMpPoints] = useState(true);
  const [localMpLive, setLocalMpLive] = useState(true);
  const [localHiddenMpLabels, setLocalHiddenMpLabels] = useState([]);

  const showWalls = bimFilters ? !!bimFilters.walls : localLayerOpts.walls;
  const showRooms = bimFilters ? !!bimFilters.rooms : localLayerOpts.rooms;
  const showRoomLabels = localLayerOpts.roomLabels;
  const showDoors = bimFilters ? !!bimFilters.doors : localLayerOpts.doors;
  const showWindows = bimFilters ? !!bimFilters.windows : localLayerOpts.windows;
  const showGrid = localLayerOpts.grid;
  const showScale = localLayerOpts.scale;

  const setPlanLayer = (key, val) => {
    if (setBimFilters && (key === "walls" || key === "rooms" || key === "doors" || key === "windows")) {
      setBimFilters((prev) => ({ ...prev, [key]: val }));
    } else {
      setLocalLayerOpts((prev) => ({ ...prev, [key]: val }));
    }
  };

  const showMpEquip = sharedShowMpEquip ?? localMpEquip;
  const setShowMpEquip = sharedSetShowMpEquip ?? setLocalMpEquip;
  const showMpSweeps = sharedShowMpSweeps ?? localMpSweeps;
  const setShowMpSweeps = sharedSetShowMpSweeps ?? setLocalMpSweeps;
  const showMpAiHints = sharedShowMpAiHints ?? localMpAiHints;
  const setShowMpAiHints = sharedSetShowMpAiHints ?? setLocalMpAiHints;
  const showMpPoints = sharedShowMpPoints ?? localMpPoints;
  const setShowMpPoints = sharedSetShowMpPoints ?? setLocalMpPoints;
  const showMpLive = sharedShowMpLive ?? localMpLive;
  const setShowMpLive = sharedSetShowMpLive ?? setLocalMpLive;
  const hiddenMpLabels = sharedHiddenMpLabels ?? localHiddenMpLabels;
  const setHiddenMpLabels = sharedSetHiddenMpLabels ?? setLocalHiddenMpLabels;

  const toggleMpLabel = (label) =>
    setHiddenMpLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );

  const labelInfo = useMemo(() => {
    const names = {};
    (mpInventory || []).forEach((r) => { names[r.label] = r.cz || r.en || r.label; });
    const counts = {};
    (mpInstances || []).forEach((inst) => {
      if (!inst?.s2f_position) return;
      if (inst.floor_idx == null || Number(inst.floor_idx) !== Number(selectedFloor)) return;
      counts[inst.label] = (counts[inst.label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => ({ label, count, name: names[label] || label }))
      .sort((a, b) => b.count - a.count);
  }, [mpInstances, mpInventory, selectedFloor]);

  const totalEquipCount = labelInfo.reduce((acc, item) => acc + item.count, 0);
  const visibleEquipCount = labelInfo.reduce(
    (acc, item) => (hiddenMpLabels.includes(item.label) ? acc : acc + item.count),
    0
  );

  // Keep selected floor synced with top-bar activeFloor
  useEffect(() => {
    const fNum = activeFloor === "all" || activeFloor == null ? 0 : Number(activeFloor);
    if (!Number.isNaN(fNum) && fNum !== selectedFloor) {
      addStepRef.current = null; setAddStep(null); snapRef.current = null;
      wallDragRef.current = null;
      notchStateRef.current = null; setNotchStep(0);
      notchPreviewRef.current = null; setNotchPreview(null);
      setSelectedWallIdx(null); selectedWallIdxRef.current = null;
      setHoveredHandle(null); hoveredHandleRef.current = null;
      setTypedWallLength(""); typedWallLengthRef.current = "";
      setEditMode("select"); editModeRef.current = "select";
      setSelectedFloor(fNum);
    }
  }, [activeFloor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep selected floor in bounds if number of floors changes
  useEffect(() => {
    const numFloors = floors.length || 1;
    if (selectedFloor >= numFloors) {
      setSelectedFloor(0);
    }
  }, [floors, selectedFloor]);

  // ── Edit state ──────────────────────────────────────────────────────────────
  // editedLines: [{pts: [[x1,z1],[x2,z2]], source: 'algo'|'user', hidden?: true}]
  const [editedLines, setEditedLines] = useState([]);
  const [editMode, setEditMode] = useState("select");
  const [addStep, setAddStep] = useState(null);   // first point of new wall
  const [hoveredLine, setHoveredLine] = useState(-1);
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle|saving|saved|error
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  // Wall selection & precision customization / placement state
  const [selectedWallIdx, setSelectedWallIdx] = useState(null);
  const [hoveredHandle, setHoveredHandle] = useState(null);
  const [moveConnectedCorners, setMoveConnectedCorners] = useState(true);
  const [resizeAnchor, setResizeAnchor] = useState("p1");
  const [toolWallThickness, setToolWallThickness] = useState(0.20);
  const [wallChainMode, setWallChainMode] = useState(true);
  const [wallAngleLockMode, setWallAngleLockMode] = useState("45"); // '45' | '90' | 'free'
  const [typedWallLength, setTypedWallLength] = useState("");

  // Orthographic scan reference underlay (point cloud / photo texture, floor & ceiling omitted)
  const [orthoMode, setOrthoMode] = useState("off"); // 'off' | 'cloud-walls' | 'cloud-slice' | 'photo-walls' | 'photo-cutaway'
  const [orthoOpacity, setOrthoOpacity] = useState(0.68);
  const [orthoBottomCut, setOrthoBottomCut] = useState(0.30);
  const [orthoTopCut, setOrthoTopCut] = useState(0.35);
  const [orthoLoading, setOrthoLoading] = useState(false);
  const [orthoError, setOrthoError] = useState(null);
  const orthoDataRef = useRef(null);
  const orthoModeRef = useRef("off");
  const orthoOpacityRef = useRef(0.68);
  const prevOrthoFloorRef = useRef(selectedFloor);

  // Refs for event handlers (avoid stale closures)
  const editModeRef = useRef("select");
  const editedLinesRef = useRef([]);
  const addStepRef = useRef(null);
  const hoveredLineRef = useRef(-1);
  const selectedWallIdxRef = useRef(null);
  const hoveredHandleRef = useRef(null);
  const wallDragRef = useRef(null);
  const moveConnectedCornersRef = useRef(true);
  const toolWallThicknessRef = useRef(0.20);
  const wallChainModeRef = useRef(true);
  const wallAngleLockModeRef = useRef("45");
  const typedWallLengthRef = useRef("");
  const snapRef = useRef(null);
  const dragRef = useRef(null);
  // Box-select drag state for delete/hide modes
  // { startCx, startCy, cx1, cy1, cx2, cy2, moved }
  const boxSelectRef = useRef(null);
  // Tracks whether Shift is currently held (for angle-snap in add mode)
  const shiftRef = useRef(false);
  // freeDrawMode: true when Shift is held to override angle-lock
  const [freeDrawMode, setFreeDrawMode] = useState(false);

  // Corner notch / wall pillar tool state
  const [notchSubMode, setNotchSubMode] = useState("corner"); // 'corner' | 'pillar'
  const [toolNotchThickness, setToolNotchThickness] = useState(0.12);
  const [trimNotchCorner, setTrimNotchCorner] = useState(true);
  const [notchFixedW, setNotchFixedW] = useState("");
  const [notchFixedD, setNotchFixedD] = useState("");
  const [notchStep, setNotchStep] = useState(0);
  const [notchPreview, setNotchPreview] = useState(null);
  const notchSubModeRef = useRef("corner");
  const toolNotchThicknessRef = useRef(0.12);
  const trimNotchCornerRef = useRef(true);
  const notchFixedWRef = useRef("");
  const notchFixedDRef = useRef("");
  const notchStateRef = useRef(null);
  const notchPreviewRef = useRef(null);
  const lastNotchTargetRef = useRef(null);

  // Corner tool state: { firstIdx } when first wall is selected, null otherwise
  // cornerState ref for event handlers; cornerStateUi for React re-renders
  const cornerStateRef = useRef(null); // { firstIdx } | null
  const [cornerStep, setCornerStep] = useState(0); // 0=pick first, 1=pick second
  const [cornerHoverIdx, setCornerHoverIdx] = useState(-1);
  const [cornerIntersection, setCornerIntersection] = useState(null);

  // ── Snap and grid resolution state ──────────────────────────────────────────
  // gridStep: 0 (free placement), 0.01 (1cm), 0.05 (5cm), 0.10 (10cm), 0.50 (50cm)
  const [gridStep, setGridStep] = useState(0.05);
  const [snapToVertices, setSnapToVertices] = useState(true);

  const gridStepRef = useRef(0.05);
  const snapToVerticesRef = useRef(true);

  // ── Openings editing state ──────────────────────────────────────────────────
  const [userOpenings, setUserOpenings] = useState([]);
  const [openingsDirty, setOpeningsDirty] = useState(false);
  const [selectedOpIdx, setSelectedOpIdx] = useState(null);
  const [hoverManualOp, setHoverManualOp] = useState(-1);
  const [hoverOp, setHoverOp] = useState(null); // { wallIdx, position_t }

  // Tool parameter defaults
  const [toolDoorWidth, setToolDoorWidth] = useState(0.9);
  const [toolDoorHingeSide, setToolDoorHingeSide] = useState(1);
  const [toolDoorSwingDir, setToolDoorSwingDir] = useState(1);
  const [toolDoorTopMargin, setToolDoorTopMargin] = useState(0.7);
  const [toolWindowWidth, setToolWindowWidth] = useState(1.2);
  const [toolWindowBottomMargin, setToolWindowBottomMargin] = useState(0.9);
  const [toolWindowTopMargin, setToolWindowTopMargin] = useState(0.7);

  const userOpeningsRef = useRef([]);
  const hoverManualOpRef = useRef(-1);
  const hoverOpeningRef = useRef(null);
  const selectedOpIdxRef = useRef(null);

  useEffect(() => { editModeRef.current = editMode; }, [editMode]);
  useEffect(() => { editedLinesRef.current = editedLines; }, [editedLines]);
  useEffect(() => { addStepRef.current = addStep; }, [addStep]);
  useEffect(() => { hoveredLineRef.current = hoveredLine; }, [hoveredLine]);
  useEffect(() => { selectedWallIdxRef.current = selectedWallIdx; }, [selectedWallIdx]);
  useEffect(() => { hoveredHandleRef.current = hoveredHandle; }, [hoveredHandle]);
  useEffect(() => { moveConnectedCornersRef.current = moveConnectedCorners; }, [moveConnectedCorners]);
  useEffect(() => { toolWallThicknessRef.current = toolWallThickness; }, [toolWallThickness]);
  useEffect(() => { wallChainModeRef.current = wallChainMode; }, [wallChainMode]);
  useEffect(() => { wallAngleLockModeRef.current = wallAngleLockMode; }, [wallAngleLockMode]);
  useEffect(() => { typedWallLengthRef.current = typedWallLength; }, [typedWallLength]);
  useEffect(() => { orthoModeRef.current = orthoMode; }, [orthoMode]);
  useEffect(() => { orthoOpacityRef.current = orthoOpacity; }, [orthoOpacity]);
  useEffect(() => { notchSubModeRef.current = notchSubMode; }, [notchSubMode]);
  useEffect(() => { toolNotchThicknessRef.current = toolNotchThickness; }, [toolNotchThickness]);
  useEffect(() => { trimNotchCornerRef.current = trimNotchCorner; }, [trimNotchCorner]);
  useEffect(() => { notchFixedWRef.current = notchFixedW; }, [notchFixedW]);
  useEffect(() => { notchFixedDRef.current = notchFixedD; }, [notchFixedD]);
  useEffect(() => { notchPreviewRef.current = notchPreview; }, [notchPreview]);
  useEffect(() => { userOpeningsRef.current = userOpenings; }, [userOpenings]);
  useEffect(() => { hoverManualOpRef.current = hoverManualOp; }, [hoverManualOp]);
  useEffect(() => { hoverOpeningRef.current = hoverOp; }, [hoverOp]);
  useEffect(() => { selectedOpIdxRef.current = selectedOpIdx; }, [selectedOpIdx]);
  useEffect(() => { gridStepRef.current = gridStep; }, [gridStep]);
  useEffect(() => { snapToVerticesRef.current = snapToVertices; }, [snapToVertices]);

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
      if (showGrid) drawGrid(ctx, cam, w, h, TC, gridStepRef.current);
      if (showRooms || showRoomLabels) {
        drawRooms(ctx, roomsData?.rooms, cam, highlightedRoomIdRef.current, TC, {
          showFills: showRooms,
          showLabels: showRoomLabels,
        });
      }
      const refImg = orthoDataRef.current;
      if (refImg?.image && orthoModeRef.current !== "off") {
        const { image, bounds } = refImg;
        const [cx1, cy1] = toCanvas(bounds.x_min, bounds.z_min, cam);
        const [cx2, cy2] = toCanvas(bounds.x_max, bounds.z_max, cam);
        ctx.save();
        ctx.globalAlpha = orthoOpacityRef.current;
        ctx.drawImage(image, cx1, cy1, cx2 - cx1, cy2 - cy1);
        ctx.restore();
      }
      if (showWalls) {
        drawEditedWalls(
          ctx, editedLinesRef.current, cam,
          hoveredLineRef.current, addStepRef.current, snapRef.current,
          editModeRef.current, TC,
          {
            selectedWallIdx: selectedWallIdxRef.current,
            hoveredHandle: hoveredHandleRef.current,
            wallDragState: wallDragRef.current,
            toolWallThickness: toolWallThicknessRef.current,
            typedLength: typedWallLengthRef.current,
          },
        );
      }
      // Corner mode overlay (drawn on top of walls, below openings)
      if (showWalls && editModeRef.current === "corner") {
        const cs = cornerStateRef.current;
        drawCornerMode(ctx, editedLinesRef.current, cam, {
          firstIdx: cs ? cs.firstIdx : -1,
          hoverIdx: hoveredLineRef.current,
          intersection: cornerStateRef.current ? cornerIntersection : null,
        }, TC);
      }
      // Corner notch / pillar preview
      if (showWalls && editModeRef.current === "notch") {
        drawNotchMode(
          ctx, editedLinesRef.current, cam,
          notchPreviewRef.current, TC,
          toolNotchThicknessRef.current, trimNotchCornerRef.current,
        );
      }
      // Draw auto-detected openings
      drawOpenings(ctx, openingsData?.openings, cam, TC, { showDoors, showWindows });

      // Draw manual user-placed openings
      for (let i = 0; i < userOpeningsRef.current.length; i++) {
        const op = userOpeningsRef.current[i];
        if (op.type === "door" ? !showDoors : !showWindows) continue;
        const isSel = i === selectedOpIdxRef.current;
        const isHov = i === hoverManualOpRef.current;
        drawManualOpening(ctx, op, editedLinesRef.current, cam, TC, isSel, isHov);
      }

      // Draw live ghost preview for door / window placement
      const em = editModeRef.current;
      const hOp = hoverOpeningRef.current;
      if ((em === "add-door" || em === "add-window") && hOp?.wallIdx >= 0 && hOp.wallIdx < editedLinesRef.current.length) {
        const isDoor = em === "add-door";
        const ghostOp = {
          type: isDoor ? "door" : "window",
          wall_idx: hOp.wallIdx,
          position_t: hOp.position_t,
          width_m: isDoor ? toolDoorWidth : toolWindowWidth,
          side: isDoor ? toolDoorHingeSide : 1,
          swing_dir: isDoor ? toolDoorSwingDir : 1,
          top_margin: isDoor ? toolDoorTopMargin : toolWindowTopMargin,
          bottom_margin: isDoor ? 0 : toolWindowBottomMargin,
        };
        ctx.save();
        ctx.globalAlpha = 0.85;
        drawManualOpening(ctx, ghostOp, editedLinesRef.current, cam, TC, false, true);
        ctx.restore();
      }

      drawMpOverlays2D(ctx, cam, selectedFloor, {
        mpInstances,
        mpSweeps,
        mpPoints,
        livePose,
        fpvPose: fpvPoseStore?.current ?? null,
        rooms: roomsData?.rooms ?? [],
        showEquip: showMpEquip,
        showSweeps: showMpSweeps,
        showAiHints: showMpAiHints,
        showPoints: showMpPoints,
        showLive: showMpLive,
        hiddenMpLabels,
        selectedMpItem,
      });

      drawBoxSelect(ctx, boxSelectRef.current, editModeRef.current);
      if (showScale) {
        drawScale(ctx, cam, w, h, TC);
        drawCompass(ctx, w, TC);
      }
    });
  }, [roomsData, openingsData, cornerIntersection, toolDoorWidth, toolDoorHingeSide, toolDoorSwingDir, toolDoorTopMargin, toolWindowWidth, toolWindowBottomMargin, toolWindowTopMargin, toolWallThickness, typedWallLength, selectedWallIdx, hoveredHandle, notchPreview, toolNotchThickness, trimNotchCorner, orthoMode, orthoOpacity, mpInstances, mpSweeps, mpPoints, livePose, fpvPoseStore, showMpEquip, showMpSweeps, showMpAiHints, showMpPoints, showMpLive, hiddenMpLabels, selectedMpItem, selectedFloor, showWalls, showRooms, showRoomLabels, showDoors, showWindows, showGrid, showScale]);

  // Load or render geo-referenced top-down ortho reference when settings change
  useEffect(() => {
    if (prevOrthoFloorRef.current !== selectedFloor) {
      prevOrthoFloorRef.current = selectedFloor;
      orthoDataRef.current = null;
    }
    if (orthoMode === "off") {
      orthoDataRef.current = null;
      setOrthoLoading(false);
      setOrthoError(null);
      scheduleDraw();
      return;
    }

    let cancelled = false;
    const ctrl = new AbortController();
    setOrthoLoading(true);
    setOrthoError(null);

    const timer = setTimeout(async () => {
      try {
        let res;
        if (orthoMode === "cloud-walls" || orthoMode === "cloud-slice") {
          res = await fetchPointCloudOrtho(apiBase, selectedFloor, {
            mode: orthoMode === "cloud-walls" ? "walls" : "slice",
            bottomCut: orthoBottomCut,
            topCut: orthoTopCut,
            signal: ctrl.signal,
          });
        } else {
          res = await renderPhotoOrtho({
            modelInfo: activeModelInfo,
            floorIdx: selectedFloor,
            mode: orthoMode,
            bottomCut: orthoBottomCut,
            topCut: orthoTopCut,
          });
        }
        if (cancelled) return;
        orthoDataRef.current = res;
        setOrthoLoading(false);
        setOrthoError(null);
        scheduleDraw();
      } catch (err) {
        if (cancelled || err?.name === "AbortError") return;
        orthoDataRef.current = null;
        setOrthoLoading(false);
        setOrthoError(err?.message || "Failed to load scan overlay");
        scheduleDraw();
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [orthoMode, selectedFloor, orthoBottomCut, orthoTopCut, apiBase, activeModelInfo, scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [orthoOpacity, scheduleDraw]);

  const isDirtyRef = useRef(false);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);
  const openingsDirtyRef = useRef(false);
  useEffect(() => { openingsDirtyRef.current = openingsDirty; }, [openingsDirty]);
  const hasFittedCamRef = useRef(false);
  const didPanRef = useRef(false);
  const prevFloorRef = useRef(selectedFloor);
  const prevSaveRef = useRef(saveName);

  // ── Fetch floor data when selected floor, dataVersion or saveName changes ──
  useEffect(() => {
    let cancelled = false;
    const floorChanged = prevFloorRef.current !== selectedFloor;
    const saveChanged = prevSaveRef.current !== saveName;
    prevFloorRef.current = selectedFloor;
    prevSaveRef.current = saveName;

    // If floor or save changed, reset everything and show loading
    if (floorChanged || saveChanged) {
      hasFittedCamRef.current = false;
      setLoadState("loading");
      setEditedLines([]); setRoomsData(null); setOpeningsData(null); setUserOpenings([]);
      setIsDirty(false); setOpeningsDirty(false); setUndoStack([]); setRedoStack([]);
      setAddStep(null); addStepRef.current = null; snapRef.current = null;
      setHoveredLine(-1); hoveredLineRef.current = -1;
      setSelectedWallIdx(null); selectedWallIdxRef.current = null;
      setHoveredHandle(null); hoveredHandleRef.current = null;
      wallDragRef.current = null;
      notchStateRef.current = null; setNotchStep(0);
      notchPreviewRef.current = null; setNotchPreview(null);
      setTypedWallLength(""); typedWallLengthRef.current = "";
      setSelectedOpIdx(null); setHoverManualOp(-1); setHoverOp(null);
    }

    const shouldFetchWalls = (floorChanged || saveChanged || !isDirtyRef.current);
    const shouldFetchOpenings = (floorChanged || saveChanged || !openingsDirtyRef.current);

    Promise.all([
      shouldFetchWalls ? fetch(`${apiBase}/walls/${selectedFloor}`).then(r => r.json()) : Promise.resolve(null),
      shouldFetchWalls ? fetch(`${apiBase}/rooms/${selectedFloor}`).then(r => r.json()) : Promise.resolve(null),
      shouldFetchOpenings ? fetch(`${apiBase}/openings/${selectedFloor}`).then(r => r.json()) : Promise.resolve(null),
    ])
      .then(([w, r, o]) => {
        if (cancelled) return;

        if (w) {
          const converted = wallJsonToEditedLines(w);
          setEditedLines(converted); editedLinesRef.current = converted;
          setSelectedWallIdx(prev => (prev != null && prev >= converted.length ? null : prev));
          if (r) setRoomsData(r);
          setIsDirty(false);
          const cvs = canvasRef.current;
          if (cvs && converted.length && (floorChanged || saveChanged || !hasFittedCamRef.current)) {
            const b = wallsBoundsFromEdited(converted);
            camRef.current = fitCamera(b, cvs.clientWidth || cvs.width, cvs.clientHeight || cvs.height);
            hasFittedCamRef.current = true;
          }
        }

        if (o) {
          setOpeningsData(o);
          const uo = o?.user_openings ?? [];
          setUserOpenings(uo); userOpeningsRef.current = uo;
          setOpeningsDirty(false);
          setSelectedOpIdx(prev => (prev != null && prev >= uo.length ? null : prev));
        }

        setLoadState("ready");
        scheduleDraw();
      })
      .catch(() => {
        if (!cancelled && (floorChanged || saveChanged)) setLoadState("error");
      });

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
      if (selectedWallIdxRef.current != null && selectedWallIdxRef.current >= last.length) {
        setSelectedWallIdx(null); selectedWallIdxRef.current = null;
      }
      const synced = syncOpeningsWithWalls(last, userOpeningsRef.current);
      if (synced.changed) { userOpeningsRef.current = synced.openings; setUserOpenings(synced.openings); }
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
      if (selectedWallIdxRef.current != null && selectedWallIdxRef.current >= next.length) {
        setSelectedWallIdx(null); selectedWallIdxRef.current = null;
      }
      const synced = syncOpeningsWithWalls(next, userOpeningsRef.current);
      if (synced.changed) { userOpeningsRef.current = synced.openings; setUserOpenings(synced.openings); }
      setIsDirty(true); scheduleDraw();
      return prev.slice(1);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selected wall customization & precision move helpers ────────────────────
  const applyWallTransform = useCallback((
    wallIdx,
    updaterFn,
    { pushUndo = true, moveConnected = moveConnectedCornersRef.current } = {},
  ) => {
    const lines = editedLinesRef.current;
    if (wallIdx == null || wallIdx < 0 || wallIdx >= lines.length) return;
    const oldLine = lines[wallIdx];
    const [[ox1, oz1], [ox2, oz2]] = oldLine.pts;
    const patch = updaterFn(oldLine, getWallMetrics(oldLine));
    if (!patch) return;

    const nextPts = patch.pts ?? oldLine.pts;
    const [[nx1, nz1], [nx2, nz2]] = nextPts;
    const p1Moved = Math.hypot(nx1 - ox1, nz1 - oz1) > 1e-5;
    const p2Moved = Math.hypot(nx2 - ox2, nz2 - oz2) > 1e-5;

    if (pushUndo) pushHistory(lines);

    const CONN_THRESH = 0.025;
    const newLines = lines.map((line, i) => {
      if (i === wallIdx) {
        return {
          ...line,
          ...patch,
          pts: [[nx1, nz1], [nx2, nz2]],
          source: patch.source ?? (p1Moved || p2Moved ? "user" : line.source),
        };
      }
      if (moveConnected && (p1Moved || p2Moved)) {
        let [[lx1, lz1], [lx2, lz2]] = line.pts;
        let touched = false;
        if (p1Moved && Math.hypot(lx1 - ox1, lz1 - oz1) <= CONN_THRESH) {
          lx1 = nx1; lz1 = nz1; touched = true;
        } else if (p2Moved && Math.hypot(lx1 - ox2, lz1 - oz2) <= CONN_THRESH) {
          lx1 = nx2; lz1 = nz2; touched = true;
        }
        if (p1Moved && Math.hypot(lx2 - ox1, lz2 - oz1) <= CONN_THRESH) {
          lx2 = nx1; lz2 = nz1; touched = true;
        } else if (p2Moved && Math.hypot(lx2 - ox2, lz2 - oz2) <= CONN_THRESH) {
          lx2 = nx2; lz2 = nz2; touched = true;
        }
        if (touched) {
          return {
            ...line,
            pts: [[lx1, lz1], [lx2, lz2]],
            source: line.source === "algo" ? "user" : line.source,
          };
        }
      }
      return line;
    });

    setEditedLines(newLines);
    editedLinesRef.current = newLines;
    const synced = syncOpeningsWithWalls(newLines, userOpeningsRef.current);
    if (synced.changed) {
      userOpeningsRef.current = synced.openings;
      setUserOpenings(synced.openings);
      setOpeningsDirty(true);
    }
    setIsDirty(true);
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  const nudgeSelectedWall = useCallback((dnNormal, dtAlong, dxWorld = 0, dzWorld = 0) => {
    const idx = selectedWallIdxRef.current;
    if (idx == null) return;
    applyWallTransform(idx, (_, m) => {
      const dx = m.nx * dnNormal + m.ux * dtAlong + dxWorld;
      const dz = m.nz * dnNormal + m.uz * dtAlong + dzWorld;
      return { pts: [[m.x1 + dx, m.z1 + dz], [m.x2 + dx, m.z2 + dz]] };
    });
  }, [applyWallTransform]);

  const setSelectedWallLength = useCallback((newLenM, anchor = resizeAnchor) => {
    const idx = selectedWallIdxRef.current;
    if (idx == null) return;
    const len = Math.max(0.05, Number(newLenM) || 0.05);
    applyWallTransform(idx, (_, m) => {
      if (anchor === "p2") {
        return { pts: [[m.x2 - m.ux * len, m.z2 - m.uz * len], [m.x2, m.z2]] };
      }
      if (anchor === "center") {
        const half = len * 0.5;
        return { pts: [[m.mx - m.ux * half, m.mz - m.uz * half], [m.mx + m.ux * half, m.mz + m.uz * half]] };
      }
      return { pts: [[m.x1, m.z1], [m.x1 + m.ux * len, m.z1 + m.uz * len]] };
    });
  }, [applyWallTransform, resizeAnchor]);

  const setSelectedWallAngle = useCallback((newAngleDeg, anchor = resizeAnchor) => {
    const idx = selectedWallIdxRef.current;
    if (idx == null) return;
    const deg = Number(newAngleDeg);
    if (!Number.isFinite(deg)) return;
    const rad = (deg * Math.PI) / 180;
    const ux = Math.cos(rad), uz = Math.sin(rad);
    applyWallTransform(idx, (_, m) => {
      const len = Math.max(0.05, m.len);
      if (anchor === "p2") {
        return { pts: [[m.x2 - ux * len, m.z2 - uz * len], [m.x2, m.z2]] };
      }
      if (anchor === "center") {
        const half = len * 0.5;
        return { pts: [[m.mx - ux * half, m.mz - uz * half], [m.mx + ux * half, m.mz + uz * half]] };
      }
      return { pts: [[m.x1, m.z1], [m.x1 + ux * len, m.z1 + uz * len]] };
    });
  }, [applyWallTransform, resizeAnchor]);

  const splitSelectedWall = useCallback((splitRatio = 0.5) => {
    const idx = selectedWallIdxRef.current;
    const lines = editedLinesRef.current;
    if (idx == null || idx < 0 || idx >= lines.length) return;
    const r = Math.max(0.1, Math.min(0.9, splitRatio));
    const oldLine = lines[idx];
    const [[x1, z1], [x2, z2]] = oldLine.pts;
    if (Math.hypot(x2 - x1, z2 - z1) < 0.10) return;

    const mx = x1 + (x2 - x1) * r;
    const mz = z1 + (z2 - z1) * r;
    const segA = {
      ...oldLine,
      pts: [[x1, z1], [mx, mz]],
      source: oldLine.source === "algo" ? "user" : oldLine.source,
    };
    const segB = {
      ...oldLine,
      pts: [[mx, mz], [x2, z2]],
      source: "user",
    };

    pushHistory(lines);
    const newLines = [...lines.slice(0, idx), segA, segB, ...lines.slice(idx + 1)];
    setEditedLines(newLines);
    editedLinesRef.current = newLines;

    if (userOpeningsRef.current.length > 0) {
      const remappedOps = userOpeningsRef.current.map((op) => {
        if (op.wall_idx > idx) return { ...op, wall_idx: op.wall_idx + 1 };
        if (op.wall_idx === idx) {
          const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
          if (t <= r) {
            return { ...op, wall_idx: idx, position_t: Math.max(0.02, Math.min(0.98, t / r)) };
          }
          return { ...op, wall_idx: idx + 1, position_t: Math.max(0.02, Math.min(0.98, (t - r) / (1 - r))) };
        }
        return op;
      });
      const synced = syncOpeningsWithWalls(newLines, remappedOps);
      userOpeningsRef.current = synced.openings;
      setUserOpenings(synced.openings);
      setOpeningsDirty(true);
    }

    setSelectedWallIdx(idx + 1);
    selectedWallIdxRef.current = idx + 1;
    setIsDirty(true);
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  const duplicateSelectedWall = useCallback((offsetM = 0.25) => {
    const idx = selectedWallIdxRef.current;
    const lines = editedLinesRef.current;
    if (idx == null || idx < 0 || idx >= lines.length) return;
    const line = lines[idx];
    const m = getWallMetrics(line);
    const dx = m.nx * offsetM, dz = m.nz * offsetM;
    const copy = {
      ...line,
      pts: [[m.x1 + dx, m.z1 + dz], [m.x2 + dx, m.z2 + dz]],
      source: "user",
      hidden: false,
    };
    pushHistory(lines);
    const newLines = [...lines, copy];
    setEditedLines(newLines);
    editedLinesRef.current = newLines;
    setSelectedWallIdx(newLines.length - 1);
    selectedWallIdxRef.current = newLines.length - 1;
    setIsDirty(true);
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  const deleteSelectedWall = useCallback(() => {
    const idx = selectedWallIdxRef.current;
    const lines = editedLinesRef.current;
    if (idx == null || idx < 0 || idx >= lines.length) return;
    pushHistory(lines);
    const newLines = lines.filter((_, i) => i !== idx);
    setEditedLines(newLines);
    editedLinesRef.current = newLines;
    setSelectedWallIdx(null);
    selectedWallIdxRef.current = null;
    setHoveredHandle(null);
    hoveredHandleRef.current = null;

    if (userOpeningsRef.current.length > 0) {
      const updatedOps = userOpeningsRef.current
        .filter(op => op.wall_idx !== idx)
        .map(op => op.wall_idx > idx ? { ...op, wall_idx: op.wall_idx - 1 } : op);
      userOpeningsRef.current = updatedOps;
      setUserOpenings(updatedOps);
      setSelectedOpIdx(null);
      setOpeningsDirty(true);
    }

    setIsDirty(true);
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  const toggleHideSelectedWall = useCallback(() => {
    const idx = selectedWallIdxRef.current;
    if (idx == null) return;
    applyWallTransform(idx, (line) => ({ hidden: !line.hidden }), { moveConnected: false });
  }, [applyWallTransform]);

  const commitAddWallWithLength = useCallback((exactLenM) => {
    const start = addStepRef.current;
    const len = Number(exactLenM);
    if (!start || !Number.isFinite(len) || len < 0.05) return;
    const [ax, az] = start;
    let ux = 1, uz = 0;
    const snap = snapRef.current;
    if (snap?.angle != null) {
      ux = Math.cos(snap.angle);
      uz = Math.sin(snap.angle);
    } else if (snap?.pt) {
      const dx = snap.pt[0] - ax, dz = snap.pt[1] - az;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) { ux = dx / d; uz = dz / d; }
    }
    const endPt = [ax + ux * len, az + uz * len];
    const newLine = {
      pts: [[ax, az], endPt],
      source: "user",
      thickness: normalizeWallThickness(toolWallThicknessRef.current),
      thicknessSource: "edited",
    };
    const newLines = [...editedLinesRef.current, newLine];
    pushHistory(editedLinesRef.current);
    setEditedLines(newLines);
    editedLinesRef.current = newLines;
    setSelectedWallIdx(newLines.length - 1);
    selectedWallIdxRef.current = newLines.length - 1;
    setTypedWallLength("");
    typedWallLengthRef.current = "";
    if (wallChainModeRef.current) {
      addStepRef.current = endPt;
      setAddStep(endPt);
    } else {
      addStepRef.current = null;
      setAddStep(null);
    }
    setIsDirty(true);
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  const hitTestSelectedWallHandle = useCallback((wx, wz, cam) => {
    const idx = selectedWallIdxRef.current;
    const lines = editedLinesRef.current;
    if (idx == null || idx < 0 || idx >= lines.length) return null;
    const line = lines[idx];
    const [[x1, z1], [x2, z2]] = line.pts;
    const handleWorldR = 10 / cam.scale;
    const d1 = Math.hypot(wx - x1, wz - z1);
    const d2 = Math.hypot(wx - x2, wz - z2);
    if (d1 <= handleWorldR || d2 <= handleWorldR) {
      return d1 <= d2 ? "p1" : "p2";
    }
    const mx = (x1 + x2) * 0.5, mz = (z1 + z2) * 0.5;
    if (Math.hypot(wx - mx, wz - mz) <= handleWorldR) return "body";
    const bodyThresh = Math.max(8 / cam.scale, normalizeWallThickness(line.thickness) * 0.5 + 3 / cam.scale);
    if (distPointToSeg(wx, wz, x1, z1, x2, z2) <= bodyThresh) return "body";
    return null;
  }, []);

  const commitNotchPreview = useCallback((preview) => {
    if (!preview) return;
    const lines = editedLinesRef.current;
    const th = normalizeWallThickness(toolNotchThicknessRef.current);
    const shouldTrim = trimNotchCornerRef.current;

    if (preview.stage === "active-corner") {
      const { idxA, idxB, ptA, ptB, ptInner, epA, epB } = preview;
      pushHistory(lines);
      const updated = shouldTrim
        ? lines.map((line, i) => {
          if (i === idxA) {
            const newPts = [line.pts[0].slice(), line.pts[1].slice()];
            newPts[epA] = ptA;
            return { ...line, pts: newPts, source: line.source === "algo" ? "user" : line.source };
          }
          if (i === idxB) {
            const newPts = [line.pts[0].slice(), line.pts[1].slice()];
            newPts[epB] = ptB;
            return { ...line, pts: newPts, source: line.source === "algo" ? "user" : line.source };
          }
          return line;
        })
        : [...lines];

      const newLines = [
        ...updated,
        { pts: [ptA, ptInner], source: "user", thickness: th, thicknessSource: "edited" },
        { pts: [ptInner, ptB], source: "user", thickness: th, thicknessSource: "edited" },
      ];
      setEditedLines(newLines);
      editedLinesRef.current = newLines;
      const synced = syncOpeningsWithWalls(newLines, userOpeningsRef.current);
      if (synced.changed) {
        userOpeningsRef.current = synced.openings;
        setUserOpenings(synced.openings);
        setOpeningsDirty(true);
      }
      setIsDirty(true);
    } else if (preview.stage === "active-pillar") {
      const { wallIdx, p1, p2, p1In, p2In, tMin, tMax } = preview;
      const origLine = lines[wallIdx];
      if (!origLine) return;
      const m = getWallMetrics(origLine);
      pushHistory(lines);

      let newLines;
      if (shouldTrim) {
        const hasLeft = tMin * m.len >= 0.04;
        const hasRight = (1 - tMax) * m.len >= 0.04;
        const pieces = [];
        if (hasLeft) {
          pieces.push({
            ...origLine,
            pts: [[m.x1, m.z1], p1],
            source: origLine.source === "algo" ? "user" : origLine.source,
          });
        }
        if (hasRight) {
          pieces.push({
            ...origLine,
            pts: [p2, [m.x2, m.z2]],
            source: origLine.source === "algo" ? "user" : origLine.source,
          });
        }
        newLines = [
          ...lines.slice(0, wallIdx),
          ...pieces,
          ...lines.slice(wallIdx + 1),
          { pts: [p1, p1In], source: "user", thickness: th, thicknessSource: "edited" },
          { pts: [p1In, p2In], source: "user", thickness: th, thicknessSource: "edited" },
          { pts: [p2In, p2], source: "user", thickness: th, thicknessSource: "edited" },
        ];
        if (userOpeningsRef.current.length > 0) {
          const delta = pieces.length - 1;
          const remapped = [];
          for (const op of userOpeningsRef.current) {
            if (op.wall_idx > wallIdx) {
              remapped.push({ ...op, wall_idx: op.wall_idx + delta });
            } else if (op.wall_idx < wallIdx) {
              remapped.push(op);
            } else {
              const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
              if (t <= tMin && hasLeft) {
                remapped.push({ ...op, wall_idx: wallIdx, position_t: Math.max(0.02, Math.min(0.98, t / tMin)) });
              } else if (t >= tMax && hasRight) {
                remapped.push({
                  ...op,
                  wall_idx: wallIdx + (hasLeft ? 1 : 0),
                  position_t: Math.max(0.02, Math.min(0.98, (t - tMax) / (1 - tMax))),
                });
              }
            }
          }
          const synced = syncOpeningsWithWalls(newLines, remapped);
          userOpeningsRef.current = synced.openings;
          setUserOpenings(synced.openings);
          setOpeningsDirty(true);
        }
      } else {
        newLines = [
          ...lines,
          { pts: [p1, p1In], source: "user", thickness: th, thicknessSource: "edited" },
          { pts: [p1In, p2In], source: "user", thickness: th, thicknessSource: "edited" },
          { pts: [p2In, p2], source: "user", thickness: th, thicknessSource: "edited" },
        ];
      }
      setEditedLines(newLines);
      editedLinesRef.current = newLines;
      setIsDirty(true);
    }

    notchStateRef.current = null;
    setNotchStep(0);
    notchPreviewRef.current = null;
    setNotchPreview(null);
    lastNotchTargetRef.current = null;
    scheduleDraw();
  }, [pushHistory, scheduleDraw]);

  useEffect(() => {
    if (editModeRef.current !== "notch" || !notchStateRef.current) return;
    const st = notchStateRef.current;
    const target = lastNotchTargetRef.current;
    if (!target) return;
    const fw = parseFloat(notchFixedW);
    const fd = parseFloat(notchFixedD);
    if (st.kind === "corner") {
      const geom = computeCornerNotchGeometry(
        editedLinesRef.current, st.idxA, st.idxB, st.cornerPt,
        target[0], target[1], fw, fd, 0,
      );
      if (geom) {
        const nextPrev = { stage: "active-corner", ...geom };
        notchPreviewRef.current = nextPrev;
        setNotchPreview(nextPrev);
      }
    } else if (st.kind === "pillar") {
      const geom = computeWallPillarGeometry(
        editedLinesRef.current, st.wallIdx, st.startPt,
        target[0], target[1], fw, fd, 0,
      );
      if (geom) {
        const nextPrev = { stage: "active-pillar", ...geom };
        notchPreviewRef.current = nextPrev;
        setNotchPreview(nextPrev);
      }
    }
  }, [notchFixedW, notchFixedD]);

  // ── Openings helpers ────────────────────────────────────────────────────────
  const updateSelectedOp = useCallback((changes) => {
    if (selectedOpIdxRef.current === null) return;
    const idx = selectedOpIdxRef.current;
    const list = [...userOpeningsRef.current];
    if (idx >= 0 && idx < list.length) {
      const merged = { ...list[idx], ...changes };
      if (changes.width_m != null) merged.width = changes.width_m;
      if (changes.width != null) merged.width_m = changes.width;
      if (changes.position_t != null && merged.wall_x1 != null && merged.wall_x2 != null) {
        merged.x = merged.wall_x1 + merged.position_t * (merged.wall_x2 - merged.wall_x1);
        merged.z = merged.wall_z1 + merged.position_t * (merged.wall_z2 - merged.wall_z1);
      }
      list[idx] = merged;
      userOpeningsRef.current = list;
      setUserOpenings(list);
      setOpeningsDirty(true);
      scheduleDraw();
    }
  }, [scheduleDraw]);

  const deleteSelectedOp = useCallback(() => {
    if (selectedOpIdxRef.current === null) return;
    const idx = selectedOpIdxRef.current;
    const list = userOpeningsRef.current.filter((_, i) => i !== idx);
    userOpeningsRef.current = list;
    setUserOpenings(list);
    setSelectedOpIdx(null);
    setOpeningsDirty(true);
    scheduleDraw();
  }, [scheduleDraw]);

  // ── Save to backend ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!isDirty && !openingsDirty) return;
    setSaveState("saving");
    try {
      if (openingsDirty) {
        const putOpUrl = `${apiBase}/openings/${selectedFloor}`;
        const body = {
          user_openings: userOpeningsRef.current,
        };
        if (openingsData?.openings) {
          body.openings = openingsData.openings;
        }
        const opRes = await fetch(putOpUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!opRes.ok) { setSaveState("error"); return; }
        setOpeningsDirty(false);
      }
      if (isDirty) {
        // Hidden walls are excluded — they are suppressed from room recalculation
        const visibleLines = editedLinesRef.current.filter(l => !l.hidden);
        const lines = visibleLines.map(l => l.pts);
        const thicknesses = visibleLines.map(l => normalizeWallThickness(l.thickness));
        const putUrl = `${apiBase}/walls/${selectedFloor}`;
        const wallRes = await fetch(putUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines, thicknesses, polygon_rooms: roomMode === "polygon" }),
        });
        if (!wallRes.ok) { setSaveState("error"); return; }
        setIsDirty(false);
      }
      setSaveState("saved");
      onWallsSaved?.();
      // Refresh rooms from updated backend
      fetch(`${apiBase}/rooms/${selectedFloor}`).then(r => r.json()).then(setRoomsData).catch(() => { });
      setTimeout(() => setSaveState("idle"), 3000);
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  }, [isDirty, openingsDirty, selectedFloor, apiBase, roomMode, onWallsSaved, openingsData]);

  // redraw when data changes
  useEffect(() => { scheduleDraw(); }, [editedLines, roomsData, openingsData, userOpenings, selectedOpIdx, hoverManualOp, hoverOp, highlightedRoomId, selectedWallIdx, hoveredHandle, toolWallThickness, typedWallLength, gridStep, snapToVertices, scheduleDraw]);

  useEffect(() => {
    if (!fpvPoseStore) return undefined;
    return fpvPoseStore.subscribe(() => {
      if (canvasRef.current && canvasRef.current.offsetParent !== null) {
        scheduleDraw();
      }
    });
  }, [fpvPoseStore, scheduleDraw]);

  useEffect(() => {
    if (visible) scheduleDraw();
  }, [visible, scheduleDraw]);

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

      if (editModeRef.current === "add" && addStepRef.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (/^[0-9.]$/.test(e.key)) {
          e.preventDefault();
          const cur = typedWallLengthRef.current;
          if (e.key === "." && cur.includes(".")) return;
          const next = cur + e.key;
          typedWallLengthRef.current = next;
          setTypedWallLength(next);
          scheduleDraw();
          return;
        }
        if (e.key === "Backspace" && typedWallLengthRef.current.length > 0) {
          e.preventDefault();
          const next = typedWallLengthRef.current.slice(0, -1);
          typedWallLengthRef.current = next;
          setTypedWallLength(next);
          scheduleDraw();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const val = parseFloat(typedWallLengthRef.current);
          if (Number.isFinite(val) && val >= 0.05) {
            commitAddWallWithLength(val);
          } else {
            addStepRef.current = null; setAddStep(null);
            snapRef.current = null;
            typedWallLengthRef.current = ""; setTypedWallLength("");
            scheduleDraw();
          }
          return;
        }
      }

      if (editModeRef.current === "notch" && notchStateRef.current && e.key === "Enter") {
        const prev = notchPreviewRef.current;
        if (prev?.stage === "active-corner" || prev?.stage === "active-pillar") {
          e.preventDefault();
          commitNotchPreview(prev);
          return;
        }
      }

      if (e.key === "Escape") {
        if (selectedOpIdxRef.current !== null) {
          setSelectedOpIdx(null); selectedOpIdxRef.current = null; scheduleDraw();
        } else if (addStepRef.current) {
          addStepRef.current = null; setAddStep(null); snapRef.current = null;
          typedWallLengthRef.current = ""; setTypedWallLength("");
          scheduleDraw();
        } else if (editModeRef.current === "corner" && cornerStateRef.current) {
          cornerStateRef.current = null;
          setCornerStep(0); setCornerHoverIdx(-1); setCornerIntersection(null);
          scheduleDraw();
        } else if (editModeRef.current === "notch" && notchStateRef.current) {
          notchStateRef.current = null; setNotchStep(0);
          notchPreviewRef.current = null; setNotchPreview(null);
          lastNotchTargetRef.current = null;
          scheduleDraw();
        } else if (selectedWallIdxRef.current !== null) {
          setSelectedWallIdx(null); selectedWallIdxRef.current = null;
          setHoveredHandle(null); hoveredHandleRef.current = null;
          scheduleDraw();
        } else {
          setEditMode("select"); editModeRef.current = "select"; scheduleDraw();
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedOpIdxRef.current !== null) {
        e.preventDefault();
        deleteSelectedOp();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedWallIdxRef.current !== null) {
        e.preventDefault();
        deleteSelectedWall();
        return;
      }

      if (selectedWallIdxRef.current !== null && !e.ctrlKey && !e.metaKey) {
        const step = e.altKey ? 0.01 : e.shiftKey ? 0.10 : (gridStepRef.current > 0 ? gridStepRef.current : 0.05);
        if (e.key === "ArrowLeft") { e.preventDefault(); nudgeSelectedWall(0, 0, -step, 0); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); nudgeSelectedWall(0, 0, step, 0); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); nudgeSelectedWall(0, 0, 0, -step); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); nudgeSelectedWall(0, 0, 0, step); return; }
        if (e.key === "[") { e.preventDefault(); nudgeSelectedWall(-step, 0); return; }
        if (e.key === "]") { e.preventDefault(); nudgeSelectedWall(step, 0); return; }
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "s" || e.key === "S") { setEditMode("select"); editModeRef.current = "select"; scheduleDraw(); }
        if (e.key === "a" || e.key === "A") { setEditMode("add"); editModeRef.current = "add"; setSelectedOpIdx(null); scheduleDraw(); }
        if (e.key === "q" || e.key === "Q") { setEditMode("add-door"); editModeRef.current = "add-door"; scheduleDraw(); }
        if (e.key === "w" || e.key === "W") { setEditMode("add-window"); editModeRef.current = "add-window"; scheduleDraw(); }
        if (e.key === "d" || e.key === "D") { setEditMode("delete"); editModeRef.current = "delete"; scheduleDraw(); }
        if (e.key === "h" || e.key === "H") { setEditMode("hide"); editModeRef.current = "hide"; scheduleDraw(); }
        if (e.key === "c" || e.key === "C") { setEditMode("corner"); editModeRef.current = "corner"; scheduleDraw(); }
        if (e.key === "n" || e.key === "N") {
          setEditMode("notch"); editModeRef.current = "notch";
          setSelectedOpIdx(null); setSelectedWallIdx(null);
          scheduleDraw();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, handleSave, deleteSelectedOp, deleteSelectedWall, nudgeSelectedWall, commitAddWallWithLength, commitNotchPreview, scheduleDraw]);

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
      didPanRef.current = false;
      const [wx, wz] = getWorldFromEvent(e);
      const handle = showWalls && hoverManualOpRef.current < 0
        ? hitTestSelectedWallHandle(wx, wz, camRef.current)
        : null;
      if (handle) {
        const wallIdx = selectedWallIdxRef.current;
        const origLines = editedLinesRef.current;
        const origLine = origLines[wallIdx];
        const [[x1, z1], [x2, z2]] = origLine.pts;
        const origPts = [[x1, z1], [x2, z2]];
        const origMetrics = getWallMetrics(origLine);
        const CONN_THRESH = 0.025;
        const connectedEndpoints = [];
        origLines.forEach((l, i) => {
          if (i === wallIdx) return;
          l.pts.forEach(([ex, ez], epIdx) => {
            if (Math.hypot(ex - x1, ez - z1) <= CONN_THRESH) {
              connectedEndpoints.push({ lineIdx: i, epIdx, whichOrig: 0 });
            } else if (Math.hypot(ex - x2, ez - z2) <= CONN_THRESH) {
              connectedEndpoints.push({ lineIdx: i, epIdx, whichOrig: 1 });
            }
          });
        });
        wallDragRef.current = {
          kind: handle,
          wallIdx,
          startWx: wx,
          startWz: wz,
          origLines,
          origPts,
          origMetrics,
          connectedEndpoints,
          moved: false,
          historyPushed: false,
          normalOffset: 0,
          freeMove: false,
        };
        dragRef.current = null;
        return;
      }
      dragRef.current = { startX: e.clientX, startY: e.clientY, ox: camRef.current.ox, oy: camRef.current.oy, moved: false };
    } else if (mode === "delete" || mode === "hide") {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      boxSelectRef.current = { startCx: cx, startCy: cy, cx1: cx, cy1: cy, cx2: cx, cy2: cy, moved: false };
    }
  }, [getWorldFromEvent, hitTestSelectedWallHandle, showWalls]);

  const onMouseMove = useCallback((e) => {
    const mode = editModeRef.current;

    // Wall handle / body drag in select mode
    if (mode === "select" && wallDragRef.current) {
      const drag = wallDragRef.current;
      const [wx, wz] = getWorldFromEvent(e);
      if (!drag.moved && Math.hypot(wx - drag.startWx, wz - drag.startWz) * camRef.current.scale <= 2) {
        return;
      }
      if (!drag.historyPushed) {
        pushHistory(drag.origLines);
        drag.historyPushed = true;
      }
      drag.moved = true;
      didPanRef.current = true;

      const effectiveGridStep = e.altKey ? 0 : gridStepRef.current;
      const effectiveSnapEp = e.altKey ? false : snapToVerticesRef.current;
      const moveConn = moveConnectedCornersRef.current && !e.ctrlKey;

      let newP1 = drag.origPts[0];
      let newP2 = drag.origPts[1];

      if (drag.kind === "p1" || drag.kind === "p2") {
        const isP1 = drag.kind === "p1";
        const anchor = drag.origPts[isP1 ? 1 : 0];
        let snap;
        if (e.shiftKey) {
          const lock = wallAngleLockModeRef.current === "free" ? "45" : wallAngleLockModeRef.current;
          snap = computeSnapConstrained(
            wx, wz, drag.origLines, camRef.current, anchor[0], anchor[1],
            14, effectiveGridStep, effectiveSnapEp, lock, drag.wallIdx,
          );
        } else {
          snap = computeSnap(
            wx, wz, drag.origLines, camRef.current,
            14, effectiveGridStep, effectiveSnapEp, drag.wallIdx,
          );
          if ((snap.kind === "grid" || snap.kind === "free") && !e.altKey) {
            const dx = snap.pt[0] - anchor[0], dz = snap.pt[1] - anchor[1];
            const rawDist = Math.hypot(dx, dz);
            if (rawDist > 0.05) {
              const rawA = Math.atan2(dz, dx);
              const magAngles = [drag.origMetrics.angleRad, drag.origMetrics.angleRad + Math.PI];
              for (let k = 0; k < 8; k++) magAngles.push((k * Math.PI) / 4);
              const thresh = (3.5 * Math.PI) / 180;
              let bestDiff = thresh, bestAngle = null;
              for (const ca of magAngles) {
                const diff = Math.abs(Math.atan2(Math.sin(rawA - ca), Math.cos(rawA - ca)));
                if (diff < bestDiff) { bestDiff = diff; bestAngle = ca; }
              }
              if (bestAngle != null) {
                const dSnapped = effectiveGridStep > 0
                  ? Math.max(0.05, Math.round(rawDist / effectiveGridStep) * effectiveGridStep)
                  : rawDist;
                snap = {
                  ...snap,
                  pt: [anchor[0] + Math.cos(bestAngle) * dSnapped, anchor[1] + Math.sin(bestAngle) * dSnapped],
                  angle: bestAngle,
                  dist: dSnapped,
                };
              }
            }
          }
        }
        snapRef.current = snap;
        if (isP1) newP1 = snap.pt;
        else newP2 = snap.pt;
      } else {
        const dxRaw = wx - drag.startWx, dzRaw = wz - drag.startWz;
        const m = drag.origMetrics;
        let dx = dxRaw, dz = dzRaw;
        if (e.shiftKey) {
          drag.freeMove = true;
          if (effectiveGridStep > 0) {
            dx = Math.round(dx / effectiveGridStep) * effectiveGridStep;
            dz = Math.round(dz / effectiveGridStep) * effectiveGridStep;
          }
        } else {
          drag.freeMove = false;
          let rawN = dxRaw * m.nx + dzRaw * m.nz;
          if (effectiveGridStep > 0) {
            rawN = Math.round(rawN / effectiveGridStep) * effectiveGridStep;
          }
          drag.normalOffset = rawN;
          dx = m.nx * rawN;
          dz = m.nz * rawN;
        }
        snapRef.current = null;
        newP1 = [drag.origPts[0][0] + dx, drag.origPts[0][1] + dz];
        newP2 = [drag.origPts[1][0] + dx, drag.origPts[1][1] + dz];
      }

      const connByLine = new Map();
      if (moveConn) {
        for (const ce of drag.connectedEndpoints) {
          if (!connByLine.has(ce.lineIdx)) connByLine.set(ce.lineIdx, []);
          connByLine.get(ce.lineIdx).push(ce);
        }
      }

      const nextLines = drag.origLines.map((line, i) => {
        if (i === drag.wallIdx) {
          return { ...line, pts: [newP1, newP2], source: "user" };
        }
        const conns = connByLine.get(i);
        if (conns) {
          const newPts = [line.pts[0].slice(), line.pts[1].slice()];
          for (const ce of conns) {
            newPts[ce.epIdx] = ce.whichOrig === 0 ? newP1 : newP2;
          }
          return { ...line, pts: newPts, source: line.source === "algo" ? "user" : line.source };
        }
        return line;
      });

      setEditedLines(nextLines);
      editedLinesRef.current = nextLines;
      const synced = syncOpeningsWithWalls(nextLines, userOpeningsRef.current);
      if (synced.changed) {
        userOpeningsRef.current = synced.openings;
        setUserOpenings(synced.openings);
        setOpeningsDirty(true);
      }
      scheduleDraw();
      return;
    }

    // Pan in select mode
    if (mode === "select" && dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) {
        dragRef.current.moved = true;
        didPanRef.current = true;
      }
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
      const altHeld = e.altKey;
      shiftRef.current = shiftHeld;

      // Alt key temporarily forces free placement and ignores snapping
      const effectiveGridStep = altHeld ? 0 : gridStepRef.current;
      const effectiveSnapEp = altHeld ? false : snapToVerticesRef.current;

      if (mode === "add" && addStepRef.current) {
        const effectiveAngleMode = shiftHeld ? "free" : wallAngleLockModeRef.current;
        if (effectiveAngleMode === "free") {
          snapRef.current = computeSnap(wx, wz, editedLinesRef.current, camRef.current, 14, effectiveGridStep, effectiveSnapEp);
          if (!freeDrawMode) setFreeDrawMode(true);
        } else {
          const [ax, az] = addStepRef.current;
          snapRef.current = computeSnapConstrained(
            wx, wz, editedLinesRef.current, camRef.current, ax, az,
            14, effectiveGridStep, effectiveSnapEp, effectiveAngleMode,
          );
          if (freeDrawMode) setFreeDrawMode(false);
        }
      } else if (mode === "corner") {
        // Corner tool: track which wall is under the cursor
        const idx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 12);
        hoveredLineRef.current = idx;
        setCornerHoverIdx(idx);

        // If first wall already selected, compute live intersection preview
        const cs = cornerStateRef.current;
        if (cs && idx >= 0 && idx !== cs.firstIdx) {
          const [ax1, az1, ax2, az2] = [...editedLinesRef.current[cs.firstIdx].pts[0], ...editedLinesRef.current[cs.firstIdx].pts[1]];
          const [bx1, bz1, bx2, bz2] = [...editedLinesRef.current[idx].pts[0], ...editedLinesRef.current[idx].pts[1]];
          const hit = lineIntersect(ax1, az1, ax2, az2, bx1, bz1, bx2, bz2);
          setCornerIntersection(hit ? hit.pt : null);
        } else {
          setCornerIntersection(null);
        }
      } else if (mode === "notch") {
        const snap = computeSnap(wx, wz, editedLinesRef.current, camRef.current, 14, effectiveGridStep, effectiveSnapEp);
        snapRef.current = snap;
        if (freeDrawMode) setFreeDrawMode(false);
        const [sx, sz] = snap.pt;
        const fw = parseFloat(notchFixedWRef.current);
        const fd = parseFloat(notchFixedDRef.current);
        const dimStep = effectiveGridStep > 0 && snap.kind !== "endpoint" && snap.kind !== "midpoint" && snap.kind !== "edge"
          ? effectiveGridStep
          : 0;

        let nextPrev = null;
        const st = notchStateRef.current;
        if (notchSubModeRef.current === "corner") {
          if (!st) {
            const corner = findNearestWallCorner(wx, wz, editedLinesRef.current, camRef.current, 32);
            if (corner) {
              nextPrev = { stage: "hover-corner", ...corner };
            } else {
              const wIdx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 12);
              if (wIdx >= 0 && !editedLinesRef.current[wIdx].hidden) {
                nextPrev = { stage: "hover-wall1", wallIdx: wIdx, pt: [wx, wz] };
              }
            }
          } else if (st.kind === "wall1") {
            const wIdx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 12);
            nextPrev = {
              stage: "active-wall1",
              idxA: st.idxA,
              hoverIdx: wIdx >= 0 && wIdx !== st.idxA && !editedLinesRef.current[wIdx]?.hidden ? wIdx : -1,
            };
          } else if (st.kind === "corner") {
            lastNotchTargetRef.current = [sx, sz];
            const geom = computeCornerNotchGeometry(
              editedLinesRef.current, st.idxA, st.idxB, st.cornerPt,
              sx, sz, fw, fd, dimStep,
            );
            if (geom) nextPrev = { stage: "active-corner", ...geom };
          }
        } else {
          if (!st) {
            const wIdx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 14);
            if (wIdx >= 0 && !editedLinesRef.current[wIdx].hidden) {
              const [[x1, z1], [x2, z2]] = editedLinesRef.current[wIdx].pts;
              const proj = projectPointToSeg(wx, wz, x1, z1, x2, z2);
              nextPrev = { stage: "hover-pillar", wallIdx: wIdx, startPt: [proj.x, proj.z] };
            }
          } else if (st.kind === "pillar") {
            lastNotchTargetRef.current = [sx, sz];
            const geom = computeWallPillarGeometry(
              editedLinesRef.current, st.wallIdx, st.startPt,
              sx, sz, fw, fd, dimStep,
            );
            if (geom) nextPrev = { stage: "active-pillar", ...geom };
          }
        }
        notchPreviewRef.current = nextPrev;
        setNotchPreview(nextPrev);
      } else {
        snapRef.current = computeSnap(wx, wz, editedLinesRef.current, camRef.current, 14, effectiveGridStep, effectiveSnapEp);
        if (freeDrawMode) setFreeDrawMode(false);
      }

      if (mode === "delete" || mode === "hide") {
        const idx = findNearestLine(wx, wz, editedLinesRef.current, camRef.current);
        hoveredLineRef.current = idx;
        setHoveredLine(idx);   // for cursor CSS
      }

      if (mode === "add-door" || mode === "add-window") {
        let bestWall = 18 / camRef.current.scale, idx = -1, t = 0.5;
        editedLinesRef.current.forEach((l, i) => {
          if (l.hidden) return;
          const [[x1, z1], [x2, z2]] = l.pts;
          const d = distPointToSeg(wx, wz, x1, z1, x2, z2);
          if (d < bestWall) {
            bestWall = d; idx = i;
            const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
            t = len2 > 0 ? Math.max(0.05, Math.min(0.95, ((wx - x1) * dx + (wz - z1) * dz) / len2)) : 0.5;
          }
        });
        const info = idx >= 0 ? { wallIdx: idx, position_t: t } : null;
        hoverOpeningRef.current = info;
        setHoverOp(info);
      }

      // Check hover over manual openings (e.g. for delete or inspect)
      let bestOp = 16 / camRef.current.scale, hitOpIdx = -1;
      userOpeningsRef.current.forEach((op, oIdx) => {
        let wi = op.wall_idx;
        if (wi < 0 || wi >= editedLinesRef.current.length) {
          if (op.wall_x1 != null) {
            editedLinesRef.current.forEach((l, i) => {
              const [[x1, z1], [x2, z2]] = l.pts;
              if (Math.hypot(x1 - op.wall_x1, z1 - op.wall_z1) < 0.2) wi = i;
            });
          }
        }
        if (wi < 0 || wi >= editedLinesRef.current.length) return;
        const [[x1, z1], [x2, z2]] = editedLinesRef.current[wi].pts;
        const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
        const mx = x1 + (x2 - x1) * t, mz = z1 + (z2 - z1) * t;
        const d = Math.hypot(wx - mx, wz - mz);
        if (d < bestOp) { bestOp = d; hitOpIdx = oIdx; }
      });
      hoverManualOpRef.current = hitOpIdx;
      setHoverManualOp(hitOpIdx);

      scheduleDraw();
    } else {
      // In select mode: check hover over manual openings, selected wall handles, and walls
      const [wx, wz] = getWorldFromEvent(e);
      let bestOp = 16 / camRef.current.scale, hitOpIdx = -1;
      userOpeningsRef.current.forEach((op, oIdx) => {
        let wi = op.wall_idx;
        if (wi < 0 || wi >= editedLinesRef.current.length) {
          if (op.wall_x1 != null) {
            editedLinesRef.current.forEach((l, i) => {
              const [[x1, z1], [x2, z2]] = l.pts;
              if (Math.hypot(x1 - op.wall_x1, z1 - op.wall_z1) < 0.2) wi = i;
            });
          }
        }
        if (wi < 0 || wi >= editedLinesRef.current.length) return;
        const [[x1, z1], [x2, z2]] = editedLinesRef.current[wi].pts;
        const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
        const mx = x1 + (x2 - x1) * t, mz = z1 + (z2 - z1) * t;
        const d = Math.hypot(wx - mx, wz - mz);
        if (d < bestOp) { bestOp = d; hitOpIdx = oIdx; }
      });

      const nextHandle = showWalls && hitOpIdx < 0
        ? hitTestSelectedWallHandle(wx, wz, camRef.current)
        : null;
      const nextWallHover = showWalls && hitOpIdx < 0 && !nextHandle
        ? findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 10)
        : -1;

      const changed =
        hitOpIdx !== hoverManualOpRef.current ||
        nextHandle !== hoveredHandleRef.current ||
        nextWallHover !== hoveredLineRef.current;

      if (hitOpIdx !== hoverManualOpRef.current) {
        hoverManualOpRef.current = hitOpIdx;
        setHoverManualOp(hitOpIdx);
      }
      if (nextHandle !== hoveredHandleRef.current) {
        hoveredHandleRef.current = nextHandle;
        setHoveredHandle(nextHandle);
      }
      if (nextWallHover !== hoveredLineRef.current) {
        hoveredLineRef.current = nextWallHover;
        setHoveredLine(nextWallHover);
      }
      if (changed) scheduleDraw();

      // Reset free-draw flag when not in add mode
      if (freeDrawMode) setFreeDrawMode(false);
    }
  }, [scheduleDraw, getWorldFromEvent, pushHistory, hitTestSelectedWallHandle, freeDrawMode, showWalls]);

  const onMouseUp = useCallback((e) => {
    // Wall drag end
    if (wallDragRef.current) {
      const moved = wallDragRef.current.moved;
      wallDragRef.current = null;
      snapRef.current = null;
      if (moved) setIsDirty(true);
      scheduleDraw();
      return;
    }

    // Pan drag end
    if (dragRef.current) {
      if (dragRef.current.moved) {
        didPanRef.current = true;
      }
      dragRef.current = null;
      return;
    }

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
          const keptIndices = [];
          newLines = [];
          lines.forEach((line, i) => {
            const [[x1, z1], [x2, z2]] = line.pts;
            if (!segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax)) {
              keptIndices.push(i);
              newLines.push(line);
            }
          });
          const updatedOps = userOpeningsRef.current
            .filter(op => keptIndices.includes(op.wall_idx))
            .map(op => ({ ...op, wall_idx: keptIndices.indexOf(op.wall_idx) }));
          userOpeningsRef.current = updatedOps;
          setUserOpenings(updatedOps);
          setOpeningsDirty(true);
          setSelectedWallIdx(null);
          selectedWallIdxRef.current = null;
          setSelectedOpIdx(null);
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

    if (mode === "add-door" || mode === "add-window") {
      const info = hoverOpeningRef.current;
      if (info?.wallIdx >= 0 && info.wallIdx < editedLinesRef.current.length) {
        const isDoor = mode === "add-door";
        const line = editedLinesRef.current[info.wallIdx];
        const linePts = line?.pts ?? [[0, 0], [0, 0]];
        const [wx1, wz1] = linePts[0];
        const [wx2, wz2] = linePts[1];
        const t = Math.max(0.05, Math.min(0.95, info.position_t ?? 0.5));
        const opW = isDoor ? toolDoorWidth : toolWindowWidth;
        const posX = wx1 + t * (wx2 - wx1);
        const posZ = wz1 + t * (wz2 - wz1);
        const newOp = {
          id: `uo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: isDoor ? "door" : "window",
          wall_idx: info.wallIdx,
          position_t: t,
          width: opW,
          width_m: opW,
          side: isDoor ? toolDoorHingeSide : 1,
          swing_dir: isDoor ? toolDoorSwingDir : 1,
          top_margin: isDoor ? toolDoorTopMargin : toolWindowTopMargin,
          bottom_margin: isDoor ? 0 : toolWindowBottomMargin,
          wall_x1: wx1,
          wall_z1: wz1,
          wall_x2: wx2,
          wall_z2: wz2,
          x: posX,
          z: posZ,
        };
        const nl = [...userOpeningsRef.current, newOp];
        userOpeningsRef.current = nl;
        setUserOpenings(nl);
        setSelectedOpIdx(nl.length - 1);
        setOpeningsDirty(true);
        scheduleDraw();
      }
      return;
    }

    if (mode === "select") {
      // If user was panning or dragging a wall, do not treat this as a click
      if (didPanRef.current) {
        didPanRef.current = false;
        return;
      }
      if (hoverManualOpRef.current >= 0) {
        setSelectedOpIdx(hoverManualOpRef.current);
        setSelectedWallIdx(null); selectedWallIdxRef.current = null;
        scheduleDraw();
        return;
      }
      if (selectedOpIdxRef.current !== null) {
        setSelectedOpIdx(null);
        scheduleDraw();
      }

      // Check click on visible Matterport equipment / viewpoint / sweep markers
      if (onSelectMpItem) {
        const [mwx, mwz] = getWorldFromEvent(e);
        const hitR = 10 / camRef.current.scale;
        const onFloor = (item) =>
          Boolean(item?.s2f_position) &&
          item.floor_idx != null &&
          Number(item.floor_idx) === Number(selectedFloor);

        if (showMpPoints) {
          for (const pt of mpPoints || []) {
            if (!onFloor(pt)) continue;
            if (Math.hypot(pt.s2f_position.x - mwx, pt.s2f_position.z - mwz) <= hitR) {
              onSelectMpItem({ kind: "point", data: pt });
              return;
            }
          }
        }
        if (showMpEquip || showMpAiHints) {
          for (const inst of mpInstances || []) {
            if (!onFloor(inst)) continue;
            if (hiddenMpLabels.includes(inst.label)) continue;
            const isHint = inst.label === "dvere" || inst.label === "okno";
            if ((isHint && !showMpAiHints) || (!isHint && !showMpEquip)) continue;
            if (Math.hypot(inst.s2f_position.x - mwx, inst.s2f_position.z - mwz) <= hitR) {
              onSelectMpItem({ kind: "instance", data: inst });
              return;
            }
          }
        }
        if (showMpSweeps) {
          for (const sw of Object.values(mpSweeps || {})) {
            if (!onFloor(sw)) continue;
            if (Math.hypot(sw.s2f_position.x - mwx, sw.s2f_position.z - mwz) <= hitR) {
              onSelectMpItem({ kind: "sweep", data: sw });
              return;
            }
          }
        }
      }

      const [wx, wz] = getWorldFromEvent(e);
      if (showWalls) {
        const wallHit = findNearestLine(wx, wz, editedLinesRef.current, camRef.current, 10);
        if (wallHit >= 0) {
          setSelectedWallIdx(wallHit); selectedWallIdxRef.current = wallHit;
          setSelectedOpIdx(null); selectedOpIdxRef.current = null;
          scheduleDraw();
          return;
        }
      }
      if (selectedWallIdxRef.current !== null) {
        setSelectedWallIdx(null); selectedWallIdxRef.current = null;
        setHoveredHandle(null); hoveredHandleRef.current = null;
        scheduleDraw();
      }

      // Check if click falls inside a room polygon / bbox → toggle selection
      if (onSelectRoom && roomsData?.rooms?.length) {
        for (const room of roomsData.rooms) {
          let inside = false;
          if (room.polygon && room.polygon.length >= 3) {
            const poly = room.polygon;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const xi = poly[i][0], zi = poly[i][1];
              const xj = poly[j][0], zj = poly[j][1];
              const intersect = ((zi > wz) !== (zj > wz)) && (wx < (xj - xi) * (wz - zi) / (zj - zi) + xi);
              if (intersect) inside = !inside;
            }
          }
          if (!inside && room.bbox) {
            const { x_min, z_min, x_max, z_max } = room.bbox;
            if (wx >= x_min && wx <= x_max && wz >= z_min && wz <= z_max) {
              inside = true;
            }
          }
          if (inside) {
            onSelectRoom(highlightedRoomIdRef.current === room.id ? null : room.id, selectedFloor, { ...room, floor_idx: selectedFloor });
            return;
          }
        }
        // Clicked outside any room — deselect
        if (highlightedRoomIdRef.current != null) {
          onSelectRoom(null);
        }
      }
      return;
    }

    if (mode === "add") {
      const snap = snapRef.current;
      const [wx, wz] = snap ? snap.pt : getWorldFromEvent(e);
      if (!addStepRef.current) {
        // Place first point
        addStepRef.current = [wx, wz];
        setAddStep([wx, wz]);
        typedWallLengthRef.current = "";
        setTypedWallLength("");
        scheduleDraw();
      } else {
        // Place second point → commit
        const [ax, az] = addStepRef.current;
        if (Math.hypot(wx - ax, wz - az) < 0.03) return;
        const newLine = {
          pts: [[ax, az], [wx, wz]],
          source: "user",
          thickness: normalizeWallThickness(toolWallThicknessRef.current),
          thicknessSource: "edited",
        };
        const newLines = [...editedLinesRef.current, newLine];
        pushHistory(editedLinesRef.current);
        setEditedLines(newLines); editedLinesRef.current = newLines;
        setSelectedWallIdx(newLines.length - 1);
        selectedWallIdxRef.current = newLines.length - 1;
        setSelectedOpIdx(null); selectedOpIdxRef.current = null;
        typedWallLengthRef.current = "";
        setTypedWallLength("");
        if (wallChainModeRef.current && !e.ctrlKey) {
          addStepRef.current = [wx, wz];
          setAddStep([wx, wz]);
        } else {
          addStepRef.current = null;
          setAddStep(null);
        }
        setIsDirty(true);
        scheduleDraw();
      }
      return;
    }

    if (mode === "delete") {
      // First check if an opening was clicked
      if (hoverManualOpRef.current >= 0) {
        const delIdx = hoverManualOpRef.current;
        const nl = userOpeningsRef.current.filter((_, i) => i !== delIdx);
        userOpeningsRef.current = nl;
        setUserOpenings(nl);
        setSelectedOpIdx(null);
        setOpeningsDirty(true);
        scheduleDraw();
        return;
      }

      // Skip if a box-select drag was just completed (boxSelectRef cleared in onMouseUp)
      if (boxSelectRef.current !== null) return; // still active (shouldn't happen)
      const idx = hoveredLineRef.current;
      if (idx >= 0) {
        const newLines = editedLinesRef.current.filter((_, i) => i !== idx);
        pushHistory(editedLinesRef.current);
        setEditedLines(newLines); editedLinesRef.current = newLines;
        hoveredLineRef.current = -1; setHoveredLine(-1);
        if (selectedWallIdxRef.current === idx) {
          setSelectedWallIdx(null); selectedWallIdxRef.current = null;
        } else if (selectedWallIdxRef.current != null && selectedWallIdxRef.current > idx) {
          const nxt = selectedWallIdxRef.current - 1;
          setSelectedWallIdx(nxt); selectedWallIdxRef.current = nxt;
        }
        snapRef.current = null;
        setIsDirty(true);

        const updatedOps = userOpeningsRef.current
          .filter(op => op.wall_idx !== idx)
          .map(op => op.wall_idx > idx ? { ...op, wall_idx: op.wall_idx - 1 } : op);
        userOpeningsRef.current = updatedOps;
        setUserOpenings(updatedOps);
        setOpeningsDirty(true);

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

    if (mode === "corner") {
      const idx = hoveredLineRef.current;
      if (idx < 0) return; // clicked empty space

      if (!cornerStateRef.current) {
        // Step 1: select first wall
        cornerStateRef.current = { firstIdx: idx };
        setCornerStep(1);
        scheduleDraw();
      } else {
        // Step 2: select second wall, compute intersection and apply
        const firstIdx = cornerStateRef.current.firstIdx;
        if (idx === firstIdx) return; // clicked same wall

        const lines = editedLinesRef.current;
        const [[ax1, az1], [ax2, az2]] = lines[firstIdx].pts;
        const [[bx1, bz1], [bx2, bz2]] = lines[idx].pts;
        const hit = lineIntersect(ax1, az1, ax2, az2, bx1, bz1, bx2, bz2);

        if (hit) {
          const [ix, iz] = hit.pt;
          // Find which endpoint of each wall to extend to the intersection
          const ep1 = nearestEndpointIdx(lines[firstIdx].pts, [ix, iz]);
          const ep2 = nearestEndpointIdx(lines[idx].pts, [ix, iz]);

          const newLines = lines.map((line, i) => {
            if (i === firstIdx) {
              const newPts = [line.pts[0].slice(), line.pts[1].slice()];
              newPts[ep1] = [ix, iz];
              return { ...line, pts: newPts, source: line.source === "algo" ? "user" : line.source };
            }
            if (i === idx) {
              const newPts = [line.pts[0].slice(), line.pts[1].slice()];
              newPts[ep2] = [ix, iz];
              return { ...line, pts: newPts, source: line.source === "algo" ? "user" : line.source };
            }
            return line;
          });
          pushHistory(lines);
          setEditedLines(newLines); editedLinesRef.current = newLines;
          setIsDirty(true);
        }

        // Reset corner state for next operation
        cornerStateRef.current = null;
        setCornerStep(0); setCornerHoverIdx(-1); setCornerIntersection(null);
        scheduleDraw();
      }
      return;
    }

    if (mode === "notch") {
      const prev = notchPreviewRef.current;
      const st = notchStateRef.current;
      const lines = editedLinesRef.current;
      const fw = parseFloat(notchFixedWRef.current);
      const fd = parseFloat(notchFixedDRef.current);

      const seedCornerSizing = (idxA, idxB, cornerPt) => {
        const lineA = lines[idxA], lineB = lines[idxB];
        const farA = lineA.pts[1 - nearestEndpointIdx(lineA.pts, cornerPt)];
        const farB = lineB.pts[1 - nearestEndpointIdx(lineB.pts, cornerPt)];
        const lA = Math.max(0.1, Math.hypot(farA[0] - cornerPt[0], farA[1] - cornerPt[1]));
        const lB = Math.max(0.1, Math.hypot(farB[0] - cornerPt[0], farB[1] - cornerPt[1]));
        const defTarget = [
          cornerPt[0] + ((farA[0] - cornerPt[0]) / lA) * 0.25 + ((farB[0] - cornerPt[0]) / lB) * 0.25,
          cornerPt[1] + ((farA[1] - cornerPt[1]) / lA) * 0.25 + ((farB[1] - cornerPt[1]) / lB) * 0.25,
        ];
        lastNotchTargetRef.current = defTarget;
        notchStateRef.current = { kind: "corner", idxA, idxB, cornerPt };
        setNotchStep(1);
        const geom = computeCornerNotchGeometry(lines, idxA, idxB, cornerPt, defTarget[0], defTarget[1], fw, fd, 0);
        const nextPrev = geom ? { stage: "active-corner", ...geom } : null;
        notchPreviewRef.current = nextPrev;
        setNotchPreview(nextPrev);
        scheduleDraw();
      };

      if (!st) {
        if (prev?.stage === "hover-corner") {
          seedCornerSizing(prev.idxA, prev.idxB, prev.cornerPt);
        } else if (prev?.stage === "hover-wall1") {
          notchStateRef.current = { kind: "wall1", idxA: prev.wallIdx };
          setNotchStep(1);
          const nextPrev = { stage: "active-wall1", idxA: prev.wallIdx, hoverIdx: -1 };
          notchPreviewRef.current = nextPrev;
          setNotchPreview(nextPrev);
          scheduleDraw();
        } else if (prev?.stage === "hover-pillar") {
          notchStateRef.current = { kind: "pillar", wallIdx: prev.wallIdx, startPt: prev.startPt };
          setNotchStep(1);
          const [wx, wz] = getWorldFromEvent(e);
          lastNotchTargetRef.current = [wx, wz];
          scheduleDraw();
        }
        return;
      }

      if (st.kind === "wall1") {
        if (prev?.hoverIdx >= 0 && prev.hoverIdx !== st.idxA) {
          const [[ax1, az1], [ax2, az2]] = lines[st.idxA].pts;
          const [[bx1, bz1], [bx2, bz2]] = lines[prev.hoverIdx].pts;
          const hit = lineIntersect(ax1, az1, ax2, az2, bx1, bz1, bx2, bz2);
          if (hit) {
            const uAx = Math.abs(ax2 - ax1) / Math.max(0.01, Math.hypot(ax2 - ax1, az2 - az1));
            const uBx = Math.abs(bx2 - bx1) / Math.max(0.01, Math.hypot(bx2 - bx1, bz2 - bz1));
            if (uBx >= uAx) seedCornerSizing(st.idxA, prev.hoverIdx, hit.pt);
            else seedCornerSizing(prev.hoverIdx, st.idxA, hit.pt);
          }
        }
        return;
      }

      if (prev?.stage === "active-corner" || prev?.stage === "active-pillar") {
        commitNotchPreview(prev);
      }
      return;
    }
  }, [pushHistory, scheduleDraw, getWorldFromEvent, onSelectRoom, roomsData, toolDoorWidth, toolDoorHingeSide, toolDoorSwingDir, toolDoorTopMargin, toolWindowWidth, toolWindowBottomMargin, toolWindowTopMargin, selectedFloor, mpInstances, mpPoints, mpSweeps, showMpEquip, showMpAiHints, showMpSweeps, showMpPoints, hiddenMpLabels, onSelectMpItem, showWalls, commitNotchPreview]);

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

  // Discard all edits
  const handleReset = useCallback(() => {
    fetch(`${apiBase}/walls/${selectedFloor}`).then(r => r.json()).then(w => {
      const converted = wallJsonToEditedLines(w);
      setEditedLines(converted); editedLinesRef.current = converted;
      setUndoStack([]); setRedoStack([]);
      setIsDirty(false); setAddStep(null); addStepRef.current = null;
      setSelectedWallIdx(null); selectedWallIdxRef.current = null;
      setHoveredHandle(null); hoveredHandleRef.current = null;
      wallDragRef.current = null;
      notchStateRef.current = null; setNotchStep(0);
      notchPreviewRef.current = null; setNotchPreview(null);
      lastNotchTargetRef.current = null;
      setTypedWallLength(""); typedWallLengthRef.current = "";
      scheduleDraw();
    }).catch(() => { });
    fetch(`${apiBase}/openings/${selectedFloor}`).then(r => r.json()).then(o => {
      const uo = o?.user_openings ?? [];
      setUserOpenings(uo); userOpeningsRef.current = uo;
      setOpeningsData(o);
      setOpeningsDirty(false); setSelectedOpIdx(null);
      scheduleDraw();
    }).catch(() => { });
  }, [selectedFloor, apiBase, scheduleDraw]);

  // ── Derived metrics ─────────────────────────────────────────────────────────
  const wallCount = editedLines.length;
  const userCount = editedLines.filter(l => l.source === "user" && !l.hidden).length;
  const hiddenCount = editedLines.filter(l => l.hidden).length;
  const roomCount = roomsData?.rooms?.length ?? 0;
  const openings = [...(openingsData?.openings ?? []), ...userOpenings];
  const doorCount = openings.filter(o => o.type === "door").length;
  const windowCount = openings.filter(o => o.type === "window").length;
  const lowConfCount = openings.filter(o => (o.confidence ?? 1) < LOW_CONF_THRESHOLD).length;

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  // Highlighted room object (for the info chip)
  const highlightedRoom = highlightedRoomId != null
    ? (roomsData?.rooms ?? []).find(r => r.id === highlightedRoomId) ?? null
    : null;

  // Cursor style
  const cursorStyle = editMode === "select"
    ? (wallDragRef.current
      ? (wallDragRef.current.kind === "body" ? "move" : "crosshair")
      : hoveredHandle === "p1" || hoveredHandle === "p2"
        ? "crosshair"
        : hoveredHandle === "body"
          ? "move"
          : dragRef.current
            ? "grabbing"
            : hoveredLine >= 0
              ? "pointer"
              : "grab")
    : editMode === "add"
      ? "crosshair"
      : editMode === "notch"
        ? (notchPreview ? "crosshair" : "pointer")
        : editMode === "corner"
          ? (cornerHoverIdx >= 0 ? "pointer" : "crosshair")
          : (boxSelectRef.current?.moved
            ? "crosshair"
            : hoveredLine >= 0 ? "pointer" : "crosshair");

  const dxfUrl = saveName
    ? `${apiBase}/download/${selectedFloor}`
    : `${apiBase}/walls/${selectedFloor}/download`;

  const ifcUrl = saveName
    ? `/api/saves/${encodeURIComponent(saveName)}/download-ifc/${selectedFloor}`
    : `/api/walls/${selectedFloor}/download-ifc`;

  const ifcAllUrl = saveName
    ? `/api/saves/${encodeURIComponent(saveName)}/download-ifc-all`
    : `/api/building/download-ifc`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="floorplan-viewer" style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ── Edit Toolbar ─────────────────────────────────────────────────────── */}
      <EditToolbar
        mode={editMode}
        onMode={(m) => {
          setEditMode(m); editModeRef.current = m;
          wallDragRef.current = null;
          setHoveredHandle(null); hoveredHandleRef.current = null;
          if (m !== "add") {
            addStepRef.current = null; setAddStep(null);
            typedWallLengthRef.current = ""; setTypedWallLength("");
            scheduleDraw();
          }
          if (m !== "select" && m !== "add") {
            setSelectedWallIdx(null); selectedWallIdxRef.current = null;
          }
          if (m === "add" || m === "notch") {
            setSelectedOpIdx(null); selectedOpIdxRef.current = null;
          }
          if (m !== "notch") {
            notchStateRef.current = null; setNotchStep(0);
            notchPreviewRef.current = null; setNotchPreview(null);
            lastNotchTargetRef.current = null;
          }
          if (m !== "corner") { cornerStateRef.current = null; setCornerStep(0); setCornerHoverIdx(-1); setCornerIntersection(null); }
          if (m !== "delete" && m !== "hide" && m !== "select") { hoveredLineRef.current = -1; setHoveredLine(-1); scheduleDraw(); }
          snapRef.current = null;
        }}
        canUndo={canUndo} canRedo={canRedo}
        onUndo={undo} onRedo={redo}
        isDirty={isDirty || openingsDirty}
        onSave={handleSave}
        onReset={handleReset}
        saveState={saveState}
        wallCount={wallCount}
        userCount={userCount}
        hiddenCount={hiddenCount}
        roomCount={roomCount}
        cornerStep={cornerStep}
        gridStep={gridStep}
        onGridStep={setGridStep}
        snapToVertices={snapToVertices}
        onToggleSnapToVertices={() => setSnapToVertices(v => !v)}
        orthoMode={orthoMode}
        onOrthoMode={setOrthoMode}
        orthoLoading={orthoLoading}
        onFit={() => {
          const cvs = canvasRef.current;
          if (!cvs || !editedLinesRef.current.length) return;
          camRef.current = fitCamera(wallsBoundsFromEdited(editedLinesRef.current), cvs.width, cvs.height);
          scheduleDraw();
        }}
        dxfUrl={dxfUrl}
        ifcUrl={ifcUrl}
        ifcAllUrl={ifcAllUrl}
        selectedFloor={selectedFloor}
        saveName={saveName}
      />

      {/* ── Wall Placement Parameter Subbar ──────────────────────────────────── */}
      {editMode === "add" && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 14px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-1)",
          flexWrap: "wrap",
          fontSize: 11,
          zIndex: 5,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Thickness:</span>
            {[0.10, 0.15, 0.20, 0.25, 0.30].map(t => (
              <button
                key={t}
                type="button"
                className={`rep-pill-btn${Math.abs(toolWallThickness - t) < 0.004 ? " active" : ""}`}
                onClick={() => setToolWallThickness(t)}
              >{Math.round(t * 100)}cm</button>
            ))}
            <DraftNumberInput
              min={0.05}
              max={1.0}
              step={0.01}
              decimals={2}
              value={toolWallThickness}
              onCommit={(v) => setToolWallThickness(v)}
              style={{ width: 56 }}
              title="Custom wall thickness (meters)"
            />
            <span style={{ color: "var(--text-3)" }}>m</span>
          </div>

          <span className="rep-sep" />

          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Angle:</span>
            {[
              ["45", "45° Lock"],
              ["90", "90° Ortho"],
              ["free", "Free"],
            ].map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className={`rep-pill-btn${wallAngleLockMode === val ? " active" : ""}`}
                onClick={() => setWallAngleLockMode(val)}
              >{lbl}</button>
            ))}
          </div>

          <span className="rep-sep" />

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className={`rep-pill-btn${wallChainMode ? " active" : ""}`}
              onClick={() => setWallChainMode(v => !v)}
              title="Continue placing connected wall segments from the previous endpoint"
            >🔗 Chain: {wallChainMode ? "ON" : "OFF"}</button>
            {addStep && (
              <button
                type="button"
                className="rep-pill-btn"
                onClick={() => {
                  addStepRef.current = null; setAddStep(null);
                  snapRef.current = null;
                  typedWallLengthRef.current = ""; setTypedWallLength("");
                  scheduleDraw();
                }}
              >End Chain (Esc)</button>
            )}
          </div>

          <span className="rep-sep" />

          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Exact Length:</span>
            <input
              type="number"
              min="0.05"
              max="200"
              step="0.01"
              placeholder="Length (m)"
              className="rep-subbar-input"
              style={{ width: 82 }}
              value={typedWallLength}
              onChange={(e) => {
                typedWallLengthRef.current = e.target.value;
                setTypedWallLength(e.target.value);
                scheduleDraw();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && addStep) {
                  const v = parseFloat(typedWallLength);
                  if (Number.isFinite(v) && v >= 0.05) {
                    commitAddWallWithLength(v);
                  }
                }
              }}
            />
            <button
              type="button"
              className={`rep-pill-btn${addStep && parseFloat(typedWallLength) >= 0.05 ? " active" : ""}`}
              disabled={!addStep || !(parseFloat(typedWallLength) >= 0.05)}
              onClick={() => commitAddWallWithLength(parseFloat(typedWallLength))}
              title="Place wall segment along active direction with exact length"
            >Place ↵</button>
          </div>
        </div>
      )}

      {/* ── Corner Notch / Wall Pillar Parameter Subbar ───────────────────────── */}
      {editMode === "notch" && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 14px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-1)",
          flexWrap: "wrap",
          fontSize: 11,
          zIndex: 5,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Shape:</span>
            {[
              ["corner", "┐ Corner Notch (2 Walls)"],
              ["pillar", "┌─┐ Wall Pillar (1 Wall)"],
            ].map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className={`rep-pill-btn${notchSubMode === val ? " active" : ""}`}
                onClick={() => {
                  setNotchSubMode(val);
                  notchStateRef.current = null; setNotchStep(0);
                  notchPreviewRef.current = null; setNotchPreview(null);
                  lastNotchTargetRef.current = null;
                  scheduleDraw();
                }}
              >{lbl}</button>
            ))}
          </div>

          <span className="rep-sep" />

          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Thickness:</span>
            {[0.08, 0.10, 0.12, 0.15, 0.20].map(t => (
              <button
                key={t}
                type="button"
                className={`rep-pill-btn${Math.abs(toolNotchThickness - t) < 0.004 ? " active" : ""}`}
                onClick={() => setToolNotchThickness(t)}
              >{Math.round(t * 100)}cm</button>
            ))}
            <DraftNumberInput
              min={0.05}
              max={0.60}
              step={0.01}
              decimals={2}
              value={toolNotchThickness}
              onCommit={(v) => setToolNotchThickness(v)}
              style={{ width: 54 }}
              title="Custom notch wall thickness (meters)"
            />
            <span style={{ color: "var(--text-3)" }}>m</span>
          </div>

          <span className="rep-sep" />

          <button
            type="button"
            className={`rep-pill-btn${trimNotchCorner ? " active" : ""}`}
            onClick={() => setTrimNotchCorner(v => !v)}
            title="Trim the outer square corner walls so rooms form a clean stepped corner"
          >✂ Trim outer corner: {trimNotchCorner ? "ON" : "OFF"}</button>

          <span className="rep-sep" />

          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>W:</span>
            <input
              type="number" min="0.04" max="10" step="0.01" placeholder="Auto"
              className="rep-subbar-input" style={{ width: 58 }}
              value={notchFixedW}
              onChange={(e) => {
                notchFixedWRef.current = e.target.value;
                setNotchFixedW(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && notchPreviewRef.current && (notchPreviewRef.current.stage === "active-corner" || notchPreviewRef.current.stage === "active-pillar")) {
                  commitNotchPreview(notchPreviewRef.current);
                }
              }}
            />
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>D:</span>
            <input
              type="number" min="0.04" max="10" step="0.01" placeholder="Auto"
              className="rep-subbar-input" style={{ width: 58 }}
              value={notchFixedD}
              onChange={(e) => {
                notchFixedDRef.current = e.target.value;
                setNotchFixedD(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && notchPreviewRef.current && (notchPreviewRef.current.stage === "active-corner" || notchPreviewRef.current.stage === "active-pillar")) {
                  commitNotchPreview(notchPreviewRef.current);
                }
              }}
            />
            <span style={{ color: "var(--text-3)" }}>m</span>
            {(notchFixedW || notchFixedD) && (
              <button
                type="button"
                className="rep-pill-btn"
                onClick={() => {
                  notchFixedWRef.current = ""; notchFixedDRef.current = "";
                  setNotchFixedW(""); setNotchFixedD("");
                }}
              >Auto</button>
            )}
            <button
              type="button"
              className={`rep-pill-btn${notchStep === 1 && (notchPreview?.stage === "active-corner" || notchPreview?.stage === "active-pillar") ? " active" : ""}`}
              disabled={!(notchStep === 1 && (notchPreview?.stage === "active-corner" || notchPreview?.stage === "active-pillar"))}
              onClick={() => commitNotchPreview(notchPreviewRef.current)}
              title="Commit corner notch / pillar (Enter)"
            >Place ↵</button>
          </div>
        </div>
      )}

      {/* ── Door / Window Parameter Subbar ───────────────────────────────────── */}
      {(editMode === "add-door" || editMode === "add-window") && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 14px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-1)",
          flexWrap: "wrap",
          fontSize: 11,
          zIndex: 5,
        }}>
          {editMode === "add-door" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Door Width:</span>
                {[0.75, 0.8, 0.9, 1.0, 1.2].map(w => (
                  <button
                    key={w}
                    className={`rep-pill-btn${toolDoorWidth === w ? " active" : ""}`}
                    onClick={() => setToolDoorWidth(w)}
                  >{w.toFixed(2)}m</button>
                ))}
                <input
                  type="number" min="0.4" max="3.0" step="0.05"
                  className="rep-subbar-input"
                  value={toolDoorWidth}
                  onChange={(e) => setToolDoorWidth(Math.max(0.4, Math.min(3.0, parseFloat(e.target.value) || 0.9)))}
                />
                <span style={{ color: "var(--text-3)" }}>m</span>
              </div>

              <span className="rep-sep" />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Hinge:</span>
                <button
                  className={`rep-pill-btn${toolDoorHingeSide === 1 ? " active" : ""}`}
                  onClick={() => setToolDoorHingeSide(1)}
                >◀ Left</button>
                <button
                  className={`rep-pill-btn${toolDoorHingeSide === -1 ? " active" : ""}`}
                  onClick={() => setToolDoorHingeSide(-1)}
                >Right ▶</button>
              </div>

              <span className="rep-sep" />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Swing:</span>
                <button
                  className={`rep-pill-btn${toolDoorSwingDir === 1 ? " active" : ""}`}
                  onClick={() => setToolDoorSwingDir(1)}
                >↶ Inward</button>
                <button
                  className={`rep-pill-btn${toolDoorSwingDir === -1 ? " active" : ""}`}
                  onClick={() => setToolDoorSwingDir(-1)}
                >Outward ↷</button>
              </div>

              <span className="rep-sep" />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Top Margin:</span>
                {[0.5, 0.6, 0.7, 0.8].map(m => (
                  <button
                    key={m}
                    className={`rep-pill-btn${toolDoorTopMargin === m ? " active" : ""}`}
                    onClick={() => setToolDoorTopMargin(m)}
                  >{m.toFixed(2)}m</button>
                ))}
                <input
                  type="number" min="0.1" max="1.8" step="0.05"
                  className="rep-subbar-input"
                  value={toolDoorTopMargin}
                  onChange={(e) => setToolDoorTopMargin(Math.max(0.1, Math.min(2.0, parseFloat(e.target.value) || 0.7)))}
                />
                <span style={{ color: "var(--text-3)" }}>m</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Window Width:</span>
                {[0.9, 1.2, 1.5, 1.8, 2.4].map(w => (
                  <button
                    key={w}
                    className={`rep-pill-btn${toolWindowWidth === w ? " active" : ""}`}
                    onClick={() => setToolWindowWidth(w)}
                  >{w.toFixed(2)}m</button>
                ))}
                <input
                  type="number" min="0.4" max="4.0" step="0.05"
                  className="rep-subbar-input"
                  value={toolWindowWidth}
                  onChange={(e) => setToolWindowWidth(Math.max(0.3, Math.min(5.0, parseFloat(e.target.value) || 1.2)))}
                />
                <span style={{ color: "var(--text-3)" }}>m</span>
              </div>

              <span className="rep-sep" />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Sill (Bottom):</span>
                {[0.7, 0.8, 0.9, 1.0, 1.1].map(m => (
                  <button
                    key={m}
                    className={`rep-pill-btn${toolWindowBottomMargin === m ? " active" : ""}`}
                    onClick={() => setToolWindowBottomMargin(m)}
                  >{m.toFixed(2)}m</button>
                ))}
                <input
                  type="number" min="0.2" max="1.8" step="0.05"
                  className="rep-subbar-input"
                  value={toolWindowBottomMargin}
                  onChange={(e) => setToolWindowBottomMargin(Math.max(0.1, Math.min(2.0, parseFloat(e.target.value) || 0.9)))}
                />
                <span style={{ color: "var(--text-3)" }}>m</span>
              </div>

              <span className="rep-sep" />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-2)", fontWeight: 600 }}>Top Margin:</span>
                {[0.5, 0.6, 0.7, 0.8].map(m => (
                  <button
                    key={m}
                    className={`rep-pill-btn${toolWindowTopMargin === m ? " active" : ""}`}
                    onClick={() => setToolWindowTopMargin(m)}
                  >{m.toFixed(2)}m</button>
                ))}
                <input
                  type="number" min="0.1" max="1.8" step="0.05"
                  className="rep-subbar-input"
                  value={toolWindowTopMargin}
                  onChange={(e) => setToolWindowTopMargin(Math.max(0.1, Math.min(2.0, parseFloat(e.target.value) || 0.7)))}
                />
                <span style={{ color: "var(--text-3)" }}>m</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Canvas area ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "var(--bg)" }}>
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
          onDoubleClick={(e) => {
            if (editModeRef.current === "select") {
              // If double-clicked inside a room, select it (opens Room Editor Panel)
              if (onSelectRoom && roomsData?.rooms?.length) {
                const [wx, wz] = getWorldFromEvent(e);
                for (const room of roomsData.rooms) {
                  let inside = false;
                  if (room.polygon && room.polygon.length >= 3) {
                    const poly = room.polygon;
                    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                      const xi = poly[i][0], zi = poly[i][1];
                      const xj = poly[j][0], zj = poly[j][1];
                      const intersect = ((zi > wz) !== (zj > wz)) && (wx < (xj - xi) * (wz - zi) / (zj - zi) + xi);
                      if (intersect) inside = !inside;
                    }
                  }
                  if (!inside && room.bbox) {
                    const { x_min, z_min, x_max, z_max } = room.bbox;
                    if (wx >= x_min && wx <= x_max && wz >= z_min && wz <= z_max) inside = true;
                  }
                  if (inside) {
                    onSelectRoom(room.id, selectedFloor, { ...room, floor_idx: selectedFloor });
                    return;
                  }
                }
              }
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

        {/* ── Floating Layers & Equipment filter panel (matches 3D & MiniPlan) ── */}
        <div
          className={`s2f-layers${layersOpen ? "" : " collapsed"}`}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="s2f-layers-head"
            onClick={() => setLayersOpen((v) => !v)}
          >
            <span>Layers</span>
            <span>{layersOpen ? "−" : "+"}</span>
          </button>
          {layersOpen && (
            <div className="s2f-layers-body">
              <div className="s2f-layer">
                <div className="s2f-layer-extra s2f-bim-grid" style={{ marginTop: 4 }}>
                  {[
                    ["walls", "Walls", showWalls, (v) => setPlanLayer("walls", v)],
                    ["rooms", "Room fills", showRooms, (v) => setPlanLayer("rooms", v)],
                    ["roomLabels", "Room labels", showRoomLabels, (v) => setPlanLayer("roomLabels", v)],
                    ["doors", "Doors", showDoors, (v) => setPlanLayer("doors", v)],
                    ["windows", "Windows", showWindows, (v) => setPlanLayer("windows", v)],
                    ["grid", "Grid", showGrid, (v) => setPlanLayer("grid", v)],
                    ["scale", "Scale bar", showScale, (v) => setPlanLayer("scale", v)],
                    ["aiHints", "AI hints", showMpAiHints, (v) => setShowMpAiHints(v)],
                  ].map(([k, label, checked, onToggle]) => (
                    <label key={k} className="s2f-mini-check">
                      <input
                        type="checkbox"
                        checked={!!checked}
                        onChange={(e) => onToggle(e.target.checked)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="s2f-layer">
                <div className="s2f-mini-section" style={{ marginTop: 2 }}>
                  <span>Scan Reference (Ortho)</span>
                  {orthoLoading && (
                    <span style={{ color: "var(--sel)", textTransform: "none", letterSpacing: 0 }}>
                      Loading…
                    </span>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 4 }}>
                  {ORTHO_MODES.map((om) => (
                    <button
                      key={om.id}
                      type="button"
                      title={om.title}
                      className={`rep-pill-btn${orthoMode === om.id ? " active" : ""}`}
                      style={om.id === "off" ? { gridColumn: "1 / -1", textAlign: "center" } : { textAlign: "center" }}
                      onClick={() => setOrthoMode(om.id)}
                    >
                      {om.label}
                    </button>
                  ))}
                </div>
                {orthoMode !== "off" && (
                  <div className="s2f-layer-extra">
                    <label className="s2f-color">
                      <span>Opacity {Math.round(orthoOpacity * 100)}%</span>
                      <input
                        type="range"
                        min="0.1"
                        max="1.0"
                        step="0.05"
                        value={orthoOpacity}
                        onChange={(e) => setOrthoOpacity(parseFloat(e.target.value))}
                      />
                    </label>
                    <label className="s2f-color">
                      <span>Floor cut {orthoBottomCut.toFixed(2)} m</span>
                      <input
                        type="range"
                        min="0.05"
                        max="1.20"
                        step="0.05"
                        value={orthoBottomCut}
                        onChange={(e) => setOrthoBottomCut(parseFloat(e.target.value))}
                      />
                    </label>
                    <label className="s2f-color">
                      <span>Ceil cut {orthoTopCut.toFixed(2)} m</span>
                      <input
                        type="range"
                        min="0.10"
                        max="1.50"
                        step="0.05"
                        value={orthoTopCut}
                        onChange={(e) => setOrthoTopCut(parseFloat(e.target.value))}
                      />
                    </label>
                    {orthoError && (
                      <div style={{ fontSize: 10.5, color: "var(--red)", lineHeight: 1.3 }}>
                        {orthoError}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="s2f-layer">
                <label className="s2f-layer-main">
                  <span className="s2f-layer-text">
                    <span className="s2f-layer-name">Equipment &amp; MEP</span>
                    <span className="s2f-layer-sub">
                      {totalEquipCount > 0
                        ? `${visibleEquipCount} / ${totalEquipCount} visible`
                        : "None on floor"}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!showMpEquip}
                    onChange={(e) => setShowMpEquip(e.target.checked)}
                  />
                  <span className="s2f-switch" />
                </label>
                {showMpEquip && labelInfo.length > 0 && (
                  <div className="s2f-layer-extra">
                    <div className="s2f-mini-section" style={{ marginTop: 2 }}>
                      <span>Equipment types</span>
                      <span>
                        <button
                          type="button"
                          className="s2f-link"
                          onClick={() => setHiddenMpLabels([])}
                        >
                          all
                        </button>
                        {" · "}
                        <button
                          type="button"
                          className="s2f-link"
                          onClick={() => setHiddenMpLabels(labelInfo.map((x) => x.label))}
                        >
                          none
                        </button>
                      </span>
                    </div>
                    <div className="s2f-equip-list">
                      {labelInfo.map(({ label, count, name }) => {
                        const visible = !hiddenMpLabels.includes(label);
                        return (
                          <label key={label} className="s2f-mini-check" title={label}>
                            <input
                              type="checkbox"
                              checked={visible}
                              onChange={() => toggleMpLabel(label)}
                            />
                            <i style={{ background: colorForMpLabel(label) }} />
                            <span className="s2f-mini-name">{name}</span>
                            <em>{count}</em>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="s2f-layer">
                <label className="s2f-layer-main">
                  <span className="s2f-layer-text">
                    <span className="s2f-layer-name">Viewpoints</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!showMpPoints}
                    onChange={(e) => setShowMpPoints(e.target.checked)}
                  />
                  <span className="s2f-switch" />
                </label>
              </div>

              <div className="s2f-layer">
                <label className="s2f-layer-main">
                  <span className="s2f-layer-text">
                    <span className="s2f-layer-name">Live / FPV camera</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!showMpLive}
                    onChange={(e) => setShowMpLive(e.target.checked)}
                  />
                  <span className="s2f-switch" />
                </label>
              </div>

              <div className="s2f-layer">
                <label className="s2f-layer-main">
                  <span className="s2f-layer-text">
                    <span className="s2f-layer-name">360° sweep nodes</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!showMpSweeps}
                    onChange={(e) => setShowMpSweeps(e.target.checked)}
                  />
                  <span className="s2f-switch" />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* ── Selected Wall Inspector ───────────────────────────────────────────── */}
        {selectedWallIdx !== null && selectedOpIdx === null && selectedWallIdx >= 0 && selectedWallIdx < editedLines.length && (() => {
          const selLine = editedLines[selectedWallIdx];
          const wm = getWallMetrics(selLine);
          const normButtons = [
            [-0.10, "-10cm"],
            [-0.05, "-5cm"],
            [-0.01, "-1cm"],
            [0.01, "+1cm"],
            [0.05, "+5cm"],
            [0.10, "+10cm"],
          ];
          const alongButtons = [
            [-0.05, "-5cm"],
            [-0.01, "-1cm"],
            [0.01, "+1cm"],
            [0.05, "+5cm"],
          ];
          return (
            <div
              className="rep-opening-inspector"
              style={{ position: "absolute", top: 12, right: 12, zIndex: 15, width: 292 }}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <div className="rep-inspector-header">
                <span className="rep-inspector-title">
                  <span>🧱</span>
                  <span>Wall #{selectedWallIdx + 1}</span>
                  <span className={`badge${selLine.hidden ? "" : " badge-sel"}`} style={{ fontSize: 9.5, padding: "1px 6px" }}>
                    {selLine.hidden ? "Hidden" : selLine.source === "user" ? "Edited" : "Detected"}
                  </span>
                </span>
                <button
                  type="button"
                  className="rep-close"
                  onClick={() => {
                    setSelectedWallIdx(null); selectedWallIdxRef.current = null;
                    setHoveredHandle(null); hoveredHandleRef.current = null;
                    scheduleDraw();
                  }}
                  title="Close Wall Inspector (Esc)"
                >✕</button>
              </div>

              <div className="rep-inspector-body" style={{ maxHeight: "calc(100vh - 210px)", overflowY: "auto", gap: 10 }}>
                {/* Dimensions summary */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  fontSize: 10.5,
                  textAlign: "center",
                }}>
                  <div>
                    <div style={{ color: "var(--text-3)", fontSize: 9.5, textTransform: "uppercase" }}>Length</div>
                    <div className="s2f-mono" style={{ color: "var(--text-1)", fontWeight: 700 }}>{wm.len.toFixed(2)} m</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text-3)", fontSize: 9.5, textTransform: "uppercase" }}>Angle</div>
                    <div className="s2f-mono" style={{ color: "var(--text-1)", fontWeight: 700 }}>{wm.angleDeg.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--text-3)", fontSize: 9.5, textTransform: "uppercase" }}>Thick</div>
                    <div className="s2f-mono" style={{ color: "var(--sel)", fontWeight: 700 }}>{Math.round(wm.thickness * 100)} cm</div>
                  </div>
                </div>

                {/* Thickness */}
                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Thickness</span>
                    <span className="rep-inspector-val">{Math.round(wm.thickness * 100)} cm ({wm.thickness.toFixed(2)} m)</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {[0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40].map(t => (
                      <button
                        key={t}
                        type="button"
                        className={`rep-pill-btn${Math.abs(wm.thickness - t) < 0.004 ? " active" : ""}`}
                        onClick={() => applyWallTransform(selectedWallIdx, () => ({ thickness: t, thicknessSource: "edited" }), { moveConnected: false })}
                      >{Math.round(t * 100)}</button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                    <input
                      type="range" min="0.05" max="0.60" step="0.01"
                      className="rep-range-slider"
                      value={Math.min(0.60, wm.thickness)}
                      onChange={(e) => applyWallTransform(
                        selectedWallIdx,
                        () => ({ thickness: Math.max(0.05, parseFloat(e.target.value) || 0.20), thicknessSource: "edited" }),
                        { moveConnected: false },
                      )}
                    />
                    <DraftNumberInput
                      min={0.05}
                      max={1.0}
                      step={0.01}
                      decimals={2}
                      value={wm.thickness}
                      onCommit={(v) => applyWallTransform(selectedWallIdx, () => ({ thickness: v, thicknessSource: "edited" }), { moveConnected: false })}
                      style={{ width: 58 }}
                    />
                    <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>m</span>
                  </div>
                </div>

                {/* Length & Angle */}
                <div className="rep-inspector-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Length &amp; Angle Anchor</span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      ["p1", "P1 Fixed"],
                      ["center", "Center"],
                      ["p2", "P2 Fixed"],
                    ].map(([val, lbl]) => (
                      <button
                        key={val}
                        type="button"
                        className={`rep-pill-btn${resizeAnchor === val ? " active" : ""}`}
                        style={{ flex: 1 }}
                        onClick={() => setResizeAnchor(val)}
                      >{lbl}</button>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 4 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-2)", width: 42 }}>Len:</span>
                    <button
                      type="button"
                      className="rep-pill-btn"
                      onClick={() => setSelectedWallLength(Math.max(0.05, wm.len - 0.05))}
                    >-5cm</button>
                    <DraftNumberInput
                      min={0.05}
                      max={500}
                      step={0.01}
                      decimals={2}
                      value={wm.len}
                      onCommit={(v) => setSelectedWallLength(v)}
                      style={{ flex: 1, minWidth: 58 }}
                    />
                    <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>m</span>
                    <button
                      type="button"
                      className="rep-pill-btn"
                      onClick={() => setSelectedWallLength(wm.len + 0.05)}
                    >+5cm</button>
                  </div>

                  <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 4 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-2)", width: 42 }}>Angle:</span>
                    <DraftNumberInput
                      min={-360}
                      max={360}
                      step={0.5}
                      decimals={1}
                      value={wm.angleDeg}
                      onCommit={(v) => setSelectedWallAngle(v)}
                      style={{ width: 62 }}
                    />
                    <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>°</span>
                    <div style={{ display: "flex", gap: 3, flex: 1, justifyContent: "flex-end" }}>
                      {[0, 45, 90, 135].map(deg => (
                        <button
                          key={deg}
                          type="button"
                          className={`rep-pill-btn${Math.abs(((wm.angleDeg - deg + 540) % 360) - 180) < 0.25 ? " active" : ""}`}
                          style={{ padding: "2px 5px" }}
                          onClick={() => setSelectedWallAngle(deg)}
                        >{deg}°</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Precision Move / Offset */}
                <div className="rep-inspector-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Precision Move</span>
                    <span style={{ fontSize: 9.5, color: "var(--text-3)" }}>Arrows / [ ]</span>
                  </div>

                  <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 1 }}>Normal offset (⊥ toward +)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 3 }}>
                    {normButtons.map(([d, lbl]) => (
                      <button
                        key={lbl}
                        type="button"
                        className="rep-pill-btn"
                        style={{ padding: "3px 2px", textAlign: "center" }}
                        onClick={() => nudgeSelectedWall(d, 0)}
                      >{lbl}</button>
                    ))}
                  </div>

                  <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>Slide along wall (∥)</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
                    {alongButtons.map(([d, lbl]) => (
                      <button
                        key={lbl}
                        type="button"
                        className="rep-pill-btn"
                        style={{ padding: "3px 4px", textAlign: "center" }}
                        onClick={() => nudgeSelectedWall(0, d)}
                      >{lbl}</button>
                    ))}
                  </div>

                  {/* Direct coordinates */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-2)" }}>
                      <span style={{ width: 18 }}>X1</span>
                      <DraftNumberInput
                        step={0.01} decimals={2} value={wm.x1}
                        style={{ flex: 1, minWidth: 0 }}
                        onCommit={(v) => applyWallTransform(selectedWallIdx, (l) => ({ pts: [[v, l.pts[0][1]], l.pts[1]] }))}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-2)" }}>
                      <span style={{ width: 18 }}>Z1</span>
                      <DraftNumberInput
                        step={0.01} decimals={2} value={wm.z1}
                        style={{ flex: 1, minWidth: 0 }}
                        onCommit={(v) => applyWallTransform(selectedWallIdx, (l) => ({ pts: [[l.pts[0][0], v], l.pts[1]] }))}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-2)" }}>
                      <span style={{ width: 18 }}>X2</span>
                      <DraftNumberInput
                        step={0.01} decimals={2} value={wm.x2}
                        style={{ flex: 1, minWidth: 0 }}
                        onCommit={(v) => applyWallTransform(selectedWallIdx, (l) => ({ pts: [l.pts[0], [v, l.pts[1][1]]] }))}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-2)" }}>
                      <span style={{ width: 18 }}>Z2</span>
                      <DraftNumberInput
                        step={0.01} decimals={2} value={wm.z2}
                        style={{ flex: 1, minWidth: 0 }}
                        onCommit={(v) => applyWallTransform(selectedWallIdx, (l) => ({ pts: [l.pts[0], [l.pts[1][0], v]] }))}
                      />
                    </label>
                  </div>

                  <label className="s2f-mini-check" style={{ marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={moveConnectedCorners}
                      onChange={(e) => setMoveConnectedCorners(e.target.checked)}
                    />
                    <span>🔗 Move connected corners together</span>
                  </label>
                </div>

                {/* Actions */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <button
                    type="button"
                    className="rep-pill-btn"
                    disabled={wm.len < 0.10}
                    onClick={() => splitSelectedWall(0.5)}
                    title="Split wall at midpoint so each half can have a different thickness or position"
                  >✂ Split Wall in 2</button>
                  <button
                    type="button"
                    className="rep-pill-btn"
                    onClick={() => duplicateSelectedWall(0.25)}
                    title="Create a parallel copy offset 25cm along normal"
                  >⧉ Offset Copy</button>
                  <button
                    type="button"
                    className="rep-pill-btn"
                    onClick={toggleHideSelectedWall}
                  >{selLine.hidden ? "👁 Show Wall" : "👁 Hide Wall"}</button>
                  <button
                    type="button"
                    className="rep-discard"
                    onClick={deleteSelectedWall}
                  >🗑 Delete</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Selected Opening Inspector ────────────────────────────────────────── */}
        {selectedOpIdx !== null && selectedOpIdx >= 0 && selectedOpIdx < userOpenings.length && (() => {
          const selectedOp = userOpenings[selectedOpIdx];
          return (
            <div className="rep-opening-inspector" style={{ position: "absolute", top: 12, right: 12, zIndex: 15 }}>
              <div className="rep-inspector-header">
                <span className="rep-inspector-title">
                  <span>{selectedOp.type === "door" ? "🚪" : "🪟"}</span>
                  <span>{selectedOp.type === "door" ? "Door" : "Window"} #{selectedOpIdx + 1}</span>
                </span>
                <button
                  className="rep-close"
                  onClick={() => setSelectedOpIdx(null)}
                  title="Close Inspector"
                >✕</button>
              </div>

              <div className="rep-inspector-body">
                {/* Width */}
                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Width:</span>
                    <span className="rep-inspector-val">{(selectedOp.width_m ?? (selectedOp.type === "door" ? 0.9 : 1.2)).toFixed(2)} m</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="number" min="0.4" max="4.0" step="0.05"
                      className="rep-subbar-input"
                      style={{ width: "100%", textAlign: "left" }}
                      value={selectedOp.width_m ?? (selectedOp.type === "door" ? 0.9 : 1.2)}
                      onChange={(e) => updateSelectedOp({ width_m: parseFloat(e.target.value) || 0.9 })}
                    />
                    <span style={{ fontSize: 11, color: "var(--text-3, #777)" }}>m</span>
                  </div>
                </div>

                {/* Door orientation */}
                {selectedOp.type === "door" && (
                  <>
                    <div className="rep-inspector-row">
                      <span className="rep-inspector-label" style={{ marginBottom: 4, display: "block" }}>Hinge Side:</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className={`rep-pill-btn${(selectedOp.side ?? 1) === 1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ side: 1 })}
                        >◀ Left</button>
                        <button
                          className={`rep-pill-btn${(selectedOp.side ?? 1) === -1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ side: -1 })}
                        >Right ▶</button>
                      </div>
                    </div>

                    <div className="rep-inspector-row">
                      <span className="rep-inspector-label" style={{ marginBottom: 4, display: "block" }}>Swing:</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className={`rep-pill-btn${(selectedOp.swing_dir ?? 1) === 1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ swing_dir: 1 })}
                        >↶ Inward</button>
                        <button
                          className={`rep-pill-btn${(selectedOp.swing_dir ?? 1) === -1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ swing_dir: -1 })}
                        >Outward ↷</button>
                      </div>
                    </div>
                  </>
                )}

                {/* Margins for 3D Viewer */}
                {selectedOp.type === "window" && (
                  <div className="rep-inspector-row">
                    <div className="rep-inspector-label-line">
                      <span className="rep-inspector-label">Sill (Bottom Margin):</span>
                      <span className="rep-inspector-val">{(selectedOp.bottom_margin ?? 0.9).toFixed(2)} m</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="number" min="0.1" max="2.0" step="0.05"
                        className="rep-subbar-input"
                        style={{ width: "100%", textAlign: "left" }}
                        value={selectedOp.bottom_margin ?? 0.9}
                        onChange={(e) => updateSelectedOp({ bottom_margin: Math.max(0.1, parseFloat(e.target.value) || 0.9) })}
                      />
                      <span style={{ fontSize: 11, color: "var(--text-3, #777)" }}>m</span>
                    </div>
                  </div>
                )}

                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Top Margin (Header):</span>
                    <span className="rep-inspector-val">{(selectedOp.top_margin ?? 0.7).toFixed(2)} m</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="number" min="0.1" max="2.0" step="0.05"
                      className="rep-subbar-input"
                      style={{ width: "100%", textAlign: "left" }}
                      value={selectedOp.top_margin ?? 0.7}
                      onChange={(e) => updateSelectedOp({ top_margin: Math.max(0.1, parseFloat(e.target.value) || 0.7) })}
                    />
                    <span style={{ fontSize: 11, color: "var(--text-3, #777)" }}>m</span>
                  </div>
                </div>

                {/* Position along wall */}
                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Position on Wall:</span>
                    <span className="rep-inspector-val">{((selectedOp.position_t ?? 0.5) * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range" min="0.05" max="0.95" step="0.01"
                    className="rep-range-slider"
                    value={selectedOp.position_t ?? 0.5}
                    onChange={(e) => updateSelectedOp({ position_t: parseFloat(e.target.value) })}
                  />
                </div>

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button className="rep-discard" style={{ flex: 1 }} onClick={deleteSelectedOp}>
                    🗑 Delete Opening
                  </button>
                  <button className="rep-pill-btn active" style={{ flex: 1 }} onClick={() => setSelectedOpIdx(null)}>
                    ✓ Done
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Placed manual openings chips */}
        {loadState === "ready" && userOpenings.length > 0 && (
          <div className="rep-placed-badge" style={{ position: "absolute", bottom: 40, right: 12, zIndex: 4 }}>
            <span style={{ fontWeight: 600, color: "var(--text-2, #aaa)" }}>Openings:</span>
            {userOpenings.map((op, idx) => (
              <span
                key={op.id || idx}
                className={`rep-op-chip${selectedOpIdx === idx ? " selected" : ""}`}
                onClick={() => setSelectedOpIdx(idx === selectedOpIdx ? null : idx)}
                title={`Click to edit ${op.type} #${idx + 1}`}
              >
                {op.type === "door" ? "🚪" : "🪟"} {op.type} {(op.width_m ?? (op.type === "door" ? 0.9 : 1.2)).toFixed(1)}m
              </span>
            ))}
          </div>
        )}

        {/* Empty state */}
        {loadState === "idle" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-3)", fontSize: 13, gap: 8 }}>
            <span style={{ fontSize: 36 }}>📐</span><span>Select a floor to preview</span>
          </div>
        )}

        {/* Loading spinner */}
        {loadState === "loading" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(var(--panel-rgb), 0.9)", color: "var(--text-1)", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Loading floor {selectedFloor}…</span>
          </div>
        )}

        {/* Error state */}
        {loadState === "error" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--red)", gap: 8 }}>
            <span style={{ fontSize: 28 }}>⚠</span>
            <span style={{ fontSize: 12 }}>Could not load floor data. Run <strong>Detect Walls</strong> in the sidebar first.</span>
          </div>
        )}

        {/* No walls */}
        {loadState === "ready" && wallCount === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-2)", gap: 8 }}>
            <span style={{ fontSize: 28 }}>🧱</span>
            <span style={{ fontSize: 12 }}>No walls for floor {selectedFloor}.<br />Run <strong>🧱 Detect Walls + Rooms</strong> in the Cloud2BIM panel.</span>
          </div>
        )}

        {/* Save status toast */}
        {saveState === "saved" && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 25, background: "var(--surface-2)", border: "1px solid var(--green)", borderRadius: 8, padding: "8px 16px", color: "var(--green)", fontSize: 12, fontWeight: 700, animation: "fadeIn 0.2s ease" }}>
            ✓ Saved — rooms recalculated
          </div>
        )}
        {saveState === "error" && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 25, background: "var(--surface-2)", border: "1px solid var(--red)", borderRadius: 8, padding: "8px 16px", color: "var(--red)", fontSize: 12, fontWeight: 700 }}>
            ✗ Save failed — check the backend
          </div>
        )}

        {/* Room info chip — selected room details */}
        {loadState === "ready" && highlightedRoom && (
          <RoomInfoChip
            room={highlightedRoom}
            floorIdx={selectedFloor}
            modelInfo={activeModelInfo}
            onOpenRoomEditor={() => onSelectRoom?.(highlightedRoom.id, selectedFloor, { ...highlightedRoom, floor_idx: selectedFloor })}
            onDeselect={() => onSelectRoom?.(null)}
          />
        )}

        {/* Legend */}
        {loadState === "ready" && wallCount > 0 && (
          <Legend wallCount={wallCount} doorCount={doorCount} windowCount={windowCount} roomCount={roomCount} userCount={userCount} hiddenCount={hiddenCount} lowConfCount={lowConfCount} />
        )}

        {/* Mode hint bar */}
        {loadState === "ready" && wallCount > 0 && (
          <ModeHint
            mode={editMode}
            addStep={addStep}
            freeDrawMode={freeDrawMode}
            cornerStep={cornerStep}
            cornerHasIntersection={cornerIntersection !== null}
            notchStep={notchStep}
            notchSubMode={notchSubMode}
          />
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes fadeIn { from { opacity:0; transform: translateX(-50%) translateY(-6px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`}</style>
    </div>
  );
}
