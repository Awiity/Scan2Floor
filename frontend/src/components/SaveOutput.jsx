import { useState } from "react";

/** Compact popover to save the current live output under a name. */
export default function SaveOutput({ defaultName, cloudColors }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const effective = name.trim() || defaultName || "output";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      const d = await fetch("/api/saves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: effective,
          wall_color: cloudColors?.wall ?? "#f5f5f5",
          floor_color: cloudColors?.floor ?? "#2ed16b",
        }),
      }).then((r) => r.json());
      setMsg(d.status === "ok" ? `✓ Saved as “${d.name}”` : "⚠ Save failed");
    } catch {
      setMsg("⚠ Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s2f-pop-wrap">
      <button className={`s2f-btn s2f-btn-sm${open ? " active" : ""}`} onClick={() => setOpen((v) => !v)}>Save output</button>
      {open && (
        <div className="s2f-pop" onPointerDown={(e) => e.stopPropagation()}>
          <div className="s2f-slider-label">Save current output</div>
          <div className="s2f-row">
            <input
              id="save-name-input"
              className="s2f-input s2f-mono"
              value={name}
              placeholder={defaultName || "output-name"}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              autoFocus
            />
            <button id="save-output-btn" className="s2f-btn s2f-btn-primary" onClick={save} disabled={busy}>{busy ? "…" : "Save"}</button>
          </div>
          {msg && <div className={msg.startsWith("✓") ? "s2f-ok" : "s2f-error"}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

