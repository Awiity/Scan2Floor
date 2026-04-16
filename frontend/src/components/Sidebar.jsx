import { useState, useEffect, useRef } from "react";

// ── ParamSlider ────────────────────────────────────────────────────────────────
// Reusable slider row with label, live value chip, and optional hint text.
function ParamSlider({ label, hint, value, min, max, step, unit, precision = 2, defaultVal, onChange, accent = "#67e8f9" }) {
  const pct = ((value - min) / (max - min)) * 100;
  const isDefault = Math.abs(value - defaultVal) < step * 0.5;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 600 }}>{label}</span>
          {!isDefault && (
            <span style={{
              marginLeft: 5, fontSize: 9, background: `${accent}22`, color: accent,
              border: `1px solid ${accent}44`, borderRadius: 3, padding: "1px 4px", fontWeight: 700,
            }}>modified</span>
          )}
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, color: accent,
          fontFamily: "JetBrains Mono, monospace", minWidth: 48, textAlign: "right",
        }}>
          {value.toFixed(precision)}{unit}
        </span>
      </div>
      {hint && <div style={{ fontSize: 10, color: "var(--text-3)", marginBottom: 4 }}>{hint}</div>}
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%", accentColor: accent, cursor: "pointer", height: 4,
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text-3)", marginTop: 2 }}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ── Main Sidebar ───────────────────────────────────────────────────────────────

export default function Sidebar({
  showMesh,
  setShowMesh,
  showCloud,
  setShowCloud,
  showFloorPlan,
  setShowFloorPlan,
  showFloorPlanViewer,
  setShowFloorPlanViewer,
  modelInfo,
  backendStatus,
  cloudPoints,
  activeFloor,
  setActiveFloor,
  onReprocessDone,
  onWallsDetected,
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
  const [c2bStatus,      setC2bStatus]      = useState(null);
  const [c2bFloorsBusy,  setC2bFloorsBusy]  = useState(false);
  const [c2bFloorsMsg,   setC2bFloorsMsg]   = useState("");
  const [c2bWallBusy,    setC2bWallBusy]    = useState(false);
  const [c2bWallMsg,     setC2bWallMsg]     = useState("");
  const [c2bFloor,       setC2bFloor]       = useState(0);

  // ── Wall detection parameters ────────────────────────────────────────
  const [showWallParams,    setShowWallParams]   = useState(false);
  const [gridSize,          setGridSize]         = useState(0.02);
  const [thresholdFrac,     setThresholdFrac]    = useState(0.01);
  const [minWallM,          setMinWallM]         = useState(0.40);
  const [maxWallThickness,  setMaxWallThickness] = useState(0.75);
  const [dpTolerance,       setDpTolerance]      = useState(0.04);
  const [snapToAxis,        setSnapToAxis]       = useState(true);

  // ── Room detection parameters ────────────────────────────────────────
  const [showRoomParams,    setShowRoomParams]   = useState(false);
  const [wallThicknessM,    setWallThicknessM]   = useState(0.20);
  const [extendM,           setExtendM]          = useState(0.45);
  const [minSegM,           setMinSegM]          = useState(0.40);
  const [minRoomM2,         setMinRoomM2]        = useState(0.80);
  const [minRoomWidthM,     setMinRoomWidthM]    = useState(0.60);

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
          floor_idx:          c2bFloor,
          grid_size:          gridSize,
          snap_to_axis:       snapToAxis,
          min_wall_m:         minWallM,
          max_wall_thickness: maxWallThickness,
          dp_tolerance:       dpTolerance,
          threshold_frac:     thresholdFrac,
          detect_openings:    true,
          detect_rooms:       true,
          wall_thickness:     wallThicknessM,
          // room params packed inside cfg on the backend
          extend_m:           extendM,
          min_seg_m:          minSegM,
          min_room_m2:        minRoomM2,
          min_room_width_m:   minRoomWidthM,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setC2bWallMsg("\u26a0 " + (d.detail ?? "Error"));
      } else {
        setC2bWallMsg(
          `\u2713 ${d.lines_count} walls \u00b7 ${d.n_doors}D ${d.n_windows}W \u00b7 ${d.n_rooms} rooms`
        );
        onWallsDetected?.(); // signal canvas to refresh
      }
    } catch {
      setC2bWallMsg("\u26a0 Network error");
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

        <div
          className="layer-item"
          onClick={() => setShowFloorPlanViewer((v) => !v)}
          style={{
            background: showFloorPlanViewer ? "rgba(0,200,224,0.07)" : undefined,
            borderRadius: 10,
          }}
        >
          <div className="layer-icon" style={{ background: "rgba(0,200,224,0.15)" }}>🗺️</div>
          <div style={{ flex: 1 }}>
            <div className="layer-label">Vector Floor Plan</div>
            <div className="layer-sub">
              {modelInfo?.floor_levels?.length
                ? `${modelInfo.floor_levels.length} floors · walls, rooms & openings`
                : "Canvas renderer · pan & zoom"}
            </div>
          </div>
          <Toggle checked={!!showFloorPlanViewer} onChange={setShowFloorPlanViewer} />
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
              background: "rgba(0,200,80,0.15)", color: "#00c850",
              border: "1px solid rgba(0,200,80,0.3)", borderRadius: 4,
              fontSize: 9, fontWeight: 700, padding: "1px 5px", letterSpacing: 0.5,
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

        {/* Step 1 — Floor levels */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4, fontWeight: 600 }}>
            Step 1 — Improve floor levels
          </div>
          <button
            id="c2b-floors-btn"
            onClick={handleC2bFloors}
            disabled={c2bFloorsBusy || !c2bStatus?.n_surfaces}
            style={{
              width: "100%", background: c2bFloorsBusy ? "rgba(168,85,247,0.3)" : "rgba(168,85,247,0.18)",
              border: "1px solid rgba(168,85,247,0.5)", borderRadius: 6, color: "#c084fc",
              fontSize: 11, fontWeight: 700, padding: "7px 10px",
              cursor: c2bFloorsBusy ? "wait" : "pointer", transition: "all 0.2s", letterSpacing: 0.2,
            }}
          >
            {c2bFloorsBusy ? "⏳ Reading surfaces…" : "↑ Import Floor Levels from C2B"}
          </button>
          {c2bFloorsMsg && (
            <div style={{ marginTop: 5, fontSize: 11, color: c2bFloorsMsg.startsWith("⚠") ? "#ef4444" : "#00c850", lineHeight: 1.4 }}>
              {c2bFloorsMsg}
            </div>
          )}
        </div>

        {/* Step 2 — Wall detector */}
        <div>
          <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 4, fontWeight: 600 }}>
            Step 2 — Run Cloud2BIM wall detector
          </div>

          {/* Floor selector */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>Floor</span>
            <select
              id="c2b-floor-select"
              value={c2bFloor}
              onChange={(e) => setC2bFloor(Number(e.target.value))}
              style={{
                flex: 1, background: "var(--surface-2, #111827)",
                border: "1px solid var(--border, #1e2d4a)", borderRadius: 5,
                color: "var(--text-1)", fontSize: 11, padding: "4px 6px", cursor: "pointer",
              }}
            >
              {(modelInfo?.floor_levels ?? [0, 1, 2]).map((_, i) => (
                <option key={i} value={i}>Floor {i}</option>
              ))}
            </select>
          </div>

          {/* ── Wall Parameters collapsible ── */}
          <button
            onClick={() => setShowWallParams((v) => !v)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              background: showWallParams ? "rgba(6,182,212,0.08)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${showWallParams ? "rgba(6,182,212,0.25)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 6, color: showWallParams ? "#67e8f9" : "var(--text-2)",
              fontSize: 11, fontWeight: 600, padding: "6px 10px", cursor: "pointer",
              transition: "all 0.2s", marginBottom: 4,
            }}
          >
            <span>⚙ Wall Parameters</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>{showWallParams ? "▲" : "▼"}</span>
          </button>

          {showWallParams && (
            <div style={{
              background: "rgba(0,0,0,0.25)", border: "1px solid rgba(6,182,212,0.12)",
              borderRadius: 8, padding: "10px 12px", marginBottom: 6,
              display: "flex", flexDirection: "column", gap: 10,
            }}>

              {/* Grid Size */}
              <ParamSlider
                label="Grid Resolution"
                hint="Finer = more detail, slower"
                value={gridSize}
                min={0.01} max={0.10} step={0.005}
                unit="m"
                defaultVal={0.02}
                onChange={setGridSize}
                accent="#67e8f9"
              />

              {/* Density Threshold */}
              <ParamSlider
                label="Density Threshold"
                hint="Lower = catch more walls (& noise)"
                value={thresholdFrac}
                min={0.001} max={0.05} step={0.001}
                unit=""
                precision={3}
                defaultVal={0.01}
                onChange={setThresholdFrac}
                accent="#67e8f9"
              />

              {/* Min Wall Length */}
              <ParamSlider
                label="Min Wall Length"
                hint="Drop segments shorter than this"
                value={minWallM}
                min={0.10} max={2.0} step={0.05}
                unit="m"
                defaultVal={0.40}
                onChange={setMinWallM}
                accent="#67e8f9"
              />

              {/* Max Wall Thickness */}
              <ParamSlider
                label="Max Wall Thickness"
                hint="Face-pair grouping tolerance"
                value={maxWallThickness}
                min={0.10} max={1.5} step={0.05}
                unit="m"
                defaultVal={0.75}
                onChange={setMaxWallThickness}
                accent="#67e8f9"
              />

              {/* DP Tolerance */}
              <ParamSlider
                label="Simplification (DP)"
                hint="Douglas-Peucker tolerance"
                value={dpTolerance}
                min={0.01} max={0.20} step={0.005}
                unit="m"
                precision={3}
                defaultVal={0.04}
                onChange={setDpTolerance}
                accent="#67e8f9"
              />

              {/* Snap to axis */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-2)", fontWeight: 600 }}>Manhattan Snap</div>
                  <div style={{ fontSize: 10, color: "var(--text-3)" }}>Force H/V alignment</div>
                </div>
                <Toggle checked={snapToAxis} onChange={setSnapToAxis} />
              </div>

              {/* Reset all */}
              <button
                onClick={() => { setGridSize(0.02); setThresholdFrac(0.01); setMinWallM(0.40); setMaxWallThickness(0.75); setDpTolerance(0.04); setSnapToAxis(true); }}
                style={{
                  fontSize: 10, color: "var(--text-3)", background: "none",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "3px 8px",
                  cursor: "pointer", alignSelf: "flex-end", transition: "all 0.15s",
                }}
              >↩ Reset defaults</button>
            </div>
          )}

          {/* ── Room Parameters collapsible ── */}
          <button
            onClick={() => setShowRoomParams((v) => !v)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              background: showRoomParams ? "rgba(52,211,153,0.08)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${showRoomParams ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 6, color: showRoomParams ? "#34d399" : "var(--text-2)",
              fontSize: 11, fontWeight: 600, padding: "6px 10px", cursor: "pointer",
              transition: "all 0.2s", marginBottom: 8,
            }}
          >
            <span>⚙ Room Parameters</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>{showRoomParams ? "▲" : "▼"}</span>
          </button>

          {showRoomParams && (
            <div style={{
              background: "rgba(0,0,0,0.25)", border: "1px solid rgba(52,211,153,0.12)",
              borderRadius: 8, padding: "10px 12px", marginBottom: 8,
              display: "flex", flexDirection: "column", gap: 10,
            }}>

              <ParamSlider
                label="Wall Draw Thickness"
                hint="Half-width for room flood-fill"
                value={wallThicknessM}
                min={0.05} max={0.50} step={0.025}
                unit="m"
                defaultVal={0.20}
                onChange={setWallThicknessM}
                accent="#34d399"
              />

              <ParamSlider
                label="Endpoint Extension"
                hint="Extend to seal T-junctions"
                value={extendM}
                min={0.10} max={1.0} step={0.025}
                unit="m"
                defaultVal={0.45}
                onChange={setExtendM}
                accent="#34d399"
              />

              <ParamSlider
                label="Min Segment"
                hint="Ignore walls shorter than this"
                value={minSegM}
                min={0.10} max={1.0} step={0.05}
                unit="m"
                defaultVal={0.40}
                onChange={setMinSegM}
                accent="#34d399"
              />

              <ParamSlider
                label="Min Room Area"
                hint="Filter out tiny noise regions"
                value={minRoomM2}
                min={0.1} max={10} step={0.1}
                unit="m²"
                defaultVal={0.80}
                onChange={setMinRoomM2}
                accent="#34d399"
              />

              <ParamSlider
                label="Min Room Width"
                hint="Reject corridor-thin regions"
                value={minRoomWidthM}
                min={0.10} max={2.0} step={0.05}
                unit="m"
                defaultVal={0.60}
                onChange={setMinRoomWidthM}
                accent="#34d399"
              />

              <button
                onClick={() => { setWallThicknessM(0.20); setExtendM(0.45); setMinSegM(0.40); setMinRoomM2(0.80); setMinRoomWidthM(0.60); }}
                style={{
                  fontSize: 10, color: "var(--text-3)", background: "none",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "3px 8px",
                  cursor: "pointer", alignSelf: "flex-end", transition: "all 0.15s",
                }}
              >↩ Reset defaults</button>
            </div>
          )}

          {/* Detect Walls button */}
          <button
            id="c2b-walls-btn"
            onClick={handleC2bWalls}
            disabled={c2bWallBusy || !c2bStatus?.n_surfaces}
            style={{
              width: "100%",
              background: c2bWallBusy ? "rgba(6,182,212,0.3)" : "rgba(6,182,212,0.18)",
              border: "1px solid rgba(6,182,212,0.5)", borderRadius: 6, color: "#67e8f9",
              fontSize: 11, fontWeight: 700, padding: "8px 10px",
              cursor: c2bWallBusy ? "wait" : "pointer", transition: "all 0.2s", letterSpacing: 0.2,
            }}
          >
            {c2bWallBusy ? "⏳ Detecting walls…" : "🧱 Detect Walls + Rooms"}
          </button>
          {c2bWallMsg && (
            <div style={{
              marginTop: 5, fontSize: 11,
              color: c2bWallMsg.startsWith("⚠") ? "#ef4444" : "#00c850", lineHeight: 1.4,
            }}>{c2bWallMsg}</div>
          )}
          {c2bWallMsg && !c2bWallMsg.startsWith("⚠") && (
            <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 3, lineHeight: 1.4 }}>
              Canvas viewer refreshed automatically ✓
            </div>
          )}
        </div>
      </div>

    </aside>
  );
}

