import { useState } from "react";
import AlgorithmSettings from "./AlgorithmSettings";
import { singleFloorBody } from "../algoParams";

/** Right-hand drawer: re-run wall + room detection for a single floor of the live session. */
export default function RedetectDrawer({ params, setParams, roomMode, setRoomMode, modelInfo, activeFloor, disabledReason, onDone, onClose }) {
  const nFloors = modelInfo?.floor_levels?.length || 1;
  const [floor, setFloor] = useState(activeFloor === "all" ? 0 : Math.min(Number(activeFloor) || 0, nFloors - 1));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const ready = modelInfo?.wall_slices_ready;
  const blocked = disabledReason || (!ready ? "Run the full pipeline first to extract wall slices." : "");

  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/c2b/walls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(singleFloorBody(floor, params, roomMode)),
      });
      const d = await r.json();
      if (!r.ok) setMsg("⚠ " + (d.detail ?? "Error"));
      else {
        setMsg(`✓ ${d.lines_count} walls · ${d.n_doors}D ${d.n_windows}W · ${d.n_rooms} rooms`);
        onDone?.();
      }
    } catch {
      setMsg("⚠ Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="s2f-drawer" onPointerDown={(e) => e.stopPropagation()}>
      <header className="s2f-drawer-head">
        <div>
          <h2>Re-detect floor</h2>
          <p className="s2f-hint">Runs wall, opening and room detection on one floor. All open views update automatically.</p>
        </div>
        <button className="s2f-iconbtn" onClick={onClose} title="Close">✕</button>
      </header>
      <div className="s2f-drawer-body">
        <AlgorithmSettings params={params} setParams={setParams} roomMode={roomMode} setRoomMode={setRoomMode} sections={["detection", "rooms"]} />
      </div>
      <footer className="s2f-drawer-foot">
        <label className="s2f-row" style={{ alignItems: "center" }}>
          <span className="s2f-muted">Floor</span>
          <select className="s2f-input" value={floor} onChange={(e) => setFloor(Number(e.target.value))}>
            {Array.from({ length: nFloors }, (_, i) => <option key={i} value={i}>Floor {i}</option>)}
          </select>
        </label>
        <button className="s2f-btn s2f-btn-primary s2f-btn-block" id="c2b-walls-btn" onClick={run} disabled={busy || !!blocked}>
          {busy ? "Detecting…" : `Re-detect floor ${floor}`}
        </button>
        {(blocked || msg) && <div className={msg.startsWith("✓") ? "s2f-ok" : "s2f-error"}>{blocked || msg}</div>}
      </footer>
    </aside>
  );
}

