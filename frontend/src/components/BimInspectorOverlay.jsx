import React, { useState } from "react";

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
}) {
  const activeWall = selectedWall;
  const activeOp = selectedOpening;
  const [isDeletingWall, setIsDeletingWall] = useState(false);
  const [isDeletingOp, setIsDeletingOp] = useState(false);

  const handleDeleteWall = async () => {
    if (!activeWall || isDeletingWall) return;
    setIsDeletingWall(true);
    try {
      await onDeleteWall?.(activeWall);
    } finally {
      setIsDeletingWall(false);
    }
  };

  const handleDeleteOpening = async () => {
    if (!activeOp || isDeletingOp) return;
    setIsDeletingOp(true);
    try {
      await onDeleteOpening?.(activeOp);
    } finally {
      setIsDeletingOp(false);
    }
  };

  return (
    <>
      {/* 1. Selected Wall Inspector Card */}
      {activeWall && !activeOp && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 24,
            zIndex: 20,
            background: "rgba(15, 23, 42, 0.90)",
            backdropFilter: "blur(14px)",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            borderRadius: 12,
            padding: "16px 18px",
            color: "#f8fafc",
            boxShadow: "0 10px 36px rgba(0, 0, 0, 0.45)",
            fontFamily: "Inter, sans-serif",
            minWidth: 280,
            maxWidth: 340,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
              borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
              paddingBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: "#f59e0b",
                  boxShadow: "0 0 10px #f59e0b",
                }}
              />
              <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.5px" }}>
                3D Wall #{activeWall.wallIdx + 1}
              </span>
            </div>
            <button
              onClick={onCloseWall}
              title="Deselect"
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: "2px 4px",
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px", fontSize: 11 }}>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Floor</span>
              <span style={{ fontWeight: 600, color: "#38bdf8" }}>
                Level {activeWall.floorIdx}
              </span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Length</span>
              <span style={{ fontWeight: 600 }}>{activeWall.length.toFixed(2)} m</span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Height</span>
              <span style={{ fontWeight: 600 }}>{activeWall.height.toFixed(2)} m</span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Surface Area</span>
              <span style={{ fontWeight: 600 }}>{(activeWall.length * activeWall.height).toFixed(1)} m²</span>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Base Elevation (Y)</span>
              <span style={{ fontWeight: 500, fontFamily: "monospace", fontSize: 10 }}>
                {activeWall.floorY.toFixed(2)} m
              </span>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Endpoints [X, Z]</span>
              <span style={{ fontWeight: 500, fontFamily: "monospace", fontSize: 10, color: "rgba(255,255,255,0.85)" }}>
                [{activeWall.x1.toFixed(2)}, {activeWall.z1.toFixed(2)}] → [{activeWall.x2.toFixed(2)}, {activeWall.z2.toFixed(2)}]
              </span>
            </div>
          </div>

          {/* Delete Wall Button */}
          <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
            <button
              onClick={handleDeleteWall}
              disabled={isDeletingWall}
              style={{
                width: "100%",
                padding: "8px 14px",
                background: isDeletingWall ? "rgba(220, 38, 38, 0.4)" : "rgba(220, 38, 38, 0.85)",
                color: "#ffffff",
                border: "1px solid rgba(248, 113, 113, 0.4)",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: isDeletingWall ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                transition: "all 0.15s ease",
                boxShadow: "0 2px 8px rgba(220, 38, 38, 0.3)",
              }}
              onMouseEnter={(e) => {
                if (!isDeletingWall) e.currentTarget.style.background = "#dc2626";
              }}
              onMouseLeave={(e) => {
                if (!isDeletingWall) e.currentTarget.style.background = "rgba(220, 38, 38, 0.85)";
              }}
            >
              <span>🗑️</span>
              <span>{isDeletingWall ? "Deleting..." : "Delete Wall"}</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. Selected Opening (Door/Window) Inspector Card */}
      {activeOp && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 24,
            zIndex: 21,
            background: "rgba(15, 23, 42, 0.92)",
            backdropFilter: "blur(14px)",
            border: activeOp.type === "door" ? "1px solid rgba(245, 158, 11, 0.55)" : "1px solid rgba(56, 189, 248, 0.55)",
            borderRadius: 12,
            padding: "16px 18px",
            color: "#f8fafc",
            boxShadow: "0 10px 36px rgba(0, 0, 0, 0.55)",
            fontFamily: "Inter, sans-serif",
            minWidth: 290,
            maxWidth: 350,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
              borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
              paddingBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>
                {activeOp.type === "door" ? "🚪" : "🪟"}
              </span>
              <div>
                <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.5px" }}>
                  3D {activeOp.type === "door" ? "Door" : "Window"}
                </span>
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: activeOp.isUser ? "rgba(16, 185, 129, 0.2)" : "rgba(56, 189, 248, 0.2)",
                    color: activeOp.isUser ? "#34d399" : "#38bdf8",
                    border: `1px solid ${activeOp.isUser ? "rgba(16, 185, 129, 0.4)" : "rgba(56, 189, 248, 0.4)"}`,
                  }}
                >
                  {activeOp.isUser ? "User Placed" : "Detected"}
                </span>
              </div>
            </div>
            <button
              onClick={onCloseOpening}
              title="Deselect"
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: "2px 4px",
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px", fontSize: 11 }}>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Floor</span>
              <span style={{ fontWeight: 600, color: "#38bdf8" }}>
                Level {activeOp.floorIdx}
              </span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Width</span>
              <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                {activeOp.width.toFixed(2)} m
              </span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>3D Height</span>
              <span style={{ fontWeight: 600 }}>{activeOp.height.toFixed(2)} m</span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Top Margin (Header)</span>
              <span style={{ fontWeight: 600, color: "#fbbf24" }}>
                {activeOp.top_margin.toFixed(2)} m
              </span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Bottom Margin (Sill)</span>
              <span style={{ fontWeight: 600, color: activeOp.type === "door" ? "rgba(255,255,255,0.4)" : "#38bdf8" }}>
                {activeOp.type === "door" ? "0.00 m (Floor level)" : `${activeOp.bottom_margin.toFixed(2)} m`}
              </span>
            </div>
            <div>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Base Elevation (Y)</span>
              <span style={{ fontWeight: 500, fontFamily: "monospace", fontSize: 10 }}>
                {activeOp.elevation_y.toFixed(2)} m
              </span>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ color: "rgba(255,255,255,0.5)", display: "block" }}>Position [X, Z]</span>
              <span style={{ fontWeight: 500, fontFamily: "monospace", fontSize: 10, color: "rgba(255,255,255,0.85)" }}>
                [{activeOp.x.toFixed(2)}, {activeOp.z.toFixed(2)}]
              </span>
            </div>
          </div>

          {/* Delete Opening Button */}
          <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
            <button
              onClick={handleDeleteOpening}
              disabled={isDeletingOp}
              style={{
                width: "100%",
                padding: "8px 14px",
                background: isDeletingOp ? "rgba(220, 38, 38, 0.4)" : "rgba(220, 38, 38, 0.85)",
                color: "#ffffff",
                border: "1px solid rgba(248, 113, 113, 0.4)",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: isDeletingOp ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                transition: "all 0.15s ease",
                boxShadow: "0 2px 8px rgba(220, 38, 38, 0.3)",
              }}
              onMouseEnter={(e) => {
                if (!isDeletingOp) e.currentTarget.style.background = "#dc2626";
              }}
              onMouseLeave={(e) => {
                if (!isDeletingOp) e.currentTarget.style.background = "rgba(220, 38, 38, 0.85)";
              }}
            >
              <span>🗑️</span>
              <span>{isDeletingOp ? "Deleting..." : `Delete ${activeOp.type === "door" ? "Door" : "Window"}`}</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. Hover preview tooltip for Opening when nothing is selected */}
      {!activeWall && !activeOp && hoveredOpening && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            background: "rgba(15, 23, 42, 0.90)",
            backdropFilter: "blur(8px)",
            border: hoveredOpening.type === "door" ? "1px solid rgba(245, 158, 11, 0.6)" : "1px solid rgba(56, 189, 248, 0.6)",
            borderRadius: 8,
            padding: "6px 14px",
            color: "#f8fafc",
            fontSize: 12,
            fontFamily: "Inter, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 10,
            pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
          }}
        >
          <span style={{ fontSize: 14 }}>
            {hoveredOpening.type === "door" ? "🚪" : "🪟"}
          </span>
          <span style={{ color: hoveredOpening.type === "door" ? "#fbbf24" : "#38bdf8", fontWeight: 700 }}>
            {hoveredOpening.type === "door" ? "Door" : "Window"} ({hoveredOpening.width.toFixed(2)}m)
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <span>Top: {hoveredOpening.top_margin.toFixed(2)}m</span>
          {hoveredOpening.type === "window" && (
            <>
              <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
              <span>Bottom: {hoveredOpening.bottom_margin.toFixed(2)}m</span>
            </>
          )}
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <span>Floor {hoveredOpening.floorIdx}</span>
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 10 }}>Click to inspect / delete</span>
        </div>
      )}

      {/* 4. Hover preview tooltip for Wall when nothing is selected */}
      {!activeWall && !activeOp && !hoveredOpening && hoveredWall && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(0, 229, 255, 0.4)",
            borderRadius: 8,
            padding: "6px 14px",
            color: "#f8fafc",
            fontSize: 12,
            fontFamily: "Inter, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 10,
            pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
          }}
        >
          <span style={{ color: "#00e5ff", fontWeight: 700 }}>
            Wall #{hoveredWall.wallIdx + 1}
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <span>{hoveredWall.length.toFixed(2)} m length</span>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <span>Floor {hoveredWall.floorIdx}</span>
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 10 }}>Click to inspect / delete</span>
        </div>
      )}

      {/* 5. Hover preview for room floor */}
      {!activeWall && !activeOp && !hoveredOpening && !hoveredWall && hoveredRoom && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(52, 211, 153, 0.4)",
            borderRadius: 8,
            padding: "6px 14px",
            color: "#f8fafc",
            fontSize: 12,
            fontFamily: "Inter, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 10,
            pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
          }}
        >
          <span style={{ color: "#34d399", fontWeight: 700 }}>
            Room #{hoveredRoom.id}
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
          <span>{hoveredRoom.area_m2 ? `${hoveredRoom.area_m2.toFixed(1)} m²` : "Room slab"}</span>
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 10 }}>Click to select room</span>
        </div>
      )}
    </>
  );
}
