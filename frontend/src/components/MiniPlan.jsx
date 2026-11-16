import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { colorForMpLabel } from "./MpObjects3D";
import { getCanvasTheme, getRoomAccent, withAlpha } from "../theme";

/**
 * MiniPlan — floating 2D plan of the active floor, meant to sit on top of the 3D viewer.
 *  • draggable anywhere on the page (header), resizable (bottom-right handle), minimisable
 *  • pan (drag) / zoom (wheel) / double-click to re-fit
 *  • every layer is toggleable, including individual equipment types
 *  • read-only, but selection is shared with the rest of the workspace
 */

const LS_KEY = "s2f_miniplan_v1";
const HEADER_H = 34;
const MIN_W = 240;
const MIN_H = 190;
const MIN_BAR_W = 190;

const DEFAULT_OPTS = {
  walls: true,
  rooms: true,
  roomLabels: true,
  doors: true,
  windows: true,
  equipment: true,
  sweeps: false,
  points: true,
  live: true,
  scale: true,
};

const OPT_LABELS = [
  ["walls", "Walls"],
  ["rooms", "Room fills"],
  ["roomLabels", "Room labels"],
  ["doors", "Doors"],
  ["windows", "Windows"],
  ["equipment", "Equipment"],
  ["sweeps", "360° sweeps"],
  ["points", "Viewpoints"],
  ["live", "Live / FPV position"],
  ["scale", "Scale bar"],
];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (p) return { ...p, opts: { ...DEFAULT_OPTS, ...(p.opts || {}) }, hidden: p.hidden || [] };
  } catch { /* ignore */ }
  return { x: null, y: null, w: 340, h: 300, open: true, opts: { ...DEFAULT_OPTS }, hidden: [] };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function pointInPoly(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function roomPoly(room) {
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  const b = room.bbox;
  if (!b) return null;
  return [[b.x_min, b.z_min], [b.x_max, b.z_min], [b.x_max, b.z_max], [b.x_min, b.z_max]];
}

export default function MiniPlan({
  floor = 0,
  floorCount = 1,
  onChangeFloor,
  saveName = null,
  dataVersion = 0,
  theme = "dark",
  instances = [],
  sweeps = {},
  points = [],
  inventory = [],
  livePose = null,
  fpvPoseStore = null,
  selectedRoomId = null,
  onSelectRoom,
  selectedMpItem = null,
  onSelectMpItem,
}) {
  const apiBase = saveName ? `/api/saves/${encodeURIComponent(saveName)}` : "/api";
  const [prefs, setPrefs] = useState(loadPrefs);
  const { open, opts, hidden, w, h } = prefs;
  const [showFilters, setShowFilters] = useState(false);
  const [data, setData] = useState({ walls: [], wallThicknesses: [], rooms: [], openings: [] });
  const [loadState, setLoadState] = useState("loading");
  const [tick, setTick] = useState(0);

  const canvasRef = useRef(null);
  const camRef = useRef({ s: 10, ox: 0, oy: 0 });
  const needFitRef = useRef(true);
  const userCamRef = useRef(false);
  const drawRef = useRef(() => {});

  const patch = useCallback((p) => setPrefs((prev) => ({ ...prev, ...p })), []);

  // Default position: bottom-left of the window (re-clamped whenever the window changes)
  useEffect(() => {
    const fit = () =>
      setPrefs((p) => {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const nw = clamp(p.w, MIN_W, Math.max(MIN_W, W - 16));
        const nh = clamp(p.h, MIN_H, Math.max(MIN_H, H - 70));
        const x0 = p.x ?? 16;
        const y0 = p.y ?? H - nh - 56;
        return {
          ...p,
          w: nw,
          h: nh,
          x: clamp(x0, 0, Math.max(0, W - 120)),
          y: clamp(y0, 0, Math.max(0, H - HEADER_H)),
        };
      });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  /* ---------------- data ---------------- */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) setLoadState("loading"); });
    const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get(`${apiBase}/walls/${floor}`), get(`${apiBase}/rooms/${floor}`), get(`${apiBase}/openings/${floor}`)])
      .then(([wd, rd, od]) => {
        if (cancelled) return;
        setData({
          walls: wd?.lines ?? [],
          wallThicknesses: wd?.thicknesses ?? [],
          rooms: rd?.rooms ?? [],
          openings: [...(od?.openings ?? []), ...(od?.user_openings ?? [])],
        });
        setLoadState(wd || rd ? "ready" : "error");
        needFitRef.current = true;
        userCamRef.current = false;
        setTick((t) => t + 1);
      });
    return () => { cancelled = true; };
  }, [apiBase, floor, dataVersion, open]);

  /* ---------------- equipment data ---------------- */
  const onFloor = useCallback(
    (item) => Boolean(item?.s2f_position) && item.floor_idx != null && Number(item.floor_idx) === Number(floor),
    [floor]
  );
  const floorInstances = useMemo(() => instances.filter(onFloor), [instances, onFloor]);
  const labelInfo = useMemo(() => {
    const names = {};
    inventory.forEach((r) => { names[r.label] = r.cz || r.en || r.label; });
    const counts = {};
    floorInstances.forEach((i) => { counts[i.label] = (counts[i.label] || 0) + 1; });
    return Object.entries(counts)
      .map(([label, count]) => ({ label, count, name: names[label] || label }))
      .sort((a, b) => b.count - a.count);
  }, [floorInstances, inventory]);

  const visibleInstances = useMemo(
    () => (opts.equipment ? floorInstances.filter((i) => !hidden.includes(i.label)) : []),
    [floorInstances, hidden, opts.equipment]
  );
  const floorSweeps = useMemo(() => Object.values(sweeps || {}).filter(onFloor), [sweeps, onFloor]);
  const floorPoints = useMemo(() => points.filter(onFloor), [points, onFloor]);

  /* ---------------- drawing ---------------- */
  const cw = w;
  const ch = Math.max(40, h - HEADER_H);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !open) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }

    const fitCam = () => {
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      const add = (x, z) => {
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      };
      data.walls.forEach(([a, b]) => { add(a[0], a[1]); add(b[0], b[1]); });
      data.rooms.forEach((r) => roomPoly(r)?.forEach(([x, z]) => add(x, z)));
      if (!isFinite(minx)) { minx = -10; maxx = 10; minz = -10; maxz = 10; }
      const pad = 14;
      const bw = Math.max(maxx - minx, 1);
      const bh = Math.max(maxz - minz, 1);
      const s = Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh);
      camRef.current = {
        s,
        ox: (cw - bw * s) / 2 - minx * s,
        oy: (ch - bh * s) / 2 - minz * s,
      };
    };

    const draw = () => {
      if (needFitRef.current || !userCamRef.current) {
        fitCam();
        needFitRef.current = false;
      }
      const cam = camRef.current;
      const T = getCanvasTheme();
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, cw, ch);
      const P = (x, z) => [x * cam.s + cam.ox, z * cam.s + cam.oy];
      const fpvPose = fpvPoseStore?.current ?? null;
      const showFpv = Boolean(
        opts.live &&
        fpvPose &&
        (fpvPose.floor_idx == null || Number(fpvPose.floor_idx) === Number(floor))
      );
      const fpvRoom = showFpv
        ? data.rooms.find((r) => {
            const poly = roomPoly(r);
            return poly && pointInPoly(fpvPose.x, fpvPose.z, poly);
          }) ?? null
        : null;

      // rooms
      if (opts.rooms || opts.roomLabels) {
        data.rooms.forEach((room) => {
          const poly = roomPoly(room);
          if (!poly) return;
          const sel = room.id === selectedRoomId;
          const isFpvRoom = fpvRoom != null && room.id === fpvRoom.id;
          ctx.beginPath();
          poly.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); });
          ctx.closePath();
          if (opts.rooms) {
            ctx.fillStyle = withAlpha(getRoomAccent(room.id), sel ? 0.32 : isFpvRoom ? 0.24 : 0.14);
            ctx.fill();
            ctx.save();
            if (isFpvRoom && !sel) {
              ctx.setLineDash([4, 3]);
              ctx.strokeStyle = "#22d3ee";
              ctx.lineWidth = 1.8;
            } else {
              ctx.strokeStyle = sel ? T.sel : T.roomBorder;
              ctx.lineWidth = sel ? 2 : 1;
            }
            ctx.stroke();
            ctx.restore();
          }
        });
        if (opts.roomLabels && cam.s > 4) {
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = T.labelRoom;
          ctx.font = "600 10px Inter, sans-serif";
          data.rooms.forEach((room) => {
            const cx = room.centroid_x ?? (room.bbox ? (room.bbox.x_min + room.bbox.x_max) / 2 : null);
            const cz = room.centroid_z ?? (room.bbox ? (room.bbox.z_min + room.bbox.z_max) / 2 : null);
            if (cx == null) return;
            const [px, pz] = P(cx, cz);
            ctx.fillText(room.name ?? room.label ?? `R${room.id}`, px, pz - (room.area_m2 ? 6 : 0));
            if (room.area_m2) {
              ctx.font = "400 9px Inter, sans-serif";
              ctx.fillText(`${Number(room.area_m2).toFixed(1)} m²`, px, pz + 6);
              ctx.font = "600 10px Inter, sans-serif";
            }
          });
        }
      }

      // walls
      if (opts.walls) {
        ctx.strokeStyle = T.wall;
        ctx.lineCap = "butt";
        data.walls.forEach(([a, b], i) => {
          const tv = Number(data.wallThicknesses?.[i]);
          const tM = Number.isFinite(tv) && tv > 0.02 ? tv : 0.2;
          ctx.lineWidth = clamp(tM * cam.s, 1.2, 14);
          const [x1, z1] = P(a[0], a[1]);
          const [x2, z2] = P(b[0], b[1]);
          ctx.beginPath();
          ctx.moveTo(x1, z1);
          ctx.lineTo(x2, z2);
          ctx.stroke();
        });
      }

      // openings
      data.openings.forEach((op) => {
        const isDoor = op.type === "door";
        if (isDoor ? !opts.doors : !opts.windows) return;
        ctx.strokeStyle = isDoor ? T.door : T.window;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = clamp(0.28 * cam.s, 2, 6);
        ctx.lineCap = "butt";
        if (op.wall_x1 != null && op.wall_x2 != null && op.u_start != null && op.u_end != null) {
          const dx = op.wall_x2 - op.wall_x1;
          const dz = op.wall_z2 - op.wall_z1;
          const len = Math.hypot(dx, dz) || 1;
          const ux = dx / len;
          const uz = dz / len;
          const [x1, z1] = P(op.wall_x1 + ux * op.u_start, op.wall_z1 + uz * op.u_start);
          const [x2, z2] = P(op.wall_x1 + ux * op.u_end, op.wall_z1 + uz * op.u_end);
          ctx.beginPath(); ctx.moveTo(x1, z1); ctx.lineTo(x2, z2); ctx.stroke();
        } else if (op.x != null && op.z != null) {
          const [px, pz] = P(op.x, op.z);
          ctx.beginPath(); ctx.arc(px, pz, 3, 0, Math.PI * 2); ctx.fill();
        }
      });

      // sweeps
      if (opts.sweeps) {
        ctx.strokeStyle = T.text2;
        ctx.lineWidth = 1;
        floorSweeps.forEach((sw) => {
          const [px, pz] = P(sw.s2f_position.x, sw.s2f_position.z);
          ctx.beginPath(); ctx.arc(px, pz, 3, 0, Math.PI * 2); ctx.stroke();
        });
      }

      // viewpoints
      if (opts.points) {
        ctx.fillStyle = T.text1;
        floorPoints.forEach((pt) => {
          const [px, pz] = P(pt.s2f_position.x, pt.s2f_position.z);
          ctx.beginPath();
          ctx.moveTo(px, pz - 5); ctx.lineTo(px + 4, pz); ctx.lineTo(px, pz + 5); ctx.lineTo(px - 4, pz);
          ctx.closePath(); ctx.fill();
        });
      }

      // equipment
      const selId = selectedMpItem?.kind === "instance" ? selectedMpItem.data?.instance_id : null;
      visibleInstances.forEach((inst) => {
        const [px, pz] = P(inst.s2f_position.x, inst.s2f_position.z);
        const sel = inst.instance_id === selId;
        ctx.fillStyle = colorForMpLabel(inst.label);
        ctx.beginPath(); ctx.arc(px, pz, sel ? 6 : 3.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = sel ? T.sel : T.bg;
        ctx.lineWidth = sel ? 2.2 : 1;
        ctx.stroke();
      });

      // live 360° & FPV position
      if (opts.live && livePose?.s2f_position && onFloor(livePose)) {
        const [px, pz] = P(livePose.s2f_position.x, livePose.s2f_position.z);
        ctx.strokeStyle = T.sel;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, pz, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = T.sel;
        ctx.beginPath(); ctx.arc(px, pz, 3, 0, Math.PI * 2); ctx.fill();
      }
      if (showFpv) {
        const [px, pz] = P(fpvPose.x, fpvPose.z);
        const heading = fpvPose.headingRad ?? Math.atan2(fpvPose.dirZ ?? -1, fpvPose.dirX ?? 0);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px, pz);
        ctx.arc(px, pz, 20, heading - 0.52, heading + 0.52);
        ctx.closePath();
        ctx.fillStyle = fpvPose.active ? "rgba(34, 211, 238, 0.26)" : "rgba(34, 211, 238, 0.14)";
        ctx.fill();
        ctx.strokeStyle = fpvPose.active ? "rgba(34, 211, 238, 0.72)" : "rgba(34, 211, 238, 0.42)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(px, pz, 7, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = "#22d3ee";
        ctx.strokeStyle = T.bg;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, pz, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        if (fpvRoom) {
          const roomText = `FPV · ${fpvRoom.name ?? fpvRoom.label ?? `R${fpvRoom.id}`}`;
          ctx.save();
          ctx.font = "600 10px Inter, sans-serif";
          const tw = ctx.measureText(roomText).width;
          const bx = 8;
          const by = 8;
          const bw = tw + 12;
          const bh = 18;
          ctx.fillStyle = theme === "dark" ? "rgba(11, 17, 32, 0.88)" : "rgba(255, 255, 255, 0.92)";
          ctx.strokeStyle = "#22d3ee";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4);
          else ctx.rect(bx, by, bw, bh);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = theme === "dark" ? "#22d3ee" : "#0891b2";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(roomText, bx + 6, by + bh / 2);
          ctx.restore();
        }
      }

      // scale bar
      if (opts.scale) {
        const target = 60 / cam.s;
        const nice = [0.5, 1, 2, 5, 10, 20, 50].find((n) => n >= target) ?? 50;
        const len = nice * cam.s;
        ctx.strokeStyle = T.scaleStroke;
        ctx.fillStyle = T.scaleFill;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(10, ch - 12); ctx.lineTo(10 + len, ch - 12);
        ctx.moveTo(10, ch - 16); ctx.lineTo(10, ch - 8);
        ctx.moveTo(10 + len, ch - 16); ctx.lineTo(10 + len, ch - 8);
        ctx.stroke();
        ctx.font = "10px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${nice} m`, 14 + len, ch - 8);
      }
    };

    drawRef.current = draw;
    draw();
  }, [open, cw, ch, data, opts, selectedRoomId, selectedMpItem, livePose, fpvPoseStore, visibleInstances, floorSweeps, floorPoints, onFloor, floor, theme, tick]);

  useEffect(() => {
    if (!fpvPoseStore || !open) return undefined;
    return fpvPoseStore.subscribe(() => {
      drawRef.current?.();
    });
  }, [fpvPoseStore, open]);

  /* ---------------- canvas interaction ---------------- */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !open) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cam = camRef.current;
      const f = Math.exp(-e.deltaY * 0.0015);
      const ns = clamp(cam.s * f, 0.5, 400);
      const k = ns / cam.s;
      camRef.current = { s: ns, ox: mx - (mx - cam.ox) * k, oy: my - (my - cam.oy) * k };
      userCamRef.current = true;
      drawRef.current();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [open]);

  const panRef = useRef(null);
  const onCanvasDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, ox: camRef.current.ox, oy: camRef.current.oy, moved: false };
  };
  const onCanvasMove = (e) => {
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    p.moved = true;
    camRef.current = { ...camRef.current, ox: p.ox + dx, oy: p.oy + dy };
    userCamRef.current = true;
    drawRef.current();
  };
  const onCanvasUp = (e) => {
    const p = panRef.current;
    panRef.current = null;
    if (!p || p.moved) return;
    // click → select nearest equipment / room
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cam = camRef.current;
    const wx = (mx - cam.ox) / cam.s;
    const wz = (my - cam.oy) / cam.s;
    const hit = 9 / cam.s;
    const near = (pos) => Math.hypot(pos.x - wx, pos.z - wz) <= hit;

    for (const inst of visibleInstances) {
      if (near(inst.s2f_position)) { onSelectMpItem?.({ kind: "instance", data: inst }); return; }
    }
    if (opts.points) {
      for (const pt of floorPoints) {
        if (near(pt.s2f_position)) { onSelectMpItem?.({ kind: "point", data: pt }); return; }
      }
    }
    if (opts.sweeps) {
      for (const sw of floorSweeps) {
        if (near(sw.s2f_position)) { onSelectMpItem?.({ kind: "sweep", data: sw }); return; }
      }
    }
    for (const room of data.rooms) {
      const poly = roomPoly(room);
      if (poly && pointInPoly(wx, wz, poly)) {
        onSelectRoom?.(room.id === selectedRoomId ? null : room.id, floor, { ...room, floor_idx: floor });
        return;
      }
    }
    onSelectRoom?.(null);
  };
  const refit = () => {
    userCamRef.current = false;
    needFitRef.current = true;
    setTick((t) => t + 1);
  };

  /* ---------------- window drag / resize ---------------- */
  const dragRef = useRef(null);
  const onHeaderDown = (e) => {
    if (e.target.closest("button, select")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, x: prefs.x, y: prefs.y };
  };
  const onHeaderMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    patch({
      x: clamp(d.x + e.clientX - d.sx, 0, Math.max(0, window.innerWidth - 120)),
      y: clamp(d.y + e.clientY - d.sy, 0, Math.max(0, window.innerHeight - HEADER_H)),
    });
  };
  const onHeaderUp = () => { dragRef.current = null; };

  const resizeRef = useRef(null);
  const onResizeDown = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { sx: e.clientX, sy: e.clientY, w: prefs.w, h: prefs.h };
  };
  const onResizeMove = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    patch({
      w: clamp(r.w + e.clientX - r.sx, MIN_W, Math.max(MIN_W, window.innerWidth - prefs.x)),
      h: clamp(r.h + e.clientY - r.sy, MIN_H, Math.max(MIN_H, window.innerHeight - prefs.y)),
    });
  };
  const onResizeUp = () => { resizeRef.current = null; };

  const setOpt = (k, v) => patch({ opts: { ...opts, [k]: v } });
  const toggleLabel = (label) =>
    patch({ hidden: hidden.includes(label) ? hidden.filter((l) => l !== label) : [...hidden, label] });

  if (prefs.x == null) return null;

  const title = `Floor ${floor} plan`;
  const style = { left: prefs.x, top: prefs.y, width: open ? w : MIN_BAR_W };

  return (
    <div
      className={`s2f-mini${open ? "" : " minimized"}`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      data-theme={theme}
    >
      <div
        className="s2f-mini-head"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
        title="Drag to move"
      >
        <span className="s2f-mini-grip">⠿</span>
        {open && floorCount > 1 && onChangeFloor && (
          <button className="s2f-mini-btn" disabled={floor <= 0} onClick={() => onChangeFloor(floor - 1)} title="Previous floor">‹</button>
        )}
        <span className="s2f-mini-title">{title}</span>
        {open && floorCount > 1 && onChangeFloor && (
          <button className="s2f-mini-btn" disabled={floor >= floorCount - 1} onClick={() => onChangeFloor(floor + 1)} title="Next floor">›</button>
        )}
        <span className="s2f-spacer" />
        {open && (
          <>
            <button className={`s2f-mini-btn${showFilters ? " active" : ""}`} onClick={() => setShowFilters((v) => !v)} title="Layers & equipment types">☰</button>
            <button className="s2f-mini-btn" onClick={refit} title="Re-fit plan (or double-click the plan)">⌖</button>
          </>
        )}
        <button className="s2f-mini-btn" onClick={() => patch({ open: !open })} title={open ? "Minimise" : "Open 2D plan"}>
          {open ? "–" : "▢"}
        </button>
      </div>

      {open && (
        <div className="s2f-mini-body" style={{ height: ch }}>
          <canvas
            ref={canvasRef}
            style={{ width: cw, height: ch }}
            onPointerDown={onCanvasDown}
            onPointerMove={onCanvasMove}
            onPointerUp={onCanvasUp}
            onPointerCancel={() => { panRef.current = null; }}
            onDoubleClick={refit}
          />
          {loadState === "loading" && <div className="s2f-mini-note">Loading…</div>}
          {loadState === "error" && <div className="s2f-mini-note">No plan data for this floor</div>}

          {showFilters && (
            <div className="s2f-mini-filters" onPointerDown={(e) => e.stopPropagation()}>
              <div className="s2f-mini-section">Layers</div>
              {OPT_LABELS.map(([k, label]) => (
                <label key={k} className="s2f-mini-check">
                  <input type="checkbox" checked={!!opts[k]} onChange={(e) => setOpt(k, e.target.checked)} />
                  <span>{label}</span>
                </label>
              ))}
              <div className="s2f-mini-section">
                Equipment types
                <span>
                  <button className="s2f-link" onClick={() => patch({ hidden: [] })}>all</button>
                  {" · "}
                  <button className="s2f-link" onClick={() => patch({ hidden: labelInfo.map((l) => l.label) })}>none</button>
                </span>
              </div>
              {labelInfo.length === 0 && <div className="s2f-hint">No equipment on this floor</div>}
              {labelInfo.map(({ label, count, name }) => (
                <label key={label} className={`s2f-mini-check${opts.equipment ? "" : " disabled"}`} title={label}>
                  <input type="checkbox" disabled={!opts.equipment} checked={!hidden.includes(label)} onChange={() => toggleLabel(label)} />
                  <i style={{ background: colorForMpLabel(label) }} />
                  <span className="s2f-mini-name">{name}</span>
                  <em>{count}</em>
                </label>
              ))}
            </div>
          )}

          <div
            className="s2f-mini-resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title="Drag to resize"
          />
        </div>
      )}
    </div>
  );
}
