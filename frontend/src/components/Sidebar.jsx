import { useState, useEffect, useRef } from "react";

export default function Sidebar({
  showMesh,
  setShowMesh,
  showCloud,
  setShowCloud,
  showFloorPlan,
  setShowFloorPlan,
  modelInfo,
  backendStatus,
  cloudPoints,
  activeFloor,
  setActiveFloor,
  onReprocessDone,
}) {
  const cloudReady = backendStatus === "ready";
  const fmt = (n) => n?.toLocaleString?.() ?? "—";

  // ── XYZ path state ─────────────────────────────────────────────────
  const [xyzPath, setXyzPath] = useState("");
  const [xyzExists, setXyzExists] = useState(null); // null=unknown, true, false
  const [xyzSaving, setXyzSaving] = useState(false);
  const [xyzError, setXyzError] = useState("");
  const [xyzBrowsing, setXyzBrowsing] = useState(false);
  const xyzInputRef = useRef(null);

  // ── Cloud2BIM state ─────────────────────────────────────────────────
  const [c2bStatus, setC2bStatus] = useState(null);      // {n_surfaces, files}
  const [c2bFloorsBusy, setC2bFloorsBusy] = useState(false);
  const [c2bFloorsMsg, setC2bFloorsMsg] = useState("");
  const [c2bWallBusy, setC2bWallBusy] = useState(false);
  const [c2bWallMsg,  setC2bWallMsg]  = useState("");
  const [c2bFloor, setC2bFloor] = useState(0);

  // ── Reprocess state ─────────────────────────────────────────────────
  const [reprocessRunning, setReprocessRunning] = useState(false);
  const [reprocessDone, setReprocessDone] = useState(false);
  const [reprocessError, setReprocessError] = useState("");
  const [reprocessLog, setReprocessLog] = useState("");
  const [reprocessElapsed, setReprocessElapsed] = useState(null);
  const reprocessPollRef = useRef(null);

  useEffect(() => {
    fetch("/api/c2b/status")
      .then((r) => r.json())
      .then((d) => setC2bStatus(d))
      .catch(() => {});
  }, []);

  const handleC2bFloors = async () => {
    setC2bFloorsBusy(true);
    setC2bFloorsMsg("");
    try {
      const r = await fetch("/api/c2b/floors", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setC2bFloorsMsg("⚠ " + (d.detail ?? "Error"));
      } else {
        setC2bFloorsMsg(
          `✓ ${d.new_floor_levels.length} floors → ${d.new_floor_levels.map((v) => v.toFixed(2) + " m").join(", ")}`
        );
      }
    } catch {
      setC2bFloorsMsg("⚠ Network error");
    } finally {
      setC2bFloorsBusy(false);
    }
  };

  const handleC2bWalls = async () => {
    setC2bWallBusy(true);
    setC2bWallMsg("");
    try {
      const r = await fetch("/api/c2b/walls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_idx: c2bFloor,
          grid_size: 0.02,
          snap_to_axis: true,
          min_wall_m: 0.40,
          max_wall_thickness: 0.75,
          dp_tolerance: 0.04,
          threshold_frac: 0.01,
          detect_openings: true,
          detect_rooms: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setC2bWallMsg("⚠ " + (d.detail ?? "Error"));
      } else {
        setC2bWallMsg(
          `✓ ${d.lines_count} walls · ${d.n_doors}D ${d.n_windows}W · ${d.n_rooms} rooms`
        );
      }
    } catch {
      setC2bWallMsg("⚠ Network error");
    } finally {
      setC2bWallBusy(false);
    }
  };

  useEffect(() => {
    fetch("/api/xyz-path")
      .then((r) => r.json())
      .then((d) => {
        setXyzPath(d.xyz_path ?? "");
        setXyzExists(d.exists ?? null);
      })
      .catch(() => {});
  }, []);

  const handleSetXyzPath = async () => {
    const val = xyzPath.trim();
    if (!val) return;
    setXyzSaving(true);
    setXyzError("");
    try {
      const r = await fetch("/api/xyz-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xyz_path: val }),
      });
      const d = await r.json();
      if (!r.ok) {
        setXyzError(d.detail ?? "Error");
      } else {
        setXyzPath(d.xyz_path);
        setXyzExists(d.exists);
      }
    } catch (e) {
      setXyzError("Network error");
    } finally {
      setXyzSaving(false);
    }
  };

  const handleBrowseXyz = async () => {
    setXyzBrowsing(true);
    setXyzError("");
    try {
      const r = await fetch("/api/browse-xyz");
      const d = await r.json();
      if (d.cancelled || !d.xyz_path) return;
      // Auto-fill the input and immediately save to backend
      setXyzPath(d.xyz_path);
      setXyzExists(d.exists ?? null);
      // Persist the chosen path
      const r2 = await fetch("/api/xyz-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xyz_path: d.xyz_path }),
      });
      const d2 = await r2.json();
      if (!r2.ok) setXyzError(d2.detail ?? "Error saving path");
      else setXyzExists(d2.exists);
    } catch {
      setXyzError("Could not open file dialog");
    } finally {
      setXyzBrowsing(false);
    }
  };

  // ── Reprocess helpers ───────────────────────────────────────────────
  const startReprocessPoll = () => {
    if (reprocessPollRef.current) return;
    reprocessPollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/reprocess/status");
        const d = await r.json();
        setReprocessRunning(d.running);
        setReprocessDone(d.done);
        setReprocessError(d.error ?? "");
        setReprocessElapsed(d.elapsed_s ?? null);
        if (d.log?.length) setReprocessLog(d.log[d.log.length - 1]);
        if (!d.running) {
          clearInterval(reprocessPollRef.current);
          reprocessPollRef.current = null;
          // Notify App so it bumps cloudReloadKey → PointCloud re-fetches
          if (d.done && !d.error) onReprocessDone?.();
        }
      } catch { /* ignore poll errors */ }
    }, 2000);
  };

  const handleReprocess = async () => {
    if (reprocessRunning) return;
    setReprocessDone(false);
    setReprocessError("");
    setReprocessLog("");
    setReprocessElapsed(null);
    try {
      const r = await fetch("/api/reprocess", { method: "POST" });
      const d = await r.json();
      if (d.status === "started" || d.status === "already_running") {
        setReprocessRunning(true);
        startReprocessPoll();
      } else if (d.detail) {
        setReprocessError(d.detail);
      }
    } catch {
      setReprocessError("Network error");
    }
  };

  const Toggle = ({ checked, onChange, disabled }) => (
    <label className="toggle" style={{ opacity: disabled ? 0.4 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
      />
      <div className="toggle-track" />
      <div className="toggle-thumb" />
    </label>
  );

  return (
    <aside className="sidebar">
      {/* ── Data Source ── */}
      <div className="sidebar-section">
        <div className="section-title">Data Source</div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>
          Point cloud (.xyz) file path
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
          <input
            ref={xyzInputRef}
            id="xyz-path-input"
            type="text"
            value={xyzPath}
            onChange={(e) => { setXyzPath(e.target.value); setXyzExists(null); setXyzError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleSetXyzPath()}
            placeholder="C:\path\to\cloud.xyz"
            style={{
              flex: 1,
              background: "var(--surface-2, #111827)",
              border: `1px solid ${xyzExists === false ? "#ef4444" : xyzExists === true ? "#00c850" : "var(--border, #1e2d4a)"}`,
              borderRadius: 6,
              color: "var(--text-1, #e2e8f0)",
              fontSize: 11,
              padding: "6px 8px",
              outline: "none",
              fontFamily: "monospace",
              transition: "border-color 0.2s",
            }}
          />
          <button
            id="xyz-browse-btn"
            onClick={handleBrowseXyz}
            disabled={xyzBrowsing}
            title="Browse for .xyz file"
            style={{
              background: "var(--surface-2, #111827)",
              color: "var(--text-2, #94a3b8)",
              border: "1px solid var(--border, #1e2d4a)",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 13,
              cursor: xyzBrowsing ? "wait" : "pointer",
              opacity: xyzBrowsing ? 0.5 : 1,
              transition: "all 0.2s",
              lineHeight: 1,
            }}
          >
            {xyzBrowsing ? "…" : "📂"}
          </button>
          <button
            id="xyz-path-set-btn"
            onClick={handleSetXyzPath}
            disabled={xyzSaving || !xyzPath.trim()}
            style={{
              background: "var(--cyan, #06b6d4)",
              color: "#000",
              border: "none",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 11,
              fontWeight: 700,
              cursor: xyzSaving ? "wait" : "pointer",
              opacity: xyzSaving ? 0.6 : 1,
              whiteSpace: "nowrap",
              transition: "opacity 0.2s",
            }}
          >
            {xyzSaving ? "…" : "Set"}
          </button>
        </div>

        {/* Status badge */}
        <div style={{ marginTop: 5, fontSize: 11, minHeight: 16 }}>
          {xyzError && (
            <span style={{ color: "#ef4444" }}>⚠ {xyzError}</span>
          )}
          {!xyzError && xyzExists === true && (
            <span style={{ color: "#00c850" }}>✓ File found</span>
          )}
          {!xyzError && xyzExists === false && (
            <span style={{ color: "#ef4444" }}>✗ File not found at this path</span>
          )}
        </div>

        {/* Rerun pipeline */}
        <div style={{ marginTop: 10 }}>
          <button
            id="reprocess-btn"
            onClick={handleReprocess}
            disabled={reprocessRunning || !xyzExists}
            title={!xyzExists ? "Set a valid .xyz path first" : "Delete existing outputs and rerun preprocess_xyz.py"}
            style={{
              width: "100%",
              background: reprocessRunning
                ? "rgba(251,146,60,0.25)"
                : reprocessDone && !reprocessError
                  ? "rgba(0,200,80,0.15)"
                  : reprocessError
                    ? "rgba(239,68,68,0.15)"
                    : "rgba(251,146,60,0.15)",
              border: `1px solid ${reprocessRunning ? "rgba(251,146,60,0.6)" : reprocessDone && !reprocessError ? "rgba(0,200,80,0.4)" : reprocessError ? "rgba(239,68,68,0.4)" : "rgba(251,146,60,0.4)"}`,
              borderRadius: 6,
              color: reprocessRunning ? "#fb923c" : reprocessDone && !reprocessError ? "#00c850" : reprocessError ? "#ef4444" : "#fb923c",
              fontSize: 11,
              fontWeight: 700,
              padding: "7px 10px",
              cursor: reprocessRunning || !xyzExists ? (reprocessRunning ? "wait" : "not-allowed") : "pointer",
              opacity: !xyzExists && !reprocessRunning ? 0.5 : 1,
              transition: "all 0.2s",
              letterSpacing: 0.2,
            }}
          >
            {reprocessRunning
              ? `⏳ Processing… ${reprocessElapsed != null ? `(${reprocessElapsed}s)` : ""}`
              : reprocessDone && !reprocessError
                ? "✓ Pipeline complete — reload page to view"
                : reprocessError
                  ? "✗ Failed — click to retry"
                  : "🔄 Rerun Full Preprocess Pipeline"}
          </button>

          {/* Live log tail */}
          {reprocessRunning && reprocessLog && (
            <div style={{
              marginTop: 5,
              fontSize: 10,
              color: "var(--text-3)",
              fontFamily: "monospace",
              background: "rgba(0,0,0,0.3)",
              borderRadius: 4,
              padding: "4px 6px",
              lineHeight: 1.4,
              wordBreak: "break-all",
              maxHeight: 48,
              overflow: "hidden",
            }}>
              {reprocessLog}
            </div>
          )}
          {reprocessError && (
            <div style={{ marginTop: 4, fontSize: 10, color: "#ef4444", lineHeight: 1.4 }}>
              {reprocessError}
            </div>
          )}
        </div>
      </div>

      {/* ── Project ── */}
      <div className="sidebar-section">
        <div className="section-title">Project</div>
        <div className="project-card">
          <div className="project-name">MatterPak Scan</div>
          <div className="project-meta" style={{ marginBottom: 4 }}>
            Matterport · XYZ + OBJ
          </div>
          <div className="project-meta">Scale: 1 unit = 1 m</div>
        </div>
      </div>

      {/* ── Layers ── */}
      <div className="sidebar-section">
        <div className="section-title">Layers</div>

        <div className="layer-item" onClick={() => setShowMesh((v) => !v)}>
          <div className="layer-icon mesh">🧊</div>
          <div style={{ flex: 1 }}>
            <div className="layer-label">OBJ Mesh</div>
            <div className="layer-sub">Optimized Geometry</div>
          </div>
          <Toggle checked={showMesh} onChange={setShowMesh} />
        </div>

        <div
          className="layer-item"
          onClick={() => cloudReady && setShowCloud((v) => !v)}
          style={{
            opacity: cloudReady ? 1 : 0.5,
            cursor: cloudReady ? "pointer" : "not-allowed",
          }}
        >
          <div className="layer-icon cloud">✦</div>
          <div style={{ flex: 1 }}>
            <div className="layer-label">Point Cloud</div>
            <div className="layer-sub">
              {cloudReady
                ? cloudPoints
                  ? `${fmt(cloudPoints)} pts loaded`
                  : `~1.1 M pts ready`
                : "Preprocessing…"}
            </div>
          </div>
          <Toggle
            checked={showCloud}
            onChange={setShowCloud}
            disabled={!cloudReady}
          />
        </div>

        <div className="layer-item" onClick={() => setShowFloorPlan((v) => !v)}>
          <div className="layer-icon floorplan">📐</div>
          <div style={{ flex: 1 }}>
            <div className="layer-label">Floor Plans</div>
            <div className="layer-sub">Matterport color plans · 2 floors</div>
          </div>
          <Toggle checked={showFloorPlan} onChange={setShowFloorPlan} />
        </div>
      </div>

      {/* ── Statistics ── */}
      <div className="sidebar-section">
        <div className="section-title">Statistics</div>
        <div className="stat-row">
          <span className="stat-label">Total points</span>
          <span className="stat-value">
            {fmt(modelInfo?.n_total ?? 114_036_775)}
          </span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Sampled points</span>
          <span className="stat-value">{fmt(modelInfo?.n_points)}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Sample rate</span>
          <span className="stat-value">
            1 : {modelInfo?.sample_rate ?? 100}
          </span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Wall slices</span>
          <span
            className="stat-value"
            style={{
              color: modelInfo?.wall_slices_ready
                ? "#00c850"
                : modelInfo?.preprocess_walls_running
                  ? "#ffa000"
                  : "var(--text-3)",
              fontWeight: 600,
            }}
          >
            {modelInfo?.preprocess_walls_running
              ? "⏳ Extracting…"
              : modelInfo?.wall_slices_ready
                ? "✓ Dense"
                : "⚠ Sparse 1:100"}
          </span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Texture maps</span>
          <span className="stat-value">349</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Floors detected</span>
          <span className="stat-value">
            {modelInfo?.floor_levels?.length ?? "—"}
          </span>
        </div>
        {modelInfo?.bbox && (
          <>
            <div className="stat-row" style={{ marginTop: 4 }}>
              <span className="stat-label">Width</span>
              <span className="stat-value">
                {(modelInfo.bbox.max[0] - modelInfo.bbox.min[0]).toFixed(1)} m
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Height</span>
              <span className="stat-value">
                {(modelInfo.bbox.max[1] - modelInfo.bbox.min[1]).toFixed(1)} m
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Depth</span>
              <span className="stat-value">
                {(modelInfo.bbox.max[2] - modelInfo.bbox.min[2]).toFixed(1)} m
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Cloud2BIM Integration ── */}
      <div className="sidebar-section">
        <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>Cloud2BIM</span>
          {c2bStatus?.n_surfaces > 0 && (
            <span style={{
              background: "rgba(0,200,80,0.15)",
              color: "#00c850",
              border: "1px solid rgba(0,200,80,0.3)",
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 5px",
              letterSpacing: 0.5,
            }}>READY</span>
          )}
        </div>

        {/* Status summary */}
        <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
          {c2bStatus == null
            ? "Checking…"
            : c2bStatus.n_surfaces === 0
            ? "⚠ No horiz_surface_*.xyz found in Cloud2BIM-1.03/output_xyz/"
            : `${c2bStatus.n_surfaces} horizontal surfaces pre-computed`}
        </div>

        {/* Floor level import */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4, fontWeight: 600 }}>
            Step 1 — Improve floor levels
          </div>
          <button
            id="c2b-floors-btn"
            onClick={handleC2bFloors}
            disabled={c2bFloorsBusy || !c2bStatus?.n_surfaces}
            style={{
              width: "100%",
              background: c2bFloorsBusy
                ? "rgba(168,85,247,0.3)"
                : "rgba(168,85,247,0.18)",
              border: "1px solid rgba(168,85,247,0.5)",
              borderRadius: 6,
              color: "#c084fc",
              fontSize: 11,
              fontWeight: 700,
              padding: "7px 10px",
              cursor: c2bFloorsBusy ? "wait" : "pointer",
              transition: "all 0.2s",
              letterSpacing: 0.2,
            }}
          >
            {c2bFloorsBusy ? "⏳ Reading surfaces…" : "↑ Import Floor Levels from C2B"}
          </button>
          {c2bFloorsMsg && (
            <div style={{
              marginTop: 5,
              fontSize: 11,
              color: c2bFloorsMsg.startsWith("⚠") ? "#ef4444" : "#00c850",
              lineHeight: 1.4,
            }}>{c2bFloorsMsg}</div>
          )}
        </div>

        {/* Wall detection */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4, fontWeight: 600 }}>
            Step 2 — Run Cloud2BIM wall detector
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>Floor</span>
            <select
              id="c2b-floor-select"
              value={c2bFloor}
              onChange={(e) => setC2bFloor(Number(e.target.value))}
              style={{
                flex: 1,
                background: "var(--surface-2, #111827)",
                border: "1px solid var(--border, #1e2d4a)",
                borderRadius: 5,
                color: "var(--text-1)",
                fontSize: 11,
                padding: "4px 6px",
                cursor: "pointer",
              }}
            >
              {(modelInfo?.floor_levels ?? [0, 1, 2]).map((_, i) => (
                <option key={i} value={i}>Floor {i}</option>
              ))}
            </select>
          </div>
          <button
            id="c2b-walls-btn"
            onClick={handleC2bWalls}
            disabled={c2bWallBusy || !c2bStatus?.n_surfaces}
            style={{
              width: "100%",
              background: c2bWallBusy
                ? "rgba(6,182,212,0.3)"
                : "rgba(6,182,212,0.18)",
              border: "1px solid rgba(6,182,212,0.5)",
              borderRadius: 6,
              color: "#67e8f9",
              fontSize: 11,
              fontWeight: 700,
              padding: "7px 10px",
              cursor: c2bWallBusy ? "wait" : "pointer",
              transition: "all 0.2s",
              letterSpacing: 0.2,
            }}
          >
            {c2bWallBusy ? "⏳ Detecting walls…" : "🧱 Detect Walls (Cloud2BIM algo)"}
          </button>
          {c2bWallMsg && (
            <div style={{
              marginTop: 5,
              fontSize: 11,
              color: c2bWallMsg.startsWith("⚠") ? "#ef4444" : "#00c850",
              lineHeight: 1.4,
            }}>{c2bWallMsg}</div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 5, lineHeight: 1.4 }}>
            Contour tracing + Douglas-Peucker +<br/>parallel face-pair grouping
          </div>
        </div>
      </div>

    </aside>
  );
}
