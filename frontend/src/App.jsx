import { Suspense, useState, useEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
import Sidebar from "./components/Sidebar";
import OBJModel from "./components/OBJModel";
import PointCloud from "./components/PointCloud";
import LoadingOverlay from "./components/LoadingOverlay";
import FloorPlanPanel from "./components/FloorPlanPanel";
import FloorPlanViewer from "./components/FloorPlanViewer";

const POLL_MS = 4000;

export default function App() {
  /* ---------- server status ---------- */
  const [backendStatus, setBackendStatus] = useState("connecting"); // connecting|ready|processing|error
  const [modelInfo, setModelInfo] = useState(null);

  /* ---------- layer visibility -------- */
  const [showMesh, setShowMesh] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [showFloorPlan, setShowFloorPlan] = useState(false);
  const [showFloorPlanViewer, setShowFloorPlanViewer] = useState(false);
  const [fpFloor, setFpFloor] = useState(0);
  const [activeFloor, setActiveFloor] = useState("all");

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

  /* ---------- camera ref -------------- */
  const controlsRef = useRef();

  /* ---------- poll backend ------------ */
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch("/api/status");
        if (!r.ok) {
          setBackendStatus("error");
          return;
        }
        const d = await r.json();
        setBackendStatus(d.status);
        if (d.info) setModelInfo(d.info);
      } catch {
        setBackendStatus("error");
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);



  const anyLoading = meshLoading || cloudLoading;
  const loadingLabel = meshLoading
    ? `Loading OBJ mesh… ${meshProgress}%`
    : cloudLoading
      ? "Loading point cloud…"
      : "";

  return (
    <div className="app">
      {/* ── Top bar ── */}
      <header className="topbar">
        <a className="logo">
          <div className="logo-icon">🏗</div>
          <span className="logo-text">Scan2Floor</span>
          <span className="logo-badge">MVP</span>
        </a>
        <div className="topbar-spacer" />
        <div className="status-pill">
          <div
            className={`status-dot ${backendStatus === "ready" ? "ready" : backendStatus === "error" ? "error" : "loading"}`}
          />
          {backendStatus === "ready" && "Point cloud ready"}
          {backendStatus === "processing" && "Preprocessing…"}
          {backendStatus === "idle" && "No data — run pipeline"}
          {backendStatus === "connecting" && "Connecting…"}
          {backendStatus === "error" && "Backend offline"}
        </div>
      </header>

      {/* ── Workspace ── */}
      <div className="workspace">
        <Sidebar
          showMesh={showMesh}
          setShowMesh={setShowMesh}
          showCloud={showCloud}
          setShowCloud={setShowCloud}
          showFloorPlan={showFloorPlan}
          setShowFloorPlan={setShowFloorPlan}
          showFloorPlanViewer={showFloorPlanViewer}
          setShowFloorPlanViewer={setShowFloorPlanViewer}
          modelInfo={modelInfo}
          backendStatus={backendStatus}
          cloudPoints={cloudPoints}
          activeFloor={activeFloor}
          setActiveFloor={setActiveFloor}
          onReprocessDone={handleReprocessDone}
          onWallsDetected={handleWallsDetected}
        />

        <div className="viewport">
          {/* Three.js canvas */}
          <div className="canvas-wrap">
            <Canvas
              camera={{ position: [30, 15, 30], fov: 50, near: 0.1, far: 2000 }}
              gl={{ antialias: true, localClippingEnabled: true }}
            >
              <color attach="background" args={["#070b18"]} />
              <ambientLight intensity={0.6} />
              <directionalLight
                position={[20, 30, 10]}
                intensity={1}
                castShadow
              />
              <directionalLight position={[-20, 10, -10]} intensity={0.4} />

              <Grid
                args={[200, 200]}
                position={[0, -0.05, 0]}
                cellColor="#0d1428"
                sectionColor="#0a2050"
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
              <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
                <GizmoViewport labelColor="white" axisHeadScale={1} />
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

          {/* Processing banner — only when a job is actively running */}
          {backendStatus === "processing" && (
            <div className="processing-banner">
              ⏳ Point cloud is being preprocessed — check back shortly
            </div>
          )}

          {/* Idle banner — no data yet, nothing running */}
          {backendStatus === "idle" && (
            <div className="processing-banner" style={{
              background: "rgba(6,182,212,0.08)",
              borderColor: "rgba(6,182,212,0.3)",
              color: "#67e8f9",
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

          {/* Floor plan panel (Matterport image) */}
          {showFloorPlan && (
            <FloorPlanPanel floor={fpFloor} setFloor={setFpFloor} />
          )}
        </div>

        {/* Phase 4: 2D Vector Floor Plan Viewer */}
        {showFloorPlanViewer && (
          <div className="fpv-panel">
            <FloorPlanViewer
              modelInfo={modelInfo}
              dataVersion={floorDataVersion}
              onClose={() => setShowFloorPlanViewer(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
