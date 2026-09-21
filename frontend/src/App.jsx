import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
import Sidebar from "./components/Sidebar";
import OBJModel from "./components/OBJModel"; // kept for future use — toggle removed from UI
import PointCloud from "./components/PointCloud";
import LoadingOverlay from "./components/LoadingOverlay";
import FloorPlanPanel from "./components/FloorPlanPanel";
import FloorPlanViewer from "./components/FloorPlanViewer";
import RoomListPanel from "./components/RoomListPanel";
import CameraFocuser from "./components/CameraFocuser";
import RoomEditorPanel from "./components/RoomEditorPanel";

const POLL_MS = 7 * 1000;

export default function App() {
  /* ---------- server status ---------- */
  const [backendStatus, setBackendStatus] = useState("connecting"); // connecting|ready|processing|error
  const [modelInfo, setModelInfo] = useState(null);

  /* ---------- layer visibility -------- */
  const [showMesh, setShowMesh] = useState(false); // reserved, toggle removed from UI
  const [showCloud, setShowCloud] = useState(false);
  const [showFloorPlan, setShowFloorPlan] = useState(false);
  const [showFloorPlanViewer, setShowFloorPlanViewer] = useState(false);
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
      } catch {}
      return next;
    });
  };
  const isDark = theme === "dark";

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
  const [roomsData, setRoomsData] = useState(null);

  /* ---------- room shape mode ---------- */
  // 'polygon' = new non-rectangular mode; 'rectangular' = legacy bbox-only mode
  const [roomMode, setRoomMode] = useState("polygon");

  /* ---------- loaded save -------------- */
  // null = live data; string = name of the loaded save being viewed
  const [loadedSave, setLoadedSave] = useState(null);

  // Fetch rooms for the active floor (defaulting to floor 0 when activeFloor is "all")
  useEffect(() => {
    const targetFloor = (activeFloor === "all" || activeFloor == null) ? 0 : activeFloor;
    let cancelled = false;
    const apiBase = loadedSave ? `/api/saves/${encodeURIComponent(loadedSave)}` : "/api";
    fetch(`${apiBase}/rooms/${targetFloor}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRoomsData(d ? { ...d, targetFloor } : null);
      })
      .catch(() => {
        if (!cancelled) setRoomsData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFloor, floorDataVersion, loadedSave]);

  // Clear room selection when activeFloor changes
  useEffect(() => {
    setSelectedRoomId(null);
  }, [activeFloor]);

  // Derive the full room object for the currently selected room
  const highlightedRoom =
    selectedRoomId != null
      ? (roomsData?.rooms ?? []).find((r) => r.id === selectedRoomId) ?? null
      : null;

  /* ---------- camera ref -------------- */
  const controlsRef = useRef(null);

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
          <span className="logo-tag">3D Studio</span>
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
          showCloud={showCloud}
          setShowCloud={setShowCloud}
          showFloorPlan={showFloorPlan}
          setShowFloorPlan={setShowFloorPlan}
          showFloorPlanViewer={showFloorPlanViewer}
          setShowFloorPlanViewer={setShowFloorPlanViewer}
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
                {showCloud && backendStatus === "ready" && (
                  <PointCloud
                    modelInfo={modelInfo}
                    activeFloor={activeFloor}
                    reloadKey={cloudReloadKey}
                    highlightedRoom={highlightedRoom}
                    onLoadStart={() => setCloudLoading(true)}
                    onLoaded={(n) => {
                      setCloudLoading(false);
                      setCloudPoints(n);
                    }}
                  />
                )}
              </Suspense>

              <OrbitControls
                ref={controlsRef}
                makeDefault
                enableDamping
                dampingFactor={0.08}
                minDistance={1}
                maxDistance={500}
              />

              {/* 3D camera focus on selected room */}
              <CameraFocuser
                highlightedRoom={highlightedRoom}
                modelInfo={modelInfo}
                controlsRef={controlsRef}
              />

              <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
                <GizmoViewport labelColor={isDark ? "white" : "#222222"} axisHeadScale={1} />
              </GizmoHelper>
            </Canvas>
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
                <span style={{ color: "#00c850" }}>✓ dense slices</span>
              ) : modelInfo.preprocess_walls_running ? (
                <span style={{ color: "#ffa000" }}>⏳ extracting…</span>
              ) : (
                <span style={{ color: "#ffa000" }}>⚠ 1:100 sparse</span>
              )}
            </div>
          )}

          {/* Room list panel — shown when FloorPlanViewer is active */}
          {showFloorPlanViewer && (
            <RoomListPanel
              floor={activeFloor === "all" ? 0 : activeFloor}
              dataVersion={floorDataVersion}
              selectedRoomId={selectedRoomId}
              onSelectRoom={setSelectedRoomId}
              saveName={loadedSave}
            />
          )}

          {/* Floor plan panel (Matterport image) */}
          {showFloorPlan && (
            <FloorPlanPanel floor={fpFloor} setFloor={setFpFloor} />
          )}
          {/* Room Editor Panel — isolated room editor, shown when a room is selected */}
          {selectedRoomId != null && highlightedRoom && (
            <RoomEditorPanel
              room={highlightedRoom}
              floor={activeFloor === "all" ? 0 : activeFloor}
              modelInfo={modelInfo}
              saveName={loadedSave}
              onClose={() => setSelectedRoomId(null)}
              onWallsChanged={handleWallsDetected}
            />
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
              onSelectRoom={setSelectedRoomId}
              onSelectFloor={setActiveFloor}
              roomMode={roomMode}
              saveName={loadedSave}
            />
          </div>
        )}
      </div>
    </div>
  );
}
