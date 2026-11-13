import { useMemo, useState } from "react";
import { colorForMpLabel } from "./MpObjects3D";

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

const BIM_ITEMS = [
  ["walls", "Walls"],
  ["rooms", "Room slabs"],
  ["doors", "Doors"],
  ["windows", "Windows"],
];

export default function LayersPanel({
  showBim3D, setShowBim3D,
  bimFilters = { walls: true, rooms: true, doors: true, windows: true },
  setBimFilters,
  showCloud, setShowCloud, cloudReady, cloudPoints,
  showTexture, setShowTexture, textureOpacity, setTextureOpacity,
  showMpEquip, setShowMpEquip,
  showMpSweeps, setShowMpSweeps,
  showMpPoints = true, setShowMpPoints,
  showMpLive = true, setShowMpLive,
  hiddenMpLabels = [], setHiddenMpLabels,
  instances = [],
  inventory = [],
  activeFloor = "all",
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

  const labelInfo = useMemo(() => {
    const floorNum = activeFloor === "all" || activeFloor == null ? null : Number(activeFloor);
    const names = {};
    inventory.forEach((r) => { names[r.label] = r.cz || r.en || r.label; });
    const counts = {};
    instances.forEach((inst) => {
      if (!inst?.s2f_position) return;
      if (floorNum !== null && inst.floor_idx != null && inst.floor_idx !== floorNum) return;
      counts[inst.label] = (counts[inst.label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => ({ label, count, name: names[label] || label }))
      .sort((a, b) => b.count - a.count);
  }, [instances, inventory, activeFloor]);

  const toggleLabel = (label) =>
    setHiddenMpLabels?.((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );

  const toggleBim = (key, val) =>
    setBimFilters?.((prev) => ({ ...prev, [key]: val }));

  const visibleEquipCount = labelInfo.reduce(
    (acc, item) => (hiddenMpLabels.includes(item.label) ? acc : acc + item.count),
    0
  );
  const totalEquipCount = labelInfo.reduce((acc, item) => acc + item.count, 0);
  const equipSub = mpStats
    ? (hiddenMpLabels.length > 0 && labelInfo.length > 0
        ? `${visibleEquipCount} / ${totalEquipCount} visible`
        : `${totalEquipCount} items on floor · ${mpStats.instances} total`)
    : "Asset markers";

  return (
    <div className={`s2f-layers${open ? "" : " collapsed"}`} onPointerDown={(e) => e.stopPropagation()}>
      <button className="s2f-layers-head" onClick={() => setOpen((v) => !v)}>
        <span>Layers</span>
        <span className="s2f-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="s2f-layers-body">
          <Row label="Walls & floors" sub="Interactive BIM entities" checked={showBim3D} onChange={setShowBim3D}>
            {setBimFilters && (
              <div className="s2f-layer-extra s2f-bim-grid">
                {BIM_ITEMS.map(([k, label]) => (
                  <label key={k} className="s2f-mini-check">
                    <input
                      type="checkbox"
                      checked={!!bimFilters[k]}
                      onChange={(e) => toggleBim(k, e.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            )}
          </Row>
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
          <Row label="Equipment & MEP" sub={equipSub} checked={showMpEquip} onChange={setShowMpEquip}>
            {setHiddenMpLabels && (
              <div className="s2f-layer-extra">
                <div className="s2f-mini-section" style={{ marginTop: 2 }}>
                  <span>Equipment types</span>
                  <span>
                    <button type="button" className="s2f-link" onClick={() => setHiddenMpLabels([])}>all</button>
                    {" · "}
                    <button type="button" className="s2f-link" onClick={() => setHiddenMpLabels(labelInfo.map((l) => l.label))}>none</button>
                  </span>
                </div>
                {labelInfo.length === 0 ? (
                  <div className="s2f-hint">No equipment on this floor</div>
                ) : (
                  <div className="s2f-equip-list">
                    {labelInfo.map(({ label, count, name }) => (
                      <label key={label} className="s2f-mini-check" title={label}>
                        <input
                          type="checkbox"
                          checked={!hiddenMpLabels.includes(label)}
                          onChange={() => toggleLabel(label)}
                        />
                        <i style={{ background: colorForMpLabel(label) }} />
                        <span className="s2f-mini-name">{name}</span>
                        <em>{count}</em>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Row>
          {setShowMpPoints && (
            <Row
              label="Viewpoints"
              sub={mpStats ? `${mpStats.points} saved pins` : "Saved camera pins"}
              checked={showMpPoints}
              onChange={setShowMpPoints}
            />
          )}
          {setShowMpLive && (
            <Row
              label="Live 360° camera"
              sub="Current showcase pose"
              checked={showMpLive}
              onChange={setShowMpLive}
            />
          )}
          <Row label="360° sweep nodes" sub={mpStats ? `${mpStats.sweeps} panoramas` : "Capture positions"} checked={showMpSweeps} onChange={setShowMpSweeps} />
        </div>
      )}
    </div>
  );
}

