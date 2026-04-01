/**
 * FloorPlanViewer.jsx — Phase 4+5 (updated: dense-slice preprocess + car filter)
 *
 * New features
 * ────────────
 * • "Preprocess Dense Slices" button — triggers POST /api/preprocess-walls
 *   which streams the full cloud.xyz (112 M pts) and builds per-floor
 *   wall_slice_floor_N.npy at full voxel density.  Polls status every 4 s.
 * • Slice-status badge — shows ✓ Dense / ⚠ Sparse (1:100) so the user knows
 *   which data source wall detection will use.
 * • Car-filter toggle — exposes the vertical-extent filter (default ON).
 *   When ON, only grid cells that have scan points above 1.55 m from the
 *   floor level are kept, eliminating car-body noise in parking areas.
 * • All previous controls retained (floor, grid res, snap, slab width).
 */
import { useState, useCallback, useEffect, useRef } from "react";

const RESOLUTIONS = [
  { label: "5 cm (fine)", value: 0.05 },
  { label: "10 cm (fast)", value: 0.1 },
];

const SLAB_OPTIONS = [
  { label: "Tight  0.25 m", value: 0.25, hint: "Fewer false positives" },
  { label: "Loose  0.35 m", value: 0.35, hint: "Catches more openings" },
];

const POLL_MS = 4000;

// ── small helpers ─────────────────────────────────────────────────────────────

function Badge({ colour, children }) {
  const styles = {
    cyan: {
      background: "rgba(0,200,200,0.12)",
      color: "#00cccc",
      border: "1px solid rgba(0,200,200,0.3)",
    },
    green: {
      background: "rgba(0,200,80,0.12)",
      color: "#00c850",
      border: "1px solid rgba(0,200,80,0.3)",
    },
    orange: {
      background: "rgba(255,160,0,0.12)",
      color: "#ffa000",
      border: "1px solid rgba(255,160,0,0.3)",
    },
    red: {
      background: "rgba(255,60,60,0.12)",
      color: "#ff4040",
      border: "1px solid rgba(255,60,60,0.3)",
    },
    grey: {
      background: "rgba(120,140,180,0.12)",
      color: "#8090b0",
      border: "1px solid rgba(120,140,180,0.2)",
    },
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        ...(styles[colour] ?? styles.grey),
      }}
    >
      {children}
    </span>
  );
}

function TabGroup({ options, value, onChange, disabled }) {
  return (
    <div className="fpv-floor-tabs">
      {options.map((o) => (
        <button
          key={o.value ?? o.label}
          className={`fpv-tab ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
          disabled={disabled}
          title={o.hint ?? ""}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({ label, checked, onChange, disabled, hint }) {
  return (
    <div className="fpv-row fpv-snap-row" style={{ alignItems: "flex-start" }}>
      <label className="fpv-label" style={{ paddingTop: 2 }}>
        {label}
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="fpv-snap-group">
          <button
            className={`fpv-snap-btn ${checked ? "active" : ""}`}
            onClick={() => onChange(true)}
            disabled={disabled}
          >
            ✓ On
          </button>
          <button
            className={`fpv-snap-btn ${!checked ? "active" : ""}`}
            onClick={() => onChange(false)}
            disabled={disabled}
          >
            ✕ Off
          </button>
        </div>
        {hint && <span className="fpv-dim fpv-snap-hint">{hint}</span>}
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function FloorPlanViewer({ modelInfo, onClose }) {
  const floors = modelInfo?.floor_levels ?? [];
  const numFloors = floors.length;

  // ── Detection state ─────────────────────────────────────────────────────────
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [resolution, setResolution] = useState(0.05);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [wallSlab, setWallSlab] = useState(0.25);
  const [carFilter, setCarFilter] = useState(true);

  const [detectStatus, setDetectStatus] = useState("idle"); // idle|running|done|error
  const [detectResult, setDetectResult] = useState(null);
  const [svgUrl, setSvgUrl] = useState(null);
  const [dxfUrl, setDxfUrl] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  // ── Preprocess state ────────────────────────────────────────────────────────
  const [slicesReady, setSlicesReady] = useState(
    modelInfo?.wall_slices_ready ?? false,
  );
  const [ppStatus, setPpStatus] = useState("idle"); // idle|running|done|error
  const [ppLog, setPpLog] = useState([]);
  const [ppElapsed, setPpElapsed] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const ppPollRef = useRef(null);
  const logEndRef = useRef(null);

  // ── Sync slicesReady from modelInfo ────────────────────────────────────────
  useEffect(() => {
    if (modelInfo?.wall_slices_ready != null) {
      setSlicesReady(modelInfo.wall_slices_ready);
    }
  }, [modelInfo?.wall_slices_ready]);

  // ── Auto-scroll log ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (showLog && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [ppLog, showLog]);

  // ── Cleanup poll on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (ppPollRef.current) clearInterval(ppPollRef.current);
    };
  }, []);

  // ── Poll preprocess status ──────────────────────────────────────────────────
  const startPollingPP = useCallback(() => {
    if (ppPollRef.current) clearInterval(ppPollRef.current);

    ppPollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/preprocess-walls/status");
        if (!r.ok) return;
        const d = await r.json();

        setPpLog(d.log ?? []);
        setPpElapsed(d.elapsed_s ?? null);

        if (!d.running) {
          clearInterval(ppPollRef.current);
          ppPollRef.current = null;

          if (d.error) {
            setPpStatus("error");
          } else if (d.done) {
            setPpStatus("done");
            setSlicesReady(d.slices_present?.length > 0);
          }
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_MS);
  }, []);

  // ── Start preprocessing ─────────────────────────────────────────────────────
  const runPreprocess = useCallback(async () => {
    setPpStatus("running");
    setPpLog(["Sending request…"]);
    setShowLog(true);

    try {
      const r = await fetch("/api/preprocess-walls", { method: "POST" });
      const d = await r.json();

      if (d.status === "already_running") {
        // Already running — just start polling
        setPpLog((prev) => [
          ...prev,
          "Job already running — attaching to status…",
        ]);
        startPollingPP();
        return;
      }
      if (!r.ok) {
        throw new Error(d.detail ?? "Unknown error");
      }
      setPpLog((prev) => [...prev, d.message ?? "Job started"]);
      startPollingPP();
    } catch (e) {
      setPpStatus("error");
      setPpLog((prev) => [...prev, `✗ ${e.message}`]);
    }
  }, [startPollingPP]);

  // ── Run wall detection ──────────────────────────────────────────────────────
  const runDetect = useCallback(async () => {
    setDetectStatus("running");
    setDetectResult(null);
    setSvgUrl(null);
    setDxfUrl(null);
    setErrorMsg("");

    try {
      const resp = await fetch("/api/walls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_idx: selectedFloor,
          grid_size: resolution,
          snap_to_axis: snapEnabled,
          wall_thickness: wallSlab,
          car_filter: carFilter,
          detect_openings: true,
          save_debug: true,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail ?? "Detection failed");
      }
      const data = await resp.json();
      setDetectResult(data);
      setSvgUrl(`/api/walls/${selectedFloor}/svg?t=${Date.now()}`);
      setDxfUrl(`/api/walls/${selectedFloor}/download`);
      setDetectStatus("done");
    } catch (e) {
      setErrorMsg(e.message);
      setDetectStatus("error");
    }
  }, [selectedFloor, resolution, snapEnabled, wallSlab, carFilter]);

  const isRunning = detectStatus === "running";
  const isPPRunning = ppStatus === "running";

  // ── Slice source indicator ──────────────────────────────────────────────────
  function SliceStatusBadge() {
    if (isPPRunning) {
      return (
        <Badge colour="orange">
          ⏳ Preprocessing… {ppElapsed ? `${ppElapsed}s` : ""}
        </Badge>
      );
    }
    if (slicesReady) {
      return <Badge colour="green">✓ Dense slices ready</Badge>;
    }
    return <Badge colour="orange">⚠ Sparse 1:100 fallback</Badge>;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="floorplan-viewer">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="fpv-header">
        <div className="fpv-title">
          <span className="fpv-icon">📐</span>
          <span>Floor Plan Generator</span>
        </div>
        <button className="fpv-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {/* ── Dense Slice Pre-processing ─────────────────────────────────────── */}
      <div
        className="fpv-controls"
        style={{
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          paddingBottom: 12,
          marginBottom: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--text-2)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Point-Cloud Source
          </div>
          <SliceStatusBadge />
        </div>

        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          {slicesReady
            ? "Full-density wall slices available. Wall detection will use ~100× more points than the default 1:100 sample, dramatically improving accuracy in the parking area."
            : "Run the one-time extraction below (3–8 min) to stream all 112 M scan points and build per-floor voxel slices. Without this, detection falls back to the 1:100 sparse sample."}
        </div>

        <button
          style={{
            width: "100%",
            padding: "9px 0",
            borderRadius: 6,
            cursor: isPPRunning ? "not-allowed" : "pointer",
            fontWeight: 700,
            fontSize: 12,
            background: isPPRunning
              ? "rgba(255,160,0,0.15)"
              : slicesReady
                ? "rgba(0,200,80,0.12)"
                : "linear-gradient(90deg, rgba(0,180,200,0.25), rgba(0,120,220,0.25))",
            color: isPPRunning
              ? "#ffa000"
              : slicesReady
                ? "#00c850"
                : "var(--cyan)",
            border: isPPRunning
              ? "1px solid rgba(255,160,0,0.3)"
              : slicesReady
                ? "1px solid rgba(0,200,80,0.3)"
                : "1px solid rgba(0,180,200,0.3)",
            opacity: isPPRunning ? 0.8 : 1,
          }}
          onClick={runPreprocess}
          disabled={isPPRunning}
        >
          {isPPRunning
            ? `⏳ Extracting wall slices… ${ppElapsed ? `(${Math.round(ppElapsed / 60)}min ${Math.round(ppElapsed % 60)}s)` : ""}`
            : slicesReady
              ? "↺ Re-extract Dense Slices"
              : "⚡ Extract Dense Wall Slices (one-time)"}
        </button>

        {/* Log toggle */}
        {ppLog.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-3)",
                fontSize: 11,
                padding: "2px 0",
              }}
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? "▾ Hide log" : "▸ Show log"}
            </button>

            {showLog && (
              <div
                style={{
                  marginTop: 4,
                  maxHeight: 120,
                  overflowY: "auto",
                  background: "rgba(0,0,0,0.4)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontFamily: "monospace",
                  fontSize: 10,
                  color: "#7090b0",
                  lineHeight: 1.6,
                }}
              >
                {ppLog.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color: line.startsWith("✓")
                        ? "#00c850"
                        : line.startsWith("✗")
                          ? "#ff4040"
                          : "#7090b0",
                    }}
                  >
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}

        {ppStatus === "error" && (
          <div style={{ color: "#ff4040", fontSize: 11, marginTop: 4 }}>
            ✗ Preprocessing failed — check the log above.
          </div>
        )}
        {ppStatus === "done" && (
          <div style={{ color: "#00c850", fontSize: 11, marginTop: 4 }}>
            ✓ Dense slices ready — run wall detection below for best results.
          </div>
        )}
      </div>

      {/* ── Detection Controls ─────────────────────────────────────────────── */}
      <div className="fpv-controls">
        {/* Floor selector */}
        <div className="fpv-row">
          <label className="fpv-label">Floor</label>
          <div className="fpv-floor-tabs">
            {numFloors > 0 ? (
              Array.from({ length: numFloors }, (_, i) => (
                <button
                  key={i}
                  className={`fpv-tab ${selectedFloor === i ? "active" : ""}`}
                  onClick={() => {
                    setSelectedFloor(i);
                    setDetectStatus("idle");
                    setSvgUrl(null);
                  }}
                  disabled={isRunning}
                >
                  {i === 0 && floors[0] < 0
                    ? `Floor ${i} (parking/B1)`
                    : `Floor ${i}`}
                </button>
              ))
            ) : (
              <span className="fpv-dim">No floors detected</span>
            )}
          </div>
        </div>

        {/* Floor level info */}
        {numFloors > 0 && (
          <div
            style={{
              fontSize: 10,
              color: "var(--text-3)",
              paddingLeft: 80,
              marginTop: -6,
              marginBottom: 4,
            }}
          >
            Level: {floors[selectedFloor]?.toFixed(3)} m Y-up
            {floors[selectedFloor] < 0
              ? "  ·  ⚠ includes parking — car filter recommended"
              : ""}
          </div>
        )}

        {/* Grid resolution */}
        <div className="fpv-row">
          <label className="fpv-label">Grid Size</label>
          <TabGroup
            options={RESOLUTIONS}
            value={resolution}
            onChange={setResolution}
            disabled={isRunning}
          />
        </div>

        {/* Manhattan snap */}
        <ToggleRow
          label="Manhattan Snap"
          checked={snapEnabled}
          onChange={setSnapEnabled}
          disabled={isRunning}
          hint={
            snapEnabled
              ? "Walls forced to exact 0° / 90°"
              : "Raw scan angles preserved"
          }
        />

        {/* Car / obstacle filter */}
        <ToggleRow
          label="Car Filter"
          checked={carFilter}
          onChange={setCarFilter}
          disabled={isRunning}
          hint={
            carFilter
              ? "Only cells with scan pts above 1.55 m kept — removes car bodies in parking areas"
              : "All heights used — may produce false lines from cars/vehicles"
          }
        />

        {/* Wall slab width — Phase 5 */}
        <div className="fpv-row fpv-snap-row">
          <label className="fpv-label">Opening Slab</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <TabGroup
              options={SLAB_OPTIONS}
              value={wallSlab}
              onChange={setWallSlab}
              disabled={isRunning}
            />
            <span className="fpv-dim fpv-snap-hint">
              {wallSlab === 0.25
                ? "Tight — fewer false positives"
                : "Loose — catches more openings"}
            </span>
          </div>
        </div>

        {/* Run button */}
        <button
          className={`fpv-run-btn ${isRunning ? "running" : ""}`}
          onClick={runDetect}
          disabled={isRunning || numFloors === 0}
          style={{ marginTop: 4 }}
        >
          {isRunning
            ? "⏳ Detecting walls & openings…"
            : slicesReady
              ? "▶  Detect Walls & Generate DXF  (dense)"
              : "▶  Detect Walls & Generate DXF  (sparse)"}
        </button>

        {!slicesReady && !isRunning && (
          <div
            style={{
              fontSize: 10,
              color: "#ffa000",
              marginTop: 4,
              lineHeight: 1.5,
            }}
          >
            ⚠ Running on sparse 1:100 data. Results may show missing walls and
            false lines in parking areas. Extract dense slices above for best
            quality.
          </div>
        )}

        {/* Result badges */}
        {detectStatus === "done" && detectResult && (
          <div className="fpv-result-col">
            <div className="fpv-result-row">
              <div className="fpv-badges">
                <span className="fpv-badge wall">
                  🧱 {detectResult.lines_count} walls
                </span>
                <span className="fpv-badge door">
                  🚪 {detectResult.n_doors} doors
                </span>
                <span className="fpv-badge window">
                  🪟 {detectResult.n_windows} windows
                </span>
              </div>
              <a
                className="fpv-dl-btn"
                href={dxfUrl}
                download={`floor_${selectedFloor}.dxf`}
              >
                ↓ DXF
              </a>
            </div>
          </div>
        )}

        {detectStatus === "error" && (
          <div className="fpv-error">⚠ {errorMsg}</div>
        )}
      </div>

      {/* ── SVG Preview ────────────────────────────────────────────────────── */}
      <div className="fpv-preview">
        {svgUrl ? (
          <>
            <div className="fpv-preview-label">
              Floor {selectedFloor}
              {floors[selectedFloor] < 0 ? " (parking/B1)" : ""}
              {" — "}
              {snapEnabled ? "Manhattan Snapped" : "Raw"}
              {" · "}
              {slicesReady ? "dense" : "sparse"}
              {carFilter ? " · car-filter ON" : ""}
              {detectResult &&
                ` · ${detectResult.n_doors + detectResult.n_windows} openings`}
            </div>
            <img
              className="fpv-svg"
              src={svgUrl}
              alt={`Floor ${selectedFloor} plan`}
            />
          </>
        ) : (
          <div className="fpv-placeholder">
            {isRunning ? (
              <div className="fpv-spinner" />
            ) : (
              <span>
                {slicesReady ? (
                  <>
                    Configure settings and click <strong>Detect Walls</strong>
                  </>
                ) : (
                  <>
                    For best results, <strong>Extract Dense Slices</strong>{" "}
                    first,
                    <br />
                    then <strong>Detect Walls</strong>
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
