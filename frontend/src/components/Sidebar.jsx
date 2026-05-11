import { useState, useEffect, useRef } from "react";

function ParamSlider({ label, hint, value, min, max, step, unit, precision = 2, defaultVal, onChange, accent = "#67e8f9" }) {
  const isDefault = Math.abs(value - defaultVal) < step * 0.5;
  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
        <div>
          <span style={{ fontSize:11, color:"var(--text-2)", fontWeight:600 }}>{label}</span>
          {!isDefault && <span style={{ marginLeft:5, fontSize:9, background:`${accent}22`, color:accent, border:`1px solid ${accent}44`, borderRadius:3, padding:"1px 4px", fontWeight:700 }}>modified</span>}
        </div>
        <span style={{ fontSize:11, fontWeight:700, color:accent, fontFamily:"JetBrains Mono, monospace", minWidth:48, textAlign:"right" }}>{value.toFixed(precision)}{unit}</span>
      </div>
      {hint && <div style={{ fontSize:10, color:"var(--text-3)", marginBottom:4 }}>{hint}</div>}
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} style={{ width:"100%", accentColor:accent, cursor:"pointer", height:4 }} />
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"var(--text-3)", marginTop:2 }}>
        <span>{min}{unit}</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

const STAGE_NAMES = ["Preprocess XYZ","Cloud2BIM Slabs","Import Floor Levels","Extract Wall Slices","Detect Walls & Rooms"];
const S = { fontSize:11, fontWeight:700 };

export default function Sidebar({ showMesh, setShowMesh, showCloud, setShowCloud, showFloorPlan, setShowFloorPlan, showFloorPlanViewer, setShowFloorPlanViewer, modelInfo, backendStatus, cloudPoints, activeFloor, setActiveFloor, onReprocessDone, onWallsDetected }) {
  const cloudReady = backendStatus === "ready";
  const fmt = n => n?.toLocaleString?.() ?? "—";

  // File browser
  const [scanGroups,   setScanGroups]   = useState([]);
  const [browseLoading,setBrowseLoading]= useState(false);
  const [selected,     setSelected]     = useState(null);
  const [showManual,   setShowManual]   = useState(false);
  const [manualPath,   setManualPath]   = useState("");
  const [manualOk,     setManualOk]     = useState(false);

  const fetchScans = async () => {
    setBrowseLoading(true);
    try {
      const d = await fetch("/api/scan/browse").then(r=>r.json());
      setScanGroups(d.groups ?? []);
      const all = (d.groups ?? []).flatMap(g=>g.files);
      if (all.length === 1 && !selected) setSelected(all[0]);
    } catch { setScanGroups([]); }
    finally { setBrowseLoading(false); }
  };

  useEffect(() => {
    fetchScans();
    fetch("/api/xyz-path").then(r=>r.json()).then(d=>{ if(d.xyz_path) setManualPath(d.xyz_path); }).catch(()=>{});
  }, []);

  const saveManual = async () => {
    const p = manualPath.trim(); if(!p) return;
    const r = await fetch("/api/xyz-path",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({xyz_path:p})}).catch(()=>null);
    if(r?.ok){ setSelected({name:p.split("/").pop(),path:p,size_mb:-1}); setManualOk(true); setTimeout(()=>setManualOk(false),3000); }
  };

  const effectivePath = selected?.path || manualPath.trim() || null;

  // Pipeline
  const [pipeStatus, setPipeStatus] = useState(null);
  const [pipeRunning,setPipeRunning]= useState(false);
  const [pipeCancelling,setPipeCancelling] = useState(false);
  const [pipeError,  setPipeError]  = useState("");
  const [showLog,    setShowLog]    = useState(false);
  const pollRef = useRef(null);

  const stopPoll = () => { if(pollRef.current){clearInterval(pollRef.current);pollRef.current=null;} };

  const startPoll = () => {
    if(pollRef.current) return;
    pollRef.current = setInterval(async()=>{
      try {
        const d = await fetch("/api/pipeline/status").then(r=>r.json());
        setPipeStatus(d); setPipeRunning(d.running);
        if(!d.running){
          stopPoll();
          setPipeCancelling(false);
          if(d.cancelled) { setPipeError("\u26a0 Cancelled"); }
          else if(d.done&&!d.error){ onReprocessDone?.(); onWallsDetected?.(); }
          else if(d.error) setPipeError(d.error);
        }
      } catch {}
    },2000);
  };

  useEffect(()=>{
    fetch("/api/pipeline/status").then(r=>r.json()).then(d=>{ setPipeStatus(d); if(d.running){setPipeRunning(true);startPoll();} }).catch(()=>{});
    return stopPoll;
  },[]);

  const runPipeline = async () => {
    if(!effectivePath||pipeRunning) return;
    setPipeError(""); setPipeStatus(null); setPipeCancelling(false);
    try {
      const d = await fetch("/api/pipeline/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({xyz_path:effectivePath,run_c2b:true,run_slices:true,grid_size:gridSize,snap_to_axis:snapToAxis,min_wall_m:minWallM,max_wall_thickness:maxWallThick,dp_tolerance:dpTol,threshold_frac:threshFrac})}).then(r=>r.json());
      if(d.status==="started"||d.status==="already_running"){ setPipeRunning(true); startPoll(); }
      else if(d.detail) setPipeError(d.detail);
    } catch { setPipeError("Network error"); }
  };

  const cancelPipeline = async () => {
    if(!pipeRunning||pipeCancelling) return;
    setPipeCancelling(true);
    try {
      await fetch("/api/pipeline/cancel", { method: "POST" });
      // Keep polling — the status will flip running→false when the thread stops
    } catch { setPipeCancelling(false); }
  };

  // Params
  const [showWP,  setShowWP]  = useState(false);
  const [gridSize,setGridSize]= useState(0.02);
  const [threshFrac,setThreshFrac]=useState(0.01);
  const [minWallM,setMinWallM]=useState(0.40);
  const [maxWallThick,setMaxWallThick]=useState(0.75);
  const [dpTol,setDpTol]=useState(0.04);
  const [snapToAxis,setSnapToAxis]=useState(true);
  const [showRP,  setShowRP]  = useState(false);
  const [wallThickM,setWallThickM]=useState(0.20);
  const [extendM,setExtendM]=useState(0.45);
  const [minSegM,setMinSegM]=useState(0.40);
  const [minRoomM2,setMinRoomM2]=useState(0.80);
  const [minRoomW,setMinRoomW]=useState(0.60);

  // Advanced single-floor
  const [showAdv,  setShowAdv] = useState(false);
  const [advFloor, setAdvFloor]= useState(0);
  const [advBusy,  setAdvBusy] = useState(false);
  const [advMsg,   setAdvMsg]  = useState("");
  useEffect(()=>{ const n=modelInfo?.floor_levels?.length||1; if(advFloor>=n) setAdvFloor(0); },[modelInfo?.floor_levels,advFloor]);

  const runSingleFloor = async()=>{
    setAdvBusy(true); setAdvMsg("");
    try {
      const r=await fetch("/api/c2b/walls",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({floor_idx:advFloor,grid_size:gridSize,snap_to_axis:snapToAxis,min_wall_m:minWallM,max_wall_thickness:maxWallThick,dp_tolerance:dpTol,threshold_frac:threshFrac,detect_openings:true,detect_rooms:true,wall_thickness:wallThickM,extend_m:extendM,min_seg_m:minSegM,min_room_m2:minRoomM2,min_room_width_m:minRoomW})});
      const d=await r.json();
      if(!r.ok) setAdvMsg("⚠ "+(d.detail??"Error"));
      else { setAdvMsg(`✓ ${d.lines_count} walls · ${d.n_doors}D ${d.n_windows}W · ${d.n_rooms} rooms`); onWallsDetected?.(); }
    } catch { setAdvMsg("⚠ Network error"); }
    finally { setAdvBusy(false); }
  };

  const Toggle = ({checked,onChange,disabled})=>(
    <label className="toggle" style={{opacity:disabled?0.4:1}}>
      <input type="checkbox" checked={checked} onChange={e=>!disabled&&onChange(e.target.checked)}/>
      <div className="toggle-track"/><div className="toggle-thumb"/>
    </label>
  );

  const stagesDone  = pipeStatus?.stages_done ?? [];
  const currentStage= pipeStatus?.stage ?? 0;
  const pipeLog     = pipeStatus?.log ?? [];
  const pipeDone    = pipeStatus?.done ?? false;
  const pipeCancelled = pipeStatus?.cancelled ?? false;

  const btnStyle = (clr, disabled) => ({
    width:"100%", border:`1px solid ${clr}88`, borderRadius:6, color:clr,
    background:`${clr}18`, fontSize:11, fontWeight:700, padding:"7px 10px",
    cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.5:1, transition:"all 0.2s", letterSpacing:0.2,
  });

  return (
    <aside className="sidebar">

      {/* ── Pipeline ── */}
      <div className="sidebar-section">
        <div className="section-title">Pipeline</div>

        {/* File Browser */}
        <div style={{marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:11,color:"var(--text-2)",fontWeight:600}}>Scan File</span>
            <button onClick={fetchScans} disabled={browseLoading} style={{fontSize:10,color:"#67e8f9",background:"none",border:"1px solid rgba(103,232,249,0.2)",borderRadius:4,padding:"2px 7px",cursor:"pointer"}}>
              {browseLoading?"…":"↺ Refresh"}
            </button>
          </div>

          {scanGroups.length === 0 && !browseLoading && (
            <div style={{fontSize:10,color:"var(--text-3)",marginBottom:6,padding:"6px 8px",background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5}}>
              No .xyz files found under mounted <code style={{color:"#67e8f9"}}>/data</code> — add volume mounts in docker-compose.yml
            </div>
          )}

          {scanGroups.map((grp,gi)=>(
            <div key={gi} style={{marginBottom:6}}>
              <div style={{fontSize:9,color:"var(--text-3)",marginBottom:3,fontFamily:"monospace"}}>{grp.dir}</div>
              {grp.files.map((f,fi)=>{
                const isSel = selected?.path===f.path;
                return (
                  <div key={fi} onClick={()=>setSelected(f)} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",borderRadius:5,marginBottom:2,background:isSel?"rgba(6,182,212,0.15)":"rgba(255,255,255,0.03)",border:`1px solid ${isSel?"rgba(6,182,212,0.4)":"rgba(255,255,255,0.06)"}`,cursor:"pointer",transition:"all 0.15s"}}>
                    <span style={{fontSize:14}}>{isSel?"📂":"📄"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,color:isSel?"#67e8f9":"var(--text-1)",fontWeight:isSel?700:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{f.name}</div>
                      {f.size_mb>0&&<div style={{fontSize:9,color:"var(--text-3)"}}>{f.size_mb.toFixed(1)} MB</div>}
                    </div>
                    {isSel&&<span style={{color:"#67e8f9",fontSize:12}}>✓</span>}
                  </div>
                );
              })}
            </div>
          ))}

          <button onClick={()=>setShowManual(v=>!v)} style={{fontSize:10,color:"var(--text-3)",background:"none",border:"none",cursor:"pointer",padding:0,marginTop:2}}>
            {showManual?"▲ Hide":"▼ Enter path manually"}
          </button>
          {showManual&&(
            <div style={{marginTop:6,display:"flex",gap:6}}>
              <input value={manualPath} onChange={e=>setManualPath(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveManual()} placeholder="/data/folder/cloud.xyz" style={{flex:1,background:"var(--surface-2,#111827)",border:"1px solid var(--border,#1e2d4a)",borderRadius:6,color:"var(--text-1)",fontSize:11,padding:"5px 8px",outline:"none",fontFamily:"monospace"}}/>
              <button onClick={saveManual} style={{background:"#06b6d4",color:"#000",border:"none",borderRadius:6,padding:"5px 9px",fontSize:11,fontWeight:700,cursor:"pointer"}}>{manualOk?"✓":"Set"}</button>
            </div>
          )}

          {selected&&(
            <div style={{marginTop:6,fontSize:11,padding:"5px 8px",background:"rgba(0,200,80,0.08)",border:"1px solid rgba(0,200,80,0.25)",borderRadius:5,color:"#00c850",fontFamily:"monospace",wordBreak:"break-all"}}>
              ✓ {selected.name}
            </div>
          )}
        </div>

        {/* Stage progress */}
        {pipeStatus&&(
          <div style={{marginBottom:8,background:"rgba(0,0,0,0.25)",border:"1px solid rgba(6,182,212,0.15)",borderRadius:8,padding:"8px 10px"}}>
            {STAGE_NAMES.map((name,i)=>{
              const idx=i+1;
              const done=stagesDone.includes(idx);
              const active=pipeRunning&&currentStage===idx;
              const color=done?"#00c850":active?"#fb923c":"var(--text-3)";
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",borderBottom:i<4?"1px solid rgba(255,255,255,0.04)":"none"}}>
                  <span style={{fontSize:14,width:18,textAlign:"center"}}>{done?"✓":active?"⏳":"○"}</span>
                  <span style={{fontSize:11,color,fontWeight:done||active?600:400}}>{idx}. {name}</span>
                  {active&&pipeStatus.elapsed_s&&<span style={{marginLeft:"auto",fontSize:10,color:"#fb923c"}}>{pipeStatus.elapsed_s}s</span>}
                </div>
              );
            })}
            {pipeDone&&!pipeRunning&&!pipeCancelled&&<div style={{marginTop:6,fontSize:11,color:"#00c850",fontWeight:700,textAlign:"center"}}>✓ Pipeline complete!</div>}
            {pipeCancelled&&!pipeRunning&&<div style={{marginTop:6,fontSize:11,color:"#fb923c",fontWeight:700,textAlign:"center"}}>⚠ Cancelled — partial results may be available</div>}
            {pipeError&&!pipeCancelled&&<div style={{marginTop:6,fontSize:11,color:"#ef4444",lineHeight:1.4}}>{pipeError}</div>}
            <button onClick={()=>setShowLog(v=>!v)} style={{marginTop:6,fontSize:10,color:"var(--text-3)",background:"none",border:"none",cursor:"pointer",padding:0}}>{showLog?"▲ Hide log":"▼ Show log"}</button>
            {showLog&&pipeLog.length>0&&(
              <div style={{marginTop:4,fontSize:10,fontFamily:"monospace",background:"rgba(0,0,0,0.4)",borderRadius:4,padding:"4px 6px",maxHeight:80,overflow:"auto",color:"var(--text-3)",lineHeight:1.5}}>
                {pipeLog.slice(-8).map((l,i)=><div key={i}>{l}</div>)}
              </div>
            )}
          </div>
        )}

        {/* Run / Cancel buttons */}
        <div style={{display:"flex",gap:6}}>
          <button id="pipeline-run-btn" onClick={runPipeline} disabled={!effectivePath||pipeRunning} style={{...btnStyle(pipeRunning?"#fb923c":pipeDone&&!pipeError&&!pipeCancelled?"#00c850":"#67e8f9", !effectivePath||pipeRunning), flex:1}}>
            {pipeRunning&&!pipeCancelling?`⏳ Running… Stage ${currentStage}/${STAGE_NAMES.length}`:pipeDone&&!pipeError&&!pipeCancelled?"✓ Pipeline done — rerun?":"▶ Run Full Pipeline"}
          </button>
          {pipeRunning&&(
            <button
              id="pipeline-cancel-btn"
              onClick={cancelPipeline}
              disabled={pipeCancelling}
              title="Cancel the running pipeline"
              style={{
                border:"1px solid #fb923c88", borderRadius:6,
                color: pipeCancelling ? "#fb923c88" : "#fb923c",
                background:"rgba(251,146,60,0.12)", fontSize:11, fontWeight:700,
                padding:"7px 11px", cursor:pipeCancelling?"not-allowed":"pointer",
                transition:"all 0.2s", whiteSpace:"nowrap",
              }}
            >
              {pipeCancelling ? "⏳ Cancelling…" : "✕ Cancel"}
            </button>
          )}
        </div>
        {!effectivePath&&<div style={{fontSize:10,color:"var(--text-3)",marginTop:4,textAlign:"center"}}>Select or enter a scan file above</div>}

        {/* Detection params */}
        <div style={{marginTop:8}}>
          <button onClick={()=>setShowWP(v=>!v)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:showWP?"rgba(6,182,212,0.08)":"rgba(255,255,255,0.03)",border:`1px solid ${showWP?"rgba(6,182,212,0.25)":"rgba(255,255,255,0.08)"}`,borderRadius:6,color:showWP?"#67e8f9":"var(--text-2)",fontSize:11,fontWeight:600,padding:"5px 10px",cursor:"pointer",transition:"all 0.2s",marginBottom:4}}>
            <span>⚙ Detection Parameters</span><span style={{fontSize:10,opacity:0.7}}>{showWP?"▲":"▼"}</span>
          </button>
          {showWP&&(
            <div style={{background:"rgba(0,0,0,0.25)",border:"1px solid rgba(6,182,212,0.12)",borderRadius:8,padding:"10px 12px",display:"flex",flexDirection:"column",gap:10}}>
              <ParamSlider label="Grid Resolution" hint="Finer = more detail, slower" value={gridSize} min={0.01} max={0.10} step={0.005} unit="m" defaultVal={0.02} onChange={setGridSize}/>
              <ParamSlider label="Density Threshold" hint="Lower = catch more walls" value={threshFrac} min={0.001} max={0.05} step={0.001} unit="" precision={3} defaultVal={0.01} onChange={setThreshFrac}/>
              <ParamSlider label="Min Wall Length" value={minWallM} min={0.10} max={2.0} step={0.05} unit="m" defaultVal={0.40} onChange={setMinWallM}/>
              <ParamSlider label="Max Wall Thickness" value={maxWallThick} min={0.10} max={1.5} step={0.05} unit="m" defaultVal={0.75} onChange={setMaxWallThick}/>
              <ParamSlider label="DP Simplification" value={dpTol} min={0.01} max={0.20} step={0.005} unit="m" precision={3} defaultVal={0.04} onChange={setDpTol}/>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div><div style={{fontSize:11,color:"var(--text-2)",fontWeight:600}}>Manhattan Snap</div><div style={{fontSize:10,color:"var(--text-3)"}}>Force H/V alignment</div></div>
                <Toggle checked={snapToAxis} onChange={setSnapToAxis}/>
              </div>
              <button onClick={()=>{setGridSize(0.02);setThreshFrac(0.01);setMinWallM(0.40);setMaxWallThick(0.75);setDpTol(0.04);setSnapToAxis(true);}} style={{fontSize:10,color:"var(--text-3)",background:"none",border:"1px solid rgba(255,255,255,0.08)",borderRadius:4,padding:"3px 8px",cursor:"pointer",alignSelf:"flex-end"}}>↩ Reset</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Project ── */}
      <div className="sidebar-section">
        <div className="section-title">Project</div>
        <div className="project-card">
          <div className="project-name">{selected?.name ?? "No scan selected"}</div>
          <div className="project-meta">Point cloud · XYZ format</div>
          <div className="project-meta">Scale: 1 unit = 1 m</div>
        </div>
      </div>

      {/* ── Layers ── */}
      <div className="sidebar-section">
        <div className="section-title">Layers</div>
        <div className="layer-item" onClick={()=>setShowMesh(v=>!v)}>
          <div className="layer-icon mesh">🧊</div>
          <div style={{flex:1}}><div className="layer-label">OBJ Mesh</div><div className="layer-sub">Optimized Geometry</div></div>
          <Toggle checked={showMesh} onChange={setShowMesh}/>
        </div>
        <div className="layer-item" onClick={()=>cloudReady&&setShowCloud(v=>!v)} style={{opacity:cloudReady?1:0.5,cursor:cloudReady?"pointer":"not-allowed"}}>
          <div className="layer-icon cloud">✦</div>
          <div style={{flex:1}}><div className="layer-label">Point Cloud</div><div className="layer-sub">{cloudReady?cloudPoints?`${fmt(cloudPoints)} pts`:"~1.1M pts ready":"Preprocessing…"}</div></div>
          <Toggle checked={showCloud} onChange={setShowCloud} disabled={!cloudReady}/>
        </div>
        <div className="layer-item" onClick={()=>setShowFloorPlan(v=>!v)}>
          <div className="layer-icon floorplan">📐</div>
          <div style={{flex:1}}><div className="layer-label">Floor Plans</div><div className="layer-sub">Matterport color plans</div></div>
          <Toggle checked={showFloorPlan} onChange={setShowFloorPlan}/>
        </div>
        <div className="layer-item" onClick={()=>setShowFloorPlanViewer(v=>!v)} style={{background:showFloorPlanViewer?"rgba(0,200,224,0.07)":undefined,borderRadius:10}}>
          <div className="layer-icon" style={{background:"rgba(0,200,224,0.15)"}}>🗺️</div>
          <div style={{flex:1}}><div className="layer-label">Vector Floor Plan</div><div className="layer-sub">{modelInfo?.floor_levels?.length?`${modelInfo.floor_levels.length} floors · walls, rooms & openings`:"Canvas renderer"}</div></div>
          <Toggle checked={!!showFloorPlanViewer} onChange={setShowFloorPlanViewer}/>
        </div>
      </div>

      {/* ── Statistics ── */}
      <div className="sidebar-section">
        <div className="section-title">Statistics</div>
        {[
          ["Total points", fmt(modelInfo?.total_points ?? 114_036_775)],
          ["Sampled points", fmt(modelInfo?.sampled_points)],
          ["Sample rate", `1 : ${modelInfo?.sample_rate ?? 100}`],
          ["Floors detected", modelInfo?.floor_levels?.length ?? "—"],
        ].map(([k,v])=>(
          <div key={k} className="stat-row"><span className="stat-label">{k}</span><span className="stat-value">{v}</span></div>
        ))}
        <div className="stat-row">
          <span className="stat-label">Wall slices</span>
          <span className="stat-value" style={{color:modelInfo?.wall_slices_ready?"#00c850":modelInfo?.preprocess_walls_running?"#ffa000":"var(--text-3)",fontWeight:600}}>
            {modelInfo?.preprocess_walls_running?"⏳ Extracting…":modelInfo?.wall_slices_ready?"✓ Dense":"⚠ Not ready"}
          </span>
        </div>
      </div>

      {/* ── Advanced ── */}
      <div className="sidebar-section">
        <button onClick={()=>setShowAdv(v=>!v)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,color:"var(--text-2)",fontSize:11,fontWeight:600,padding:"6px 10px",cursor:"pointer"}}>
          <span>⚙ Advanced — Single Floor</span><span style={{fontSize:10,opacity:0.7}}>{showAdv?"▲":"▼"}</span>
        </button>
        {showAdv&&(
          <div style={{marginTop:8}}>
            <div style={{fontSize:11,color:"var(--text-3)",marginBottom:8,lineHeight:1.5}}>Run wall detection for one floor only, using pre-existing wall slices (skips C2B and slice extraction).</div>
            <div style={{display:"flex",gap:6,marginBottom:8,alignItems:"center"}}>
              <span style={{fontSize:11,color:"var(--text-3)",flexShrink:0}}>Floor</span>
              <select value={advFloor} onChange={e=>setAdvFloor(Number(e.target.value))} style={{flex:1,background:"var(--surface-2,#111827)",border:"1px solid var(--border,#1e2d4a)",borderRadius:5,color:"var(--text-1)",fontSize:11,padding:"4px 6px",cursor:"pointer"}}>
                {(modelInfo?.floor_levels ?? [0]).map((_,i)=><option key={i} value={i}>Floor {i}</option>)}
              </select>
            </div>
            <button id="c2b-walls-btn" onClick={runSingleFloor} disabled={advBusy||!modelInfo?.wall_slices_ready} style={btnStyle("#67e8f9",advBusy||!modelInfo?.wall_slices_ready)}>
              {advBusy?"⏳ Detecting…":"🧱 Detect Walls + Rooms (this floor)"}
            </button>
            {advMsg&&<div style={{marginTop:5,fontSize:11,color:advMsg.startsWith("⚠")?"#ef4444":"#00c850",lineHeight:1.4}}>{advMsg}</div>}
            {!modelInfo?.wall_slices_ready&&<div style={{marginTop:4,fontSize:10,color:"var(--text-3)"}}>Run the full pipeline first to extract wall slices.</div>}
          </div>
        )}
      </div>

    </aside>
  );
}
