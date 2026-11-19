import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { colorForMpLabel, SUPPORTED_EQUIPMENT_LABELS } from "./MpObjects3D";

const SDK_BOOTSTRAP = "https://api.matterport.com/sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.es6.js";

export default function MpShowcasePanel({
  apiBase = "/api",
  mpConfig,
  points = [],
  sweeps = {},
  instances = [],
  placedEquipment = [],
  inventory = [],
  activeFloor = "all",
  saveName = null,
  livePose = null,
  onPoseUpdate,
  onDataChanged,
  onFocus3D,
  onEnterFpv,
  onSelectMpItem,
  onAddEquipmentFromMp,
  labelFilter,
  setLabelFilter,
  pendingCommand = null,
  onCommandConsumed,
  onClose,
  full = false,
}) {
  const [tab, setTab] = useState("inventory"); // "points" | "sweeps" | "inventory"
  const [expandedLabel, setExpandedLabel] = useState("dvere"); // auto-expand doors first
  const [newPointName, setNewPointName] = useState("");
  const [newPointNote, setNewPointNote] = useState("");
  const [tourRunning, setTourRunning] = useState(false);
  const [tourIdx, setTourIdx] = useState(0);
  const [sdkState, setSdkState] = useState("loading"); // "loading" | "connected" | "embed"
  const [embedSize, setEmbedSize] = useState("compact"); // "compact" | "expanded" | "hidden"
  const [currentSweepId, setCurrentSweepId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  const iframeRef = useRef(null);
  const sdkRef = useRef(null);
  const wsRef = useRef(null);
  const tourTimerRef = useRef(null);

  const modelId = mpConfig?.model_id || "yQPhyaCwigp";
  const appKey = mpConfig?.application_key || "";
  const sweepList = useMemo(() => Object.values(sweeps || {}), [sweeps]);

  const withTransitionRetry = useCallback(async (fn, attempt = 0) => {
    try {
      return await fn();
    } catch (e) {
      if (/transition/i.test(String(e)) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        return withTransitionRetry(fn, attempt + 1);
      }
      throw e;
    }
  }, []);

  const executeShowcaseMove = useCallback(async (cmd) => {
    if (!cmd) return;
    const sdk = sdkRef.current;
    if (cmd.sweep_id) setCurrentSweepId(cmd.sweep_id);
    if (!sdk) return;
    try {
      const transition = sdk.Camera?.TransitionType?.FLY ?? sdk.Sweep?.Transition?.FLY ?? 1;
      if (cmd.sweep_id && sdk.Sweep?.moveTo) {
        await withTransitionRetry(() =>
          sdk.Sweep.moveTo(cmd.sweep_id, {
            rotation: cmd.rotation || { x: 0, y: 0 },
            transition,
            transitionTime: 1200,
          })
        );
      } else if (cmd.position && sdk.Camera?.setPose) {
        await withTransitionRetry(() =>
          sdk.Camera.setPose({
            position: cmd.position,
            rotation: cmd.rotation || { x: 0, y: 0 },
          })
        );
      } else if (cmd.rotation && sdk.Camera?.setRotation) {
        await sdk.Camera.setRotation(cmd.rotation);
      }
    } catch (err) {
      console.warn("Showcase move skipped:", err);
    }
  }, [withTransitionRetry]);

  // Expose window.__mp helper for tools/capture_sweeps & console inspection
  useEffect(() => {
    window.__mp = {
      sweeps: () => sweepList,
      move: executeShowcaseMove,
      sdk: () => sdkRef.current,
    };
    return () => {
      if (window.__mp?.sdk?.() === sdkRef.current) delete window.__mp;
    };
  }, [sweepList, executeShowcaseMove]);

  // Connect WebSocket for bi-directional camera pose & move commands
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}${apiBase}/mp/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "pose") {
          onPoseUpdate?.(msg);
          if (msg.sweep_id) setCurrentSweepId(msg.sweep_id);
        } else if (msg.type === "move") {
          executeShowcaseMove(msg);
        } else if (msg.type === "points_changed" || msg.type === "objects_changed") {
          onDataChanged?.();
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      try { ws.close(); } catch {}
    };
  }, [apiBase, executeShowcaseMove, onPoseUpdate, onDataChanged]);

  // Handle imperative command passed via React prop (e.g. from 3D/2D Inspector)
  useEffect(() => {
    if (!pendingCommand) return;
    executeShowcaseMove(pendingCommand);
    onCommandConsumed?.();
  }, [pendingCommand, executeShowcaseMove, onCommandConsumed]);

  // Connect Matterport Showcase ES6 SDK when applicationKey is configured
  const handleIframeLoad = useCallback(async () => {
    if (!appKey || !iframeRef.current) {
      setSdkState("embed");
      return;
    }
    setSdkState("loading");
    try {
      const sdkUrl = `${SDK_BOOTSTRAP}?applicationKey=${encodeURIComponent(appKey)}`;
      const { connect } = await import(/* @vite-ignore */ sdkUrl);
      const sdk = await connect(iframeRef.current);
      sdkRef.current = sdk;
      setSdkState("connected");

      sdk.Camera?.pose?.subscribe?.((pose) => {
        const payload = {
          type: "pose",
          position: pose.position,
          rotation: pose.rotation,
          sweep_id: pose.sweep,
        };
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(payload));
        }
      });
    } catch (err) {
      console.warn("Matterport SDK connect fell back to passive iframe:", err);
      setSdkState("embed");
    }
  }, [appKey]);

  const floorNum = activeFloor === "all" ? null : Number(activeFloor);
  const placedIdSet = useMemo(
    () => new Set((placedEquipment || []).map((eq) => eq.instance_id).filter(Boolean)),
    [placedEquipment]
  );

  const filteredPoints = useMemo(() => {
    return points.filter((p) => {
      if (floorNum !== null && p.floor_idx != null && p.floor_idx !== floorNum) return false;
      if (searchQuery && !p.name?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [points, floorNum, searchQuery]);

  const filteredInventory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return inventory.filter((row) => {
      if (!q) return true;
      return (
        row.label.includes(q) ||
        row.cz?.toLowerCase().includes(q) ||
        row.en?.toLowerCase().includes(q)
      );
    });
  }, [inventory, searchQuery]);

  const filteredSweeps = useMemo(() => {
    return sweepList.filter((sw) => {
      if (floorNum !== null && sw.floor_idx != null && sw.floor_idx !== floorNum) return false;
      if (searchQuery && !sw.sweep_id?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [sweepList, floorNum, searchQuery]);

  // Guided Tour interval (drives both 3D FPV and 360° Showcase)
  useEffect(() => {
    if (!tourRunning || filteredPoints.length === 0) return;
    tourTimerRef.current = setInterval(() => {
      setTourIdx((prev) => {
        const next = (prev + 1) % filteredPoints.length;
        const pt = filteredPoints[next];
        if (pt) {
          fetch(`${apiBase}/mp/points/${pt.id}/go`, { method: "POST" }).catch(() => {});
          if (onEnterFpv) onEnterFpv({ kind: "point", data: pt });
          else if (pt.s2f_position) onFocus3D?.(pt.s2f_position);
        }
        return next;
      });
    }, 4500);
    return () => clearInterval(tourTimerRef.current);
  }, [tourRunning, filteredPoints, apiBase, onFocus3D, onEnterFpv]);

  const handleSavePoint = async (e) => {
    e.preventDefault();
    if (!newPointName.trim()) return;
    try {
      const body = {
        name: newPointName.trim(),
        note: newPointNote.trim(),
        position: livePose?.position || { x: 0, y: 1.5, z: 0 },
        rotation: livePose?.rotation || { x: 0, y: 0 },
        sweep_id: currentSweepId || livePose?.sweep_id || null,
      };
      const res = await fetch(`${apiBase}/mp/points`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      setNewPointName("");
      setNewPointNote("");
      setStatusMsg("Saved viewpoint.");
      onDataChanged?.();
    } catch (err) {
      setStatusMsg(`Save failed: ${err.message}`);
    }
  };

  const handleDeletePoint = async (id) => {
    try {
      await fetch(`${apiBase}/mp/points/${id}`, { method: "DELETE" });
      onDataChanged?.();
    } catch {}
  };

  const handleFlyToInstance = async (inst, enter3dFpv = true) => {
    if (enter3dFpv) {
      onEnterFpv?.({ kind: "instance", data: inst });
    }
    try {
      const res = await fetch(
        `${apiBase}/mp/goto-instance/${inst.instance_id}${saveName ? `?save_name=${encodeURIComponent(saveName)}` : ""}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (data?.sweep_id) setCurrentSweepId(data.sweep_id);
      if (!enter3dFpv && data?.target_s2f_position) onFocus3D?.(data.target_s2f_position);
    } catch {}
  };

  const handleSaveClassAsPoints = async (label) => {
    try {
      const res = await fetch(`${apiBase}/mp/inventory/save-as-points/${label}`, { method: "POST" });
      const data = await res.json();
      setStatusMsg(`Created ${data.created_count || 0} viewpoints for ${label}`);
      onDataChanged?.();
    } catch {}
  };

  const ifcExportUrl = `${apiBase}/mp/export/ifc${saveName ? `?save_name=${encodeURIComponent(saveName)}` : ""}`;
  const iframeSrc = `https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1&qs=1&gt=0&hr=0&mls=1${appKey ? `&applicationKey=${encodeURIComponent(appKey)}` : ""}`;
  const embedHeight = embedSize === "hidden" ? 0 : embedSize === "expanded" ? 390 : 235;

  // In `full` mode the 360° embed fills the left side and the inventory sits in a right column.
  const place = (row) => (full ? { gridColumn: 2, gridRow: row, minHeight: 0 } : {});
  return (
    <div style={{
      ...(full
        ? { display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gridTemplateRows: "auto auto auto auto minmax(0,1fr)" }
        : { display: "flex", flexDirection: "column" }),
      height: "100%", width: "100%",
      background: "var(--bg-panel, #111827)", color: "var(--text-1, #f3f4f6)",
      borderLeft: "1px solid rgba(var(--fg-rgb, 255,255,255), 0.1)",
      fontSize: 12,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px", borderBottom: "1px solid rgba(var(--fg-rgb, 255,255,255), 0.08)",
        ...place(1),
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>🌐</span>
          <strong style={{ fontSize: 12.5 }}>Equipment & 360° View</strong>
          <span style={{
            fontSize: 10, padding: "2px 6px", borderRadius: 99,
            background: sdkState === "connected" ? "rgba(34,197,94,0.16)" : "rgba(56,189,248,0.14)",
            color: sdkState === "connected" ? "#4ade80" : "#38bdf8",
          }}>
            {sdkState === "connected" ? "SDK Sync" : appKey ? "Embed" : "360° Embed"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {!full && <button
            onClick={() =>
              setEmbedSize((s) => (s === "compact" ? "expanded" : s === "expanded" ? "hidden" : "compact"))
            }
            style={{
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
              color: "#cbd5e1", borderRadius: 5, padding: "3px 7px", fontSize: 10.5, cursor: "pointer",
            }}
            title="Cycle 360° Showcase height (Compact / Tall / Hidden)"
          >
            {embedSize === "hidden" ? "Show 360°" : embedSize === "compact" ? "⤢ Tall" : "⤡ Hide"}
          </button>}
          <a
            href={ifcExportUrl}
            download={`${modelId}_matterport.ifc`}
            style={{
              background: "rgba(168,85,247,0.16)", border: "1px solid rgba(168,85,247,0.35)",
              color: "#c084fc", borderRadius: 5, padding: "3px 7px",
              fontSize: 10.5, fontWeight: 600, textDecoration: "none",
            }}
            title="Download Matterport Equipment IFC4"
          >
            ↓ IFC4
          </a>
          {onClose && <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", color: "var(--text-2, #9ca3af)",
              cursor: "pointer", fontSize: 15, padding: "2px 5px",
            }}
            title="Close Panel"
          >
            ✕
          </button>}
        </div>
      </div>

      {/* Live Matterport 360° Embed (renders directly regardless of SDK key) */}
      {(full || embedSize !== "hidden") && (
        <div style={full
          ? { position: "relative", gridColumn: 1, gridRow: "1 / 6", minHeight: 0, background: "#05070e" }
          : { position: "relative", height: embedHeight, flexShrink: 0, background: "#05070e", transition: "height 0.2s ease" }}>
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            title="Matterport 360° Showcase"
            allow="fullscreen *; xr-spatial-tracking"
            onLoad={handleIframeLoad}
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
          {!appKey && (
            <div style={{
              position: "absolute", bottom: 6, right: 6, pointerEvents: "none",
              background: "rgba(15,23,42,0.82)", color: "#94a3b8", fontSize: 9.5,
              padding: "2px 7px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)",
            }}>
              Use 👁 FPV below for instant 3D camera jump
            </div>
          )}
        </div>
      )}

      {/* Tabs + Search */}
      <div style={{
        display: "flex", gap: 4, padding: "8px 10px 6px",
        borderBottom: "1px solid rgba(var(--fg-rgb, 255,255,255), 0.08)",
        ...place(2),
      }}>
        {[
          { id: "inventory", label: `Inventář (${inventory.length})` },
          { id: "points", label: `Body (${filteredPoints.length})` },
          { id: "sweeps", label: `Objekty (${filteredSweeps.length})` },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: "5px 6px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              background: tab === t.id ? "rgba(var(--accent-rgb, 56,189,248), 0.18)" : "rgba(var(--fg-rgb, 255,255,255), 0.04)",
              color: tab === t.id ? "var(--accent, #38bdf8)" : "var(--text-2, #9ca3af)",
              border: `1px solid ${tab === t.id ? "rgba(var(--accent-rgb, 56,189,248), 0.4)" : "transparent"}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center", ...place(3) }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search dvere, okno, radiator, sweep..."
          style={{
            flex: 1, padding: "5px 8px", borderRadius: 6, fontSize: 11,
            background: "rgba(var(--fg-rgb, 255,255,255), 0.05)",
            border: "1px solid rgba(var(--fg-rgb, 255,255,255), 0.12)",
            color: "var(--text-1, #f3f4f6)",
          }}
        />
        {labelFilter && (
          <button
            onClick={() => setLabelFilter?.(null)}
            style={{
              fontSize: 10, padding: "4px 7px", borderRadius: 5, cursor: "pointer",
              background: "rgba(245,158,11,0.18)", border: "1px solid rgba(245,158,11,0.4)",
              color: "#fbbf24",
            }}
          >
            Clear: {labelFilter}
          </button>
        )}
      </div>

      {statusMsg && (
        <div style={{ padding: "2px 12px 4px", fontSize: 10.5, color: "var(--green)", ...place(4) }}>
          {statusMsg}
        </div>
      )}

      {/* Tab Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 10px 12px", ...place(5) }}>
        {tab === "inventory" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {filteredInventory.map((row) => {
              const isExpanded = expandedLabel === row.label;
              const isFilter = labelFilter === row.label;
              const isSupportedEquip = SUPPORTED_EQUIPMENT_LABELS.includes(row.label);
              const matchingFloorInsts = instances.filter(
                (i) => i.label === row.label && (floorNum === null || i.floor_idx === floorNum)
              );
              const placedHereCount = matchingFloorInsts.filter((i) =>
                placedIdSet.has(i.instance_id)
              ).length;
              const firstInst = matchingFloorInsts[0] || instances.find((i) => i.label === row.label);

              return (
                <div
                  key={row.label}
                  style={{
                    borderRadius: 7,
                    background: "rgba(var(--fg-rgb, 255,255,255), 0.035)",
                    border: `1px solid ${isFilter ? colorForMpLabel(row.label) : "rgba(var(--fg-rgb, 255,255,255), 0.07)"}`,
                    padding: "6px 8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 9, height: 9, borderRadius: "50%",
                        background: colorForMpLabel(row.label), flexShrink: 0,
                      }}
                    />
                    <div
                      onClick={() => setExpandedLabel(isExpanded ? null : row.label)}
                      style={{ flex: 1, cursor: "pointer" }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {row.cz} <span style={{ color: "var(--text-3, #6b7280)", fontWeight: 400 }}>({row.en})</span>
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-3, #9ca3af)" }}>
                        {floorNum !== null ? `${matchingFloorInsts.length} on floor · ` : ""}{row.count} total
                        {isSupportedEquip && ` · ${placedHereCount} in 3D`}
                      </div>
                    </div>
                    {isSupportedEquip && onAddEquipmentFromMp && matchingFloorInsts.length > 0 && (
                      <button
                        onClick={async () => {
                          const res = await onAddEquipmentFromMp({
                            labels: [row.label],
                            floorIdx: floorNum,
                          });
                          if (res) setStatusMsg(`Added ${res.added} ${row.en} to 3D Viewer.`);
                        }}
                        disabled={placedHereCount >= matchingFloorInsts.length}
                        style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 4,
                          cursor: placedHereCount >= matchingFloorInsts.length ? "default" : "pointer",
                          background: placedHereCount >= matchingFloorInsts.length
                            ? "rgba(34,197,94,0.12)"
                            : "rgba(34,197,94,0.22)",
                          border: "1px solid rgba(34,197,94,0.45)",
                          color: "#4ade80", fontWeight: 700,
                        }}
                        title={`Add all ${row.en} on this floor to 3D Viewer`}
                      >
                        {placedHereCount >= matchingFloorInsts.length ? "✓ 3D" : "+ 3D"}
                      </button>
                    )}
                    {firstInst && (
                      <button
                        onClick={() => {
                          setExpandedLabel(row.label);
                          handleFlyToInstance(firstInst, true);
                        }}
                        style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                          background: "rgba(56,189,248,0.2)", border: "1px solid rgba(56,189,248,0.45)",
                          color: "#38bdf8", fontWeight: 700,
                        }}
                        title={`Enter First-Person View looking at ${row.en}`}
                      >
                        👁 FPV
                      </button>
                    )}
                    <button
                      onClick={() => setLabelFilter?.(isFilter ? null : row.label)}
                      style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                        background: isFilter ? "rgba(56,189,248,0.22)" : "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-1, #e5e7eb)",
                      }}
                      title="Isolate class in 3D & 2D"
                    >
                      {isFilter ? "Showing" : "Filter"}
                    </button>
                    {!saveName && (
                      <button
                        onClick={() => handleSaveClassAsPoints(row.label)}
                        style={{
                          fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                          background: "rgba(34,197,94,0.14)", border: "1px solid rgba(34,197,94,0.3)",
                          color: "#4ade80",
                        }}
                        title="Save all instances as Viewpoints"
                      >
                        +Pts
                      </button>
                    )}
                  </div>

                  {isExpanded && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: 4 }}>
                      {matchingFloorInsts.length === 0 && (
                        <div style={{ fontSize: 10.5, color: "#9ca3af" }}>
                          No {row.en} on Floor {floorNum}. Switch to All Floors to see all {row.count}.
                        </div>
                      )}
                      {matchingFloorInsts.slice(0, 50).map((inst) => (
                        <div
                          key={inst.instance_id}
                          onClick={() => handleFlyToInstance(inst, true)}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            fontSize: 11, cursor: "pointer", padding: "3px 5px", borderRadius: 4,
                            background: "rgba(255,255,255,0.025)",
                          }}
                          title="Click to jump here in 3D First-Person View"
                        >
                          <span style={{ fontFamily: "monospace", color: "var(--text-1, #e2e8f0)" }}>
                            {inst.instance_id}
                            {inst.floor_idx != null ? ` · F${inst.floor_idx}` : ""}
                            {inst.room_name ? ` (${inst.room_name})` : ""}
                          </span>
                          <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                            {isSupportedEquip && onAddEquipmentFromMp && (
                              <button
                                disabled={placedIdSet.has(inst.instance_id)}
                                onClick={async () => {
                                  const res = await onAddEquipmentFromMp({ instanceIds: [inst.instance_id] });
                                  if (res) setStatusMsg(`Added ${inst.instance_id} to 3D Viewer.`);
                                }}
                                style={{
                                  fontSize: 10, padding: "2px 6px", borderRadius: 4,
                                  cursor: placedIdSet.has(inst.instance_id) ? "default" : "pointer",
                                  background: placedIdSet.has(inst.instance_id)
                                    ? "rgba(34,197,94,0.12)"
                                    : "rgba(34,197,94,0.22)",
                                  border: "1px solid rgba(34,197,94,0.45)",
                                  color: "#4ade80", fontWeight: 700,
                                }}
                                title={placedIdSet.has(inst.instance_id) ? "Already in 3D Viewer" : "Add to 3D Viewer"}
                              >
                                {placedIdSet.has(inst.instance_id) ? "✓ 3D" : "+ 3D"}
                              </button>
                            )}
                            <button
                              onClick={() => handleFlyToInstance(inst, true)}
                              style={{
                                fontSize: 10, padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                                background: "rgba(56,189,248,0.22)", border: "1px solid rgba(56,189,248,0.4)",
                                color: "#38bdf8", fontWeight: 700,
                              }}
                              title="Put 3D Camera near this object & point directly at it"
                            >
                              👁 FPV
                            </button>
                            <button
                              onClick={() => {
                                onSelectMpItem?.({ kind: "instance", data: inst });
                                if (inst.s2f_position) onFocus3D?.(inst.s2f_position);
                              }}
                              style={{
                                fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
                                background: "rgba(255,255,255,0.08)", border: "none", color: "#e5e7eb",
                              }}
                              title="Orbit around object in 3D"
                            >
                              Orbit
                            </button>
                          </div>
                        </div>
                      ))}
                      {matchingFloorInsts.length > 50 && (
                        <div style={{ fontSize: 10, color: "var(--text-3, #9ca3af)" }}>
                          Showing first 50 of {matchingFloorInsts.length} instances
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "points" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!saveName && (
              <form onSubmit={handleSavePoint} style={{ display: "flex", flexDirection: "column", gap: 5, padding: 8, borderRadius: 7, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <input
                  value={newPointName}
                  onChange={(e) => setNewPointName(e.target.value)}
                  placeholder="Viewpoint name..."
                  style={{ padding: "5px 7px", borderRadius: 5, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: 11 }}
                />
                <div style={{ display: "flex", gap: 5 }}>
                  <input
                    value={newPointNote}
                    onChange={(e) => setNewPointNote(e.target.value)}
                    placeholder="Optional note..."
                    style={{ flex: 1, padding: "5px 7px", borderRadius: 5, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: 11 }}
                  />
                  <button
                    type="submit"
                    style={{
                      padding: "5px 10px", borderRadius: 5, border: "none", cursor: "pointer",
                      background: "#0284c7", color: "#fff", fontWeight: 600, fontSize: 11,
                    }}
                  >
                    + Save Pose
                  </button>
                </div>
              </form>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "var(--text-3, #9ca3af)" }}>Saved Viewpoints</span>
              <button
                onClick={() => setTourRunning((v) => !v)}
                disabled={filteredPoints.length === 0}
                style={{
                  fontSize: 10.5, padding: "3px 8px", borderRadius: 5, cursor: "pointer",
                  background: tourRunning ? "rgba(239,68,68,0.2)" : "rgba(34,197,94,0.16)",
                  border: `1px solid ${tourRunning ? "rgba(239,68,68,0.4)" : "rgba(34,197,94,0.35)"}`,
                  color: tourRunning ? "#f87171" : "#4ade80", fontWeight: 600,
                }}
              >
                {tourRunning ? `Stop Tour (${tourIdx + 1}/${filteredPoints.length})` : "▶ Guided Tour"}
              </button>
            </div>

            {filteredPoints.map((pt) => (
              <div
                key={pt.id}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 8px", borderRadius: 6,
                  background: "rgba(255,255,255,0.035)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{pt.name}</div>
                  {pt.note && <div style={{ fontSize: 10, color: "var(--text-3, #9ca3af)" }}>{pt.note}</div>}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => {
                      fetch(`${apiBase}/mp/points/${pt.id}/go`, { method: "POST" }).catch(() => {});
                      if (onEnterFpv) onEnterFpv({ kind: "point", data: pt });
                      else if (pt.s2f_position) onFocus3D?.(pt.s2f_position);
                    }}
                    style={{
                      fontSize: 10.5, padding: "3px 8px", borderRadius: 4, border: "none",
                      background: "rgba(56,189,248,0.2)", color: "#38bdf8", cursor: "pointer", fontWeight: 700,
                    }}
                  >
                    👁 Go FPV
                  </button>
                  {!saveName && (
                    <button
                      onClick={() => handleDeletePoint(pt.id)}
                      style={{
                        fontSize: 10.5, padding: "3px 6px", borderRadius: 4, border: "none",
                        background: "rgba(239,68,68,0.16)", color: "#f87171", cursor: "pointer",
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "sweeps" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {filteredSweeps.map((sw) => {
              const detCount = sw.detections?.length || 0;
              return (
                <div
                  key={sw.sweep_id}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 8px", borderRadius: 6,
                    background: currentSweepId === sw.sweep_id ? "rgba(56,189,248,0.14)" : "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <div>
                    <div style={{ fontFamily: "monospace", fontWeight: 600 }}>{sw.sweep_id}</div>
                    <div style={{ fontSize: 10, color: "var(--text-3, #9ca3af)" }}>
                      Floor {sw.floor_idx ?? "?"} {sw.room_name ? `· ${sw.room_name}` : ""} &middot; {detCount} detections
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setCurrentSweepId(sw.sweep_id);
                      fetch(`${apiBase}/mp/move`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sweep_id: sw.sweep_id, position: sw.position }),
                      }).catch(() => {});
                      if (onEnterFpv) onEnterFpv({ kind: "sweep", data: sw });
                      else if (sw.s2f_position) onFocus3D?.(sw.s2f_position);
                    }}
                    style={{
                      fontSize: 10.5, padding: "3px 8px", borderRadius: 4, border: "none",
                      background: "rgba(96,165,250,0.22)", color: "#60a5fa", cursor: "pointer", fontWeight: 700,
                    }}
                  >
                    👁 Fly FPV
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
