import { Suspense, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
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
import HomePage from "./components/HomePage";
import LayersPanel from "./components/LayersPanel";
import RedetectDrawer from "./components/RedetectDrawer";
import SaveOutput from "./components/SaveOutput";
import MiniPlan from "./components/MiniPlan";
import { loadAlgoParams, persistAlgoParams } from "./algoParams";

const POLL_MS = 7 * 1000;

const VIEW_DEFS = [
  { id: "3d", label: "3D Viewer", key: "1" },
  { id: "360", label: "360° Showcase", key: "2" },
  { id: "2d", label: "2D Vector Plan", key: "3" },
  { id: "plans", label: "Matterport Plans", key: "4" },
];

export default function App() {
  /* ---------- server status ---------- */
  const [backendStatus, setBackendStatus] = useState("connecting"); // connecting|ready|processing|error
  const [modelInfo, setModelInfo] = useState(null);

  /* ---------- layer visibility -------- */
  const [showMesh] = useState(false); // reserved, toggle removed from UI
  const [showCloud, setShowCloud] = useState(false);
  const [showTexture, setShowTexture] = useState(false);
  const [textureOpacity, setTextureOpacity] = useState(0.85);
  const [showBim3D, setShowBim3D] = useState(true);
  const [bimFilters, setBimFilters] = useState({ walls: true, rooms: true, doors: true, windows: true });
  const [showMpEquip, setShowMpEquip] = useState(true);
  const [showMpSweeps, setShowMpSweeps] = useState(false);
  const [showMpPoints, setShowMpPoints] = useState(true);
  const [showMpLive, setShowMpLive] = useState(true);
  const [hiddenMpLabels, setHiddenMpLabels] = useState([]);
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
  const fpvPoseStore = useMemo(() => {
    const listeners = new Set();
    return {
      current: null,
      set(pose) {
        this.current = pose;
        listeners.forEach((fn) => fn(pose));
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }, []);
  const [selectedWall, setSelectedWall] = useState(null);
  const [hoveredWall, setHoveredWall] = useState(null);
  const [hoveredRoom, setHoveredRoom] = useState(null);
  const [selectedOpening, setSelectedOpening] = useState(null);
  const [hoveredOpening, setHoveredOpening] = useState(null);
  const [fpFloor, setFpFloor] = useState(0);
  const [activeFloor, setActiveFloor] = useState(0);

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
      } catch { /* ignore */ }
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
  const [saveInfo, setSaveInfo] = useState(null);
  const [sourceName, setSourceName] = useState("output");

  /* ---------- app stage & workspace layout ---------- */
  const [stage, setStage] = useState("home"); // "home" | "workspace"
  const [sessionKey, setSessionKey] = useState(0);
  const [layout, setLayout] = useState("single"); // "single" | "split" | "all"
  const [slots, setSlots] = useState(["3d", "2d"]); // [primary, secondary] views
  const [visited, setVisited] = useState(() => new Set(["3d"]));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMpAiHints, setShowMpAiHints] = useState(true);
  const [showAlgo, setShowAlgo] = useState(false);
  const [algoParams, setAlgoParams] = useState(loadAlgoParams);
  const rootRef = useRef(null);

  const visibleViews =
    layout === "single" ? [slots[0]] : layout === "split" ? [slots[0], slots[1]] : ["3d", "360", "2d"];
  const visibleKey = visibleViews.join(",");

  /** Make sure a view is on screen (used when an action in one view targets another). */
  const revealView = useCallback((v) => {
    if (layout === "all" && v !== "plans") return;
    setSlots((prev) => {
      if (layout === "single") return [v, prev[1] === v ? prev[0] : prev[1]];
      if (prev.includes(v)) return prev;
      return [prev[0], v];
    });
    if (layout === "all") setLayout("single");
  }, [layout]);

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
      const currentThicknesses = Array.isArray(data.thicknesses) ? data.thicknesses : null;

      // Filter out this wall (by index or proximity of endpoints) while keeping thicknesses aligned
      const filteredLines = [];
      const filteredThicknesses = currentThicknesses ? [] : null;
      currentLines.forEach((seg, idx) => {
        const [[x1, z1], [x2, z2]] = seg;
        const match1 = Math.hypot(x1 - wall.x1, z1 - wall.z1) < 0.04 && Math.hypot(x2 - wall.x2, z2 - wall.z2) < 0.04;
        const match2 = Math.hypot(x1 - wall.x2, z1 - wall.z2) < 0.04 && Math.hypot(x2 - wall.x1, z2 - wall.z1) < 0.04;
        if (idx === wall.wallIdx || match1 || match2) return;
        filteredLines.push(seg);
        if (filteredThicknesses) {
          const tv = Number(currentThicknesses[idx]);
          filteredThicknesses.push(Number.isFinite(tv) && tv > 0.02 ? tv : 0.20);
        }
      });

      const putBody = {
        lines: filteredLines,
        polygon_rooms: roomMode === "polygon",
      };
      if (filteredThicknesses) putBody.thicknesses = filteredThicknesses;

      const putRes = await fetch(`${apiBase}/walls/${floorIdx}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
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

  // Clear room and equipment selection when user changes activeFloor
  const prevActiveFloorRef = useRef(activeFloor);
  useEffect(() => {
    if (prevActiveFloorRef.current !== activeFloor) {
      prevActiveFloorRef.current = activeFloor;
      if (selectedRoomFloor != null && activeFloor !== "all" && activeFloor !== selectedRoomFloor) {
        handleSelectRoom(null);
      }
      setSelectedMpItem((prev) => {
        if (
          prev?.data?.floor_idx != null &&
          (activeFloor === "all" || Number(activeFloor) !== Number(prev.data.floor_idx))
        ) {
          return null;
        }
        return prev;
      });
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
      revealView("3d");
    }
  }, [activeFloor, computeFpvForMpItem, showBim3D, showTexture, showCloud, revealView]);

  const handleDropToFloorEyeLevel = useCallback(() => {
    const floorIdx = activeFloor === "all" || activeFloor == null ? 0 : Number(activeFloor);
    const levels = modelInfo?.floor_levels ?? [];
    const floorY = levels.length > floorIdx && levels[floorIdx] != null ? Number(levels[floorIdx]) : floorIdx * 2.8;
    const nextFloorY = levels.length > floorIdx + 1 && levels[floorIdx + 1] != null ? Number(levels[floorIdx + 1]) : floorY + 2.8;
    const storeyH = Math.max(2.2, nextFloorY - floorY);
    const eyeY = floorY + Math.min(1.58, storeyH * 0.58);

    const ctrl = controlsRef.current;
    const cam = ctrl?.object;
    const b = modelInfo?.bounds;

    let eyeX = 0;
    let eyeZ = 0;
    let dirX = 0;
    let dirZ = -1;

    if (cam && ctrl) {
      const dx = ctrl.target.x - cam.position.x;
      const dz = ctrl.target.z - cam.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        dirX = dx / d;
        dirZ = dz / d;
      }
    }

    const inHeightBand = cam && cam.position.y >= floorY + 0.3 && cam.position.y <= floorY + storeyH - 0.1;
    const inBoundsXZ = cam && (!b || (
      cam.position.x >= b.x_min - 2 && cam.position.x <= b.x_max + 2 &&
      cam.position.z >= b.z_min - 2 && cam.position.z <= b.z_max + 2
    ));

    if (highlightedRoom) {
      const rb = highlightedRoom.bbox;
      eyeX = typeof highlightedRoom.centroid_x === "number" && !Number.isNaN(highlightedRoom.centroid_x)
        ? highlightedRoom.centroid_x
        : rb ? (rb.x_min + rb.x_max) / 2 : 0;
      eyeZ = typeof highlightedRoom.centroid_z === "number" && !Number.isNaN(highlightedRoom.centroid_z)
        ? highlightedRoom.centroid_z
        : rb ? (rb.z_min + rb.z_max) / 2 : 0;
    } else if (inHeightBand && inBoundsXZ) {
      eyeX = cam.position.x;
      eyeZ = cam.position.z;
    } else {
      const floorSweep = Object.values(mpSweeps || {}).find(
        (sw) => sw?.s2f_position && (sw.floor_idx == null || Number(sw.floor_idx) === floorIdx)
      );
      const floorRoom = (roomsData?.rooms ?? []).find((rm) => rm?.centroid_x != null && rm?.centroid_z != null);
      if (floorSweep) {
        eyeX = floorSweep.s2f_position.x;
        eyeZ = floorSweep.s2f_position.z;
      } else if (floorRoom) {
        eyeX = floorRoom.centroid_x;
        eyeZ = floorRoom.centroid_z;
      } else if (ctrl) {
        eyeX = ctrl.target.x;
        eyeZ = ctrl.target.z;
        if (b) {
          const padX = Math.min(1.0, (b.x_max - b.x_min) * 0.15);
          const padZ = Math.min(1.0, (b.z_max - b.z_min) * 0.15);
          eyeX = Math.max(b.x_min + padX, Math.min(b.x_max - padX, eyeX));
          eyeZ = Math.max(b.z_min + padZ, Math.min(b.z_max - padZ, eyeZ));
        }
      }
    }

    if (!showBim3D && !showTexture && !showCloud) {
      setShowBim3D(true);
    }
    setFpvMode(true);
    setFpvRequest({
      id: `eye-${Date.now()}`,
      eyePos: { x: eyeX, y: eyeY, z: eyeZ },
      lookAtPos: { x: eyeX + dirX * 2.5, y: eyeY, z: eyeZ + dirZ * 2.5 },
      lockFpv: true,
    });
  }, [activeFloor, modelInfo, highlightedRoom, mpSweeps, roomsData, showBim3D, showTexture, showCloud]);

  const handleCycleFpvItem = useCallback((delta) => {
    const floorNum = activeFloor === "all" ? null : Number(activeFloor);
    const activeLabel =
      selectedMpItem?.kind === "instance" ? selectedMpItem.data?.label : "dvere";
    const pool = mpInstances.filter(
      (i) =>
        i.label === activeLabel &&
        (floorNum === null || i.floor_idx === floorNum) &&
        (!hiddenMpLabels.includes(i.label) ||
          (selectedMpItem?.kind === "instance" && selectedMpItem.data?.label === i.label))
    );
    if (!pool.length) return;
    const curIdx =
      selectedMpItem?.kind === "instance"
        ? pool.findIndex((i) => i.instance_id === selectedMpItem.data?.instance_id)
        : -1;
    const nextIdx = curIdx < 0 ? 0 : (curIdx + delta + pool.length) % pool.length;
    handleEnterFpv({ kind: "instance", data: pool[nextIdx] });
  }, [activeFloor, mpInstances, selectedMpItem, hiddenMpLabels, handleEnterFpv]);

  const handleJumpToMpItem = useCallback(async (item) => {
    if (!item?.data) return;
    revealView("360");
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
  }, [loadedSave, revealView]);

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

  /* ---------- workspace navigation / sync helpers ---------- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => { persistAlgoParams(algoParams); }, [algoParams]);

  // Keep every view that has been shown mounted so state (camera, edits, 360 position) survives switching.
  useEffect(() => {
    setVisited((prev) => {
      const next = new Set(prev);
      visibleKey.split(",").forEach((v) => next.add(v));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleKey]);

  useEffect(() => {
    if (!loadedSave) { setSaveInfo(null); return undefined; }
    let cancelled = false;
    fetch(`/api/saves/${encodeURIComponent(loadedSave)}/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setSaveInfo(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loadedSave]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else rootRef.current?.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const focusView = useCallback((id) => {
    setLayout("single");
    setSlots((prev) => [id, prev[0] === id ? prev[1] : prev[0]]);
  }, []);

  const changeLayout = useCallback((l) => {
    setLayout(l);
  }, []);

  const onTab = useCallback((id) => {
    if (layout === "all") focusView(id);
    else revealView(id);
  }, [layout, focusView, revealView]);

  // Alt+1..4 switch views, Alt+F toggles full screen
  useEffect(() => {
    if (stage !== "workspace") return undefined;
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const def = VIEW_DEFS.find((v) => v.key === e.key);
      if (def) { e.preventDefault(); onTab(def.id); }
      else if (e.key.toLowerCase() === "f") { e.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, onTab, toggleFullscreen]);

  const resetSession = useCallback(() => {
    handleSelectRoom(null);
    setSelectedWall(null);
    setSelectedOpening(null);
    setSelectedMpItem(null);
    setFpvMode(false);
    setFpvRequest(null);
    fpvPoseStore.set(null);
    setMpLabelFilter(null);
    setHiddenMpLabels([]);
    setActiveFloor(0);
    setShowAlgo(false);
    setLayout("single");
    setSlots(["3d", "2d"]);
    setVisited(new Set(["3d"]));
    setSessionKey((k) => k + 1);
  }, [handleSelectRoom, fpvPoseStore]);

  const openSave = (sv) => {
    resetSession();
    setLoadedSave(sv.name);
    setSourceName(sv.name);
    if (sv.wall_color || sv.floor_color) {
      const restored = {
        wall: sv.wall_color ?? cloudColors?.wall ?? "#f5f5f5",
        floor: sv.floor_color ?? cloudColors?.floor ?? "#2ed16b",
      };
      setCloudColors(restored);
      try { localStorage.setItem("s2f_cloud_colors", JSON.stringify(restored)); } catch { /* ignore */ }
    }
    setStage("workspace");
  };

  const openLive = () => {
    resetSession();
    setLoadedSave(null);
    handleWallsDetected();
    checkStatus();
    setStage("workspace");
  };

  const onPipelineDone = (src) => {
    if (src) setSourceName(src);
    resetSession();
    setLoadedSave(null);
    handleReprocessDone();
    handleWallsDetected();
    checkStatus();
    setStage("workspace");
  };

  const loadingLabel = meshLoading
    ? `Loading 3D Mesh (${meshProgress}%)`
    : "Streaming Point Cloud…";

  /* ---------- derived workspace values ---------- */
  const floorCount = loadedSave
    ? (saveInfo?.floor_levels?.length ?? 1)
    : (modelInfo?.floor_levels?.length ?? 0);
  const cloudReady = backendStatus === "ready";
  const mpStats = {
    instances: mpInstances.length,
    sweeps: Object.keys(mpSweeps).length,
    points: mpPoints.length,
  };
  const multi = visibleViews.length > 1;

  const paneStyle = (id) => {
    if (layout === "single") return { gridColumn: 1, gridRow: 1 };
    if (layout === "split") return { gridColumn: slots[0] === id ? 1 : 2, gridRow: 1 };
    const m = {
      "3d": { gridColumn: 1, gridRow: "1 / span 2" },
      "360": { gridColumn: 2, gridRow: 1 },
      "2d": { gridColumn: 2, gridRow: 2 },
    };
    return m[id] ?? {};
  };
  const stageStyle =
    layout === "all"
      ? { gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr) minmax(0,1fr)" }
      : layout === "split"
        ? { gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr)" }
        : { gridTemplateColumns: "minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr)" };

  const onSelectMpItemShared = (item) => {
    setSelectedMpItem(item);
    if (item) {
      setSelectedWall(null);
      setSelectedOpening(null);
    }
  };

  const hudBtn = (active) => `s2f-hud-btn${active ? " active" : ""}`;

  /* ---------- the four views ---------- */
  const render3D = (visible) => (
    <>
      <Canvas
        frameloop={visible ? "always" : "never"}
        camera={{ position: [30, 15, 30], fov: 50, near: 0.1, far: 2000 }}
        gl={{ antialias: true, localClippingEnabled: true }}
        onPointerMissed={() => {
          setSelectedWall(null);
          setSelectedMpItem(null);
        }}
      >
        <color attach="background" args={[isDark ? "#0f0f0f" : "#f5f5f5"]} />
        <ambientLight intensity={isDark ? 0.6 : 0.8} />
        <directionalLight position={[20, 30, 10]} intensity={1} castShadow />
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
              onLoadStart={() => { setMeshLoading(true); setMeshProgress(0); }}
              onProgress={(p) => setMeshProgress(p)}
              onLoaded={() => setMeshLoading(false)}
            />
          )}
          {showTexture && (
            <TexturedMesh
              modelInfo={modelInfo}
              activeFloor={activeFloor}
              opacity={textureOpacity}
              onLoadStart={() => { setMeshLoading(true); setMeshProgress(0); }}
              onProgress={(p) => setMeshProgress(p)}
              onLoaded={() => setMeshLoading(false)}
            />
          )}
          {showCloud && cloudReady && (
            <PointCloud
              modelInfo={modelInfo}
              activeFloor={activeFloor}
              reloadKey={cloudReloadKey}
              highlightedRoom={highlightedRoom}
              wallColor={cloudColors.wall}
              floorColor={cloudColors.floor}
              onLoadStart={() => setCloudLoading(true)}
              onLoaded={(n) => { setCloudLoading(false); setCloudPoints(n); }}
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
              onSelectWall={(w) => { setSelectedWall(w); if (w) setSelectedOpening(null); }}
              hoveredWall={hoveredWall}
              setHoveredWall={setHoveredWall}
              hoveredRoom={hoveredRoom}
              setHoveredRoom={setHoveredRoom}
              selectedOpening={selectedOpening}
              onSelectOpening={(op) => { setSelectedOpening(op); if (op) setSelectedWall(null); }}
              hoveredOpening={hoveredOpening}
              setHoveredOpening={setHoveredOpening}
              showWalls={bimFilters.walls}
              showRooms={bimFilters.rooms}
              showDoors={bimFilters.doors}
              showWindows={bimFilters.windows}
            />
          )}
          <MpObjects3D
            instances={mpInstances}
            points={mpPoints}
            sweeps={mpSweeps}
            activeFloor={activeFloor}
            showEquipment={showMpEquip}
            showSweeps={showMpSweeps}
            showPoints={showMpPoints}
            showLivePose={showMpLive}
            hiddenLabels={hiddenMpLabels}
            labelFilter={mpLabelFilter}
            livePose={liveMpPose}
            selectedMpItem={selectedMpItem}
            hoveredMpItem={hoveredMpItem}
            onSelectMpItem={onSelectMpItemShared}
            onHoverMpItem={setHoveredMpItem}
          />
        </Suspense>

        <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} minDistance={0.05} maxDistance={500} />

        <CameraFocuser
          highlightedRoom={highlightedRoom}
          modelInfo={loadedSave ? (saveInfo || modelInfo) : modelInfo}
          controlsRef={controlsRef}
          activeFloor={activeFloor}
          fpvRequest={fpvRequest}
          fpvMode={fpvMode}
          fpvPoseStore={fpvPoseStore}
        />

        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport labelColor={isDark ? "white" : "#222222"} axisHeadScale={1} />
        </GizmoHelper>
      </Canvas>

      <LayersPanel
        showBim3D={showBim3D} setShowBim3D={setShowBim3D}
        bimFilters={bimFilters} setBimFilters={setBimFilters}
        showCloud={showCloud} setShowCloud={setShowCloud} cloudReady={cloudReady} cloudPoints={cloudPoints}
        showTexture={showTexture}
        setShowTexture={(v) => {
          setShowTexture(v);
          if (v && textureOpacity < 0.9) setTextureOpacity(1.0);
        }}
        textureOpacity={textureOpacity} setTextureOpacity={setTextureOpacity}
        showMpEquip={showMpEquip} setShowMpEquip={setShowMpEquip}
        showMpSweeps={showMpSweeps} setShowMpSweeps={setShowMpSweeps}
        showMpPoints={showMpPoints} setShowMpPoints={setShowMpPoints}
        showMpLive={showMpLive} setShowMpLive={setShowMpLive}
        hiddenMpLabels={hiddenMpLabels} setHiddenMpLabels={setHiddenMpLabels}
        instances={mpInstances}
        inventory={mpInventory}
        activeFloor={activeFloor}
        cloudColors={cloudColors} setCloudColors={setCloudColors}
        mpStats={mpStats}
      />

      <MiniPlan
        floor={activeFloor === "all" ? 0 : Number(activeFloor)}
        floorCount={Math.max(floorCount, 1)}
        onChangeFloor={setActiveFloor}
        saveName={loadedSave}
        dataVersion={floorDataVersion}
        theme={theme}
        instances={mpInstances}
        sweeps={mpSweeps}
        points={mpPoints}
        inventory={mpInventory}
        livePose={liveMpPose}
        fpvPoseStore={fpvPoseStore}
        selectedRoomId={selectedRoomId}
        onSelectRoom={handleSelectRoom}
        selectedMpItem={selectedMpItem}
        onSelectMpItem={onSelectMpItemShared}
      />

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

      {/* First-person HUD */}
      <div className={`s2f-hud${fpvMode ? " fpv" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
        {!fpvMode ? (
          <>
            <button
              className={hudBtn(false)}
              onClick={() => (selectedMpItem ? handleEnterFpv(selectedMpItem) : handleDropToFloorEyeLevel())}
              title="Walk / look around at eye level (WASD + mouse drag)"
            >
              First-person view
            </button>
            <button
              className={hudBtn(false)}
              onClick={() => handleCycleFpvItem(1)}
              disabled={!mpInstances.some((i) => i.label === "dvere")}
              title="Jump directly to a door in first-person view"
            >
              Inspect doors
            </button>
          </>
        ) : (
          <>
            <span className="s2f-hud-title">FPV · {selectedMpItem?.data?.instance_id || selectedMpItem?.data?.name || "Free walk"}</span>
            <button className={hudBtn(false)} onClick={() => handleCycleFpvItem(-1)} title="Previous item in class">◀</button>
            {selectedMpItem && (
              <button className={hudBtn(false)} onClick={() => handleEnterFpv(selectedMpItem)} title="Re-aim camera at selected object">Re-aim</button>
            )}
            <button className={hudBtn(false)} onClick={() => handleCycleFpvItem(1)} title="Next item in class">▶</button>
            <span className="s2f-hud-sep" />
            <button className={hudBtn(showBim3D)} onClick={() => setShowBim3D((v) => !v)}>Walls</button>
            <button className={hudBtn(showTexture)} onClick={() => { setShowTexture((v) => { const n = !v; if (n && textureOpacity < 0.9) setTextureOpacity(1.0); return n; }); }}>Photo</button>
            <button className={hudBtn(showCloud)} onClick={() => setShowCloud((v) => !v)}>Cloud</button>
            <button className={hudBtn(showMpEquip)} onClick={() => setShowMpEquip((v) => !v)}>Markers</button>
            <button
              className={hudBtn(false)}
              onClick={handleDropToFloorEyeLevel}
              title="Snap camera to eye level on the current floor"
            >
              Eye level
            </button>
            <span className="s2f-hud-hint">WASD · drag · scroll</span>
            <button className="s2f-hud-btn danger" onClick={() => setFpvMode(false)}>Exit</button>
          </>
        )}
      </div>

      {(meshLoading || cloudLoading) && (
        <LoadingOverlay label={loadingLabel} progress={meshLoading ? meshProgress : null} />
      )}

      {backendStatus === "processing" && <div className="s2f-notice">Point cloud is being preprocessed — check back shortly</div>}
      {backendStatus === "idle" && !loadedSave && (
        <div className="s2f-notice">No live point cloud loaded — go back to Home and run the pipeline</div>
      )}

      {modelInfo && !loadedSave && (
        <div className="s2f-corner">
          {modelInfo.n_points?.toLocaleString()} pts ·{" "}
          {modelInfo.wall_slices_ready ? "dense slices" : modelInfo.preprocess_walls_running ? "extracting…" : "1:100 sparse"}
        </div>
      )}
    </>
  );

  const render360 = () => (
    <MpShowcasePanel
      full
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
      onSelectMpItem={onSelectMpItemShared}
      labelFilter={mpLabelFilter}
      setLabelFilter={setMpLabelFilter}
      pendingCommand={pendingMpCommand}
      onCommandConsumed={() => setPendingMpCommand(null)}
    />
  );

  const render2D = (visible) => (
    <FloorPlanViewer
      modelInfo={modelInfo}
      dataVersion={floorDataVersion}
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
      mpInventory={mpInventory}
      livePose={liveMpPose}
      fpvPoseStore={fpvPoseStore}
      visible={visible}
      selectedMpItem={selectedMpItem}
      onSelectMpItem={onSelectMpItemShared}
      hiddenMpLabels={hiddenMpLabels}
      setHiddenMpLabels={setHiddenMpLabels}
      sharedShowMpEquip={showMpEquip}
      sharedSetShowMpEquip={setShowMpEquip}
      sharedShowMpSweeps={showMpSweeps}
      sharedSetShowMpSweeps={setShowMpSweeps}
      sharedShowMpAiHints={showMpAiHints}
      sharedSetShowMpAiHints={setShowMpAiHints}
      sharedShowMpPoints={showMpPoints}
      sharedSetShowMpPoints={setShowMpPoints}
      sharedShowMpLive={showMpLive}
      sharedSetShowMpLive={setShowMpLive}
      bimFilters={bimFilters}
      setBimFilters={setBimFilters}
    />
  );

  const renderPlans = () => (
    <div className="s2f-plans">
      <FloorPlanPanel floor={fpFloor} setFloor={setFpFloor} />
    </div>
  );

  const renderView = (id, visible) =>
    id === "3d" ? render3D(visible) : id === "360" ? render360() : id === "2d" ? render2D(visible) : renderPlans();

  /* ---------- render ---------- */
  if (stage === "home") {
    return (
      <div className="s2f-root" ref={rootRef} data-theme={theme}>
        <HomePage
          backendStatus={backendStatus}
          theme={theme}
          toggleTheme={toggleTheme}
          params={algoParams}
          setParams={setAlgoParams}
          roomMode={roomMode}
          setRoomMode={setRoomMode}
          hasLive={backendStatus === "ready"}
          onOpenLive={openLive}
          onOpenSave={openSave}
          onPipelineDone={onPipelineDone}
        />
      </div>
    );
  }

  return (
    <div className="s2f-root" ref={rootRef} data-theme={theme}>
      <header className="s2f-top">
        <button className="s2f-btn s2f-btn-sm" onClick={() => setStage("home")} title="Back to session picker">← Home</button>
        <div className="s2f-brand"><span className="s2f-logo">◈</span> Scan2Floor</div>
        <div className="s2f-session" title={loadedSave ? "Saved output" : "Live pipeline data"}>
          <span className={`s2f-dot ${loadedSave ? "s2f-dot-saved" : "s2f-dot-live"}`} />
          {loadedSave ?? "Live session"}
        </div>

        <div className="s2f-seg s2f-views" role="tablist" aria-label="Views">
          {VIEW_DEFS.map((v) => (
            <button
              key={v.id}
              role="tab"
              className={visibleViews.includes(v.id) ? "active" : ""}
              onClick={() => onTab(v.id)}
              title={`${v.label} (Alt+${v.key})`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="s2f-seg" aria-label="Layout">
          {[["single", "Single"], ["split", "Split"], ["all", "All"]].map(([id, label]) => (
            <button key={id} className={layout === id ? "active" : ""} onClick={() => changeLayout(id)} title={`${label} layout`}>{label}</button>
          ))}
        </div>

        <div className="s2f-seg" aria-label="Floor">
          <button className={activeFloor === "all" ? "active" : ""} onClick={() => setActiveFloor("all")}>All floors</button>
          {Array.from({ length: floorCount }, (_, i) => (
            <button key={i} className={activeFloor === i ? "active" : ""} onClick={() => setActiveFloor(i)}>F{i}</button>
          ))}
        </div>

        <div className="s2f-spacer" />

        {!loadedSave && cloudReady && <SaveOutput defaultName={sourceName} cloudColors={cloudColors} />}
        {!loadedSave && (
          <button className={`s2f-btn s2f-btn-sm${showAlgo ? " active" : ""}`} onClick={() => setShowAlgo((v) => !v)}>Re-detect</button>
        )}
        <button className="s2f-iconbtn" onClick={toggleTheme} title="Toggle theme">{isDark ? "☀" : "☾"}</button>
        <button className="s2f-iconbtn" onClick={toggleFullscreen} title="Full screen (Alt+F)">{isFullscreen ? "⤡" : "⛶"}</button>
      </header>

      <div className="s2f-stage" style={stageStyle} key={sessionKey}>
        {VIEW_DEFS.filter((v) => visited.has(v.id) || visibleViews.includes(v.id)).map((v) => {
          const visible = visibleViews.includes(v.id);
          return (
            <section
              key={v.id}
              className={`s2f-pane${multi ? " multi" : ""}`}
              style={{ ...paneStyle(v.id), display: visible ? undefined : "none" }}
              data-view={v.id}
            >
              {multi && (
                <div className="s2f-pane-head">
                  {layout === "split" ? (
                    <select
                      className="s2f-pane-select"
                      value={v.id}
                      onChange={(e) => {
                        const nv = e.target.value;
                        setSlots((prev) => {
                          const idx = prev.indexOf(v.id);
                          const other = 1 - idx;
                          const n = [...prev];
                          if (prev[other] === nv) n[other] = prev[idx];
                          n[idx] = nv;
                          return n;
                        });
                      }}
                    >
                      {VIEW_DEFS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  ) : (
                    <span className="s2f-pane-title">{v.label}</span>
                  )}
                  <span className="s2f-spacer" />
                  <button className="s2f-iconbtn s2f-iconbtn-sm" onClick={() => focusView(v.id)} title="Maximise this view">▣</button>
                  <button className="s2f-iconbtn s2f-iconbtn-sm" onClick={() => { focusView(v.id); toggleFullscreen(); }} title="Full screen this view">⛶</button>
                </div>
              )}
              <div className="s2f-pane-body">{renderView(v.id, visible)}</div>
            </section>
          );
        })}

        {showAlgo && !loadedSave && (
          <RedetectDrawer
            params={algoParams}
            setParams={setAlgoParams}
            roomMode={roomMode}
            setRoomMode={setRoomMode}
            modelInfo={modelInfo}
            activeFloor={activeFloor}
            onDone={handleWallsDetected}
            onClose={() => setShowAlgo(false)}
          />
        )}

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
