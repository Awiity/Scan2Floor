import { useState } from "react";

function Row({ label, sub, checked, onChange, disabled, children }) {
  return (
    <div className={`s2f-layer${disabled ? " disabled" : ""}`}>
      <label className="s2f-layer-main">
        <span className="s2f-layer-text">
          <span className="s2f-layer-name">{label}</span>
          {sub && <span className="s2f-layer-sub">{sub}</span>}
        </span>
        <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="s2f-switch" />
      </label>
      {checked && children}
    </div>
  );
}

export default function LayersPanel({
  showBim3D, setShowBim3D,
  showCloud, setShowCloud, cloudReady, cloudPoints,
  showTexture, setShowTexture, textureOpacity, setTextureOpacity,
  showMpEquip, setShowMpEquip,
  showMpSweeps, setShowMpSweeps,
  cloudColors, setCloudColors,
  mpStats,
}) {
  const [open, setOpen] = useState(true);
  const fmt = (n) => n?.toLocaleString?.() ?? "—";

  const updateColor = (key, value) =>
    setCloudColors((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem("s2f_cloud_colors", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });

  return (
    <div className={`s2f-layers${open ? "" : " collapsed"}`} onPointerDown={(e) => e.stopPropagation()}>
      <button className="s2f-layers-head" onClick={() => setOpen((v) => !v)}>
        <span>Layers</span>
        <span className="s2f-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="s2f-layers-body">
          <Row label="Walls & floors" sub="Interactive BIM entities" checked={showBim3D} onChange={setShowBim3D} />
          <Row
            label="Point cloud"
            sub={cloudReady ? (cloudPoints ? `${fmt(cloudPoints)} pts` : "Ready") : "Not available"}
            checked={showCloud}
            onChange={setShowCloud}
            disabled={!cloudReady}
          >
            <div className="s2f-layer-extra">
              {[["wall", "Walls", "#f5f5f5"], ["floor", "Floor / ceiling", "#2ed16b"]].map(([k, label, def]) => (
                <label key={k} className="s2f-color">
                  <span>{label}</span>
                  <input type="color" value={cloudColors?.[k] ?? def} onChange={(e) => updateColor(k, e.target.value)} />
                </label>
              ))}
            </div>
          </Row>
          <Row label="Photo texture" sub="Matterport photos on mesh" checked={showTexture} onChange={setShowTexture}>
            <div className="s2f-layer-extra">
              <label className="s2f-color">
                <span>Opacity {Math.round(textureOpacity * 100)}%</span>
                <input type="range" min="0.1" max="1" step="0.05" value={textureOpacity} onChange={(e) => setTextureOpacity(parseFloat(e.target.value))} />
              </label>
            </div>
          </Row>
          <Row label="Equipment & MEP" sub={mpStats ? `${mpStats.instances} items · ${mpStats.points} pts` : "Asset markers"} checked={showMpEquip} onChange={setShowMpEquip} />
          <Row label="360° sweep nodes" sub={mpStats ? `${mpStats.sweeps} panoramas` : "Capture positions"} checked={showMpSweeps} onChange={setShowMpSweeps} />
        </div>
      )}
    </div>
  );
}

