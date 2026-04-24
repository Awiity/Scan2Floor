# Scan2Floor — Architecture & Technical Reference

Scan2Floor is a full-stack application that transforms raw Matterport `.xyz` 3D point clouds into vectorised architectural floor plans (DXF/SVG). It bridges the gap between unstructured 3D scans and structured 2D architectural vectors by sequentially extracting floor levels, wall segments, structural openings (doors/windows), and enclosed rooms — all inside a single Docker container with no external tool dependencies.

---

## System Overview

The system has two primary parts:

1. **Frontend:** A React + Vite web application using Three.js (`@react-three/fiber`) for 3D point cloud visualisation, and a custom 2D canvas editor for reviewing and tweaking vectorised wall data.
2. **Backend:** A Python FastAPI server that serves as both a file manager and the core point cloud processing pipeline, using NumPy, OpenCV, Pandas (C engine), optional CuPy GPU acceleration, and structural heuristics.

The entire processing pipeline runs as a unified 5-stage background job orchestrated by `run_pipeline.py`, exposed via `POST /api/pipeline/run` and polled via `GET /api/pipeline/status`.

---

## 0. Unified Pipeline Runner (`run_pipeline.py`)

`run_pipeline.py` orchestrates all five processing stages in a single daemon thread:

| Stage | Script | Output |
|---|---|---|
| 1 | `preprocess_xyz.py` | `pointcloud.bin` + `info.json` (basic bounds + histogram floor levels) |
| 2 | `run_c2b.py` | `c2b_output/horiz_surface_N.xyz` (built-in slab detection) |
| 3 | `floor_from_c2b.py` | `info.json` updated with precise `floor_levels[]` |
| 4 | `preprocess_walls.py` | `wall_slice_floor_N.npy` (dense per-floor point arrays) |
| 5 | `wall_detection_c2b.py` + `opening_detection.py` + `room_detection.py` + `dxf_export.py` | `walls/openings/rooms_floor_N.json`, `floor_N.dxf`, `floor_N.svg` |

Status is published to a shared dict (`status`) protected by a threading lock and polled by the frontend every 2 seconds. Stages 1 and 4 are run as **subprocesses** (so their stdout is streamed to the log); stages 3 and 5 run in-process.

---

## 1. Data Ingestion & Preprocessing

### 1.1 First-Stage Transformation (`preprocess_xyz.py`)

- **Input:** Matterport raw `.xyz` file (space-separated `X Y Z` per line).
- **Two-pass streaming:** The file is read in chunks of 2 M lines using `pandas.read_csv` with `engine="c"` and `sep=" "` — the C engine processes ~8–12 M rows/s vs ~500 K rows/s for the Python/regex engine.
  - **Pass 1:** Accumulates sum of raw X/Y to compute the horizontal centroid (`cx`, `cy`) without loading all data into RAM.
  - **Pass 2:** Applies the coordinate transform, downsamples 1-in-N points, and accumulates all heights for floor detection.
- **Coordinate transform:** Converts Matterport Z-up → Three.js Y-up (`y_yup = z_raw`), centres horizontally on `(cx, cy)` for numeric stability.
- **Downsampled binary:** Exports `pointcloud.bin` (uint32 count + float32 XYZ + uint8 RGB) for fast frontend streaming.
- **Floor detection:** Finds peaks in the Y-axis density histogram using `scipy.signal.find_peaks` (or a manual peak finder as fallback) with a minimum 2 m separation between peaks.
- **Output:** `pointcloud.bin` + `info.json` (bounds, centroid, preliminary `floor_levels[]`).

### 1.2 Built-in Horizontal Surface Detection (`run_c2b.py`)

Reimplements Cloud2BIM's `identify_slabs()` algorithm internally — **no external Cloud2BIM installation required**.

- **Pass 1a:** Reads only column Z to determine the global Z range.
- **Pass 1b:** Builds a Z-axis histogram with `Z_STEP = 0.15 m` bins.
- **Band detection:** Identifies contiguous histogram bands above `DENSITY_FRAC × peak` (default 60% of peak). Merges adjacent bands within `2 × Z_STEP`.
- **Pass 2:** Streams the full file again, extracting XYZ points that fall inside each surface band.
- **Output:** `c2b_output/horiz_surface_N.xyz` files in Cloud2BIM-compatible tab-separated format with `//X Y Z` header, plus `surfaces.json`.

All three passes also use `engine="c"` for maximum throughput.

### 1.3 Floor Level Derivation (`floor_from_c2b.py`)

- Reads all `horiz_surface_N.xyz` files and computes the **median Z-height** of each surface.
- **Slab pairing:** Sorts median heights and pairs adjacent planes within typical concrete-slab thickness. The lower face of each pair is a confirmed floor level with `{ floor_y, ceiling_y, storey_height }`.
- Updates `info.json → floor_levels[]` with the precise values, replacing the histogram heuristic from Stage 1.

### 1.4 Dense Wall Slices (`preprocess_walls.py`)

Because the full `.xyz` file can exceed 4 GB, this stage **streams** it in 2 M-line Pandas chunks (`engine="c"`).

**For each detected floor level:**
- Retains only points within the height band `[floor_y − 0.05 m, floor_y + 2.65 m]`.
- Converts metric coordinates to **5 cm voxel integer indices** (`int32`) for efficient deduplication.

**Voxel deduplication — GPU path (CuPy):**

Three `int32` voxel indices are **packed into a single `int64` key** using 21-bit fields:

```
key = (vx + OFFSET) << 42 | (vy + OFFSET) << 21 | (vz + OFFSET)
```

where `OFFSET = 2²⁰ ≈ 1 M voxels = ±52 km` — far beyond any building footprint.

`cp.unique(keys)` on a **1D int64 array** uses CuPy's native GPU radix sort (O(N) in practice). This contrasts with the naïve `cp.unique(array, axis=0)` on a 2D `(N, 3)` array, which has no native GPU kernel: CuPy internally converts it to a structured void dtype and runs a lexicographic sort, allocating 2–3× the array size as VRAM workspace and degrading to O(N log N) with significant overhead. The 1D encoding approach uses ~3× less VRAM and runs 5–10× faster.

Keys are decoded back with bitwise masks after deduplication. The CPU fallback (`numpy.unique` on the 1D key) is also faster than 2D numpy unique.

Deduplication is triggered every `DEDUP_EVERY = 4` chunks to cap per-floor VRAM usage, with `cp.get_default_memory_pool().free_all_blocks()` called after each pass to return VRAM to the pool.

**Output:** `wall_slice_floor_N.npy` — float32 `(M, 3)` arrays of voxel-centred coordinates.

---

## 2. Structural Component Detection

### 2.1 Wall Detection (`wall_detection_c2b.py`)

- **Algorithm:** Cloud2BIM-style 2D density projection.
- **Height band filter:** Takes the mid-height fraction (`0.30 × storey_height` → `0.90 × storey_height`) of the floor slice to exclude floor reflections and ceiling geometry.
- **2D grid projection:** Accumulates point density onto a configurable 2–5 cm/cell XZ raster grid.
- **Binarisation:** Applies local relative thresholding (`threshold_frac × max_density`).
- **Morphological closing:** `cv2.morphologyEx` with a 5×5 kernel stitches broken scan gaps.
- **Contour extraction:** `cv2.findContours` extracts closed regions representing wall bodies.
- **Simplification:** `cv2.approxPolyDP` (Douglas-Peucker) reduces each contour to linear segments.
- **Collinear merge:** Adjacent near-collinear segments are merged into single long wall segments.
- **Face pairing:** Parallel segment pairs within `max_wall_thickness` (default 0.75 m) are grouped; the **midline** becomes the canonical wall axis.
- **Manhattan snapping:** Walls within a small angular threshold of 0° or 90° are snapped to the axis grid.
- **Output:** `walls_floor_N.json` — list of `[[x1, z1], [x2, z2]]` metric endpoint pairs.

### 2.2 Opening Detection (`opening_detection.py`)

For every detected wall segment:
1. Collects nearby floor-slice points within `±wall_thickness`. Projects onto the wall's local UV frame (U = along wall, V = vertical).
2. Builds a 2D occupancy grid in (U, V) space.
3. Scans each U-column for vertical empty spans:
   - **Door:** mostly empty from `~0.15 m` to `~1.85 m`.
   - **Window:** solid sill below `~0.65 m`, gap to `~2.05 m`.
4. Merges adjacent positive columns into single opening regions.
- **Output:** `openings_floor_N.json`.

### 2.3 Room Bounding (`room_detection.py`)

Uses **image processing** rather than computational geometry:
1. Renders `walls_floor_N.json` as thick white lines on a large OpenCV canvas (typically 2–5 cm/px), with endpoints slightly extended to seal T-junctions.
2. Iterative morphological closing with kernels from 10 cm → 50 cm to close remaining gaps.
3. Inverts the image; `cv2.connectedComponentsWithStats` (8-connectivity) labels each enclosed region.
4. Filters out the exterior blob (largest region touching the image boundary), plus regions below `min_room_m2`, above `max_room_m2`, or narrower than `min_room_width_m`.
5. Converts pixel bounding boxes and areas back to metric units.
- **Output:** `rooms_floor_N.json` — rooms with bounding box, centroid, and area (m²).

---

## 3. Post-Processing and Output

### DXF and SVG Export (`dxf_export.py`)

Combines JSON artefacts into standard CAD formats using `ezdxf`:

| DXF Layer | Contents |
|---|---|
| `A-WALL` | Wall centre-line segments |
| `A-DOOR` | Door gap lines + swing arc |
| `A-WINDOW` | Window pane offset lines |
| `A-ROOM` | Room bounding rectangle + area text (m²) |

**Output:** `floor_N.dxf` (CAD) + `floor_N.svg` (browser preview) per floor.

---

## 4. Web Interface (Frontend)

- **`PointCloud.jsx` / `OBJModel.jsx`:** Three.js renderers for the `pointcloud.bin` binary stream and OBJ/GLB mesh overlay.
- **`FloorPlanViewer.jsx`:** HTML5 `<canvas>` 2D floor plan editor with pan/zoom, add-wall, delete-wall, snap-to-endpoint, and undo/redo.
- **`Sidebar.jsx`:** Scan file browser (polls `GET /api/scan/browse`, walks `SCAN_ROOTS` directories), pipeline trigger and 5-stage progress display, wall detection parameter sliders, and single-floor re-run controls.
- **Status polling:** The frontend polls `/api/pipeline/status` every 2 seconds while `running: true` to update stage indicators and the log tail.

---

## 5. Docker Deployment

The entire backend is containerised. Two compose files are provided:

| File | Base image | GPU support |
|---|---|---|
| `docker-compose.yml` | `python:3.11-slim` | No |
| `docker-compose.gpu.yml` (overlay) | CUDA 12.6 + CuPy | Yes (NVIDIA) |

Key environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PROCESSED_DIR` | `/processed` | Named Docker volume for all pipeline outputs |
| `DATA_DIR` | `/data/matterpak` | Default scan folder fallback |
| `C2B_DIR` | `/processed/c2b_output` | Cloud2BIM output location |
| `SCAN_ROOTS` | `/data` | Comma-separated roots walked by the scan browser |

Host scan directories are mounted read-only under `/data/<name>:ro`. The named volume `processed_data` persists pipeline outputs across container restarts and rebuilds.

---

## 6. Performance Reference (114 M point / ~4.4 GB file)

| Stage | CPU container | GPU container |
|---|---|---|
| 1 — Preprocess XYZ | ~2 min | ~2 min |
| 2 — C2B Slab Detection | ~2 min | ~2 min |
| 3 — Import Floor Levels | <1 s | <1 s |
| 4 — Extract Wall Slices | ~3–4 min | **~1–2 min** |
| 5 — Detect Walls & Rooms | ~1–2 min | ~1–2 min |
| **Total** | **~8–10 min** | **~6 min** |

Stage 4 GPU speedup is driven by the 1D int64 radix sort described in §1.4.
