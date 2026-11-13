/**
 * theme.js — JS mirror of the design tokens in index.css.
 *
 * Canvas and three.js code cannot read CSS variables directly, so every
 * colour used there must come from this file. Keep it in sync with the
 * `--layer-*`, `--sel`, `--red` … tokens in index.css.
 *
 * Palette: neutral (black / grey / white). Colour is reserved for
 * layers (door, window, rooms), selection (amber) and status.
 */

export const isDarkTheme = () => !document.querySelector('[data-theme="light"]');

const DARK = {
  bg: "#0f0f0f",
  gridLine: "#1e1e1e",
  text1: "#e8e8e8",
  text2: "#a0a0a0",
  text3: "#707070",

  // layers
  wall: "#d4d4d4", wallGlow: "rgba(212,212,212,0.14)",
  wallUser: "#fbbf24", wallUserGlow: "rgba(251,191,36,0.20)",
  wallHover: "#f87171", wallHoverGlow: "rgba(248,113,113,0.25)",
  wallHidden: "#6b6b6b", wallHiddenGlow: "rgba(107,107,107,0.15)",
  wallPreview: "#fbbf24",
  door: "#fbbf24",
  window: "#818cf8",
  corner: "#818cf8",
  room: "#9ca3af",

  // selection / interaction
  sel: "#fbbf24",
  hover: "#ffffff",
  danger: "#f87171",
  snapEp: "#fbbf24",
  snapGrid: "rgba(255,255,255,0.4)",

  roomFill: "rgba(156,163,175,0.10)",
  roomBorder: "rgba(255,255,255,0.14)",
  labelRoom: "rgba(255,255,255,0.6)",
  scaleStroke: "rgba(255,255,255,0.6)",
  scaleFill: "rgba(255,255,255,0.7)",
};

const LIGHT = {
  bg: "#f5f5f5",
  gridLine: "#e0e0e0",
  text1: "#111111",
  text2: "#555555",
  text3: "#8a8a8a",

  wall: "#3a3a3a", wallGlow: "rgba(58,58,58,0.10)",
  wallUser: "#d97706", wallUserGlow: "rgba(217,119,6,0.15)",
  wallHover: "#dc2626", wallHoverGlow: "rgba(220,38,38,0.18)",
  wallHidden: "#a0a0a0", wallHiddenGlow: "rgba(160,160,160,0.12)",
  wallPreview: "#d97706",
  door: "#d97706",
  window: "#6366f1",
  corner: "#6366f1",
  room: "#6b7280",

  sel: "#d97706",
  hover: "#000000",
  danger: "#dc2626",
  snapEp: "#d97706",
  snapGrid: "rgba(0,0,0,0.30)",

  roomFill: "rgba(107,114,128,0.10)",
  roomBorder: "rgba(0,0,0,0.14)",
  labelRoom: "rgba(0,0,0,0.65)",
  scaleStroke: "rgba(0,0,0,0.55)",
  scaleFill: "rgba(0,0,0,0.65)",
};

// Muted per-room hues (rooms must stay distinguishable from each other)
export const ROOM_COLORS = [
  "#9ca3af", "#818cf8", "#fbbf24", "#34d399", "#fb7185",
  "#a78bfa", "#67e8f9", "#fb923c", "#4ade80", "#f87171",
];
export const getRoomAccent = (id) => ROOM_COLORS[(((id ?? 1) - 1) % ROOM_COLORS.length + ROOM_COLORS.length) % ROOM_COLORS.length];

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const withAlpha = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/** Room fills (translucent) derived from ROOM_COLORS. */
export const getRoomFills = (alpha = 0.07) => ROOM_COLORS.map((c) => withAlpha(c, alpha));

/** Canvas palette for the current theme (read each frame; it is cheap). */
export function getCanvasTheme() {
  const base = isDarkTheme() ? DARK : LIGHT;
  return { ...base, roomFills: getRoomFills(isDarkTheme() ? 0.07 : 0.08) };
}

/** three.js palette (hex strings) for the current theme. */
export function getSceneTheme() {
  const dark = isDarkTheme();
  const t = dark ? DARK : LIGHT;
  return {
    wall: dark ? "#c8c8c8" : "#4a4a4a",
    wallEdge: dark ? "#ffffff" : "#111111",
    wallHover: t.hover,
    wallSelected: t.sel,
    floor: dark ? "#2a2a2a" : "#d8d8d8",
    floorSelected: t.sel,
    door: t.door,
    window: t.window,
    room: t.room,
    sel: t.sel,
    frame: dark ? "#3a3a3a" : "#9a9a9a",
    edge: dark ? "#8a8a8a" : "#555555",
  };
}