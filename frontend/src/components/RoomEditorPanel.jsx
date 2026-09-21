/**
 * RoomEditorPanel.jsx — Isolated Room Editor Modal
 *
 * Renders as a full-viewport overlay over the 3D canvas area.
 * Shows the selected room's walls isolated (other walls at 15% opacity).
 * Tools: Pan · Add Wall · Delete Wall · Hide Wall · Add Door · Add Window
 * Features:
 *   - Freely minimize/maximize (V or header button) to switch between 3D view and Room Editor
 *   - Pre-placement parameter bar for Doors (width, hinge side, swing direction) & Windows (width)
 *   - Interactive selection and parameter inspector for placed doors and windows
 *   - 4-way CAD door orientation toggles (In-Left, In-Right, Out-Left, Out-Right)
 *   - Saves walls + manual openings to backend.
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Colour constants ─────────────────────────────────────────────────────────
function getTheme() {
  const isDark = !document.querySelector('[data-theme="light"]');
  return isDark
    ? {
        bg: "#0b0e1a",
        gridLine: "#1a1f33",
        wall: "#00c8e0",       wallGlow: "rgba(0,200,224,0.18)",
        wallUser: "#fbbf24",   wallUserGlow: "rgba(251,191,36,0.20)",
        wallHover: "#ff6b6b",  wallHoverGlow: "rgba(255,107,107,0.25)",
        wallHidden: "#4a6080", wallHiddenGlow: "rgba(74,96,128,0.15)",
        wallPreview: "#fbbf24",
        door: "#fbbf24", window: "#818cf8",
        snapEp: "#fbbf24", snapGrid: "rgba(200,220,255,0.5)",
        roomFill: "rgba(0,200,224,0.10)", roomBorder: "#00c8e0",
        scaleStroke: "rgba(255,255,255,0.6)", scaleFill: "rgba(255,255,255,0.7)",
      }
    : {
        bg: "#f5f5f5", gridLine: "#e0e0e0",
        wall: "#0066cc",       wallGlow: "rgba(0,102,204,0.12)",
        wallUser: "#d97706",   wallUserGlow: "rgba(217,119,6,0.15)",
        wallHover: "#dc2626",  wallHoverGlow: "rgba(220,38,38,0.18)",
        wallHidden: "#94a3b8", wallHiddenGlow: "rgba(148,163,184,0.12)",
        wallPreview: "#d97706",
        door: "#d97706", window: "#6366f1",
        snapEp: "#d97706", snapGrid: "rgba(30,60,120,0.35)",
        roomFill: "rgba(0,102,204,0.09)", roomBorder: "#0066cc",
        scaleStroke: "rgba(0,0,0,0.55)", scaleFill: "rgba(0,0,0,0.65)",
      };
}

const ROOM_COLORS = [
  "#00c8e0","#818cf8","#fbbf24","#34d399","#fb7185",
  "#a78bfa","#22d3ee","#fb923c","#4ade80","#f87171",
];
const getRoomAccent = (id) => ROOM_COLORS[(id - 1) % ROOM_COLORS.length];

// ── Coordinate utilities ─────────────────────────────────────────────────────
const toCanvas = (wx, wz, cam) => [cam.ox + wx * cam.scale, cam.oy + wz * cam.scale];
const toWorld  = (cx, cy, cam) => [(cx - cam.ox) / cam.scale, (cy - cam.oy) / cam.scale];

function fitCameraRoom(bbox, pad, W, H) {
  const xMin = bbox.x_min - pad, xMax = bbox.x_max + pad;
  const zMin = bbox.z_min - pad, zMax = bbox.z_max + pad;
  const bw = xMax - xMin, bh = zMax - zMin;
  if (bw === 0 || bh === 0) return { scale: 20, ox: W / 2, oy: H / 2 };
  const scale = Math.min(W * 0.9 / bw, H * 0.9 / bh);
  const cx = (xMin + xMax) / 2, cz = (zMin + zMax) / 2;
  return { scale, ox: W / 2 - cx * scale, oy: H / 2 - cz * scale };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
function distPointToSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - x1, pz - z1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

function projectOntoSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
  if (len2 === 0) return 0;
  return Math.max(0.02, Math.min(0.98, ((px - x1) * dx + (pz - z1) * dz) / len2));
}

function computeSnap(wx, wz, lines, cam, pixThresh = 14) {
  const thresh = pixThresh / cam.scale;
  let best = thresh, snapped = null;
  for (const { pts: [[x1, z1], [x2, z2]] } of lines) {
    const d1 = Math.hypot(wx - x1, wz - z1), d2 = Math.hypot(wx - x2, wz - z2);
    if (d1 < best) { best = d1; snapped = { pt: [x1, z1], kind: "endpoint" }; }
    if (d2 < best) { best = d2; snapped = { pt: [x2, z2], kind: "endpoint" }; }
  }
  if (snapped) return snapped;
  const g = 0.5;
  return { pt: [Math.round(wx / g) * g, Math.round(wz / g) * g], kind: "grid" };
}

function applyAngle(wx, wz, fx, fz) {
  const dx = wx - fx, dz = wz - fz;
  const a = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const dist = Math.hypot(dx, dz);
  return { pt: [fx + Math.cos(a) * dist, fz + Math.sin(a) * dist], angle: a, dist };
}

function computeSnapConstrained(wx, wz, lines, cam, fx, fz, pixThresh = 14) {
  const { angle, dist } = applyAngle(wx, wz, fx, fz);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const worldTh = pixThresh / cam.scale;
  let bestEp = worldTh, epPt = null;
  for (const { pts: [[x1, z1], [x2, z2]] } of lines) {
    for (const [ex, ez] of [[x1, z1], [x2, z2]]) {
      const tPt = (ex - fx) * cosA + (ez - fz) * sinA;
      if (tPt < 0) continue;
      const px = fx + tPt * cosA, pz = fz + tPt * sinA;
      const d = Math.hypot(ex - px, ez - pz);
      if (d < worldTh && d < bestEp) { bestEp = d; epPt = [px, pz]; }
    }
  }
  if (epPt) return { pt: epPt, kind: "endpoint", angle, dist: Math.hypot(epPt[0] - fx, epPt[1] - fz), fromPt: [fx, fz] };
  const g = 0.5, tS = Math.round(dist / g) * g;
  return { pt: [fx + cosA * tS, fz + sinA * tS], kind: "angle", angle, dist: tS, fromPt: [fx, fz] };
}

function segIntersectsRect(x1, z1, x2, z2, rxMin, rxMax, rzMin, rzMax) {
  if (x1 >= rxMin && x1 <= rxMax && z1 >= rzMin && z1 <= rzMax) return true;
  if (x2 >= rxMin && x2 <= rxMax && z2 >= rzMin && z2 <= rzMax) return true;
  const dx = x2 - x1, dz = z2 - z1;
  for (const [edge, dPar, sP, dPerp, sPerp, pMin, pMax] of [
    [rzMin, dz, z1, dx, x1, rxMin, rxMax], [rzMax, dz, z1, dx, x1, rxMin, rxMax],
    [rxMin, dx, x1, dz, z1, rzMin, rzMax], [rxMax, dx, x1, dz, z1, rzMin, rzMax],
  ]) {
    if (dPar === 0) continue;
    const t = (edge - sP) / dPar;
    if (t < 0 || t > 1) continue;
    const p = sPerp + t * dPerp;
    if (p >= pMin && p <= pMax) return true;
  }
  return false;
}

function isRoomWall(line, room) {
  if (!room) return true;
  const { bbox } = room, pad = 0.5;
  const [[x1, z1], [x2, z2]] = line.pts;
  return segIntersectsRect(x1, z1, x2, z2,
    bbox.x_min - pad, bbox.x_max + pad, bbox.z_min - pad, bbox.z_max + pad);
}

function distPointToOpening(wx, wz, op, lines) {
  const wi = op.wall_idx;
  if (wi < 0 || wi >= lines.length) return Infinity;
  const [[x1, z1], [x2, z2]] = lines[wi].pts;
  const wl = Math.hypot(x2 - x1, z2 - z1);
  if (wl < 0.001) return Infinity;
  const ux = (x2 - x1) / wl, uz = (z2 - z1) / wl;
  const nx = -uz, nz = ux;
  const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
  const mx = x1 + (x2 - x1) * t, mz = z1 + (z2 - z1) * t;
  const w_m = op.width_m ?? (op.type === "door" ? 0.9 : 1.2);
  const hw = w_m / 2;

  const dCenter = Math.hypot(wx - mx, wz - mz);
  if (dCenter < hw) return dCenter;

  if (op.type === "door") {
    const hingeSide = op.side === -1 ? -1 : 1;
    const swingDir = op.swing_dir === -1 ? -1 : 1;
    const hx = hingeSide === 1 ? mx - ux * hw : mx + ux * hw;
    const hz = hingeSide === 1 ? mz - uz * hw : mz + uz * hw;
    const tx = hx + swingDir * nx * w_m;
    const tz = hz + swingDir * nz * w_m;
    const dLeaf = distPointToSeg(wx, wz, hx, hz, tx, tz);
    return Math.min(dCenter, dLeaf);
  }

  return dCenter;
}

// ── Draw functions ───────────────────────────────────────────────────────────
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

function drawRoomFill(ctx, room, cam, TC) {
  if (!room) return;
  ctx.save(); ctx.beginPath();
  const poly = room.polygon;
  if (poly?.length >= 3) {
    const [sx, sy] = toCanvas(poly[0][0], poly[0][1], cam);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < poly.length; i++) {
      const [px, py] = toCanvas(poly[i][0], poly[i][1], cam); ctx.lineTo(px, py);
    }
  } else {
    const { x_min, z_min, x_max, z_max } = room.bbox;
    const [cx1, cy1] = toCanvas(x_min, z_min, cam), [cx2, cy2] = toCanvas(x_max, z_max, cam);
    ctx.rect(cx1, cy1, cx2 - cx1, cy2 - cy1);
  }
  ctx.closePath();
  ctx.fillStyle = TC.roomFill; ctx.fill();
  ctx.strokeStyle = TC.roomBorder; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.25; ctx.stroke();
  ctx.restore();
}

function drawBoxSelect(ctx, box, mode) {
  if (!box) return;
  const { cx1, cy1, cx2, cy2 } = box;
  const x = Math.min(cx1, cx2), y = Math.min(cy1, cy2), w = Math.abs(cx2 - cx1), h = Math.abs(cy2 - cy1);
  if (w < 2 && h < 2) return;
  const col = mode === "delete" ? "rgba(255,80,80,0.9)" : "rgba(74,160,220,0.9)";
  const fill = mode === "delete" ? "rgba(255,60,60,0.08)" : "rgba(74,140,220,0.08)";
  ctx.save();
  ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); ctx.restore();
}

function drawWalls(ctx, lines, cam, hovIdx, addStart, snapInfo, mode, room, TC, hoverOp, toolParams) {
  const lw = Math.max(1.0, cam.scale * 0.09);

  // Non-room walls — 15% opacity
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isRoomWall(l, room) || l.hidden) continue;
    const [[x1, z1], [x2, z2]] = l.pts;
    const [cx1, cy1] = toCanvas(x1, z1, cam), [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save(); ctx.globalAlpha = 0.15; ctx.lineCap = "round";
    ctx.strokeStyle = TC.wall; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke(); ctx.restore();
  }

  // Room hidden walls (dashed)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.hidden || !isRoomWall(l, room)) continue;
    const [[x1, z1], [x2, z2]] = l.pts;
    const isHov = i === hovIdx && (mode === "delete" || mode === "hide");
    const color = isHov ? TC.wallHover : TC.wallHidden;
    const [cx1, cy1] = toCanvas(x1, z1, cam), [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save(); ctx.globalAlpha = isHov ? 0.85 : 0.45; ctx.lineCap = "round";
    if (!isHov) ctx.setLineDash([5, 6]);
    ctx.strokeStyle = TC.wallHiddenGlow; ctx.lineWidth = lw + 5;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = isHov ? lw * 1.8 : lw;
    ctx.shadowColor = color; ctx.shadowBlur = isHov ? 8 : 2;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // Room visible walls
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.hidden || !isRoomWall(l, room)) continue;
    const { pts: [[x1, z1], [x2, z2]], source } = l;
    const isHov = i === hovIdx && (mode === "delete" || mode === "hide");
    const isOpHov = (mode === "add-door" || mode === "add-window") && hoverOp?.wallIdx === i;
    const color = isHov ? TC.wallHover : isOpHov ? "#a78bfa" : source === "user" ? TC.wallUser : TC.wall;
    const glow  = isHov ? TC.wallHoverGlow : source === "user" ? TC.wallUserGlow : TC.wallGlow;
    const [cx1, cy1] = toCanvas(x1, z1, cam), [cx2, cy2] = toCanvas(x2, z2, cam);
    ctx.save(); ctx.lineCap = "round";
    ctx.strokeStyle = glow; ctx.lineWidth = lw + 6;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = isHov ? lw * 2 : isOpHov ? lw * 1.5 : lw;
    ctx.shadowColor = color; ctx.shadowBlur = isHov ? 10 : isOpHov ? 8 : 3;
    ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke(); ctx.restore();
  }

  // Add-wall preview
  if (mode === "add" && addStart && snapInfo) {
    const [ax, az] = addStart, [sx, sz] = snapInfo.pt;
    const [cax, cay] = toCanvas(ax, az, cam), [csx, csy] = toCanvas(sx, sz, cam);
    if (snapInfo.kind === "angle" || (snapInfo.kind === "endpoint" && snapInfo.angle != null)) {
      const cosA = Math.cos(snapInfo.angle), sinA = Math.sin(snapInfo.angle), FAR = 4000;
      ctx.save(); ctx.setLineDash([4, 8]);
      ctx.strokeStyle = TC.wall + "28"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cax - cosA * cam.scale * FAR, cay - sinA * cam.scale * FAR);
      ctx.lineTo(cax + cosA * cam.scale * FAR, cay + sinA * cam.scale * FAR);
      ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
    const dist = Math.hypot(sx - ax, sz - az);
    if (dist > 0.01) {
      const angleDeg = Math.round(((Math.atan2(sz - az, sx - ax) * 180 / Math.PI) % 360 + 360) % 360);
      const label = `${angleDeg}°  ${dist.toFixed(2)} m`;
      const mx = (cax + csx) / 2, my = (cay + csy) / 2;
      ctx.save(); ctx.font = '10px "JetBrains Mono",monospace'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(12,14,26,0.88)"; ctx.fillRect(mx - tw / 2 - 4, my - 8, tw + 8, 16);
      ctx.fillStyle = TC.wallUser; ctx.fillText(label, mx, my); ctx.restore();
    }
    ctx.save(); ctx.setLineDash([6, 4]); ctx.lineCap = "round";
    ctx.strokeStyle = TC.wallPreview; ctx.lineWidth = lw;
    ctx.shadowColor = TC.wallPreview; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(cax, cay); ctx.lineTo(csx, csy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = TC.wallPreview;
    ctx.beginPath(); ctx.arc(cax, cay, Math.max(3, lw * 1.5), 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }

  // Snap indicator
  if (snapInfo && mode !== "select" && mode !== "add-door" && mode !== "add-window") {
    const [sx, sz] = snapInfo.pt, [csx, csy] = toCanvas(sx, sz, cam);
    const r = snapInfo.kind === "endpoint" ? 7 : 5;
    const color = snapInfo.kind === "endpoint" ? TC.snapEp : TC.snapGrid;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = snapInfo.kind === "endpoint" ? 2 : 1;
    const cr = r + 4;
    ctx.beginPath(); ctx.moveTo(csx - cr, csy); ctx.lineTo(csx + cr, csy);
    ctx.moveTo(csx, csy - cr); ctx.lineTo(csx, csy + cr); ctx.stroke();
    ctx.beginPath(); ctx.arc(csx, csy, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }

  // Live door/window placement ghost preview
  if ((mode === "add-door" || mode === "add-window") && hoverOp?.wallIdx >= 0 && hoverOp.wallIdx < lines.length) {
    const [[x1, z1], [x2, z2]] = lines[hoverOp.wallIdx].pts;
    const wl = Math.hypot(x2 - x1, z2 - z1);
    if (wl > 0.001) {
      const ghostOp = {
        type: mode === "add-door" ? "door" : "window",
        wall_idx: hoverOp.wallIdx,
        position_t: hoverOp.position_t,
        width_m: mode === "add-door" ? (toolParams?.doorWidth ?? 0.9) : (toolParams?.windowWidth ?? 1.2),
        side: toolParams?.doorHingeSide ?? 1,
        swing_dir: toolParams?.doorSwingDir ?? 1,
      };
      ctx.save();
      ctx.globalAlpha = 0.85;
      drawManualOpening(ctx, ghostOp, lines, cam, TC, false, true);
      ctx.restore();
    }
  }
}

function drawAutoOpening(ctx, op, cam, TC) {
  if (op.type === "door") {
    const [cx, cy] = toCanvas(op.x, op.z, cam), [hx, hy] = toCanvas(op.hinge_x, op.hinge_z, cam);
    const radius = Math.hypot(cx - hx, cy - hy), lw = Math.max(1, cam.scale * 0.08);
    ctx.save(); ctx.strokeStyle = TC.door; ctx.lineWidth = lw; ctx.shadowColor = TC.door; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(cx, cy); ctx.stroke();
    const a0 = Math.atan2(cy - hy, cx - hx);
    ctx.beginPath(); ctx.arc(hx, hy, radius, a0, a0 + Math.PI / 2); ctx.stroke();
    ctx.fillStyle = TC.door; ctx.beginPath(); ctx.arc(hx, hy, Math.max(2, cam.scale * 0.06), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (op.type === "window") {
    const [cx1, cz1] = toCanvas(op.wall_x1, op.wall_z1, cam), [cx2, cz2] = toCanvas(op.wall_x2, op.wall_z2, cam);
    const dx = cx2 - cx1, dz = cz2 - cz1;
    const t1 = op.u_start / op.wall_len, t2 = op.u_end / op.wall_len;
    ctx.save(); ctx.strokeStyle = TC.window; ctx.lineWidth = Math.max(1.5, cam.scale * 0.12);
    ctx.setLineDash([4, 3]); ctx.shadowColor = TC.window; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(cx1 + dx * t1, cz1 + dz * t1); ctx.lineTo(cx1 + dx * t2, cz1 + dz * t2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
}

function drawManualOpening(ctx, op, lines, cam, TC, isSelected = false, isHovered = false) {
  const wi = op.wall_idx;
  if (wi < 0 || wi >= lines.length) return;
  const [[x1, z1], [x2, z2]] = lines[wi].pts;
  const wl = Math.hypot(x2 - x1, z2 - z1);
  if (wl < 0.001) return;

  const ux = (x2 - x1) / wl, uz = (z2 - z1) / wl;
  const nx = -uz, nz = ux; // normal pointing 90° CCW / left of wall

  const t = Math.max(0.02, Math.min(0.98, op.position_t ?? 0.5));
  const mx = x1 + (x2 - x1) * t, mz = z1 + (z2 - z1) * t;

  const w_m = op.width_m ?? (op.type === "door" ? 0.9 : 1.2);
  const hw = w_m / 2;

  // Jambs in world coords
  const jax = mx - ux * hw, jaz = mz - uz * hw;
  const jbx = mx + ux * hw, jbz = mz + uz * hw;

  const [cjax, cjay] = toCanvas(jax, jaz, cam);
  const [cjbx, cjby] = toCanvas(jbx, jbz, cam);
  const [cmx, cmy]   = toCanvas(mx, mz, cam);

  const baseCol   = op.type === "door" ? TC.door : TC.window;
  const strokeCol = isSelected ? "#38bdf8" : isHovered ? "#fbbf24" : baseCol;
  const glowCol   = isSelected ? "rgba(56,189,248,0.5)" : isHovered ? "rgba(251,191,36,0.4)" : baseCol;

  if (op.type === "door") {
    const hingeSide = op.side === -1 ? -1 : 1;
    const swingDir  = op.swing_dir === -1 ? -1 : 1;

    // Hinge and closed tip positions in world coords
    const hx = hingeSide === 1 ? jax : jbx;
    const hz = hingeSide === 1 ? jaz : jbz;
    const ex = hingeSide === 1 ? jbx : jax;
    const ez = hingeSide === 1 ? jbz : jaz;

    // Open tip at 90°
    const tx = hx + swingDir * nx * w_m;
    const tz = hz + swingDir * nz * w_m;

    const [chx, chy]     = toCanvas(hx, hz, cam);
    const [cex, cey]     = toCanvas(ex, ez, cam);
    const [ctx_p, cty_p] = toCanvas(tx, tz, cam);

    ctx.save();
    ctx.lineCap = "round";

    // 1. Wall threshold / opening gap
    ctx.strokeStyle = TC.wallHidden || "rgba(100,120,150,0.5)";
    ctx.lineWidth = Math.max(1, cam.scale * 0.04);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cjax, cjay);
    ctx.lineTo(cjbx, cjby);
    ctx.stroke();
    ctx.setLineDash([]);

    // Jamb tick marks
    const tickLen = Math.max(3, cam.scale * 0.08);
    const cnx = - (cjby - cjay) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
    const cny =   (cjbx - cjax) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = Math.max(1.5, cam.scale * 0.06);
    ctx.beginPath();
    ctx.moveTo(cjax - cnx * tickLen, cjay - cny * tickLen);
    ctx.lineTo(cjax + cnx * tickLen, cjay + cny * tickLen);
    ctx.moveTo(cjbx - cnx * tickLen, cjby - cny * tickLen);
    ctx.lineTo(cjbx + cnx * tickLen, cjby + cny * tickLen);
    ctx.stroke();

    // 2. Door leaf (hinge to open tip)
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = isSelected ? Math.max(2.5, cam.scale * 0.12) : Math.max(1.8, cam.scale * 0.09);
    ctx.shadowColor = glowCol;
    ctx.shadowBlur = isSelected ? 14 : isHovered ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(chx, chy);
    ctx.lineTo(ctx_p, cty_p);
    ctx.stroke();

    // 3. Swing arc
    const r_px = w_m * cam.scale;
    const aClosed = Math.atan2(cey - chy, cex - chx);
    const aOpen   = Math.atan2(cty_p - chy, ctx_p - chx);

    let dAngle = (aOpen - aClosed + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const ccw = dAngle < 0;

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = Math.max(1.2, cam.scale * 0.05);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(chx, chy, r_px, aClosed, aOpen, ccw);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. Hinge circle
    ctx.fillStyle = strokeCol;
    ctx.beginPath();
    ctx.arc(chx, chy, Math.max(3, cam.scale * 0.07), 0, Math.PI * 2);
    ctx.fill();

    // 5. Dimension / tag if selected or hovered
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

    // Outer double frame lines
    ctx.beginPath();
    ctx.moveTo(cx1_a, cy1_a); ctx.lineTo(cx2_a, cy2_a);
    ctx.moveTo(cx1_b, cy1_b); ctx.lineTo(cx2_b, cy2_b);
    // Jamb end-caps
    ctx.moveTo(cx1_a, cy1_a); ctx.lineTo(cx1_b, cy1_b);
    ctx.moveTo(cx2_a, cy2_a); ctx.lineTo(cx2_b, cy2_b);
    ctx.stroke();

    // Center glass line (dashed)
    ctx.strokeStyle = isSelected ? "#ffffff" : TC.window;
    ctx.lineWidth = Math.max(1.2, cam.scale * 0.06);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cjax, cjay); ctx.lineTo(cjbx, cjby);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dimension tag
    if (isSelected || isHovered) {
      const dimLabel = `${w_m.toFixed(2)} m`;
      ctx.font = 'bold 10px "JetBrains Mono",monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(dimLabel).width;
      const cnx = - (cjby - cjay) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
      const cny =   (cjbx - cjax) / (Math.hypot(cjbx - cjax, cjby - cjay) || 1);
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

function drawScale(ctx, cam, w, h, TC) {
  const candidates = [1, 2, 5, 10, 20]; let chosen = 5;
  for (const c of candidates) { if (c * cam.scale >= 80) { chosen = c; break; } }
  const barPx = chosen * cam.scale, bx = 20, by = h - 28;
  ctx.save(); ctx.strokeStyle = TC.scaleStroke; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
  ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
  ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4);
  ctx.stroke();
  ctx.fillStyle = TC.scaleFill; ctx.font = '11px "Inter",sans-serif'; ctx.textAlign = "center";
  ctx.fillText(`${chosen} m`, bx + barPx / 2, by - 8); ctx.restore();
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  { id: "select",     icon: "✋", label: "Pan",     title: "Pan & Zoom (S) · Click opening to edit" },
  { id: "add",        icon: "✏️",  label: "Add",     title: "Add Wall (A)" },
  { id: "delete",     icon: "✂️",  label: "Delete",  title: "Delete Wall (D)" },
  { id: "hide",       icon: "👁",  label: "Hide",    title: "Hide / Show Wall (H)" },
  { id: "add-door",   icon: "🚪", label: "Door",    title: "Add Door — click on wall (Q)" },
  { id: "add-window", icon: "🪟", label: "Window",  title: "Add Window — click on wall (W)" },
];

const MODE_HINTS = {
  select:       "Drag to pan · Scroll to zoom · Click door/window to edit · Double-click to fit",
  add:          "Click first point → click to finish wall · Shift → 45° lock · Esc to cancel",
  delete:       "Click wall to delete · Drag to box-delete (room walls only) · Esc to exit",
  hide:         "Click wall to hide / unhide · Drag to box-toggle · Esc to exit",
  "add-door":   "Click on wall to place door with configured size & swing (Q or Esc to exit)",
  "add-window": "Click on wall to place window with configured width (W or Esc to exit)",
};

// ── Main Component ───────────────────────────────────────────────────────────
export default function RoomEditorPanel({
  room, floor, modelInfo, saveName = null, onClose, onWallsChanged,
}) {
  const canvasRef = useRef(null);
  const camRef    = useRef({ scale: 20, ox: 300, oy: 300 });
  const rafRef    = useRef(null);
  const apiBase   = saveName ? `/api/saves/${encodeURIComponent(saveName)}` : "/api";

  // Data states
  const [editedLines,    setEditedLines]    = useState([]);
  const [autoOpenings,   setAutoOpenings]   = useState([]);
  const [manualOpenings, setManualOpenings] = useState([]);
  const [loadState,      setLoadState]      = useState("loading");
  const [editMode,       setEditMode]       = useState("select");
  const [addStep,        setAddStep]        = useState(null);
  const [hoveredLine,    setHoveredLine]    = useState(-1);
  const [hoverOpening,   setHoverOpening]   = useState(null);
  const [hoverManualOp,  setHoverManualOp]  = useState(-1);
  const [selectedOpIdx,  setSelectedOpIdx]  = useState(null);
  const [isDirty,        setIsDirty]        = useState(false);
  const [openingsDirty,  setOpeningsDirty]  = useState(false);
  const [saveState,      setSaveState]      = useState("idle");
  const [undoStack,      setUndoStack]      = useState([]);
  const [redoStack,      setRedoStack]      = useState([]);
  const [angleConst,     setAngleConst]     = useState(false);

  // Switch between 3D view and Room Editor
  const [isMinimized,    setIsMinimized]    = useState(false);

  // Parameterization tool defaults
  const [toolDoorWidth,     setToolDoorWidth]     = useState(0.9);
  const [toolDoorHingeSide, setToolDoorHingeSide] = useState(1);  // 1: left (start), -1: right (end)
  const [toolDoorSwingDir,  setToolDoorSwingDir]  = useState(1);  // 1: inward/left, -1: outward/right
  const [toolWindowWidth,   setToolWindowWidth]   = useState(1.2);

  const editModeRef       = useRef("select");
  const editedLinesRef    = useRef([]);
  const addStepRef        = useRef(null);
  const hoveredLineRef    = useRef(-1);
  const snapRef           = useRef(null);
  const hoverOpeningRef   = useRef(null);
  const hoverManualOpRef  = useRef(-1);
  const selectedOpIdxRef  = useRef(null);
  const dragRef           = useRef(null);
  const boxSelectRef      = useRef(null);
  const manualOpeningsRef = useRef([]);
  const autoOpeningsRef   = useRef([]);

  useEffect(() => { editModeRef.current      = editMode;        }, [editMode]);
  useEffect(() => { editedLinesRef.current   = editedLines;     }, [editedLines]);
  useEffect(() => { addStepRef.current       = addStep;         }, [addStep]);
  useEffect(() => { hoveredLineRef.current   = hoveredLine;     }, [hoveredLine]);
  useEffect(() => { manualOpeningsRef.current = manualOpenings; }, [manualOpenings]);
  useEffect(() => { hoverManualOpRef.current  = hoverManualOp;  }, [hoverManualOp]);
  useEffect(() => { selectedOpIdxRef.current  = selectedOpIdx;  }, [selectedOpIdx]);

  // Expand whenever room changes
  useEffect(() => {
    setIsMinimized(false);
    setSelectedOpIdx(null);
  }, [room?.id]);

  // ── Load data ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!room) return;
    let cancelled = false;
    setLoadState("loading");
    setEditedLines([]); setAutoOpenings([]); setManualOpenings([]);
    setIsDirty(false); setOpeningsDirty(false);
    setUndoStack([]); setRedoStack([]);
    setAddStep(null); addStepRef.current = null;
    snapRef.current = null; hoverOpeningRef.current = null;
    setSelectedOpIdx(null);

    Promise.all([
      fetch(`${apiBase}/walls/${floor}`).then(r => r.json()),
      fetch(`${apiBase}/openings/${floor}`).then(r => r.json()),
    ]).then(([w, o]) => {
      if (cancelled) return;
      const converted = (w?.lines ?? []).map(pts => ({ pts, source: "algo" }));
      setEditedLines(converted); editedLinesRef.current = converted;
      const auto = o?.openings ?? [];
      setAutoOpenings(auto); autoOpeningsRef.current = auto;
      const manual = o?.user_openings ?? [];
      setManualOpenings(manual); manualOpeningsRef.current = manual;
      setLoadState("ready");
      const cvs = canvasRef.current;
      if (cvs && room.bbox) {
        const { x_min, x_max, z_min, z_max } = room.bbox;
        const pad = Math.max(2, Math.max(x_max - x_min, z_max - z_min) * 0.35);
        camRef.current = fitCameraRoom(room.bbox, pad, cvs.clientWidth || cvs.width, cvs.clientHeight || cvs.height);
        scheduleDraw();
      }
    }).catch(() => { if (!cancelled) setLoadState("error"); });
    return () => { cancelled = true; };
  }, [room?.id, floor, saveName]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Undo / Redo ─────────────────────────────────────────────────────────────
  const pushHistory = useCallback((snap) => {
    setUndoStack(p => [...p.slice(-49), snap]); setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    setUndoStack(p => {
      if (!p.length) return p;
      const last = p[p.length - 1];
      setRedoStack(r => [editedLinesRef.current, ...r.slice(0, 49)]);
      setEditedLines(last); editedLinesRef.current = last;
      setIsDirty(true); scheduleDraw(); return p.slice(0, -1);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    setRedoStack(p => {
      if (!p.length) return p;
      const next = p[0];
      setUndoStack(u => [...u.slice(-49), editedLinesRef.current]);
      setEditedLines(next); editedLinesRef.current = next;
      setIsDirty(true); scheduleDraw(); return p.slice(1);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!isDirty && !openingsDirty) return;
    setSaveState("saving");
    try {
      const reqs = [];
      if (isDirty) {
        const lines = editedLinesRef.current.filter(l => !l.hidden).map(l => l.pts);
        reqs.push(fetch(`${apiBase}/walls/${floor}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines, polygon_rooms: true }),
        }));
      }
      if (openingsDirty) {
        reqs.push(fetch(`${apiBase}/openings/${floor}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_openings: manualOpeningsRef.current }),
        }));
      }
      await Promise.all(reqs);
      setSaveState("saved"); setIsDirty(false); setOpeningsDirty(false);
      onWallsChanged?.(); setTimeout(() => setSaveState("idle"), 3000);
    } catch { setSaveState("error"); setTimeout(() => setSaveState("idle"), 3000); }
  }, [isDirty, openingsDirty, floor, apiBase, onWallsChanged]);

  // ── Reset ───────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    fetch(`${apiBase}/walls/${floor}`).then(r => r.json()).then(w => {
      const c = (w?.lines ?? []).map(pts => ({ pts, source: "algo" }));
      setEditedLines(c); editedLinesRef.current = c;
      setUndoStack([]); setRedoStack([]); setIsDirty(false);
      setAddStep(null); addStepRef.current = null; scheduleDraw();
    }).catch(() => {});
    fetch(`${apiBase}/openings/${floor}`).then(r => r.json()).then(o => {
      const m = o?.user_openings ?? [];
      setManualOpenings(m); manualOpeningsRef.current = m;
      setOpeningsDirty(false); setSelectedOpIdx(null); scheduleDraw();
    }).catch(() => {});
  }, [floor, apiBase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw ─────────────────────────────────────────────────────────────────────
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const cvs = canvasRef.current; if (!cvs) return;
      const ctx = cvs.getContext("2d");
      const { width: W, height: H } = cvs, cam = camRef.current, TC = getTheme();
      ctx.fillStyle = TC.bg; ctx.fillRect(0, 0, W, H);
      drawGrid(ctx, cam, W, H, TC);
      drawRoomFill(ctx, room, cam, TC);

      const toolParams = {
        doorWidth: toolDoorWidth,
        doorHingeSide: toolDoorHingeSide,
        doorSwingDir: toolDoorSwingDir,
        windowWidth: toolWindowWidth,
      };

      drawWalls(ctx, editedLinesRef.current, cam,
        hoveredLineRef.current, addStepRef.current, snapRef.current,
        editModeRef.current, room, TC, hoverOpeningRef.current, toolParams);

      for (const op of autoOpeningsRef.current) drawAutoOpening(ctx, op, cam, TC);

      for (let i = 0; i < manualOpeningsRef.current.length; i++) {
        const op = manualOpeningsRef.current[i];
        const isSel = i === selectedOpIdxRef.current;
        const isHov = i === hoverManualOpRef.current;
        drawManualOpening(ctx, op, editedLinesRef.current, cam, TC, isSel, isHov);
      }

      drawBoxSelect(ctx, boxSelectRef.current, editModeRef.current);
      drawScale(ctx, cam, W, H, TC);
    });
  }, [room, toolDoorWidth, toolDoorHingeSide, toolDoorSwingDir, toolWindowWidth]);

  useEffect(() => { scheduleDraw(); }, [editedLines, manualOpenings, autoOpenings, selectedOpIdx, hoverManualOp, scheduleDraw]);

  // Canvas resize
  useEffect(() => {
    const cvs = canvasRef.current; if (!cvs) return;
    const ro = new ResizeObserver(() => {
      if (cvs.clientWidth && cvs.clientHeight) {
        cvs.width = cvs.clientWidth;
        cvs.height = cvs.clientHeight;
        scheduleDraw();
      }
    });
    ro.observe(cvs); return () => ro.disconnect();
  }, [scheduleDraw, isMinimized]);

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Z")) { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); return; }
      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        setIsMinimized(m => !m);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedOpIdxRef.current !== null) {
          e.preventDefault();
          const idx = selectedOpIdxRef.current;
          const nl = manualOpeningsRef.current.filter((_, i) => i !== idx);
          manualOpeningsRef.current = nl;
          setManualOpenings(nl);
          setSelectedOpIdx(null);
          setOpeningsDirty(true);
          scheduleDraw();
          return;
        }
      }
      if (e.key === "Escape") {
        if (selectedOpIdxRef.current !== null) {
          setSelectedOpIdx(null);
          scheduleDraw();
          return;
        }
        if (addStepRef.current) { addStepRef.current = null; setAddStep(null); snapRef.current = null; scheduleDraw(); }
        else { setEditMode("select"); editModeRef.current = "select"; }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const m = { s:"select",S:"select",a:"add",A:"add",d:"delete",D:"delete",h:"hide",H:"hide",q:"add-door",Q:"add-door",w:"add-window",W:"add-window" }[e.key];
        if (m) { setEditMode(m); editModeRef.current = m; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, handleSave, scheduleDraw]);

  // ── Pointer ───────────────────────────────────────────────────────────────────
  const getWorld = useCallback((e) => {
    const cvs = canvasRef.current; if (!cvs) return [0, 0];
    const rect = cvs.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top, camRef.current);
  }, []);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const mode = editModeRef.current;
    if (mode === "select") {
      dragRef.current = { startX: e.clientX, startY: e.clientY, ox: camRef.current.ox, oy: camRef.current.oy, moved: false };
    } else if (mode === "delete" || mode === "hide") {
      const cvs = canvasRef.current; if (!cvs) return;
      const rect = cvs.getBoundingClientRect(), cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      boxSelectRef.current = { startCx: cx, startCy: cy, cx1: cx, cy1: cy, cx2: cx, cy2: cy, moved: false };
    }
  }, []);

  const onMouseMove = useCallback((e) => {
    const mode = editModeRef.current;
    const [wx, wz] = getWorld(e);

    // Check hover over manual openings
    let bestOpDist = 22 / camRef.current.scale, opIdx = -1;
    manualOpeningsRef.current.forEach((op, idx) => {
      const d = distPointToOpening(wx, wz, op, editedLinesRef.current);
      if (d < bestOpDist) { bestOpDist = d; opIdx = idx; }
    });
    if (hoverManualOpRef.current !== opIdx) {
      hoverManualOpRef.current = opIdx;
      setHoverManualOp(opIdx);
    }

    if (mode === "select" && dragRef.current) {
      const dx = e.clientX - dragRef.current.startX, dy = e.clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 3) dragRef.current.moved = true;
      camRef.current = { ...camRef.current, ox: dragRef.current.ox + dx, oy: dragRef.current.oy + dy };
      scheduleDraw(); return;
    }
    if ((mode === "delete" || mode === "hide") && boxSelectRef.current) {
      const cvs = canvasRef.current; if (!cvs) return;
      const rect = cvs.getBoundingClientRect(), cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const { startCx, startCy } = boxSelectRef.current;
      boxSelectRef.current = { startCx, startCy, cx1: startCx, cy1: startCy, cx2: cx, cy2: cy, moved: Math.hypot(cx - startCx, cy - startCy) > 5 };
      hoveredLineRef.current = -1; setHoveredLine(-1); scheduleDraw(); return;
    }
    if (mode !== "select") {
      if (mode === "add") {
        if (addStepRef.current && e.shiftKey) {
          const [ax, az] = addStepRef.current;
          snapRef.current = computeSnapConstrained(wx, wz, editedLinesRef.current, camRef.current, ax, az);
          if (!angleConst) setAngleConst(true);
        } else {
          snapRef.current = computeSnap(wx, wz, editedLinesRef.current, camRef.current);
          if (angleConst) setAngleConst(false);
        }
      }
      if (mode === "delete" || mode === "hide") {
        let best = 10 / camRef.current.scale, idx = -1;
        editedLinesRef.current.forEach((l, i) => {
          if (!isRoomWall(l, room)) return;
          const [[x1, z1], [x2, z2]] = l.pts, d = distPointToSeg(wx, wz, x1, z1, x2, z2);
          if (d < best) { best = d; idx = i; }
        });
        hoveredLineRef.current = idx; setHoveredLine(idx);
      }
      if (mode === "add-door" || mode === "add-window") {
        let best = 15 / camRef.current.scale, idx = -1, t = 0;
        editedLinesRef.current.forEach((l, i) => {
          if (!isRoomWall(l, room) || l.hidden) return;
          const [[x1, z1], [x2, z2]] = l.pts, d = distPointToSeg(wx, wz, x1, z1, x2, z2);
          if (d < best) { best = d; idx = i; t = projectOntoSeg(wx, wz, x1, z1, x2, z2); }
        });
        const info = idx >= 0 ? { wallIdx: idx, position_t: t } : null;
        hoverOpeningRef.current = info; setHoverOpening(info);
      }
      scheduleDraw();
    } else {
      if (angleConst) setAngleConst(false);
      scheduleDraw();
    }
  }, [scheduleDraw, getWorld, angleConst, room]);

  const onMouseUp = useCallback(() => {
    if (dragRef.current) { dragRef.current = null; return; }
    const box = boxSelectRef.current;
    if (box && box.moved) {
      boxSelectRef.current = null;
      const [wx1, wz1] = toWorld(Math.min(box.cx1, box.cx2), Math.min(box.cy1, box.cy2), camRef.current);
      const [wx2, wz2] = toWorld(Math.max(box.cx1, box.cx2), Math.max(box.cy1, box.cy2), camRef.current);
      const rxMin = Math.min(wx1, wx2), rxMax = Math.max(wx1, wx2), rzMin = Math.min(wz1, wz2), rzMax = Math.max(wz1, wz2);
      const mode = editModeRef.current, lines = editedLinesRef.current;
      const hits = lines.filter(l => isRoomWall(l, room) && segIntersectsRect(...l.pts[0], ...l.pts[1], rxMin, rxMax, rzMin, rzMax));
      if (hits.length > 0) {
        pushHistory(lines);
        const shouldHide = hits.filter(l => l.hidden).length < hits.length / 2;
        const newLines = mode === "delete"
          ? lines.filter(l => !(isRoomWall(l, room) && segIntersectsRect(...l.pts[0], ...l.pts[1], rxMin, rxMax, rzMin, rzMax)))
          : lines.map(l => isRoomWall(l, room) && segIntersectsRect(...l.pts[0], ...l.pts[1], rxMin, rxMax, rzMin, rzMax) ? { ...l, hidden: shouldHide } : l);
        setEditedLines(newLines); editedLinesRef.current = newLines; setIsDirty(true);
      }
      hoveredLineRef.current = -1; setHoveredLine(-1); scheduleDraw(); return;
    }
    if (box) { boxSelectRef.current = null; scheduleDraw(); }
  }, [pushHistory, scheduleDraw, room]);

  const onClick = useCallback((e) => {
    const mode = editModeRef.current;

    // Check if user clicked an existing placed opening
    if (hoverManualOpRef.current >= 0) {
      setSelectedOpIdx(hoverManualOpRef.current);
      scheduleDraw();
      return;
    }

    if (mode === "select") {
      // Click on background deselects opening
      if (selectedOpIdxRef.current !== null) {
        setSelectedOpIdx(null);
        scheduleDraw();
      }
      return;
    }

    if (mode === "add") {
      const snap = snapRef.current, [wx, wz] = snap ? snap.pt : getWorld(e);
      if (!addStepRef.current) { addStepRef.current = [wx, wz]; setAddStep([wx, wz]); scheduleDraw(); }
      else {
        pushHistory(editedLinesRef.current);
        const newLines = [...editedLinesRef.current, { pts: [addStepRef.current, [wx, wz]], source: "user" }];
        setEditedLines(newLines); editedLinesRef.current = newLines;
        addStepRef.current = null; setAddStep(null); setIsDirty(true); scheduleDraw();
      }
      return;
    }

    if (mode === "delete") {
      if (boxSelectRef.current !== null) return;
      const idx = hoveredLineRef.current;
      if (idx >= 0) {
        pushHistory(editedLinesRef.current);
        const nl = editedLinesRef.current.filter((_, i) => i !== idx);
        setEditedLines(nl); editedLinesRef.current = nl;
        hoveredLineRef.current = -1; setHoveredLine(-1); setIsDirty(true); scheduleDraw();
      }
      return;
    }

    if (mode === "hide") {
      if (boxSelectRef.current !== null) return;
      const idx = hoveredLineRef.current;
      if (idx >= 0) {
        pushHistory(editedLinesRef.current);
        const nl = editedLinesRef.current.map((l, i) => i === idx ? { ...l, hidden: !l.hidden } : l);
        setEditedLines(nl); editedLinesRef.current = nl; setIsDirty(true); scheduleDraw();
      }
      return;
    }

    if (mode === "add-door" || mode === "add-window") {
      const info = hoverOpeningRef.current;
      if (info?.wallIdx >= 0) {
        const isDoor = mode === "add-door";
        const newOp = {
          type: isDoor ? "door" : "window",
          wall_idx: info.wallIdx,
          position_t: info.position_t,
          width_m: isDoor ? toolDoorWidth : toolWindowWidth,
          side: isDoor ? toolDoorHingeSide : 1,
          swing_dir: isDoor ? toolDoorSwingDir : 1,
        };
        const nl = [...manualOpeningsRef.current, newOp];
        manualOpeningsRef.current = nl;
        setManualOpenings(nl);
        setSelectedOpIdx(nl.length - 1);
        setOpeningsDirty(true);
        scheduleDraw();
      }
      return;
    }
  }, [pushHistory, scheduleDraw, getWorld, toolDoorWidth, toolDoorHingeSide, toolDoorSwingDir, toolWindowWidth]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const cvs = canvasRef.current; if (!cvs) return;
    const rect = cvs.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89, cam = camRef.current;
    const ns = Math.max(1, Math.min(400, cam.scale * factor)), r = ns / cam.scale;
    camRef.current = { scale: ns, ox: mx - r * (mx - cam.ox), oy: my - r * (my - cam.oy) };
    scheduleDraw();
  }, [scheduleDraw]);

  const onDoubleClick = useCallback(() => {
    if (!room?.bbox) return;
    const cvs = canvasRef.current; if (!cvs) return;
    const { x_min, x_max, z_min, z_max } = room.bbox;
    const pad = Math.max(2, Math.max(x_max - x_min, z_max - z_min) * 0.35);
    camRef.current = fitCameraRoom(room.bbox, pad, cvs.width, cvs.height);
    scheduleDraw();
  }, [scheduleDraw, room]);

  const switchMode = useCallback((m) => {
    setEditMode(m); editModeRef.current = m;
    if (m !== "add") { addStepRef.current = null; setAddStep(null); }
    if (m !== "delete" && m !== "hide") { hoveredLineRef.current = -1; setHoveredLine(-1); }
    if (m !== "add-door" && m !== "add-window") { hoverOpeningRef.current = null; setHoverOpening(null); }
    snapRef.current = null; scheduleDraw();
  }, [scheduleDraw]);

  // Update selected opening properties
  const updateSelectedOp = useCallback((changes) => {
    if (selectedOpIdxRef.current === null) return;
    const idx = selectedOpIdxRef.current;
    const list = [...manualOpeningsRef.current];
    if (idx >= 0 && idx < list.length) {
      list[idx] = { ...list[idx], ...changes };
      manualOpeningsRef.current = list;
      setManualOpenings(list);
      setOpeningsDirty(true);
      scheduleDraw();
    }
  }, [scheduleDraw]);

  // Delete selected opening
  const deleteSelectedOp = useCallback(() => {
    if (selectedOpIdxRef.current === null) return;
    const idx = selectedOpIdxRef.current;
    const list = manualOpeningsRef.current.filter((_, i) => i !== idx);
    manualOpeningsRef.current = list;
    setManualOpenings(list);
    setSelectedOpIdx(null);
    setOpeningsDirty(true);
    scheduleDraw();
  }, [scheduleDraw]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const wallCount   = editedLines.length;
  const userCount   = editedLines.filter(l => l.source === "user" && !l.hidden).length;
  const hiddenCount = editedLines.filter(l => l.hidden).length;
  const doorCount   = autoOpenings.filter(o => o.type === "door").length + manualOpenings.filter(o => o.type === "door").length;
  const winCount    = autoOpenings.filter(o => o.type === "window").length + manualOpenings.filter(o => o.type === "window").length;
  const canUndo = undoStack.length > 0, canRedo = redoStack.length > 0;
  const isAnyDirty = isDirty || openingsDirty;
  const roomAccent = getRoomAccent(room?.id ?? 1);
  const bboxW = room ? Math.abs(room.bbox.x_max - room.bbox.x_min) : 0;
  const bboxH = room ? Math.abs(room.bbox.z_max - room.bbox.z_min) : 0;
  const dimA = Math.max(bboxW, bboxH), dimB = Math.min(bboxW, bboxH);

  const selectedOp = selectedOpIdx !== null && selectedOpIdx < manualOpenings.length ? manualOpenings[selectedOpIdx] : null;

  const cursorStyle = hoverManualOp >= 0 ? "pointer"
    : editMode === "select" ? (dragRef.current ? "grabbing" : "grab")
    : (editMode === "add" || editMode === "add-door" || editMode === "add-window") ? "crosshair"
    : hoveredLine >= 0 ? "pointer" : "crosshair";

  // ── Minimized Floating Pill View ──────────────────────────────────────────────
  if (isMinimized) {
    return (
      <div className="rep-minimized-pill" onClick={() => setIsMinimized(false)}>
        <div
          className="rep-mini-badge"
          style={{ background: roomAccent + "33", color: roomAccent, borderColor: roomAccent + "66" }}
        >
          Room {room?.id}
        </div>
        <div className="rep-mini-info">
          <span className="rep-mini-title">Room Editor</span>
          <span className="rep-mini-sub">{wallCount} walls · {doorCount}🚪 · {winCount}🪟</span>
        </div>
        {isAnyDirty && <span className="rep-unsaved">✎ Unsaved</span>}
        <button
          className="rep-mini-restore"
          onClick={(e) => { e.stopPropagation(); setIsMinimized(false); }}
          title="Return to Room Editor (V)"
        >
          ⤢ Open Editor (V)
        </button>
        <button
          className="rep-mini-close"
          onClick={(e) => { e.stopPropagation(); onClose?.(); }}
          title="Close Room Editor"
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Full Modal Overlay Render ──────────────────────────────────────────────────
  return (
    <div className="rep-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setIsMinimized(true); }}>
      <div className="rep-panel">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="rep-header">
          <div className="rep-header-left">
            <div className="rep-room-badge"
              style={{ background: roomAccent + "22", borderColor: roomAccent + "55", color: roomAccent }}>
              Room {room?.id}
            </div>
            {room && (
              <div className="rep-room-stats">
                <span>{room.area_m2.toFixed(1)} m²</span>
                <span className="rep-stat-sep">·</span>
                <span>{dimA.toFixed(2)} × {dimB.toFixed(2)} m</span>
                {doorCount > 0 && <><span className="rep-stat-sep">·</span><span>🚪 {doorCount}</span></>}
                {winCount  > 0 && <><span className="rep-stat-sep">·</span><span>🪟 {winCount}</span></>}
              </div>
            )}
          </div>
          <div className="rep-header-right">
            {isAnyDirty && <span className="rep-unsaved">✎ Unsaved</span>}

            {/* Switch to 3D View button */}
            <button
              className="rep-minimize-btn"
              onClick={() => setIsMinimized(true)}
              title="Hide editor to view and interact with 3D scene (V)"
            >
              👁 3D View (Hide)
            </button>

            <button className="rep-close" onClick={onClose} title="Close editor (Esc)">✕</button>
          </div>
        </div>

        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <div className="rep-toolbar">
          {TOOLS.map(t => {
            const isActive = editMode === t.id;
            const isOpTool = t.id === "add-door" || t.id === "add-window";
            const sep = t.id === "add-door";
            return (
              <span key={t.id} style={{ display:"inline-flex", alignItems:"center" }}>
                {sep && <span className="rep-sep" />}
                <button
                  className={`rep-tool${isActive ? " active" : ""}${isOpTool ? " op" : ""}`}
                  onClick={() => switchMode(t.id)}
                  title={t.title}
                  style={isActive ? {
                    background: isOpTool ? "rgba(129,140,248,0.16)" : "rgba(251,191,36,0.14)",
                    borderColor: isOpTool ? "rgba(129,140,248,0.6)"  : "rgba(251,191,36,0.5)",
                    color:       isOpTool ? "#818cf8" : "#fbbf24",
                    fontWeight: 700,
                  } : {}}
                >
                  {t.icon} <span className="rep-tool-lbl">{t.label}</span>
                </button>
              </span>
            );
          })}

          <span className="rep-sep" />
          <button className="rep-icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↩</button>
          <button className="rep-icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">↪</button>

          <span style={{ flex: 1 }} />

          <span className="rep-wall-info">
            {wallCount}W
            {userCount   > 0 && <span style={{ color:"#fbbf24", marginLeft:4 }}>+{userCount}</span>}
            {hiddenCount > 0 && <span style={{ color:"#4a6080", marginLeft:4 }}>👁{hiddenCount}</span>}
          </span>

          {isAnyDirty && (
            <button className="rep-discard" onClick={handleReset} title="Discard all changes">↺ Discard</button>
          )}
          <button
            className={`rep-save${isAnyDirty && saveState !== "saving" ? " dirty" : ""}`}
            onClick={handleSave}
            disabled={!isAnyDirty || saveState === "saving"}
            title="Save walls + openings (Ctrl+S)"
          >
            {saveState === "saving" ? "⏳ Saving…" : saveState === "saved" ? "✓ Saved" : "💾 Save"}
          </button>
        </div>

        {/* ── Tool Parameter Sub-bar (for Door and Window placement) ───── */}
        {(editMode === "add-door" || editMode === "add-window") && (
          <div className="rep-tool-subbar">
            {editMode === "add-door" ? (
              <>
                <div className="rep-subbar-group">
                  <span className="rep-subbar-label">Door Width:</span>
                  <div className="rep-subbar-pills">
                    {[0.75, 0.8, 0.9, 1.0, 1.2].map(w => (
                      <button
                        key={w}
                        className={`rep-pill-btn${toolDoorWidth === w ? " active" : ""}`}
                        onClick={() => setToolDoorWidth(w)}
                      >
                        {w.toFixed(2)}m
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="0.5"
                    max="2.5"
                    step="0.05"
                    className="rep-subbar-input"
                    value={toolDoorWidth}
                    onChange={(e) => setToolDoorWidth(Math.max(0.4, Math.min(3.0, parseFloat(e.target.value) || 0.9)))}
                  />
                  <span style={{ fontSize: 11, color: "var(--text-3, #777)" }}>m</span>
                </div>

                <span className="rep-sep" />

                <div className="rep-subbar-group">
                  <span className="rep-subbar-label">Hinge Side:</span>
                  <button
                    className={`rep-pill-btn${toolDoorHingeSide === 1 ? " active" : ""}`}
                    onClick={() => setToolDoorHingeSide(1)}
                    title="Hinge at start of opening"
                  >
                    ◀ Left
                  </button>
                  <button
                    className={`rep-pill-btn${toolDoorHingeSide === -1 ? " active" : ""}`}
                    onClick={() => setToolDoorHingeSide(-1)}
                    title="Hinge at end of opening"
                  >
                    Right ▶
                  </button>
                </div>

                <span className="rep-sep" />

                <div className="rep-subbar-group">
                  <span className="rep-subbar-label">Swing:</span>
                  <button
                    className={`rep-pill-btn${toolDoorSwingDir === 1 ? " active" : ""}`}
                    onClick={() => setToolDoorSwingDir(1)}
                    title="Swing inward"
                  >
                    ↶ Inward
                  </button>
                  <button
                    className={`rep-pill-btn${toolDoorSwingDir === -1 ? " active" : ""}`}
                    onClick={() => setToolDoorSwingDir(-1)}
                    title="Swing outward"
                  >
                    Outward ↷
                  </button>
                </div>
              </>
            ) : (
              <div className="rep-subbar-group">
                <span className="rep-subbar-label">Window Width:</span>
                <div className="rep-subbar-pills">
                  {[0.9, 1.2, 1.5, 1.8, 2.4].map(w => (
                    <button
                      key={w}
                      className={`rep-pill-btn${toolWindowWidth === w ? " active" : ""}`}
                      onClick={() => setToolWindowWidth(w)}
                    >
                      {w.toFixed(2)}m
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min="0.4"
                  max="4.0"
                  step="0.05"
                  className="rep-subbar-input"
                  value={toolWindowWidth}
                  onChange={(e) => setToolWindowWidth(Math.max(0.3, Math.min(5.0, parseFloat(e.target.value) || 1.2)))}
                />
                <span style={{ fontSize: 11, color: "var(--text-3, #777)" }}>m</span>
              </div>
            )}
          </div>
        )}

        {/* ── Canvas ──────────────────────────────────────────────────── */}
        <div className="rep-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="rep-canvas"
            style={{ cursor: cursorStyle }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => { if (boxSelectRef.current) { boxSelectRef.current = null; scheduleDraw(); } if (dragRef.current) dragRef.current = null; }}
            onClick={onClick}
            onWheel={onWheel}
            onDoubleClick={onDoubleClick}
          />

          {loadState === "loading" && (
            <div className="rep-overlay-state">
              <div className="rep-spinner" />
              <span>Loading floor {floor}…</span>
            </div>
          )}
          {loadState === "error" && (
            <div className="rep-overlay-state" style={{ color:"#ef4444" }}>
              <span style={{ fontSize:28 }}>⚠</span>
              <span>Could not load floor data</span>
            </div>
          )}

          {saveState === "saved" && (
            <div className="rep-toast">✓ Saved — rooms recalculated</div>
          )}
          {saveState === "error" && (
            <div className="rep-toast" style={{ background:"rgba(239,68,68,0.16)", borderColor:"rgba(239,68,68,0.4)", color:"#ef4444" }}>
              ✗ Save failed
            </div>
          )}

          {loadState === "ready" && (
            <div className={`rep-hint${editMode === "add" && angleConst ? " locked" : ""}`}>
              {selectedOp ? "Opening selected — customize parameters in the panel or press Delete to remove"
                : editMode === "add" && angleConst ? "🔒 Angle locked — Release Shift to free-draw"
                : MODE_HINTS[editMode]}
            </div>
          )}

          {/* Placed manual openings chips */}
          {loadState === "ready" && manualOpenings.length > 0 && (
            <div className="rep-placed-badge">
              <span style={{ fontWeight: 600, color: "var(--text-2, #aaa)" }}>Openings:</span>
              {manualOpenings.map((op, idx) => (
                <button
                  key={idx}
                  className={`rep-op-chip${selectedOpIdx === idx ? " selected" : ""}`}
                  onClick={() => setSelectedOpIdx(idx)}
                  title={`Click to edit ${op.type} #${idx + 1}`}
                >
                  {op.type === "door" ? "🚪" : "🪟"} {(op.width_m ?? (op.type === "door" ? 0.9 : 1.2)).toFixed(2)}m
                </button>
              ))}
              <button
                className="rep-clear-btn"
                onClick={() => {
                  manualOpeningsRef.current = [];
                  setManualOpenings([]);
                  setSelectedOpIdx(null);
                  setOpeningsDirty(true);
                  scheduleDraw();
                }}
                title="Clear all manual openings"
              >
                ✕ Clear All
              </button>
            </div>
          )}

          {/* Opening Inspector Panel (appears when an opening is selected) */}
          {selectedOp && (
            <div className="rep-opening-inspector">
              <div className="rep-inspector-header">
                <div className="rep-inspector-title">
                  <span>{selectedOp.type === "door" ? "🚪 Door Properties" : "🪟 Window Properties"}</span>
                  <span className="rep-inspector-sub">#{selectedOpIdx + 1} (Wall {selectedOp.wall_idx})</span>
                </div>
                <button className="rep-close" style={{ width: 22, height: 22, fontSize: 11 }} onClick={() => setSelectedOpIdx(null)}>✕</button>
              </div>

              <div className="rep-inspector-body">
                {/* Width */}
                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Width:</span>
                    <span className="rep-inspector-val">{(selectedOp.width_m ?? (selectedOp.type === "door" ? 0.9 : 1.2)).toFixed(2)} m</span>
                  </div>
                  <div className="rep-subbar-pills" style={{ marginBottom: 6 }}>
                    {(selectedOp.type === "door" ? [0.75, 0.8, 0.9, 1.0, 1.2] : [0.9, 1.2, 1.5, 1.8, 2.4]).map(w => (
                      <button
                        key={w}
                        className={`rep-pill-btn${selectedOp.width_m === w ? " active" : ""}`}
                        onClick={() => updateSelectedOp({ width_m: w })}
                      >
                        {w.toFixed(2)}m
                      </button>
                    ))}
                  </div>
                  <input
                    type="range"
                    min={selectedOp.type === "door" ? "0.5" : "0.4"}
                    max={selectedOp.type === "door" ? "2.5" : "3.6"}
                    step="0.05"
                    className="rep-range-slider"
                    value={selectedOp.width_m ?? (selectedOp.type === "door" ? 0.9 : 1.2)}
                    onChange={(e) => updateSelectedOp({ width_m: parseFloat(e.target.value) })}
                  />
                </div>

                {/* Door Direction & Side Controls */}
                {selectedOp.type === "door" && (
                  <>
                    <div className="rep-inspector-row">
                      <div className="rep-inspector-label-line">
                        <span className="rep-inspector-label">Hinge Side & Swing:</span>
                      </div>
                      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                        <button
                          className={`rep-pill-btn${(selectedOp.side ?? 1) === 1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ side: 1 })}
                          title="Hinge on start end of wall opening"
                        >
                          ◀ Left Hinge
                        </button>
                        <button
                          className={`rep-pill-btn${(selectedOp.side ?? 1) === -1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ side: -1 })}
                          title="Hinge on other end of wall opening"
                        >
                          Right Hinge ▶
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className={`rep-pill-btn${(selectedOp.swing_dir ?? 1) === 1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ swing_dir: 1 })}
                          title="Swing inward"
                        >
                          ↶ Inward Swing
                        </button>
                        <button
                          className={`rep-pill-btn${(selectedOp.swing_dir ?? 1) === -1 ? " active" : ""}`}
                          style={{ flex: 1 }}
                          onClick={() => updateSelectedOp({ swing_dir: -1 })}
                          title="Swing outward"
                        >
                          Outward Swing ↷
                        </button>
                      </div>
                    </div>

                    <div className="rep-inspector-row">
                      <span className="rep-inspector-label" style={{ marginBottom: 4, display: "block" }}>CAD Orientation Presets:</span>
                      <div className="rep-orient-grid">
                        <button
                          className={`rep-orient-btn${(selectedOp.side ?? 1) === 1 && (selectedOp.swing_dir ?? 1) === 1 ? " active" : ""}`}
                          onClick={() => updateSelectedOp({ side: 1, swing_dir: 1 })}
                          title="Inward Left"
                        >
                          ↙ In-Left
                        </button>
                        <button
                          className={`rep-orient-btn${(selectedOp.side ?? 1) === -1 && (selectedOp.swing_dir ?? 1) === -1 ? " active" : ""}`}
                          onClick={() => updateSelectedOp({ side: -1, swing_dir: -1 })}
                          title="Inward Right"
                        >
                          ↘ In-Right
                        </button>
                        <button
                          className={`rep-orient-btn${(selectedOp.side ?? 1) === 1 && (selectedOp.swing_dir ?? 1) === -1 ? " active" : ""}`}
                          onClick={() => updateSelectedOp({ side: 1, swing_dir: -1 })}
                          title="Outward Left"
                        >
                          ↖ Out-Left
                        </button>
                        <button
                          className={`rep-orient-btn${(selectedOp.side ?? 1) === -1 && (selectedOp.swing_dir ?? 1) === 1 ? " active" : ""}`}
                          onClick={() => updateSelectedOp({ side: -1, swing_dir: 1 })}
                          title="Outward Right"
                        >
                          ↗ Out-Right
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Position along wall */}
                <div className="rep-inspector-row">
                  <div className="rep-inspector-label-line">
                    <span className="rep-inspector-label">Position on Wall:</span>
                    <span className="rep-inspector-val">{((selectedOp.position_t ?? 0.5) * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.05"
                    max="0.95"
                    step="0.01"
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
          )}

          <button className="rep-fit-btn" onClick={onDoubleClick} title="Fit view to room">⊞ Fit</button>
        </div>
      </div>

      <style>{`
        @keyframes rep-in { from{opacity:0;transform:scale(0.94) translateY(12px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes rep-spin { to{transform:rotate(360deg)} }
        @keyframes rep-toast { from{opacity:0;transform:translateX(-50%) translateY(-8px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
      `}</style>
    </div>
  );
}
