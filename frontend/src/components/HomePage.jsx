import { useState, useEffect, useRef, useCallback } from "react";
import AlgorithmSettings from "./AlgorithmSettings";
import { pipelineBody } from "../algoParams";

const STAGE_NAMES = [
  "Clean point cloud",
  "Preprocess XYZ",
  "Cloud2BIM slabs",
  "Import floor levels",
  "Extract wall slices",
  "Detect walls & rooms",
];
const LS_ROOT_KEY = "scan2floor_scan_root";

function fmtDate(ts) {
  if (!ts) return "";
  return ts.replace("T", " ").replace("Z", " UTC").slice(0, 19);
}

function StatusPill({ status }) {
  const label =
    status === "ready" ? "Backend connected" :
    status === "idle" ? "Connected · no live data" :
    status === "processing" ? "Processing…" :
    status === "error" ? "Backend offline" : "Connecting…";
  return (
    <div className={`s2f-status s2f-status-${status}`}>
      <span className="s2f-dot" />
      {label}
    </div>
  );
}

export default function HomePage({
  backendStatus,
  theme,
  toggleTheme,
  params,
  setParams,
  roomMode,
  setRoomMode,
  hasLive,
  onOpenLive,
  onOpenSave,
  onPipelineDone,
}) {
  /* ---------------- saves ---------------- */
  const [saves, setSaves] = useState([]);
  const [savesLoading, setSavesLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [tab, setTab] = useState("saved");
  const userPickedTab = useRef(false);

  const fetchSaves = useCallback(async () => {
    setSavesLoading(true);
    try {
      const d = await fetch("/api/saves").then((r) => r.json());
      setSaves(d.saves ?? []);
    } catch {
      setSaves([]);
    } finally {
      setSavesLoading(false);
    }
  }, []);

  useEffect(() => { fetchSaves(); }, [fetchSaves]);

  // Land on "New" when there is nothing saved and no live session yet
  useEffect(() => {
    if (!savesLoading && !userPickedTab.current && saves.length === 0 && !hasLive) setTab("new");
  }, [savesLoading, saves.length, hasLive]);

  const pickTab = (t) => { userPickedTab.current = true; setTab(t); };

  const deleteSave = async (name) => {
    if (deleteConfirm !== name) { setDeleteConfirm(name); return; }
    setDeleteConfirm(null);
    try {
      await fetch(`/api/saves/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch { /* ignore */ }
    fetchSaves();
  };

  /* ---------------- Matterpak scan ---------------- */
  const [scanRoot, setScanRoot] = useState(() => localStorage.getItem(LS_ROOT_KEY) ?? "/data");
  const [scanGroups, setScanGroups] = useState([]);
  const [scanTotal, setScanTotal] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [selected, setSelected] = useState(null);

  const fetchScans = useCallback(async (rootOverride) => {
    const root = (rootOverride ?? scanRoot).trim();
    if (!root) return;
    setScanLoading(true);
    setScanError("");
    try {
      const d = await fetch(`/api/scan/browse?root=${encodeURIComponent(root)}`).then((r) => r.json());
      const groups = d.groups ?? [];
      setScanGroups(groups);
      setScanTotal(d.total ?? 0);
      const all = groups.flatMap((g) => g.files);
      if (all.length === 1) setSelected((s) => s ?? all[0]);
      localStorage.setItem(LS_ROOT_KEY, root);
    } catch {
      setScanGroups([]);
      setScanTotal(0);
      setScanError("Failed to reach backend.");
    } finally {
      setScanLoading(false);
    }
  }, [scanRoot]);

  useEffect(() => { fetchScans(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sourceName = (() => {
    const parts = (selected?.path || "").replace(/\\/g, "/").split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "output";
  })();

  /* ---------------- pipeline ---------------- */
  const [pipeStatus, setPipeStatus] = useState(null);
  const [pipeRunning, setPipeRunning] = useState(false);
  const [pipeCancelling, setPipeCancelling] = useState(false);
  const [pipeError, setPipeError] = useState("");
  const [showLog, setShowLog] = useState(false);
  const pollRef = useRef(null);
  const sourceRef = useRef(sourceName);
  sourceRef.current = sourceName;
  const onDoneRef = useRef(onPipelineDone);
  onDoneRef.current = onPipelineDone;

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const startPoll = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const d = await fetch("/api/pipeline/status").then((r) => r.json());
        setPipeStatus(d);
        setPipeRunning(d.running);
        if (!d.running) {
          stopPoll();
          setPipeCancelling(false);
          if (d.cancelled) setPipeError("Cancelled — partial results may exist");
          else if (d.error) setPipeError(d.error);
          else if (d.done) onDoneRef.current?.(sourceRef.current);
        }
      } catch { /* keep polling */ }
    }, 2000);
  }, []);

  useEffect(() => {
    fetch("/api/pipeline/status")
      .then((r) => r.json())
      .then((d) => {
        setPipeStatus(d);
        if (d.running) { setPipeRunning(true); startPoll(); }
      })
      .catch(() => {});
    return stopPoll;
  }, [startPoll]);

  const runPipeline = async (resumeFrom) => {
    if (!selected?.path || pipeRunning) return;
    setPipeError("");
    setPipeCancelling(false);
    if (!resumeFrom) setPipeStatus(null);
    try {
      const body = pipelineBody(selected.path, params, roomMode, resumeFrom ? { resume_from_stage: resumeFrom } : {});
      const d = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (d.status === "started" || d.status === "already_running") { setPipeRunning(true); startPoll(); }
      else if (d.detail) setPipeError(typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail));
    } catch { setPipeError("Network error"); }
  };

  const cancelPipeline = async () => {
    if (!pipeRunning || pipeCancelling) return;
    setPipeCancelling(true);
    try { await fetch("/api/pipeline/cancel", { method: "POST" }); } catch { setPipeCancelling(false); }
  };

  const stagesDone = pipeStatus?.stages_done ?? [];
  const currentStage = pipeStatus?.stage ?? 0;
  const pipeCancelled = pipeStatus?.cancelled ?? false;
  const lastDone = stagesDone.length ? Math.max(...stagesDone) : 0;
  const resumeStage = pipeCancelled && lastDone > 0 && lastDone < 6 ? lastDone + 1 : null;
  const showProgress = pipeRunning || (pipeStatus && (stagesDone.length > 0 || pipeStatus.error || pipeCancelled));
  const pct = Math.round((stagesDone.length / STAGE_NAMES.length) * 100);

  return (
    <div className="s2f-home">
      <header className="s2f-top">
        <div className="s2f-brand"><span className="s2f-logo">◈</span> Scan2Floor</div>
        <div className="s2f-spacer" />
        <StatusPill status={backendStatus} />
        <button className="s2f-iconbtn" onClick={toggleTheme} title="Toggle theme">{theme === "dark" ? "☀" : "☾"}</button>
      </header>

      <main className="s2f-home-scroll">
        <div className="s2f-home-inner">
          <div className="s2f-hero">
            <h1>Start a session</h1>
            <p>Open a previously saved output, or process new Matterpak scan data.</p>
          </div>

          <div className="s2f-tabs">
            <button className={tab === "saved" ? "active" : ""} onClick={() => pickTab("saved")}>
              Saved outputs <span className="s2f-count">{saves.length}</span>
            </button>
            <button className={tab === "new" ? "active" : ""} onClick={() => pickTab("new")}>
              New from Matterpak
              {pipeRunning && <span className="s2f-count s2f-count-live">running</span>}
            </button>
          </div>

          {/* ───────────── SAVED ───────────── */}
          {tab === "saved" && (
            <section>
              <div className="s2f-section-head">
                <span>{saves.length} saved output{saves.length === 1 ? "" : "s"}</span>
                <button className="s2f-btn s2f-btn-sm" onClick={fetchSaves}>{savesLoading ? "Loading…" : "Refresh"}</button>
              </div>
              <div className="s2f-cards">
                {hasLive && (
                  <article className="s2f-card s2f-card-live">
                    <div className="s2f-card-badge">Live</div>
                    <h3>Current session</h3>
                    <p className="s2f-muted">Latest pipeline result held by the backend (not saved yet).</p>
                    <div className="s2f-card-actions">
                      <button className="s2f-btn s2f-btn-primary" onClick={onOpenLive}>Open workspace</button>
                    </div>
                  </article>
                )}
                {saves.map((sv) => (
                  <article key={sv.name} className="s2f-card" onDoubleClick={() => onOpenSave(sv)}>
                    <h3 title={sv.name}>{sv.name}</h3>
                    <div className="s2f-meta">
                      <span>{sv.n_floors} floor{sv.n_floors !== 1 ? "s" : ""}</span>
                      <span>{fmtDate(sv.timestamp)}</span>
                    </div>
                    <div className="s2f-card-actions">
                      <button className="s2f-btn s2f-btn-primary" id={`load-save-${sv.name}`} onClick={() => onOpenSave(sv)}>Open</button>
                      <button
                        className={`s2f-btn ${deleteConfirm === sv.name ? "s2f-btn-danger" : ""}`}
                        onClick={() => deleteSave(sv.name)}
                        onBlur={() => setDeleteConfirm(null)}
                        title="Delete this save"
                      >
                        {deleteConfirm === sv.name ? "Confirm delete" : "Delete"}
                      </button>
                    </div>
                  </article>
                ))}
                {!savesLoading && saves.length === 0 && !hasLive && (
                  <div className="s2f-empty">
                    <p>No saved outputs yet.</p>
                    <button className="s2f-btn s2f-btn-primary" onClick={() => pickTab("new")}>Process Matterpak data</button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ───────────── NEW ───────────── */}
          {tab === "new" && (
            <div className="s2f-new">
              <div className="s2f-new-col">
                <section className="s2f-panel">
                  <header className="s2f-panel-head">
                    <h2>1 · Matterpak data</h2>
                    {scanTotal !== null && !scanLoading && (
                      <span className="s2f-muted">{scanTotal} file{scanTotal === 1 ? "" : "s"}</span>
                    )}
                  </header>
                  <div className="s2f-row">
                    <input
                      className="s2f-input s2f-mono"
                      id="scan-folder-input"
                      value={scanRoot}
                      onChange={(e) => setScanRoot(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && fetchScans()}
                      placeholder="/data"
                    />
                    <button className="s2f-btn" id="scan-folder-btn" onClick={() => fetchScans()} disabled={scanLoading}>
                      {scanLoading ? "Scanning…" : "Scan folder"}
                    </button>
                  </div>
                  {scanError && <div className="s2f-error">{scanError}</div>}
                  {scanTotal === 0 && !scanLoading && !scanError && (
                    <div className="s2f-muted" style={{ padding: "12px 0" }}>No .xyz files found under {scanRoot}</div>
                  )}
                  <div className="s2f-files">
                    {scanGroups.map((grp, gi) => (
                      <div key={gi} className="s2f-file-group">
                        <div className="s2f-file-dir">{grp.dir}</div>
                        {grp.files.map((f, fi) => {
                          const isSel = selected?.path === f.path;
                          return (
                            <button key={fi} className={`s2f-file${isSel ? " active" : ""}`} onClick={() => setSelected(f)}>
                              <span className="s2f-radio" />
                              <span className="s2f-file-name">{f.name}</span>
                              {f.size_mb > 0 && <span className="s2f-muted">{f.size_mb.toFixed(1)} MB</span>}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="s2f-panel">
                  <header className="s2f-panel-head"><h2>2 · Run</h2></header>
                  {showProgress && (
                    <div className="s2f-progress">
                      <div className="s2f-bar"><div style={{ width: `${pipeRunning ? Math.max(pct, 4) : pct}%` }} /></div>
                      <ol className="s2f-stages">
                        {STAGE_NAMES.map((name, i) => {
                          const idx = i + 1;
                          const done = stagesDone.includes(idx);
                          const active = pipeRunning && currentStage === idx;
                          return (
                            <li key={idx} className={done ? "done" : active ? "active" : ""}>
                              <span className="s2f-stage-ico">{done ? "✓" : active ? "…" : idx}</span>
                              <span>{name}</span>
                              {active && pipeStatus?.elapsed_s != null && <span className="s2f-muted" style={{ marginLeft: "auto" }}>{pipeStatus.elapsed_s}s</span>}
                            </li>
                          );
                        })}
                      </ol>
                      {pipeError && <div className="s2f-error">{pipeError}</div>}
                      <button className="s2f-link" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide log" : "Show log"}</button>
                      {showLog && (
                        <pre className="s2f-log">{(pipeStatus?.log ?? []).slice(-12).join("\n")}</pre>
                      )}
                    </div>
                  )}
                  <div className="s2f-run-row">
                    <div className="s2f-selected">
                      {selected ? <><span className="s2f-muted">Source</span> <b>{selected.name}</b></> : <span className="s2f-muted">Select a scan file above</span>}
                    </div>
                    {pipeRunning ? (
                      <button className="s2f-btn s2f-btn-danger" id="pipeline-cancel-btn" onClick={cancelPipeline} disabled={pipeCancelling}>
                        {pipeCancelling ? "Cancelling…" : "Cancel"}
                      </button>
                    ) : (
                      <>
                        {resumeStage && (
                          <button className="s2f-btn" id="pipeline-resume-btn" onClick={() => runPipeline(resumeStage)} disabled={!selected}>
                            Resume from stage {resumeStage}
                          </button>
                        )}
                        <button className="s2f-btn s2f-btn-primary" id="pipeline-run-btn" onClick={() => runPipeline()} disabled={!selected}>
                          Run pipeline
                        </button>
                      </>
                    )}
                  </div>
                  {backendStatus === "ready" && !pipeRunning && (
                    <button className="s2f-link" style={{ marginTop: 10 }} onClick={onOpenLive}>Skip — open existing live data →</button>
                  )}
                </section>
              </div>

              <div className="s2f-new-col">
                <section className="s2f-panel">
                  <header className="s2f-panel-head"><h2>Algorithm settings</h2></header>
                  <AlgorithmSettings
                    params={params}
                    setParams={setParams}
                    roomMode={roomMode}
                    setRoomMode={setRoomMode}
                    sections={["stages", "cleaning", "detection"]}
                  />
                  <p className="s2f-hint" style={{ marginTop: 12 }}>
                    Room-detection tuning (wall thickness, min area …) is available inside the workspace via <b>Re-detect</b> once a floor is loaded.
                  </p>
                </section>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

