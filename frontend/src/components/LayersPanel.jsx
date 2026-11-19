import { useMemo, useState } from "react";
import {
  colorForMpLabel,
  EQUIPMENT_META,
  SUPPORTED_EQUIPMENT_LABELS,
} from "./MpObjects3D";

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
  showMpHints3D = true, setShowMpHints3D,
  showMpSweeps, setShowMpSweeps,
  showMpPoints = true, setShowMpPoints,
  showMpLive = true, setShowMpLive,
  hiddenMpLabels = [], setHiddenMpLabels,
  instances = [],
  placedEquipment = [],
  inventory = [],
  activeFloor = "all",
  cloudColors, setCloudColors,
  mpStats,
  onAddEquipmentFromMp,
  onClearEquipmentByLabel,
}) {
  const [open, setOpen] = useState(true);
  const [busyLabel, setBusyLabel] = useState(null);
  const fmt = (n) => n?.toLocaleString?.() ?? "—";

  const updateColor = (key, value) =>
    setCloudColors((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem("s2f_cloud_colors", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });

  const labelInfo = useMemo(() => {
    const floorNum = activeFloor === "all" || activeFloor == null ? null : Number(activeFloor);
    const onFloor = (item) =>
      item?.floor_idx != null && (floorNum === null || Number(item.floor_idx) === floorNum);

    const names = {};
    inventory.forEach((r) => { names[r.label] = r.en || r.cz || r.label; });

    const detectedCounts = {};
    instances.forEach((inst) => {
      if (!SUPPORTED_EQUIPMENT_LABELS.includes(inst?.label)) return;
      if (!(inst?.snapped_s2f_position || inst?.s2f_position) || !onFloor(inst)) return;
      detectedCounts[inst.label] = (detectedCounts[inst.label] || 0) + 1;
    });

    const placedCounts = {};
    placedEquipment.forEach((eq) => {
      if (!SUPPORTED_EQUIPMENT_LABELS.includes(eq?.label)) return;
      if (!onFloor(eq)) return;
      placedCounts[eq.label] = (placedCounts[eq.label] || 0) + 1;
    });

    return SUPPORTED_EQUIPMENT_LABELS
      .map((label) => {
        const meta = EQUIPMENT_META[label];
        return {
          label,
          count: detectedCounts[label] || 0,
          placed: placedCounts[label] || 0,
          name: meta?.en || names[label] || label,
          czName: meta?.cz || names[label] || label,
        };
      })
      .filter((row) => row.count > 0 || row.placed > 0);
  }, [instances, placedEquipment, inventory, activeFloor]);

  const toggleLabel = (label) =>
    setHiddenMpLabels?.((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );

  const toggleBim = (key, val) =>
    setBimFilters?.((prev) => ({ ...prev, [key]: val }));

  const totalEquipCount = labelInfo.reduce((acc, item) => acc + item.count, 0);
  const totalPlacedCount = labelInfo.reduce((acc, item) => acc + item.placed, 0);
  const equipSub = labelInfo.length > 0
    ? `${totalPlacedCount} placed · ${totalEquipCount} detected`
    : mpStats
      ? "No fire/light objects on floor"
      : "Asset markers";

  const handleBulkAdd = async (label) => {
    if (!onAddEquipmentFromMp || busyLabel) return;
    setBusyLabel(label);
    try {
      await onAddEquipmentFromMp({
        labels: [label],
        floorIdx: activeFloor === "all" ? null : Number(activeFloor),
      });
    } finally {
      setBusyLabel(null);
    }
  };

  const handleBulkClear = async (label) => {
    if (!onClearEquipmentByLabel || busyLabel) return;
    setBusyLabel(label);
    try {
      await onClearEquipmentByLabel(label, activeFloor);
    } finally {
      setBusyLabel(null);
    }
  };

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
                {setShowMpHints3D && (
                  <label className="s2f-mini-check" style={{ marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={!!showMpHints3D}
                      onChange={(e) => setShowMpHints3D(e.target.checked)}
                    />
                    <span className="s2f-mini-name">Show unplaced AI hints</span>
                  </label>
                )}
                <div className="s2f-mini-section" style={{ marginTop: 2 }}>
                  <span>Equipment types</span>
                  <span>
                    <button type="button" className="s2f-link" onClick={() => setHiddenMpLabels([])}>all</button>
                    {" · "}
                    <button type="button" className="s2f-link" onClick={() => setHiddenMpLabels(labelInfo.map((l) => l.label))}>none</button>
                  </span>
                </div>
                {labelInfo.length === 0 ? (
                  <div className="s2f-hint">
                    No fire extinguishers or light sources on this floor
                  </div>
                ) : (
                  <div className="s2f-equip-list">
                    {labelInfo.map(({ label, count, placed, name, czName }) => {
                      const isBusy = busyLabel === label;
                      return (
                        <div
                          key={label}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "2px 0",
                          }}
                        >
                          <label
                            className="s2f-mini-check"
                            style={{ flex: 1, minWidth: 0, padding: 0 }}
                            title={`${name} (${czName})`}
                          >
                            <input
                              type="checkbox"
                              checked={!hiddenMpLabels.includes(label)}
                              onChange={() => toggleLabel(label)}
                            />
                            <i style={{ background: colorForMpLabel(label) }} />
                            <span className="s2f-mini-name">{name}</span>
                            <em style={{ marginLeft: "auto", flexShrink: 0 }}>
                              {placed}/{count}
                            </em>
                          </label>
                          {onAddEquipmentFromMp && placed < count && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleBulkAdd(label)}
                              title={`Add all ${name} from MatterportIn3D to 3D Viewer`}
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: "1px 5px",
                                borderRadius: 4,
                                cursor: isBusy ? "wait" : "pointer",
                                background: "rgba(34,197,94,0.16)",
                                border: "1px solid rgba(34,197,94,0.4)",
                                color: "#4ade80",
                                flexShrink: 0,
                              }}
                            >
                              {isBusy ? "…" : "+ Add all"}
                            </button>
                          )}
                          {onClearEquipmentByLabel && placed > 0 && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleBulkClear(label)}
                              title={`Remove placed ${name} from 3D Viewer`}
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "1px 5px",
                                borderRadius: 4,
                                cursor: isBusy ? "wait" : "pointer",
                                background: "rgba(var(--red-rgb),0.14)",
                                border: "1px solid rgba(var(--red-rgb),0.35)",
                                color: "var(--red)",
                                flexShrink: 0,
                              }}
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      );
                    })}
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
              label="Live / FPV camera"
              sub="Current showcase or FPV pose"
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

