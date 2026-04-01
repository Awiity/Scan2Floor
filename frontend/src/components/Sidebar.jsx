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
  onCameraPreset,
  activeFloor,
  setActiveFloor,
}) {
  const cloudReady = backendStatus === "ready";

  const fmt = (n) => n?.toLocaleString?.() ?? "—";

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

      {/* ── Camera presets ── */}
      <div className="sidebar-section">
        <div className="section-title">Camera</div>
        <div className="cam-grid">
          {[
            { key: "top", label: "⬆ Top" },
            { key: "3d", label: "◈ 3D" },
            { key: "front", label: "▣ Front" },
            { key: "side", label: "▷ Side" },
          ].map(({ key, label }) => (
            <button
              key={key}
              className="cam-btn"
              onClick={() => onCameraPreset(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Floor Slicer ── */}
      {modelInfo?.floor_levels && modelInfo.floor_levels.length > 0 && (
        <div className="sidebar-section">
          <div className="section-title">Slice by Floor</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className={`fp-tab ${activeFloor === "all" ? "active" : ""}`}
              onClick={() => setActiveFloor("all")}
              style={{ padding: "6px 12px", flex: "1 1 auto" }}
            >
              All
            </button>
            {modelInfo.floor_levels.map((level, i) => (
              <button
                key={i}
                className={`fp-tab ${activeFloor === i ? "active" : ""}`}
                onClick={() => setActiveFloor(i)}
                style={{ padding: "6px 12px", flex: "1 1 auto" }}
              >
                Floor {i}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Generate Floor Plan ── */}
      <div className="sidebar-section">
        <div className="section-title">Floor Plan (Phase 4)</div>
        <button
          className={`generate-btn ${showFloorPlanViewer ? "active" : ""}`}
          onClick={() => setShowFloorPlanViewer((v) => !v)}
          disabled={!modelInfo?.floor_levels?.length}
        >
          {showFloorPlanViewer ? "✕ Close Generator" : "📐 Generate Floor Plan"}
        </button>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
          Wall detection · DXF export
        </div>
      </div>

      {/* ── Roadmap ── */}
      <div className="sidebar-section">
        <div className="section-title">Roadmap</div>
        {[
          { icon: "✅", label: "Wall Detection", note: "M3 Done", done: true },
          {
            icon: "✅",
            label: "Car-Filter (parking)",
            note: "M3b Done",
            done: true,
          },
          {
            icon: "🚪",
            label: "Door / Window Detection",
            note: "M4 Active",
            done: false,
          },
          { icon: "📄", label: "DXF Export", note: "M5 Active", done: false },
          { icon: "📋", label: "Building Passport", note: "M6", done: false },
        ].map(({ icon, label, note, done }) => (
          <div
            key={label}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "5px 0",
              color: done ? "var(--cyan)" : "var(--text-3)",
              fontSize: 12,
            }}
          >
            <span>{icon}</span>
            <span>{label}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 10,
                color: done ? "var(--cyan)" : "var(--purple)",
              }}
            >
              {note}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
