/**
 * FloorPlanViewer.jsx — Floor Plan Preview
 *
 * Provides two things:
 *   1. Dense Slice extraction  — streams the full 112 M-pt cloud into per-floor
 *      wall_slice_floor_N.npy used by the Cloud2BIM algorithm.
 *   2. SVG / DXF preview       — shows the floor plan last written by the
 *      Cloud2BIM wall detector in the Sidebar.
 *
 * All wall-detection controls have been removed; they now live in the Sidebar
 * Cloud2BIM panel.
 */
import { useState, useCallback, useEffect, useRef } from "react";

const POLL_MS = 4000;

// ── Badge helper ──────────────────────────────────────────────────────────────

function Badge({ colour, children }) {
  const styles = {
    cyan:   { background: "rgba(0,200,200,0.12)",  color: "#00cccc", border: "1px solid rgba(0,200,200,0.3)"  },
    green:  { background: "rgba(0,200,80,0.12)",   color: "#00c850", border: "1px solid rgba(0,200,80,0.3)"   },
    orange: { background: "rgba(255,160,0,0.12)",  color: "#ffa000", border: "1px solid rgba(255,160,0,0.3)"  },
    red:    { background: "rgba(255,60,60,0.12)",  color: "#ff4040", border: "1px solid rgba(255,60,60,0.3)"  },
    grey:   { background: "rgba(120,140,180,0.12)",color: "#8090b0", border: "1px solid rgba(120,140,180,0.2)"},
  };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      ...(styles[colour] ?? styles.grey),
    }}>
      {children}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function FloorPlanViewer({ modelInfo, onClose }) {
  // ── Dense-slice preprocess state ──────────────────────────────────────────
  const [slicesReady, setSlicesReady] = useState(modelInfo?.wall_slices_ready ?? false);
  const [ppStatus,    setPpStatus]    = useState("idle"); // idle | running | done | error
  const [ppLog,       setPpLog]       = useState([]);
  const [ppElapsed,   setPpElapsed]   = useState(null);
  const [showLog,     setShowLog]     = useState(false);

  const ppPollRef = useRef(null);
  const logEndRef = useRef(null);

  // ── SVG / DXF preview state ───────────────────────────────────────────────
  const [selectedFloor, setSelectedFloor] = useState(0);
  const [svgUrl,        setSvgUrl]        = useState(null);
  const [dxfUrl,        setDxfUrl]        = useState(null);

  const floors    = modelInfo?.floor_levels ?? [];
  const isPPRunning = ppStatus === "running";

  // ── Sync slicesReady from modelInfo ───────────────────────────────────────
  useEffect(() => {
    if (modelInfo?.wall_slices_ready != null) {
      setSlicesReady(modelInfo.wall_slices_ready);
    }
  }, [modelInfo?.wall_slices_ready]);

  // ── Auto-scroll log ───────────────────────────────────────────────────────
  useEffect(() => {
    if (showLog && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [ppLog, showLog]);

  // ── Cleanup poll on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => { if (ppPollRef.current) clearInterval(ppPollRef.current); };
  }, []);

  // ── Poll preprocess status ────────────────────────────────────────────────
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
          if (d.error)      setPpStatus("error");
          else if (d.done) { setPpStatus("done"); setSlicesReady(d.slices_present?.length > 0); }
        }
      } catch { /* network hiccup — keep polling */ }
    }, POLL_MS);
  }, []);

  // ── Start preprocessing ───────────────────────────────────────────────────
  const runPreprocess = useCallback(async () => {
    setPpStatus("running");
    setPpLog(["Sending request…"]);
    setShowLog(true);

    try {
      const r = await fetch("/api/preprocess-walls", { method: "POST" });
      const d = await r.json();

      if (d.status === "already_running") {
        setPpLog((prev) => [...prev, "Job already running — attaching to status…"]);
        startPollingPP();
        return;
      }
      if (!r.ok) throw new Error(d.detail ?? "Unknown error");
      setPpLog((prev) => [...prev, d.message ?? "Job started"]);
      startPollingPP();
    } catch (e) {
      setPpStatus("error");
      setPpLog((prev) => [...prev, `✗ ${e.message}`]);
    }
  }, [startPollingPP]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const loadFloor = (i) => {
    setSelectedFloor(i);
    setSvgUrl(`/api/walls/${i}/svg?t=${Date.now()}`);
    setDxfUrl(`/api/walls/${i}/download`);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="floorplan-viewer">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="fpv-header">
        <div className="fpv-title">
          <span className="fpv-icon">📐</span>
          <span>Floor Plan Viewer</span>
        </div>
        <button className="fpv-close" onClick={onClose} title="Close">✕</button>
      </div>

      {/* ── Dense Slice Extraction ──────────────────────────────────────────── */}
      <div className="fpv-controls" style={{
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        paddingBottom: 12, marginBottom: 4,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-2)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Point-Cloud Source
          </div>
          {isPPRunning
            ? <Badge colour="orange">⏳ Preprocessing… {ppElapsed ? `${ppElapsed}s` : ""}</Badge>
            : slicesReady
              ? <Badge colour="green">✓ Dense slices ready</Badge>
              : <Badge colour="orange">⚠ Sparse 1:100 fallback</Badge>
          }
        </div>

        <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 10, lineHeight: 1.5 }}>
          {slicesReady
            ? "Full-density wall slices available. The Cloud2BIM algorithm uses ~100× more points than the default 1:100 sample."
            : "Run the one-time extraction (3–8 min) to stream all 112 M scan points and build per-floor voxel slices. Required for best wall-detection quality."}
        </div>

        <button
          style={{
            width: "100%", padding: "9px 0", borderRadius: 6,
            cursor: isPPRunning ? "not-allowed" : "pointer",
            fontWeight: 700, fontSize: 12,
            background: isPPRunning
              ? "rgba(255,160,0,0.15)"
              : slicesReady
                ? "rgba(0,200,80,0.12)"
                : "linear-gradient(90deg, rgba(0,180,200,0.25), rgba(0,120,220,0.25))",
            color:   isPPRunning ? "#ffa000" : slicesReady ? "#00c850" : "var(--cyan)",
            border:  isPPRunning ? "1px solid rgba(255,160,0,0.3)" : slicesReady ? "1px solid rgba(0,200,80,0.3)" : "1px solid rgba(0,180,200,0.3)",
            opacity: isPPRunning ? 0.8 : 1,
            transition: "all 0.2s",
          }}
          onClick={runPreprocess}
          disabled={isPPRunning}
        >
          {isPPRunning
            ? `⏳ Extracting… ${ppElapsed ? `(${Math.round(ppElapsed / 60)}min ${Math.round(ppElapsed % 60)}s)` : ""}`
            : slicesReady
              ? "↺ Re-extract Dense Slices"
              : "⚡ Extract Dense Wall Slices (one-time)"}
        </button>

        {/* Log */}
        {ppLog.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <button
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", fontSize: 11, padding: "2px 0" }}
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? "▾ Hide log" : "▸ Show log"}
            </button>
            {showLog && (
              <div style={{
                marginTop: 4, maxHeight: 120, overflowY: "auto",
                background: "rgba(0,0,0,0.4)", borderRadius: 4,
                padding: "6px 8px", fontFamily: "monospace", fontSize: 10,
                color: "#7090b0", lineHeight: 1.6,
              }}>
                {ppLog.map((line, i) => (
                  <div key={i} style={{
                    color: line.startsWith("✓") ? "#00c850" : line.startsWith("✗") ? "#ff4040" : "#7090b0"
                  }}>{line}</div>
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
            ✓ Dense slices ready — use the Cloud2BIM panel in the sidebar to detect walls.
          </div>
        )}
      </div>

      {/* ── Floor / SVG preview ─────────────────────────────────────────────── */}
      <div style={{ padding: "10px 12px 6px", display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>Preview</span>
        <div className="fpv-floor-tabs" style={{ flex: 1 }}>
          {floors.length > 0 ? (
            floors.map((_, i) => (
              <button
                key={i}
                className={`fpv-tab ${selectedFloor === i ? "active" : ""}`}
                onClick={() => loadFloor(i)}
              >
                {i === 0 && floors[0] < 0 ? `Floor ${i} (B1)` : `Floor ${i}`}
              </button>
            ))
          ) : (
            <span className="fpv-dim">No floors detected</span>
          )}
          {floors.length > 0 && (
            <button
              className="fpv-tab"
              style={{ marginLeft: "auto", opacity: 0.6 }}
              onClick={() => setSvgUrl(`/api/walls/${selectedFloor}/svg?t=${Date.now()}`)}
              title="Refresh SVG"
            >
              ↺
            </button>
          )}
        </div>
        {dxfUrl && (
          <a className="fpv-dl-btn" href={dxfUrl} download={`floor_${selectedFloor}.dxf`}>
            ↓ DXF
          </a>
        )}
      </div>

      <div className="fpv-preview">
        {svgUrl ? (
          <img
            className="fpv-svg"
            src={svgUrl}
            alt={`Floor ${selectedFloor} plan`}
            onError={() => setSvgUrl(null)}
          />
        ) : (
          <div className="fpv-placeholder">
            <span>
              Run <strong>🧱 Detect Walls</strong> in the sidebar,<br />
              then click a floor above to preview.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
