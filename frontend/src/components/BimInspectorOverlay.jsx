import React, { useState, useCallback } from "react";

/* Design tokens */
const T = {
  bg: "rgba(30, 32, 38, 0.94)",
  blur: "blur(18px)",
  radius: 14,
  shadow: "0 12px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.10)",
  minW: 300,
  maxW: 370,
  font: "'Inter', 'Segoe UI', sans-serif",
  labelColor: "rgba(200,205,215,0.52)",
  valueColor: "#e2e5ea",
  accentWall:   "#94a3b8",
  accentDoor:   "#fbbf24",
  accentWindow: "#60a5fa",
  accentUser:   "#34d399",
  accentDetect: "#818cf8",
  divider: "rgba(255,255,255,0.07)",
  deleteBg: "rgba(185, 28, 28, 0.75)",
  deleteBgHover: "rgba(220, 38, 38, 0.95)",
  deleteBorder: "rgba(252, 165, 165, 0.25)",
};

function CardShell({ children, accentColor }) {
  return (
    <div style={{
      position: "absolute", bottom: 24, left: 24, zIndex: 22,
      background: T.bg, backdropFilter: T.blur, WebkitBackdropFilter: T.blur,
      border: T.border, borderLeft: "3px solid " + accentColor,
      borderRadius: T.radius, padding: "15px 17px", color: T.valueColor,
      boxShadow: T.shadow, fontFamily: T.font,
      minWidth: T.minW, maxWidth: T.maxW,
      animation: "bimCardIn 0.18s ease-out",
      overflowY: "auto", maxHeight: "calc(100vh - 80px)",
    }}>
      {children}
    </div>
  );
}

function CardHeader({ icon, title, badge, badgeColor, badgeBg, badgeBorder, onClose }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      marginBottom: 11, paddingBottom: 9, borderBottom: "1px solid " + T.divider,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {icon && <span style={{ fontSize: 17, lineHeight: 1 }}>{icon}</span>}
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.3px", color: T.valueColor }}>
          {title}
        </span>
        {badge && (
          <span style={{
            fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.6px", padding: "2px 6px", borderRadius: 4,
            background: badgeBg, color: badgeColor, border: "1px solid " + badgeBorder,
          }}>
            {badge}
          </span>
        )}
      </div>
      <button onClick={onClose} title="Deselect" style={{
        background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)",
        color: "rgba(200,205,215,0.6)", cursor: "pointer", fontSize: 13,
        lineHeight: 1, padding: "3px 7px", borderRadius: 6, transition: "background 0.12s, color 0.12s",
      }}
        onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.13)"; e.currentTarget.style.color = "#e2e5ea"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "rgba(200,205,215,0.6)"; }}
      >
        &#x2715;
      </button>
    </div>
  );
}

function PropGrid({ children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "9px 16px", fontSize: 11 }}>
      {children}
    </div>
  );
}

function Prop({ label, value, valueColor, span, mono }) {
  return (
    <div style={span === 2 ? { gridColumn: "span 2" } : {}}>
      <span style={{ color: T.labelColor, display: "block", marginBottom: 2, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </span>
      <span style={{ fontWeight: 600, color: valueColor || T.valueColor, fontFamily: mono ? "monospace" : T.font, fontSize: mono ? 10 : 12, lineHeight: 1.4 }}>
        {value}
      </span>
    </div>
  );
}

function SectionDivider() {
  return <div style={{ gridColumn: "span 2", height: 1, background: T.divider, margin: "2px 0" }} />;
}

function DeleteButton({ label, loading, onClick }) {
  return (
    <div style={{ marginTop: 13, paddingTop: 10, borderTop: "1px solid " + T.divider }}>
      <button onClick={onClick} disabled={loading} style={{
        width: "100%", padding: "8px 14px",
        background: loading ? "rgba(185,28,28,0.45)" : T.deleteBg,
        color: "#fecaca", border: "1px solid " + T.deleteBorder, borderRadius: 8,
        fontSize: 11.5, fontWeight: 600, fontFamily: T.font, cursor: loading ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
        transition: "background 0.15s, color 0.15s", letterSpacing: "0.2px",
      }}
        onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = T.deleteBgHover; e.currentTarget.style.color = "#fff"; }}}
        onMouseLeave={e => { if (!loading) { e.currentTarget.style.background = T.deleteBg; e.currentTarget.style.color = "#fecaca"; }}}
      >
        <span style={{ fontSize: 13 }}>&#x1F5D1;</span>
        <span>{loading ? "Deleting\u2026" : label}</span>
      </button>
    </div>
  );
}

const tooltipBase = {
  position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
  zIndex: 20, background: "rgba(22, 24, 30, 0.92)", backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)", borderRadius: 8, padding: "6px 14px", fontSize: 11.5,
  fontFamily: "'Inter', 'Segoe UI', sans-serif", display: "flex", alignItems: "center",
  gap: 9, pointerEvents: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.4)", color: "#e2e5ea",
};

function TooltipSep() {
  return <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 14 }}>|</span>;
}

/* Opening chip — shown in wall inspector list */
function OpeningChip({ op, isActive, onClick }) {
  const isDoor = op.type === "door";
  const accent = isDoor ? T.accentDoor : T.accentWindow;
  return (
    <button
      onClick={() => onClick(op)}
      title={"Click to inspect & edit this " + (isDoor ? "door" : "window")}
      style={{
        display: "flex", alignItems: "center", gap: 6, width: "100%",
        padding: "6px 9px",
        background: isActive ? (isDoor ? "rgba(251,191,36,0.18)" : "rgba(96,165,250,0.18)") : "rgba(255,255,255,0.04)",
        border: isActive ? ("1px solid " + accent + "66") : "1px solid rgba(255,255,255,0.08)",
        borderRadius: 7, cursor: "pointer", transition: "all 0.14s", textAlign: "left", fontFamily: T.font,
      }}
      onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.borderColor = accent + "44"; }}}
      onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}}
    >
      <span style={{ fontSize: 13 }}>{isDoor ? "\uD83D\uDEAA" : "\uD83E\uDE9F"}</span>
      <span style={{ flex: 1, fontSize: 11, color: T.valueColor, fontWeight: 600 }}>
        {isDoor ? "Door" : "Window"}&nbsp;
        <span style={{ color: accent, fontFamily: "monospace" }}>{op.width.toFixed(2)} m</span>
      </span>
      <span style={{
        fontSize: 9, padding: "1px 5px", borderRadius: 3,
        background: op.isUser ? "rgba(52,211,153,0.12)" : "rgba(129,140,248,0.12)",
        color: op.isUser ? T.accentUser : T.accentDetect,
        border: "1px solid " + (op.isUser ? "rgba(52,211,153,0.3)" : "rgba(129,140,248,0.3)"),
        fontWeight: 700, letterSpacing: "0.4px", textTransform: "uppercase",
      }}>
        {op.isUser ? "Manual" : "Auto"}
      </span>
      <span style={{ color: T.labelColor, fontSize: 11 }}>{isActive ? "\u25BE" : "\u203A"}</span>
    </button>
  );
}

/* Slider row */
function EditSlider({ label, value, min, max, step, unit, accent, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: T.labelColor, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: accent || T.valueColor, fontFamily: "monospace" }}>
          {value.toFixed(2)} {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: accent || T.accentWall, cursor: "pointer", height: 4 }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
        <span style={{ fontSize: 9, color: T.labelColor }}>{min}{unit}</span>
        <span style={{ fontSize: 9, color: T.labelColor }}>{max}{unit}</span>
      </div>
    </div>
  );
}

/* Inline edit panel for a single opening */
function OpeningEditPanel({ op, wallLength, onSave, onClose, onDelete, isSaving, isDeleting }) {
  const isDoor = op.type === "door";
  const accent = isDoor ? T.accentDoor : T.accentWindow;

  const initialT = (() => {
    if (typeof op.position_t === "number") return op.position_t;
    if (op.x != null && op.wall_x1 != null && op.wall_x2 != null) {
      const wl = Math.hypot(op.wall_x2 - op.wall_x1, op.wall_z2 - op.wall_z1);
      if (wl > 0.01) {
        const proj = ((op.x - op.wall_x1) * (op.wall_x2 - op.wall_x1) + (op.z - op.wall_z1) * (op.wall_z2 - op.wall_z1)) / wl;
        return Math.max(0.05, Math.min(0.95, proj / wl));
      }
    }
    return 0.5;
  })();

  const [editWidth, setEditWidth] = useState(op.width ?? op.width_m ?? (isDoor ? 0.9 : 1.2));
  const [editT, setEditT] = useState(initialT);
  const [editTopMargin, setEditTopMargin] = useState(op.top_margin ?? 0.7);
  const [editBottomMargin, setEditBottomMargin] = useState(isDoor ? 0 : (op.bottom_margin ?? 0.9));
  const [isDirty, setIsDirty] = useState(false);

  const handleSave = () => onSave({
    ...op,
    width: editWidth, width_m: editWidth,
    position_t: editT,
    top_margin: editTopMargin,
    bottom_margin: isDoor ? 0 : editBottomMargin,
  });

  return (
    <div style={{
      marginTop: 10, padding: "12px", background: "rgba(0,0,0,0.35)",
      borderRadius: 10, border: "1px solid " + accent + "33",
      animation: "bimCardIn 0.15s ease-out",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid " + T.divider }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>{isDoor ? "\uD83D\uDEAA" : "\uD83E\uDE9F"}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: accent }}>Edit {isDoor ? "Door" : "Window"}</span>
          <span style={{
            fontSize: 9, borderRadius: 3, padding: "1px 5px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px",
            color: op.isUser ? T.accentUser : T.accentDetect,
            background: op.isUser ? "rgba(52,211,153,0.1)" : "rgba(129,140,248,0.1)",
            border: "1px solid " + (op.isUser ? "rgba(52,211,153,0.25)" : "rgba(129,140,248,0.25)"),
          }}>
            {op.isUser ? "Manual" : "Detected"}
          </span>
        </div>
        <button onClick={onClose} style={{
          background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
          color: T.labelColor, cursor: "pointer", fontSize: 11, padding: "2px 6px", borderRadius: 5,
        }}>&#x2715;</button>
      </div>

      {/* Read-only info */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px", marginBottom: 12 }}>
        {[
          { label: "Type", value: isDoor ? "Door" : "Window", color: accent },
          { label: "Floor", value: "Level " + op.floorIdx, color: T.accentWindow },
          { label: "Elevation Y", value: (op.elevation_y != null ? op.elevation_y.toFixed(2) : "\u2013") + " m", mono: true },
          { label: "Void Height", value: (op.height != null ? op.height.toFixed(2) : "\u2013") + " m", mono: true },
        ].map(({ label, value, color, mono }) => (
          <div key={label}>
            <span style={{ fontSize: 9, color: T.labelColor, textTransform: "uppercase", letterSpacing: "0.5px", display: "block", marginBottom: 2 }}>{label}</span>
            <span style={{ fontSize: mono ? 10 : 11, fontWeight: 600, color: color || T.valueColor, fontFamily: mono ? "monospace" : T.font }}>{value}</span>
          </div>
        ))}
      </div>

      <div style={{ height: 1, background: T.divider, marginBottom: 12 }} />

      {/* Sliders */}
      <EditSlider label="Width" value={editWidth} min={0.3} max={Math.min(wallLength ?? 4, 4)} step={0.05} unit="m" accent={accent}
        onChange={v => { setEditWidth(v); setIsDirty(true); }} />
      <EditSlider label="Position along wall" value={Math.round(editT * 100)} min={5} max={95} step={1} unit="%" accent={accent}
        onChange={v => { setEditT(v / 100); setIsDirty(true); }} />
      <EditSlider label="Top Margin (Header)" value={editTopMargin} min={0.1} max={1.5} step={0.05} unit="m" accent={T.accentDoor}
        onChange={v => { setEditTopMargin(v); setIsDirty(true); }} />
      {!isDoor && (
        <EditSlider label="Bottom Margin (Sill)" value={editBottomMargin} min={0} max={1.5} step={0.05} unit="m" accent={T.accentWindow}
          onChange={v => { setEditBottomMargin(v); setIsDirty(true); }} />
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <button onClick={handleSave} disabled={isSaving || !isDirty} style={{
          flex: 1, padding: "8px 12px", borderRadius: 7, fontSize: 11.5, fontWeight: 700, fontFamily: T.font,
          cursor: isSaving || !isDirty ? "not-allowed" : "pointer",
          background: isDirty ? "rgba(0,200,80,0.22)" : "rgba(255,255,255,0.05)",
          border: isDirty ? "1px solid rgba(0,200,80,0.5)" : "1px solid rgba(255,255,255,0.1)",
          color: isDirty ? "#00c850" : "rgba(150,160,180,0.45)",
          transition: "all 0.14s",
        }}>
          {isSaving ? "\u23F3 Saving\u2026" : "\uD83D\uDCBE Apply Changes"}
        </button>
        <button onClick={() => onDelete(op)} disabled={isDeleting}
          title={"Delete this " + (isDoor ? "door" : "window")}
          style={{
            padding: "8px 11px", borderRadius: 7, fontSize: 13,
            cursor: isDeleting ? "not-allowed" : "pointer",
            background: "rgba(185,28,28,0.55)", border: "1px solid rgba(252,165,165,0.22)",
            color: "#fecaca", transition: "all 0.14s",
          }}
          onMouseEnter={e => { if (!isDeleting) e.currentTarget.style.background = "rgba(220,38,38,0.85)"; }}
          onMouseLeave={e => { if (!isDeleting) e.currentTarget.style.background = "rgba(185,28,28,0.55)"; }}
        >
          &#x1F5D1;
        </button>
      </div>
      {!isDirty && (
        <p style={{ margin: "8px 0 0", fontSize: 9.5, color: T.labelColor, textAlign: "center" }}>
          Adjust sliders above to enable Apply
        </p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main export
═══════════════════════════════════════════════════════════════════════════ */
export default function BimInspectorOverlay({
  selectedWall,
  onCloseWall,
  onDeleteWall,
  hoveredWall,
  hoveredRoom,
  selectedOpening,
  onCloseOpening,
  onDeleteOpening,
  hoveredOpening,
  onUpdateOpening,
}) {
  const activeWall = selectedWall;
  const activeOp   = selectedOpening;
  const [isDeletingWall, setIsDeletingWall] = useState(false);
  const [isDeletingOp,   setIsDeletingOp]   = useState(false);
  const [wallEditOp, setWallEditOp]         = useState(null);
  const [isSavingInline, setIsSavingInline] = useState(false);
  const [isDeletingInline, setIsDeletingInline] = useState(false);

  React.useEffect(() => { setWallEditOp(null); }, [activeWall?.id]);

  const handleDeleteWall = async () => {
    if (!activeWall || isDeletingWall) return;
    setIsDeletingWall(true);
    try { await onDeleteWall?.(activeWall); } finally { setIsDeletingWall(false); }
  };

  const handleDeleteOpening = async () => {
    if (!activeOp || isDeletingOp) return;
    setIsDeletingOp(true);
    try { await onDeleteOpening?.(activeOp); } finally { setIsDeletingOp(false); }
  };

  const handleInlineSave = useCallback(async (updatedOp) => {
    if (!onUpdateOpening) return;
    setIsSavingInline(true);
    try { await onUpdateOpening(updatedOp); setWallEditOp(null); }
    finally { setIsSavingInline(false); }
  }, [onUpdateOpening]);

  const handleInlineDelete = useCallback(async (op) => {
    if (!onDeleteOpening) return;
    setIsDeletingInline(true);
    try { await onDeleteOpening(op); setWallEditOp(null); }
    finally { setIsDeletingInline(false); }
  }, [onDeleteOpening]);

  const isDoor = activeOp?.type === "door";
  const opAccent = isDoor ? T.accentDoor : T.accentWindow;
  const wallOpenings = activeWall?.openings ?? [];

  return (
    <>
      <style>{`
        @keyframes bimCardIn {
          from { opacity: 0; transform: translateY(10px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .bim-slider { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 3px; outline: none; width: 100%; cursor: pointer; }
        .bim-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: currentColor; cursor: pointer; border: 2px solid rgba(255,255,255,0.3); box-shadow: 0 1px 6px rgba(0,0,0,0.4); }
      `}</style>

      {/* ── 1. Wall Inspector ── */}
      {activeWall && !activeOp && (
        <CardShell accentColor={T.accentWall}>
          <CardHeader
            icon={<span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: T.accentWall, boxShadow: "0 0 7px " + T.accentWall }} />}
            title={"Wall #" + (activeWall.wallIdx + 1)}
            onClose={onCloseWall}
          />
          <PropGrid>
            <Prop label="Floor"        value={"Level " + activeWall.floorIdx} valueColor={T.accentWindow} />
            <Prop label="Length"       value={activeWall.length.toFixed(2) + " m"} />
            <Prop label="Height"       value={activeWall.height.toFixed(2) + " m"} />
            <Prop label="Surface Area" value={(activeWall.length * activeWall.height).toFixed(1) + " m\u00b2"} />
            <SectionDivider />
            <Prop label="Base Elevation (Y)" value={activeWall.floorY.toFixed(2) + " m"} mono span={2} />
            <Prop label="Endpoints [X, Z]"
              value={"[" + activeWall.x1.toFixed(2) + ", " + activeWall.z1.toFixed(2) + "] \u2192 [" + activeWall.x2.toFixed(2) + ", " + activeWall.z2.toFixed(2) + "]"}
              mono span={2}
            />
          </PropGrid>

          {/* Openings list */}
          {wallOpenings.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid " + T.divider }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", color: T.labelColor }}>
                  Openings on this wall
                </span>
                <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: T.valueColor, fontWeight: 700 }}>
                  {wallOpenings.length}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {wallOpenings.map((op, i) => (
                  <div key={op.id ?? i}>
                    <OpeningChip
                      op={op}
                      isActive={wallEditOp?.id === op.id}
                      onClick={clickedOp => setWallEditOp(prev => prev?.id === clickedOp.id ? null : clickedOp)}
                    />
                    {wallEditOp?.id === op.id && (
                      <OpeningEditPanel
                        op={wallEditOp}
                        wallLength={activeWall.length}
                        onSave={handleInlineSave}
                        onClose={() => setWallEditOp(null)}
                        onDelete={handleInlineDelete}
                        isSaving={isSavingInline}
                        isDeleting={isDeletingInline}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {wallOpenings.length === 0 && (
            <div style={{ marginTop: 10, paddingTop: 9, borderTop: "1px solid " + T.divider }}>
              <span style={{ fontSize: 11, color: T.labelColor, fontStyle: "italic" }}>No doors or windows on this wall</span>
            </div>
          )}

          <DeleteButton label="Delete Wall" loading={isDeletingWall} onClick={handleDeleteWall} />
        </CardShell>
      )}

      {/* ── 2. Opening Inspector (directly selected from 3D) ── */}
      {activeOp && (
        <CardShell accentColor={opAccent}>
          <CardHeader
            icon={isDoor ? "\uD83D\uDEAA" : "\uD83E\uDE9F"}
            title={"3D " + (isDoor ? "Door" : "Window")}
            badge={activeOp.isUser ? "User Placed" : "Detected"}
            badgeColor={activeOp.isUser ? T.accentUser : T.accentDetect}
            badgeBg={activeOp.isUser ? "rgba(52,211,153,0.12)" : "rgba(129,140,248,0.12)"}
            badgeBorder={activeOp.isUser ? "rgba(52,211,153,0.3)" : "rgba(129,140,248,0.3)"}
            onClose={onCloseOpening}
          />
          <PropGrid>
            <Prop label="Floor"  value={"Level " + activeOp.floorIdx} valueColor={T.accentWindow} />
            <Prop label="Width"  value={activeOp.width.toFixed(2) + " m"} />
            <Prop label="Height" value={activeOp.height.toFixed(2) + " m"} />
            <Prop label="Base Elevation (Y)" value={activeOp.elevation_y.toFixed(2) + " m"} mono />
            <SectionDivider />
            <Prop label="Top Margin (Header)" value={activeOp.top_margin.toFixed(2) + " m"} valueColor={T.accentDoor} />
            <Prop label="Bottom Margin (Sill)"
              value={isDoor ? "0.00 m  (floor level)" : activeOp.bottom_margin.toFixed(2) + " m"}
              valueColor={isDoor ? T.labelColor : T.accentWindow}
            />
            <SectionDivider />
            <Prop label="Position [X, Z]"
              value={"[" + activeOp.x.toFixed(2) + ", " + activeOp.z.toFixed(2) + "]"}
              mono span={2}
            />
          </PropGrid>

          {onUpdateOpening ? (
            <OpeningEditPanel
              op={activeOp}
              wallLength={null}
              onSave={async updatedOp => { await onUpdateOpening(updatedOp); onCloseOpening?.(); }}
              onClose={onCloseOpening}
              onDelete={async op => {
                setIsDeletingOp(true);
                try { await onDeleteOpening?.(op); } finally { setIsDeletingOp(false); }
              }}
              isSaving={false}
              isDeleting={isDeletingOp}
            />
          ) : (
            <DeleteButton label={"Delete " + (isDoor ? "Door" : "Window")} loading={isDeletingOp} onClick={handleDeleteOpening} />
          )}
        </CardShell>
      )}

      {/* ── 3. Hover — Opening ── */}
      {!activeWall && !activeOp && hoveredOpening && (
        <div style={{ ...tooltipBase, border: "1px solid " + (hoveredOpening.type === "door" ? "rgba(251,191,36,0.45)" : "rgba(96,165,250,0.45)") }}>
          <span style={{ fontSize: 15 }}>{hoveredOpening.type === "door" ? "\uD83D\uDEAA" : "\uD83E\uDE9F"}</span>
          <span style={{ fontWeight: 700, color: hoveredOpening.type === "door" ? T.accentDoor : T.accentWindow }}>
            {hoveredOpening.type === "door" ? "Door" : "Window"}&nbsp;({hoveredOpening.width.toFixed(2)} m)
          </span>
          <TooltipSep />
          <span style={{ color: T.labelColor }}>Top:</span>
          <span>{hoveredOpening.top_margin.toFixed(2)} m</span>
          {hoveredOpening.type === "window" && (
            <><TooltipSep /><span style={{ color: T.labelColor }}>Bottom:</span><span>{hoveredOpening.bottom_margin.toFixed(2)} m</span></>
          )}
          <TooltipSep />
          <span style={{ color: T.labelColor }}>Floor {hoveredOpening.floorIdx}</span>
          <span style={{ color: T.labelColor, fontSize: 10, marginLeft: 2 }}>&middot; click to inspect</span>
        </div>
      )}

      {/* ── 4. Hover — Wall ── */}
      {!activeWall && !activeOp && !hoveredOpening && hoveredWall && (
        <div style={{ ...tooltipBase, border: "1px solid rgba(148,163,184,0.35)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.accentWall, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: T.accentWall }}>Wall #{hoveredWall.wallIdx + 1}</span>
          <TooltipSep />
          <span>{hoveredWall.length.toFixed(2)} m</span>
          <TooltipSep />
          <span style={{ color: T.labelColor }}>Floor {hoveredWall.floorIdx}</span>
          {(hoveredWall.openings?.length ?? 0) > 0 && (
            <>
              <TooltipSep />
              <span>
                {hoveredWall.openings.filter(o => o.type === "door").length > 0 && ("\uD83D\uDEAA" + hoveredWall.openings.filter(o => o.type === "door").length)}
                {hoveredWall.openings.filter(o => o.type === "window").length > 0 && (" \uD83E\uDE9F" + hoveredWall.openings.filter(o => o.type === "window").length)}
              </span>
            </>
          )}
          <span style={{ color: T.labelColor, fontSize: 10, marginLeft: 2 }}>&middot; click to inspect</span>
        </div>
      )}

      {/* ── 5. Hover — Room ── */}
      {!activeWall && !activeOp && !hoveredOpening && !hoveredWall && hoveredRoom && (
        <div style={{ ...tooltipBase, border: "1px solid rgba(52,211,153,0.35)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.accentUser, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: T.accentUser }}>Room #{hoveredRoom.id}</span>
          <TooltipSep />
          <span>{hoveredRoom.area_m2 ? hoveredRoom.area_m2.toFixed(1) + " m\u00b2" : "Room slab"}</span>
          <span style={{ color: T.labelColor, fontSize: 10, marginLeft: 2 }}>&middot; click to select</span>
        </div>
      )}
    </>
  );
}
