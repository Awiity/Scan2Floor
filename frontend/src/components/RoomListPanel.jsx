/**
 * RoomListPanel.jsx — Detected Rooms List with Selection
 *
 * Displays all rooms detected on the current floor as a scrollable list.
 * Clicking a room selects/deselects it for highlighting on the 2D floor plan
 * and 3D point cloud.
 */

import { useState, useEffect } from "react";

// Palette matching FloorPlanViewer room colours (same order)
const ROOM_COLORS = [
  "#00c8e0", "#818cf8", "#fbbf24", "#34d399", "#fb7185",
  "#a78bfa", "#22d3ee", "#fb923c", "#4ade80", "#f87171",
];

export default function RoomListPanel({
  floor,
  dataVersion,
  selectedRoomId,
  onSelectRoom,
}) {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Fetch rooms whenever the floor or data version changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/rooms/${floor}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setRooms(d?.rooms ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setRooms([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [floor, dataVersion]);

  const handleClick = (id) => {
    onSelectRoom?.(selectedRoomId === id ? null : id);
  };

  return (
    <div className={`room-list-panel${collapsed ? " collapsed" : ""}`}>
      {/* Header */}
      <div className="room-list-header">
        <div className="room-list-title">
          <span className="room-list-icon">🏠</span>
          <span>Rooms</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span className="room-list-badge">
            {loading ? "…" : rooms.length}
          </span>
          <button
            className="room-list-collapse-btn"
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? "Expand room list" : "Collapse room list"}
          >
            <span className="rlp-arrow">▾</span>
          </button>
        </div>
      </div>

      {/* List */}
      <div className="room-list-scroll">
        {loading && (
          <div className="room-list-empty">
            <div className="room-list-spinner" />
            <span>Loading…</span>
          </div>
        )}

        {!loading && rooms.length === 0 && (
          <div className="room-list-empty">
            <span style={{ fontSize: 22 }}>🔍</span>
            <span>No rooms detected</span>
          </div>
        )}

        {!loading &&
          rooms.map((room) => {
            const isSelected = selectedRoomId === room.id;
            const accent = ROOM_COLORS[(room.id - 1) % ROOM_COLORS.length];

            return (
              <button
                key={room.id}
                className={`room-list-item${isSelected ? " selected" : ""}`}
                onClick={() => handleClick(room.id)}
                style={{
                  "--room-accent": accent,
                  "--room-accent-dim": `${accent}22`,
                  "--room-accent-mid": `${accent}55`,
                }}
              >
                {/* Colour indicator */}
                <div
                  className="room-list-swatch"
                  style={{ background: accent }}
                />

                {/* Info */}
                <div className="room-list-info">
                  <div className="room-list-name">
                    Room {room.id}
                  </div>
                  <div className="room-list-meta">
                    {room.area_m2.toFixed(1)} m² &nbsp;·&nbsp;
                    ({room.centroid_x.toFixed(1)}, {room.centroid_z.toFixed(1)})
                  </div>
                </div>

                {/* Selection indicator */}
                {isSelected && (
                  <span className="room-list-check">✓</span>
                )}
              </button>
            );
          })}
      </div>

      {/* Hint */}
      {rooms.length > 0 && (
        <div className="room-list-hint">
          Click a room to highlight it on the floor plan &amp; point cloud
        </div>
      )}
    </div>
  );
}
