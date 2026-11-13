import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
import Sidebar from "./components/Sidebar";
import TexturedMesh from "./components/TexturedMesh";
import OBJModel from "./components/OBJModel"; // kept for future use — toggle removed from UI
import PointCloud from "./components/PointCloud";
import LoadingOverlay from "./components/LoadingOverlay";
import FloorPlanPanel from "./components/FloorPlanPanel";
import FloorPlanViewer from "./components/FloorPlanViewer";
//import RoomListPanel from "./components/RoomListPanel";
import CameraFocuser from "./components/CameraFocuser";
import RoomEditorPanel from "./components/RoomEditorPanel";
import DetectedBim3D from "./components/DetectedBim3D";
import BimInspectorOverlay from "./components/BimInspectorOverlay";
import MpObjects3D from "./components/MpObjects3D";
import MpShowcasePanel from "./components/MpShowcasePanel";

const POLL_MS = 7 * 1000;

export default function App() {
  /* ---------- server status ---------- */
  const [backendStatus, setBackendStatus] = useState("connecting"); // connecting|ready|processing|error
  const [modelInfo, setModelInfo] = useState(null);

  /* ---------- layer visibility -------- */
  const [showMesh, setShowMesh] = useState(false); // reserved, toggle removed from UI
  const [showCloud, setShowCloud] = useState(false);
  const [showTexture, setShowTexture] = useState(false);
  const [textureOpacity, setTextureOpacity] = useState(0.85);
  const [showFloorPlan, setShowFloorPlan] = useState(false);
  const [showFloorPlanViewer, setShowFloorPlanViewer] = useState(false);
  const [showBim3D, setShowBim3D] = useState(true);
  const [showMpEquip, setShowMpEquip] = useState(true);
  const [showMpSweeps, setShowMpSweeps] = useState(false);
  const [showMpShowcase, setShowMpShowcase] = useState(false);
  const [mpConfig, setMpConfig] = useState(null);
  const [mpPoints, setMpPoints] = useState([]);
  const [mpSweeps, setMpSweeps] = useState({});
  const [mpInstances, setMpInstances] = useState([]);
  const [mpInventory, setMpInventory] = useState([]);
  const [mpLabelFilter, setMpLabelFilter] = useState(null);
  const [selectedMpItem, setSelectedMpItem] = useState(null);
  const [hoveredMpItem, setHoveredMpItem] = useState(null);
  const [liveMpPose, setLiveMpPose] = useState(null);
  const [pendingMpCommand, setPendingMpCommand] = useState(null);
  const [fpvMode, setFpvMode] = useState(false);
  const [fpvRequest, setFpvRequest] = useState(null);
  const [selectedWall, setSelectedWall] = useState(null);
  const [hoveredWall, setHoveredWall] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [selectedOpening, setSelectedOpening] = useState(null);
  const [hoveredOpening, setHoveredOpening] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fpFloor, setFpFloor] = useState(0);
  const [activeFloor, setActiveFloor] = useState("all");

  /* ---------- theme ------------------- */
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("s2f_theme") || "dark";
    } catch {
      return "dark";
    }
  });
  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("s2f_theme", next);
      } catch { }
      return next;
    });
  };
  const isDark = theme === "dark";

  /* ---------- point cloud colors ---------- */
  const [cloudColors, setCloudColors] = useState(() => {
    try {
      const stored = localStorage.getItem("s2f_cloud_colors");
      return stored ? JSON.parse(stored) : { wall: "#f5f5f5", floor: "#2ed16b" };
    } catch {
      return { wall: "#f5f5f5", floor: "#2ed16b" };
    }
  });

  /* ---------- fpv panel width (resizable) --------- */
  const MIN_FPV_WIDTH = 560;
  const [fpvWidth, setFpvWidth] = useState(MIN_FPV_WIDTH);
  const fpvDragRef = useRef(null);

  const onFpvResizeStart = useCallback((e) => {
    e.preventDefault();
    fpvDragRef.current = { startX: e.clientX, startWidth: fpvWidth };
    const onMove = (ev) => {
      if (!fpvDragRef.current) return;
      // Dragging left = larger panel (panel is on the right side)
      const delta = fpvDragRef.current.startX - ev.clientX;
      const newW = Math.max(MIN_FPV_WIDTH, fpvDragRef.current.startWidth + delta);
      setFpvWidth(newW);
    };
    const onUp = () => {
      fpvDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [fpvWidth]);

  /* ---------- loading state ----------- */
  const [meshLoading, setMeshLoading] = useState(false);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [meshProgress, setMeshProgress] = useState(0);
  const [cloudPoints, setCloudPoints] = useState(null);

  /* ---------- cloud reload key --------- */
  // Bumped by Sidebar after a successful full reprocess so PointCloud
  // re-fetches the new pointcloud.bin with a cache-busting URL param.
  const [cloudReloadKey, setCloudReloadKey] = useState(null);
  const handleReprocessDone = () => setCloudReloadKey(String(Date.now()));

  /* ---------- floor-plan data version --------- */
  // Bumped whenever wall detection finishes so FloorPlanViewer re-fetches.
  const [floorDataVersion, setFloorDataVersion] = useState(0);
  const handleWallsDetected = () => setFloorDataVersion((v) => v + 1);

  /* ---------- room selection ----------- */
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [selectedRoomFloor, setSelectedRoomFloor] = useState(null);
  const [selectedRoomObj, setSelectedRoomObj] = useState(null);
  const [roomsData, setRoomsData] = useState(null);

  const handleSelectRoom = useCallback((roomId, floorIdx = null, roomObj = null) => {
    if (roomId == null) {
      setSelectedRoomId(null);
      setSelectedRoomFloor(null);
      setSelectedRoomObj(null);
    } else {
      setSelectedRoomId(roomId);
      if (floorIdx != null) setSelectedRoomFloor(floorIdx);
      if (roomObj != null) setSelectedRoomObj(roomObj);
    }
  }, []);

  /* ---------- room shape mode ---------- */
  // 'polygon' = new non-rectangular mode; 'rectangular' = legacy bbox-only mode
  const [roomMode, setRoomMode] = useState("polygon");

  /* ---------- loaded save -------------- */
  // null = live data; string = name of the loaded save being viewed
  const [loadedSave, setLoadedSave] = useState(null);

  /* ---------- 3D wall deletion ---------- */
  const handleDeleteWallFrom3D = useCallback(async (wall) => {
    if (!wall) return;
    try {
      const floorIdx = wall.floorIdx;
      const apiBase = loadedSave ? `/api/saves/${encodeURIComponent(loadedSave)}` : "/api";
      const res = await fetch(`${apiBase}/walls/${floorIdx}`);
      if (!res.ok) throw new Error("Failed to fetch walls");
      const data = await res.json();
      const currentLines = data.lines || [];

      // Filter out this wall (by index or proximity of endpoints)
      const filteredLines = currentLines.filter((seg, idx) => {
        if (idx === wall.wallIdx) return false;
        const [[x1, z1], [x2, z2]] = seg;
        const match1 = Math.hypot(x1 - wall.x1, z1 - wall.z1) < 0.04 && Math.hypot(x2 - wall.x2, z2 - wall.z2) < 0.04;
        const match2 = Math.hypot(x1 - wall.x2, z1 - wall.z2) < 0.04 && Math.hypot(x2 - wall.x1, z2 - wall.z1) < 0.04;
        return !(match1 || match2);
      });

      const putRes = await fetch(`${apiBase}/walls/${floorIdx}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: filteredLines,
          polygon_rooms: roomMode === "polygon",
        }),
      });
      if (!putRes.ok) throw new Error("Failed to save walls");

      setSelectedWall(null);
      handleWallsDetected();
    } catch (err) {
      console.error("Failed to delete wall from 3D:", err);
    }
  }, [loadedSave, roomMode]);

  /* ---------- Helper: match opening across 3D entity and backend JSON ---------- */
  const isSameOpening = (o, target, idx, floorIdx, listType) => {
    if (!o || !target) return false;
    // 1. Direct ID match
    if (o.id && target.id && o.id === target.id) return true;
    if (target.raw && (o === target.raw || (o.id && o.id === target.raw.id))) return true;

    // 2. Synthetic ID match (e.g. auto_0_1 or user_0_2)
    if (target.id && target.id === `${listType}_${floorIdx}_${idx}`) return true;

    // 3. World position coordinates matching
    const getPos = (item) => {
      let x = item.x;
      let z = item.z;
      if ((x == null || z == null) && item.wall_x1 != null && item.wall_x2 != null && typeof item.position_t === "number") {
        x = item.wall_x1 + item.position_t * (item.wall_x2 - item.wall_x1);
        z = item.wall_z1 + item.position_t * (item.wall_z2 - item.wall_z1);
      }
      return { x, z };
    };

    const oPos = getPos(o);
    const tPos = getPos(target);

    if (oPos.x != null && oPos.z != null && tPos.x != null && tPos.z != null) {
      if (Math.hypot(oPos.x - tPos.x, oPos.z - tPos.z) < 0.45) {
        if (!target.type || !o.type || target.type === o.type) return true;
      }
    }

    // 4. Wall matching: same wall_idx and matching position along wall
    const targetWall = target.wall_idx ?? target.wallIdx;
    if (o.wall_idx != null && targetWall != null && o.wall_idx === targetWall) {
      if (!target.type || !o.type || target.type === o.type) {
        if (typeof o.position_t === "number" && typeof target.position_t === "number") {
          if (Math.abs(o.position_t - target.position_t) < 0.20) return true;
        }
        if (o.wall_len && o.u_start != null && o.u_end != null && typeof target.position_t === "number") {
          const oT = (o.u_start + o.u_end) / (2 * o.wall_len);
          if (Math.abs(oT - target.position_t) < 0.20) return true;
        }
      }
    }

    return false;
  };

  /* ---------- 3D opening deletion ---------- */
  const handleDeleteOpeningFrom3D = useCallback(async (op) => {
    if (!op) return;
    try {
      const floorIdx = op.floorIdx ?? (activeFloor === "all" ? 0 : Number(activeFloor));
      const apiBase = loadedSave ? `/api/saves/${encodeURIComponent(loadedSave)}` : "/api";
      const res = await fetch(`${apiBase}/openings/${floorIdx}`);
      if (!res.ok) throw new Error("Failed to fetch openings");
      const data = await res.json();
      const userOps = data.user_openings || [];
      const autoOps = data.openings || [];

      // Filter out from user_openings and auto_detected openings
      const updatedUserOps = userOps.filter((o, idx) => !isSameOpening(o, op, idx, floorIdx, "user"));
      const updatedAutoOps = autoOps.filter((o, idx) => !isSameOpening(o, op, idx, floorIdx, "auto"));

      const putRes = await fetch(`${apiBase}/openings/${floorIdx}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_openings: updatedUserOps,
          openings: updatedAutoOps,
        }),
      });
      if (!putRes.ok) throw new Error("Failed to save openings");

      setSelectedOpening(null);
      handleWallsDetected();
    } catch (err) {
      console.error("Failed to delete opening from 3D:", err);
    }
  }, [loadedSave, activeFloor]);

  /* ---------- 3D opening update (size / position / margins) ---------- */
  const handleUpdateOpeningFrom3D = useCallback(async (updatedOp) => {
    if (!updatedOp) return;
    try {
      const floorIdx = updatedOp.floorIdx ?? (activeFloor === "all" ? 0 : Number(activeFloor));
      const apiBase = loadedSave ? `/api/saves/${encodeURIComponent(loadedSave)}` : "/api";
      const res = await fetch(`${apiBase}/openings/${floorIdx}`);
      if (!res.ok) throw new Error("Failed to fetch openings");
      const data = await res.json();
      const userOps = data.user_openings || [];
      const autoOps = data.openings || [];

      const patchOpeningObj = (o) => {
        const wall_x1 = updatedOp.wall_x1 ?? o.wall_x1;
        const wall_z1 = updatedOp.wall_z1 ?? o.wall_z1;
        const wall_x2 = updatedOp.wall_x2 ?? o.wall_x2;
        const wall_z2 = updatedOp.wall_z2 ?? o.wall_z2;
        const width = Number(updatedOp.width ?? updatedOp.width_m ?? o.width ?? o.width_m ?? 0.9);
        const position_t = typeof updatedOp.position_t === "number"
          ? updatedOp.position_t
          : (typeof o.position_t === "number" ? o.position_t : 0.5);

        let x = o.x;
        let z = o.z;
        let wall_len = o.wall_len;
        let u_start = o.u_start;
        let u_end = o.u_end;
        let hinge_x = o.hinge_x;
        let hinge_z = o.hinge_z;

        if (wall_x1 != null && wall_x2 != null && wall_z1 != null && wall_z2 != null) {
          const dx = wall_x2 - wall_x1;
          const dz = wall_z2 - wall_z1;
          const wl = Math.hypot(dx, dz);
          wall_len = wl;
          if (wl > 1e-4) {
            const ux = dx / wl;
            const uz = dz / wl;
            const midS = position_t * wl;
            x = wall_x1 + ux * midS;
            z = wall_z1 + uz * midS;
            u_start = Math.max(0, midS - width / 2);
            u_end = Math.min(wl, midS + width / 2);
            hinge_x = wall_x1 + ux * u_start;
            hinge_z = wall_z1 + uz * u_start;
          }
        } else if (updatedOp.x != null && updatedOp.z != null) {
          x = updatedOp.x;
          z = updatedOp.z;
        }

        return {
          ...o,
          width,
          width_m: width,
          position_t,
          top_margin: typeof updatedOp.top_margin === "number" ? updatedOp.top_margin : o.top_margin,
          bottom_margin: typeof updatedOp.bottom_margin === "number" ? updatedOp.bottom_margin : o.bottom_margin,
          x,
          z,
          wall_x1,
          wall_z1,
          wall_x2,
          wall_z2,
          wall_len,
          u_start,
          u_end,
          hinge_x,
          hinge_z,
        };
      };

      let userFound = false;
      let updatedUserOps = userOps.map((o, idx) => {
        if (isSameOpening(o, updatedOp, idx, floorIdx, "user")) {
          userFound = true;
          return patchOpeningObj(o);
        }
        return o;
      });

      let autoFound = false;
      let updatedAutoOps = autoOps.map((o, idx) => {
        if (isSameOpening(o, updatedOp, idx, floorIdx, "auto")) {
          autoFound = true;
          return patchOpeningObj(o);
        }
        return o;
      });

      if (!userFound && !autoFound) {
        if (updatedOp.isUser) {
          updatedUserOps = [...userOps, patchOpeningObj(updatedOp.raw ?? updatedOp)];
        } else {
          updatedAutoOps = [...autoOps, patchOpeningObj(updatedOp.raw ?? updatedOp)];
        }
      }

      const putRes = await fetch(`${apiBase}/openings/${floorIdx}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_openings: updatedUserOps,
          openings: updatedAutoOps,
        }),
      });
      if (!putRes.ok) throw new Error("Failed to save updated opening");

      handleWallsDetected();
    } catch (err) {
      console.error("Failed to update opening from 3D:", err);
    }
  }, [loadedSave, activeFloor]);

  // Fetch rooms for the active floor (defaulting to floor 0 when activeFloor is "all")
  useEffect(() => {
    const targetFloor = (activeFloor === "all" || activeFloor == null) ? 0 : activeFloor;
    let cancelled = false;
    const apiBase = loadedSave ? `/api/saves/${encodeURIComponent(loadedSave)}` : "/api";
    fetch(`${apiBase}/rooms/${targetFloor}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          const floorIdx = typeof d?.floor_idx === "number" ? d.floor_idx : targetFloor;
          const roomsWithFloor = (d?.rooms ?? []).map((rm) => ({ ...rm, floor_idx: floorIdx }));
          setRoomsData(d ? { ...d, rooms: roomsWithFloor, targetFloor } : null);
        }
      })
      .catch(() => {
        if (!cancelled) setRoomsData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFloor, floorDataVersion, loadedSave]);

  // Clear room selection only when user manually changes activeFloor to a different floor
  const prevActiveFloorRef = useRef(activeFloor);
  useEffect(() => {
    if (prevActiveFloorRef.current !== activeFloor) {
      prevActiveFloorRef.current = activeFloor;
      if (selectedRoomFloor != null && activeFloor !== "all" && activeFloor !== selectedRoomFloor) {
        handleSelectRoom(null);
      }
    }
  }, [activeFloor, selectedRoomFloor, handleSelectRoom]);

  // Derive the full room object for the currently selected room
  const highlightedRoom =
    selectedRoomObj ??
    (selectedRoomId != null
      ? (roomsData?.rooms ?? []).find((r) => r.id === selectedRoomId) ?? null
      : null);

  /* ---------- camera ref -------------- */
  const controlsRef = useRef(null);

  /* ---------- Matterport data fetch & actions ---------- */
  const refreshMpData = useCallback(() => {
    const qs = loadedSave ? `?save_name=${encodeURIComponent(loadedSave)}` : "";
    Promise.all([
      fetch(`/api/mp/config${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/mp/objects${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/mp/points${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/mp/inventory${qs}`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([cfg, obj, pts, inv]) => {
        if (cfg) setMpConfig(cfg);
        if (obj) {
          setMpSweeps(obj.sweeps || {});
          setMpInstances(obj.instances || []);
        }
        if (pts) setMpPoints(pts.points || []);
        if (inv) setMpInventory(inv.items || []);
      })
      .catch(() => {});
  }, [loadedSave]);

  useEffect(() => {
    refreshMpData();
  }, [refreshMpData, floorDataVersion]);

  const handleFocus3DPoint = useCallback((s2fPos) => {
    const ctrl = controlsRef.current;
    if (!ctrl || !s2fPos) return;
    setFpvMode(false);
    ctrl.target.set(s2fPos.x, s2fPos.y, s2fPos.z);
    if (ctrl.object) {
      ctrl.object.position.set(s2fPos.x + 4, s2fPos.y + 3.5, s2fPos.z + 4);
    }
    ctrl.update?.();
  }, []);

  const computeFpvForMpItem = useCallback((item) => {
    if (!item?.data) return null;
    const levels = modelInfo?.floor_levels ?? [];

    if (item.kind === "instance") {
      const target = item.data.s2f_position;
      if (!target) return null;

      // Pick highest-confidence observing sweep so camera stands inside room looking at object
      const obs = [...(item.data.observations || [])].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0)
      );
      const bestSid = obs[0]?.sweep_id || (item.data.sweep_ids || [])[0];
      const sw = bestSid ? mpSweeps[bestSid] : null;
      const swPos = sw?.s2f_position;

      let eyeX = target.x;
      let eyeZ = target.z + 1.6;
      if (swPos) {
        const dx = swPos.x - target.x;
        const dz = swPos.z - target.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.25) {
          const standDist = Math.min(Math.max(dist * 0.78, 1.4), 2.1);
          eyeX = target.x + (dx / dist) * standDist;
          eyeZ = target.z + (dz / dist) * standDist;
        }
      }

      const fIdx = item.data.floor_idx;
      const floorY =
        fIdx != null && levels[fIdx] != null
          ? levels[fIdx]
          : swPos?.y != null
          ? swPos.y - 1.55
          : target.y - 1.0;

      return {
        id: `${Date.now()}-${item.data.instance_id}`,
        eyePos: { x: eyeX, y: floorY + 1.58, z: eyeZ },
        lookAtPos: { x: target.x, y: target.y, z: target.z },
        lockFpv: true,
      };
    }

    if (item.kind === "point" || item.kind === "sweep") {
      const p = item.data.s2f_position;
      if (!p) return null;
      const yawDeg = Number(item.data.rotation?.y ?? 0);
      const pitchDeg = Number(item.data.rotation?.x ?? 0);
      const yawRad = (yawDeg * Math.PI) / 180;
      const pitchRad = (pitchDeg * Math.PI) / 180;
      const cp = Math.cos(pitchRad);
      const dx = -Math.sin(yawRad) * cp;
      const dy = Math.sin(pitchRad);
      const dz = -Math.cos(yawRad) * cp;

      return {
        id: `${Date.now()}-${item.data.id || item.data.sweep_id}`,
        eyePos: { x: p.x, y: p.y, z: p.z },
        lookAtPos: { x: p.x + dx * 2.5, y: p.y + dy * 2.5, z: p.z + dz * 2.5 },
        lockFpv: true,
      };
    }

    return null;
  }, [modelInfo, mpSweeps]);

  const handleEnterFpv = useCallback((item) => {
    if (!item?.data) return;
    setSelectedMpItem(item);
    setSelectedWall(null);
    setSelectedOpening(null);

    if (item.data.floor_idx != null && activeFloor !== "all" && Number(activeFloor) !== item.data.floor_idx) {
      setActiveFloor(item.data.floor_idx);
    }
    if (!showBim3D && !showTexture && !showCloud) {
      setShowBim3D(true);
    }

    const req = computeFpvForMpItem(item);
    if (req) {
      setFpvMode(true);
      setFpvRequest(req);
    }
  }, [activeFloor, computeFpvForMpItem, showBim3D, showTexture, showCloud]);

  const handleCycleFpvItem = useCallback((delta) => {
    const floorNum = activeFloor === "all" ? null : Number(activeFloor);
    const activeLabel =
      selectedMpItem?.kind === "instance" ? selectedMpItem.data?.label : "dvere";
    const pool = mpInstances.filter(
      (i) => i.label === activeLabel && (floorNum === null || i.floor_idx === floorNum)
    );
    if (!pool.length) return;
    const curIdx =
      selectedMpItem?.kind === "instance"
        ? pool.findIndex((i) => i.instance_id === selectedMpItem.data?.instance_id)
        : -1;
    const nextIdx = curIdx < 0 ? 0 : (curIdx + delta + pool.length) % pool.length;
    handleEnterFpv({ kind: "instance", data: pool[nextIdx] });
  }, [activeFloor, mpInstances, selectedMpItem, handleEnterFpv]);

  const handleJumpToMpItem = useCallback(async (item) => {
    if (!item?.data) return;
    setShowMpShowcase(true);
    const qs = loadedSave ? `?save_name=${encodeURIComponent(loadedSave)}` : "";
    if (item.kind === "instance") {
      const res = await fetch(`/api/mp/goto-instance/${item.data.instance_id}${qs}`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setPendingMpCommand(data);
      }
    } else if (item.kind === "point") {
      const res = await fetch(`/api/mp/points/${item.data.id}/go${qs}`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setPendingMpCommand(data);
      }
    } else if (item.kind === "sweep") {
      const cmd = { sweep_id: item.data.sweep_id, position: item.data.position };
      await fetch(`/api/mp/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
      setPendingMpCommand(cmd);
    }
  }, [loadedSave]);

  const handleSaveMpAsPoint = useCallback(async (inst) => {
    if (!inst?.anchor) return;
    await fetch(`/api/mp/points`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: inst.instance_id || inst.label,
        note: `Saved from 3D Inspector (${inst.label})`,
        position: inst.anchor,
        sweep_id: (inst.sweep_ids || [])[0] || null,
        floor: inst.floor,
      }),
    });
    refreshMpData();
  }, [refreshMpData]);

  const handleDeleteMpPoint = useCallback(async (pointId) => {
    await fetch(`/api/mp/points/${pointId}`, { method: "DELETE" });
    setSelectedMpItem(null);
    refreshMpData();
  }, [refreshMpData]);

  /* ---------- poll server status ------ */
  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("bad status");
      const data = await res.json();
      setBackendStatus(data.status); // "idle" | "processing" | "ready"
      if (data.info) setModelInfo(data.info);
    } catch {
      setBackendStatus("error");
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const id = setInterval(checkStatus, POLL_MS);
    return () => clearInterval(id);
  }, [checkStatus]);

  const anyLoading = meshLoading || cloudLoading;
  const loadingLabel = meshLoading
    ? `Loading 3D Mesh (${meshProgress}%)`
    : "Streaming Point Cloud…";

  return (
    <div className="app" data-theme={theme}>
      {/* Top navigation bar */}
      <header className="topbar">
        <div className="logo-group">
          <span className="logo-icon">◈</span>
          <span className="logo-text">Scan2Floor</span>
          <span className="logo-tag">BIM</span>
        </div>

        <div className="topbar-spacer" />

        {/* Theme toggle */}
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={isDark ? "Switch to Light theme" : "Switch to Dark theme"}
        >
          <span>{isDark ? "☀" : "🌙"}</span>
        </button>

        {/* Backend status pill */}
        <div className={`status-pill status-${backendStatus}`}>
          <span className="status-dot" />
          <span className="status-label">
            {backendStatus === "ready" && "Connected"}
            {backendStatus === "idle" && "Idle (No Data)"}
            {backendStatus === "processing" && "Processing…"}
            {backendStatus === "error" && "Offline"}
            {backendStatus === "connecting" && "Connecting…"}
          </span>
        </div>
      </header>

      {/* Main layout */}
      <div className="workspace">
        {/* Left sidebar */}
        <Sidebar
          backendStatus={backendStatus}
          modelInfo={modelInfo}
          showMesh={showMesh}
          setShowMesh={setShowMesh}
          showTexture={showTexture}
          setShowTexture={setShowTexture}
          textureOpacity={textureOpacity}
          setTextureOpacity={setTextureOpacity}
          showCloud={showCloud}
          setShowCloud={setShowCloud}
          showFloorPlan={showFloorPlan}
          setShowFloorPlan={setShowFloorPlan}
          showFloorPlanViewer={showFloorPlanViewer}
          setShowFloorPlanViewer={setShowFloorPlanViewer}
          showBim3D={showBim3D}
          setShowBim3D={setShowBim3D}
          showMpEquip={showMpEquip}
          setShowMpEquip={setShowMpEquip}
          showMpSweeps={showMpSweeps}
          setShowMpSweeps={setShowMpSweeps}
          showMpShowcase={showMpShowcase}
          setShowMpShowcase={setShowMpShowcase}
          mpStats={{
            instances: mpInstances.length,
            sweeps: Object.keys(mpSweeps).length,
            points: mpPoints.length,
          }}
          className={sidebarCollapsed ? "collapsed" : ""}
          cloudPoints={cloudPoints}
          onReprocessDone={handleReprocessDone}
          onWallsDetected={handleWallsDetected}
          onRefreshStatus={checkStatus}
          activeFloor={activeFloor}
          setActiveFloor={setActiveFloor}
          roomMode={roomMode}
          setRoomMode={setRoomMode}
          onLoadSave={setLoadedSave}
          cloudColors={cloudColors}
          setCloudColors={setCloudColors}
        />

        {/* Sidebar toggle tab */}
        <button
          className={`sidebar-toggle-tab${sidebarCollapsed ? " collapsed" : ""}`}
          style={{ left: sidebarCollapsed ? 0 : "var(--sidebar-w)", transition: "left 0.2s cubic-bezier(0.4,0,0.2,1), color 0.15s, border-color 0.15s, background 0.15s" }}
          onClick={() => setSidebarCollapsed(v => !v)}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <span className="toggle-arrow">‹</span>
        </button>

        <div className="viewport">
          {/* Three.js canvas */}
          <div className="canvas-wrap">
            <Canvas
              camera={{ position: [30, 15, 30], fov: 50, near: 0.1, far: 2000 }}
              gl={{ antialias: true, localClippingEnabled: true }}
              onPointerMissed={() => {
                setSelectedWall(null);
                setSelectedMpItem(null);
              }}
            >
              <color attach="background" args={[isDark ? "#0f0f0f" : "#f5f5f5"]} />
              <ambientLight intensity={isDark ? 0.6 : 0.8} />
              <directionalLight
                position={[20, 30, 10]}
                intensity={1}
                castShadow
              />
              <directionalLight position={[-20, 10, -10]} intensity={0.4} />

              <Grid
                args={[200, 200]}
                position={[0, -0.05, 0]}
                cellColor={isDark ? "#1f1f1f" : "#e5e5e5"}
                sectionColor={isDark ? "#333333" : "#cccccc"}
                sectionSize={10}
                fadeDistance={120}
                infiniteGrid
              />

              <Suspense fallback={null}>
                {showMesh && (
                  <OBJModel
                    modelInfo={modelInfo}
                    activeFloor={activeFloor}
                    onLoadStart={() => {
                      setMeshLoading(true);
                      setMeshProgress(0);
                    }}
                    onProgress={(p) => setMeshProgress(p)}
                    onLoaded={() => setMeshLoading(false)}
                  />
                )}
                {showTexture && (
                  <TexturedMesh
                    modelInfo={modelInfo}
                    activeFloor={activeFloor}
                    opacity={textureOpacity}
                    onLoadStart={() => {
                      setMeshLoading(true);
                      setMeshProgress(0);
                    }}
                    onProgress={(p) => setMeshProgress(p)}
                    onLoaded={() => setMeshLoading(false)}
                  />
                )}
                {showCloud && backendStatus === "ready" && (
                  <PointCloud
                    modelInfo={modelInfo}
                    activeFloor={activeFloor}
                    reloadKey={cloudReloadKey}
                    highlightedRoom={highlightedRoom}
                    wallColor={cloudColors.wall}
                    floorColor={cloudColors.floor}
                    onLoadStart={() => setCloudLoading(true)}
                    onLoaded={(n) => {
                      setCloudLoading(false);
                      setCloudPoints(n);
                    }}
                  />
                )}
                {showBim3D && (
                  <DetectedBim3D
                    modelInfo={modelInfo}
                    activeFloor={activeFloor}
                    dataVersion={floorDataVersion}
                    loadedSave={loadedSave}
                    selectedRoomId={selectedRoomId}
                    onSelectRoom={handleSelectRoom}
                    selectedWall={selectedWall}
                    onSelectWall={(w) => {
                      setSelectedWall(w);
                      if (w) setSelectedOpening(null);
                    }}
                    hoveredWall={hoveredWall}
                    setHoveredWall={setHoveredWall}
                    hoveredRoom={hoveredRoom}
                    setHoveredRoom={setHoveredRoom}
                    selectedOpening={selectedOpening}
                    onSelectOpening={(op) => {
                      setSelectedOpening(op);
                      if (op) setSelectedWall(null);
                    }}
                    hoveredOpening={hoveredOpening}
                    setHoveredOpening={setHoveredOpening}
                  />
                )}
                <MpObjects3D
                  instances={mpInstances}
                  points={mpPoints}
                  sweeps={mpSweeps}
                  activeFloor={activeFloor}
                  showEquipment={showMpEquip}
                  showSweeps={showMpSweeps}
                  labelFilter={mpLabelFilter}
                  livePose={liveMpPose}
                  selectedMpItem={selectedMpItem}
                  hoveredMpItem={hoveredMpItem}
                  onSelectMpItem={(item) => {
                    setSelectedMpItem(item);
                    if (item) {
                      setSelectedWall(null);
                      setSelectedOpening(null);
                    }
                  }}
                  onHoverMpItem={setHoveredMpItem}
                />
              </Suspense>

              <OrbitControls
                ref={controlsRef}
                makeDefault
                enableDamping
                dampingFactor={0.08}
                minDistance={0.05}
                maxDistance={500}
              />

              {/* 3D camera focus on selected room & First-Person View */}
              <CameraFocuser
                highlightedRoom={highlightedRoom}
                modelInfo={modelInfo}
                controlsRef={controlsRef}
                activeFloor={activeFloor}
                fpvRequest={fpvRequest}
                fpvMode={fpvMode}
              />

              <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
                <GizmoViewport labelColor={isDark ? "white" : "#222222"} axisHeadScale={1} />
              </GizmoHelper>
            </Canvas>
          </div>

          {/* 3D BIM Inspector Overlay */}
          <BimInspectorOverlay
            selectedWall={selectedWall}
            onCloseWall={() => setSelectedWall(null)}
            onDeleteWall={handleDeleteWallFrom3D}
            hoveredWall={hoveredWall}
            hoveredRoom={hoveredRoom}
            selectedOpening={selectedOpening}
            onCloseOpening={() => setSelectedOpening(null)}
            onDeleteOpening={handleDeleteOpeningFrom3D}
            hoveredOpening={hoveredOpening}
            onUpdateOpening={handleUpdateOpeningFrom3D}
            selectedMpItem={selectedMpItem}
            onCloseMpItem={() => setSelectedMpItem(null)}
            hoveredMpItem={hoveredMpItem}
            onJumpToMpItem={handleJumpToMpItem}
            onEnterFpv={handleEnterFpv}
            onDeleteMpPoint={handleDeleteMpPoint}
            onSaveMpAsPoint={handleSaveMpAsPoint}
          />

          {/* Floating First-Person View (FPV) & Layer Switcher HUD */}
          <div style={{
            position: "absolute",
            top: loadedSave ? 48 : 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 18,
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            justifyContent: "center",
            background: "rgba(var(--panel-rgb, 17,24,39), 0.9)",
            backdropFilter: "blur(12px)",
            border: fpvMode ? "1px solid rgba(56,189,248,0.55)" : "1px solid var(--border-hi, rgba(255,255,255,0.14))",
            borderRadius: 999,
            padding: "5px 10px",
            boxShadow: "0 4px 18px rgba(0,0,0,0.32)",
            fontFamily: "Inter, sans-serif",
            fontSize: 11.5,
          }}>
            {!fpvMode ? (
              <>
                <button
                  onClick={() => {
                    if (selectedMpItem) handleEnterFpv(selectedMpItem);
                    else setFpvMode(true);
                  }}
                  style={{
                    background: "rgba(56,189,248,0.18)",
                    border: "1px solid rgba(56,189,248,0.42)",
                    borderRadius: 999,
                    color: "#38bdf8",
                    fontWeight: 700,
                    fontSize: 11.5,
                    padding: "4px 10px",
                    cursor: "pointer",
                  }}
                  title="Walk/Look around at eye level (WASD + Mouse drag)"
                >
                  👁 First-Person View
                </button>
                <button
                  onClick={() => handleCycleFpvItem(1)}
                  disabled={!mpInstances.some((i) => i.label === "dvere")}
                  style={{
                    background: "rgba(34,197,94,0.15)",
                    border: "1px solid rgba(34,197,94,0.38)",
                    borderRadius: 999,
                    color: "#4ade80",
                    fontWeight: 700,
                    fontSize: 11.5,
                    padding: "4px 10px",
                    cursor: "pointer",
                  }}
                  title="Jump directly to a door in First-Person View"
                >
                  🚪 Inspect Doors
                </button>
                <button
                  onClick={() => setShowMpShowcase((v) => !v)}
                  style={{
                    background: showMpShowcase ? "rgba(168,85,247,0.2)" : "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 999,
                    color: showMpShowcase ? "#c084fc" : "var(--text-1, #e5e7eb)",
                    fontWeight: 600,
                    fontSize: 11.5,
                    padding: "4px 10px",
                    cursor: "pointer",
                  }}
                >
                  🌐 Equipment & 360°
                </button>
              </>
            ) : (
              <>
                <span style={{ color: "#38bdf8", fontWeight: 700, paddingLeft: 4 }}>
                  👁 FPV {selectedMpItem?.data?.instance_id || selectedMpItem?.data?.name || "Free Walk"}
                </span>
                <button
                  onClick={() => handleCycleFpvItem(-1)}
                  style={{
                    background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 999, color: "var(--text-1, #e5e7eb)", padding: "3px 8px",
                    fontSize: 11, cursor: "pointer",
                  }}
                  title="Previous item in class"
                >
                  ◀ Prev
                </button>
                {selectedMpItem && (
                  <button
                    onClick={() => handleEnterFpv(selectedMpItem)}
                    style={{
                      background: "rgba(56,189,248,0.16)", border: "1px solid rgba(56,189,248,0.35)",
                      borderRadius: 999, color: "#38bdf8", padding: "3px 8px",
                      fontSize: 11, cursor: "pointer", fontWeight: 600,
                    }}
                    title="Re-aim camera straight at selected object"
                  >
                    🎯 Re-Aim
                  </button>
                )}
                <button
                  onClick={() => handleCycleFpvItem(1)}
                  style={{
                    background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 999, color: "var(--text-1, #e5e7eb)", padding: "3px 8px",
                    fontSize: 11, cursor: "pointer",
                  }}
                  title="Next item in class"
                >
                  Next ▶
                </button>
                <span style={{ opacity: 0.35 }}>|</span>
                <button
                  onClick={() => setShowBim3D((v) => !v)}
                  style={{
                    background: showBim3D ? "rgba(56,189,248,0.22)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${showBim3D ? "rgba(56,189,248,0.45)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 999, color: showBim3D ? "#38bdf8" : "var(--text-3, #9ca3af)",
                    padding: "3px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                  title="Toggle 3D BIM Walls & Slabs"
                >
                  🏛️ BIM
                </button>
                <button
                  onClick={() => {
                    setShowTexture((v) => {
                      const next = !v;
                      if (next && textureOpacity < 0.9) setTextureOpacity(1.0);
                      return next;
                    });
                  }}
                  style={{
                    background: showTexture ? "rgba(251,191,36,0.22)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${showTexture ? "rgba(251,191,36,0.45)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 999, color: showTexture ? "#fbbf24" : "var(--text-3, #9ca3af)",
                    padding: "3px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                  title="Toggle Photo Texture Mesh Layer"
                >
                  📷 Photo
                </button>
                <button
                  onClick={() => setShowCloud((v) => !v)}
                  style={{
                    background: showCloud ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${showCloud ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 999, color: showCloud ? "#4ade80" : "var(--text-3, #9ca3af)",
                    padding: "3px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                  title="Toggle Point Cloud"
                >
                  ✦ Cloud
                </button>
                <button
                  onClick={() => setShowMpEquip((v) => !v)}
                  style={{
                    background: showMpEquip ? "rgba(168,85,247,0.2)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${showMpEquip ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 999, color: showMpEquip ? "#c084fc" : "var(--text-3, #9ca3af)",
                    padding: "3px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                  title="Toggle Equipment Markers"
                >
                  📦 Markers
                </button>
                <span style={{ fontSize: 10, color: "var(--text-3, #9ca3af)" }} title="Controls">
                  WASD Walk · Drag Look · Scroll Step
                </span>
                <button
                  onClick={() => setFpvMode(false)}
                  style={{
                    background: "rgba(239,68,68,0.18)", border: "1px solid rgba(239,68,68,0.4)",
                    borderRadius: 999, color: "#f87171", padding: "3px 9px",
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}
                >
                  ✕ Exit FPV
                </button>
              </>
            )}
          </div>

          {/* Loading overlay */}
          {anyLoading && (
            <LoadingOverlay
              label={loadingLabel}
              progress={meshLoading ? meshProgress : null}
            />
          )}

          {/* Saved-output banner */}
          {loadedSave && (
            <div style={{
              position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
              zIndex: 10, display: "flex", alignItems: "center", gap: 8,
              background: "var(--surface-2)",
              border: "1px solid var(--border-hi)", borderRadius: 8,
              padding: "6px 14px", fontSize: 12, fontWeight: 700,
              color: "var(--text-1)", fontFamily: "Inter, sans-serif",
              boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
            }}>
              <span>💾 Viewing saved output:</span>
              <span style={{ color: "var(--accent)" }}>{loadedSave}</span>
              <button
                onClick={() => setLoadedSave(null)}
                title="Return to live data"
                style={{
                  marginLeft: 4, background: "var(--surface-3)",
                  border: "1px solid var(--border)",
                  borderRadius: 5, color: "var(--text-2)", fontSize: 11,
                  padding: "2px 7px", cursor: "pointer",
                }}
              >✕ Live</button>
            </div>
          )}

          {/* Processing banner — only when a job is actively running */}
          {backendStatus === "processing" && (
            <div className="processing-banner">
              ⏳ Point cloud is being preprocessed — check back shortly
            </div>
          )}

          {/* Idle banner — no data yet, nothing running */}
          {backendStatus === "idle" && (
            <div className="processing-banner" style={{
              background: "var(--surface-2)",
              borderColor: "var(--border)",
              color: "var(--text-2)",
            }}>
              📂 No point cloud loaded — select a .xyz file in the sidebar and click <strong>Rerun Full Preprocess Pipeline</strong>
            </div>
          )}

          {/* Corner metric */}
          {modelInfo && (
            <div className="corner-info">
              {modelInfo.n_points?.toLocaleString()} pts &nbsp;·&nbsp;
              {modelInfo.wall_slices_ready ? (
                <span style={{ color: "var(--green)" }}>✓ dense slices</span>
              ) : modelInfo.preprocess_walls_running ? (
                <span style={{ color: "var(--sel)" }}>⏳ extracting…</span>
              ) : (
                <span style={{ color: "var(--sel)" }}>⚠ 1:100 sparse</span>
              )}
            </div>
          )}

          {/* Room list panel — shown when FloorPlanViewer is active */}
          {/* {showFloorPlanViewer && (
            <RoomListPanel
              floor={activeFloor === "all" ? 0 : activeFloor}
              dataVersion={floorDataVersion}
              selectedRoomId={selectedRoomId}
              onSelectRoom={setSelectedRoomId}
              saveName={loadedSave}
            />
          )} */}

          {/* Floor plan panel (Matterport image) */}
          {showFloorPlan && (
            <FloorPlanPanel floor={fpFloor} setFloor={setFpFloor} />
          )}
        </div>

        {/* Phase 4: 2D Vector Floor Plan Viewer */}
        {showFloorPlanViewer && (
          <div className="fpv-panel" style={{ width: fpvWidth, position: "relative" }}>
            {/* Drag handle on left edge */}
            <div
              className="fpv-resize-handle"
              onMouseDown={onFpvResizeStart}
              title="Drag to resize panel"
            />
            <FloorPlanViewer
              modelInfo={modelInfo}
              dataVersion={floorDataVersion}
              onClose={() => setShowFloorPlanViewer(false)}
              highlightedRoomId={selectedRoomId}
              onSelectRoom={handleSelectRoom}
              onSelectFloor={setActiveFloor}
              activeFloor={activeFloor}
              roomMode={roomMode}
              saveName={loadedSave}
              onWallsSaved={handleWallsDetected}
              mpInstances={mpInstances}
              mpSweeps={mpSweeps}
              mpPoints={mpPoints}
              livePose={liveMpPose}
              selectedMpItem={selectedMpItem}
              onSelectMpItem={(item) => {
                setSelectedMpItem(item);
                if (item) {
                  setSelectedWall(null);
                  setSelectedOpening(null);
                }
              }}
            />
          </div>
        )}

        {/* Phase 3: Dockable 360° Matterport Showcase + Inventory + Guided Tour */}
        {showMpShowcase && (
          <div style={{ width: 420, height: "100%", flexShrink: 0 }}>
            <MpShowcasePanel
              apiBase="/api"
              mpConfig={mpConfig}
              points={mpPoints}
              sweeps={mpSweeps}
              instances={mpInstances}
              inventory={mpInventory}
              activeFloor={activeFloor}
              saveName={loadedSave}
              livePose={liveMpPose}
              onPoseUpdate={setLiveMpPose}
              onDataChanged={refreshMpData}
              onFocus3D={handleFocus3DPoint}
              onEnterFpv={handleEnterFpv}
              onSelectMpItem={(item) => {
                setSelectedMpItem(item);
                if (item) {
                  setSelectedWall(null);
                  setSelectedOpening(null);
                }
              }}
              labelFilter={mpLabelFilter}
              setLabelFilter={setMpLabelFilter}
              pendingCommand={pendingMpCommand}
              onCommandConsumed={() => setPendingMpCommand(null)}
              onClose={() => setShowMpShowcase(false)}
            />
          </div>
        )}

        {/* Room Editor Panel — isolated room editor modal, floating over viewport & vector floor plan */}
        {selectedRoomId != null && highlightedRoom && (
          <RoomEditorPanel
            room={highlightedRoom}
            floor={selectedRoomFloor ?? (highlightedRoom?.floor_idx ?? (activeFloor === "all" ? 0 : activeFloor))}
            modelInfo={modelInfo}
            saveName={loadedSave}
            onClose={() => handleSelectRoom(null)}
            onWallsChanged={handleWallsDetected}
            mpInstances={mpInstances}
          />
        )}
      </div>
    </div>
  );
}
