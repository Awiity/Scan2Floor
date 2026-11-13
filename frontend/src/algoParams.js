/**
 * Algorithm parameters shared by the Home page (full pipeline run)
 * and the workspace "Re-detect" drawer (single-floor wall/room detection).
 */

export const ALGO_DEFAULTS = {
  // Pipeline stages
  run_c2b: true,
  run_slices: true,
  detect_floors: "", // comma separated floor indices, empty = all

  // Point cloud cleaning
  enable_cleaning: true,
  clean_downsample_pct: 20,
  clean_span_min: 0.65,
  clean_span_max: 1.0,

  // Wall detection
  grid_size: 0.02,
  threshold_frac: 0.01,
  min_wall_m: 0.4,
  max_wall_thickness: 0.75,
  dp_tolerance: 0.04,
  wall_reach_frac: 0.35,
  snap_to_axis: true,

  // Room detection (single-floor re-detect only)
  wall_thickness: 0.2,
  extend_m: 0.45,
  min_seg_m: 0.4,
  min_room_m2: 0.8,
  min_room_width_m: 0.6,
};

const LS_KEY = "s2f_algo_params";

export function loadAlgoParams() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...ALGO_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...ALGO_DEFAULTS };
}

export function persistAlgoParams(p) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function parseFloors(str) {
  const nums = String(str || "")
    .split(/[ ,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return nums.length ? nums : null;
}

/** Body for POST /api/pipeline/run */
export function pipelineBody(xyzPath, p, roomMode, extra = {}) {
  return {
    xyz_path: xyzPath,
    run_c2b: p.run_c2b,
    run_slices: p.run_slices,
    detect_floors: parseFloors(p.detect_floors),
    enable_cleaning: p.enable_cleaning,
    clean_downsample_pct: p.clean_downsample_pct,
    clean_span_min: p.clean_span_min,
    clean_span_max: p.clean_span_max,
    grid_size: p.grid_size,
    snap_to_axis: p.snap_to_axis,
    min_wall_m: p.min_wall_m,
    max_wall_thickness: p.max_wall_thickness,
    dp_tolerance: p.dp_tolerance,
    threshold_frac: p.threshold_frac,
    wall_reach_frac: p.wall_reach_frac,
    polygon_rooms: roomMode === "polygon",
    ...extra,
  };
}

/** Body for POST /api/c2b/walls (single floor) */
export function singleFloorBody(floorIdx, p, roomMode) {
  return {
    floor_idx: floorIdx,
    grid_size: p.grid_size,
    snap_to_axis: p.snap_to_axis,
    min_wall_m: p.min_wall_m,
    max_wall_thickness: p.max_wall_thickness,
    dp_tolerance: p.dp_tolerance,
    threshold_frac: p.threshold_frac,
    wall_reach_frac: p.wall_reach_frac,
    detect_openings: true,
    detect_rooms: true,
    wall_thickness: p.wall_thickness,
    extend_m: p.extend_m,
    min_seg_m: p.min_seg_m,
    min_room_m2: p.min_room_m2,
    min_room_width_m: p.min_room_width_m,
    polygon_rooms: roomMode === "polygon",
  };
}

