# Scan2Floor

> **Point cloud → vectorized architectural floor plan, end-to-end.**

Scan2Floor ingests a raw Matterport `.xyz` 3-D point cloud and produces analysis-ready 2-D floor plans — complete with wall segments, door/window openings, room boundaries, area labels, and downloadable DXF/SVG files. A React frontend lets you inspect results in 3-D, fine-tune wall traces on a live canvas, and export at any stage.

---

## Table of Contents

1. [Features](#features)
2. [Project Structure](#project-structure)
3. [Tech Stack](#tech-stack)
4. [Processing Pipeline](#processing-pipeline)
   - [Stage 1 — XYZ Preprocessing](#stage-1--xyz-preprocessing)
   - [Stage 2 — Built-in C2B Slab Detection](#stage-2--built-in-c2b-slab-detection)
   - [Stage 3 — Import C2B Floor Levels](#stage-3--import-c2b-floor-levels)
   - [Stage 4 — Dense Wall Slices (GPU-accelerated)](#stage-4--dense-wall-slices-gpu-accelerated)
   - [Stage 5 — Detect Walls, Rooms & Export](#stage-5--detect-walls-rooms--export)
5. [Algorithms & Techniques](#algorithms--techniques)
6. [API Reference](#api-reference)
7. [Frontend](#frontend)
8. [Getting Started](#getting-started)
9. [Configuration](#configuration)
10. [Data Directory Layout](#data-directory-layout)
11. [Known Limitations](#known-limitations)

---

## Features

| Capability | Detail |
|---|---|
| **3-D Viewer** | Three.js point cloud + OBJ mesh overlay |
| **Unified 5-stage pipeline** | One-click full run: XYZ → slabs → floors → slices → walls/rooms/DXF |
| **Built-in slab detection** | Cloud2BIM-compatible `run_c2b.py` — no external tool required |
| **Wall vectorisation** | 2-D density grid → CV contour → Douglas-Peucker → axis merge |
| **Opening detection** | Per-wall vertical occupancy profile for doors & windows |
| **Room bounding** | Morphological closing + connected-component labelling |
| **GPU acceleration** | CuPy-powered voxel dedup in Stage 4 (1D int64 radix sort, ~3× less VRAM) |
| **Scan file browser** | Auto-discovers `.xyz` files under mounted `/data` volumes |
| **Manual editing** | Draw / erase walls on canvas; undo/redo; snap-to-endpoint |
| **Auto re-calculation** | Saving edits triggers room re-detection and DXF re-export automatically |
| **CAD export** | Multi-layer DXF (walls, doors, windows, rooms) + SVG preview |
| **Docker deployment** | Single `docker compose up --build` for CPU; GPU variant via overlay file |

---

## Project Structure

```
scan2floor/
├── backend/
│   ├── main.py                    # FastAPI application & all REST endpoints
│   ├── requirements.txt           # Python dependencies
│   ├── start_backend.bat          # One-click backend launcher (Windows)
│   └── pipeline/
│       ├── preprocess_xyz.py      # Stage 1 — coordinate transform & bin export
│       ├── floor_from_c2b.py      # Stage 2 — Cloud2BIM floor level derivation
│       ├── preprocess_walls.py    # Stage 3 — chunked XYZ → per-floor npy slices
│       ├── wall_detection_c2b.py  # Stage 4 — 2-D density → vectorised walls
│       ├── opening_detection.py   # Stage 5 — door/window gap analysis
│       ├── room_detection.py      # Stage 6 — connected-component room bounding
│       ├── dxf_export.py          # Stage 7 — DXF / SVG assembly
│       ├── preprocess_o3d.py      # (legacy) Open3D-based preprocessing helper
│       └── convert_glb.py         # GLB mesh conversion utility
│
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── main.jsx               # React entry point
│       ├── App.jsx                # Root component, routing, status polling
│       ├── index.css              # Global design system & tokens
│       ├── App.css
│       └── components/
│           ├── Sidebar.jsx        # Controls panel (pipeline triggers, settings)
│           ├── FloorPlanViewer.jsx # 2-D canvas editor (draw / erase / undo)
│           ├── FloorPlanPanel.jsx  # Floor tab switcher wrapper
│           ├── PointCloud.jsx     # Three.js point cloud renderer
│           ├── OBJModel.jsx       # Three.js OBJ/GLB mesh viewer
│           └── LoadingOverlay.jsx # Processing state overlay
│
├── ARCHITECTURE.md                # Technical deep-dive reference
├── start_backend.bat              # Backend launcher shortcut
└── README.md                      # ← you are here
```

---

## Tech Stack

### Backend

| Library | Purpose |
|---|---|
| **FastAPI** | REST API framework, async request handling |
| **Uvicorn** | ASGI server |
| **NumPy** | Dense array math (voxel grids, projections) |
| **Pandas** | Chunked streaming of multi-GB XYZ files |
| **OpenCV (`opencv-python`)** | Morphological ops, contour extraction, connected components |
| **SciPy** | Histogram peak-finding for floor height estimation |
| **Open3D** | Point cloud I/O & legacy preprocessing |
| **ezdxf** | DXF file generation (walls, doors, windows, rooms) |
| **Matplotlib** | Debug visualisation plots |
| **aiofiles** | Async file I/O helpers |
| **tkinter** (stdlib) | Native Windows file picker (spawned as subprocess) |

### Frontend

| Library / Tool | Version | Purpose |
|---|---|---|
| **React** | 19 | Component-based UI |
| **Vite** | 8 | Dev server and bundler |
| **Three.js** | 0.183 | WebGL scene management |
| **@react-three/fiber** | 9 | React renderer for Three.js |
| **@react-three/drei** | 10 | Helpers: OrbitControls, loaders, etc. |

---

## Processing Pipeline

The pipeline is sequential. Each stage produces intermediate artefacts consumed by the next. All artefacts land in the `processed_data` Docker volume (mounted at `/processed` inside the container). The unified runner `run_pipeline.py` orchestrates all five stages in a single background thread, triggered by `POST /api/pipeline/run`.

```
cloud.xyz  (raw Matterport scan, mounted read-only at /data/…)
    │
    ▼ Stage 1 ─ preprocess_xyz.py       (pandas C engine, 2 passes)
pointcloud.bin  +  info.json            (bounds, histogram floor levels)
    │
    ▼ Stage 2 ─ run_c2b.py             (built-in slab detector, 3 passes)
c2b_output/horiz_surface_N.xyz
    │
    ▼ Stage 3 ─ floor_from_c2b.py      (in-process, <1 s)
info.json  ← updated with precise floor_levels[]
    │
    ▼ Stage 4 ─ preprocess_walls.py    (pandas C engine + optional CuPy GPU)
wall_slice_floor_0.npy
wall_slice_floor_1.npy  …
    │
    ▼ Stage 5 ─ per-floor loop (in-process)
    ├─▶ wall_detection_c2b.py  →  walls_floor_N.json
    ├─▶ opening_detection.py   →  openings_floor_N.json
    ├─▶ room_detection.py      →  rooms_floor_N.json
    └─▶ dxf_export.py          →  floor_N.dxf + floor_N.svg
```

**Typical runtime** (114 M points / ~4.4 GB):

| Stage | CPU | GPU (CuPy) |
|---|---|---|
| 1 — Preprocess XYZ | ~2 min | ~2 min |
| 2 — C2B Slab Detection | ~2 min | ~2 min |
| 3 — Import Floor Levels | <1 s | <1 s |
| 4 — Extract Wall Slices | ~3–4 min | ~1–2 min |
| 5 — Detect Walls & Rooms | ~1–2 min | ~1–2 min |
| **Total** | **~8–10 min** | **~6 min** |

---

### Stage 1 — XYZ Preprocessing

**Script:** `pipeline/preprocess_xyz.py`

- Reads the raw Matterport `.xyz` file in two streaming passes using `pandas.read_csv(engine="c", sep=" ")` — the C engine processes ~8–12 M rows/s.
- **Pass 1:** Streams all X/Y values to compute the horizontal centroid (`cx`, `cy`) without loading the full file into RAM.
- **Pass 2:** Applies the coordinate transform (`y_yup = z_raw`), centres on `(cx, cy)`, downsamples 1-in-N points for the viewer, and accumulates all heights for floor detection.
- **Downsampled binary:** Exports `pointcloud.bin` (uint32 count + float32 XYZ + uint8 RGB).
- **Metadata:** Writes `info.json` with 3-D bounding box, centroid, sample rate, and preliminary `floor_levels[]` from a Y-axis density histogram peak finder.

---

### Stage 2 — Built-in C2B Slab Detection

**Script:** `pipeline/run_c2b.py`

Reimplements Cloud2BIM's `identify_slabs()` algorithm internally — **no external Cloud2BIM installation required**.

- **Pass 1a:** Reads only column Z to determine the global Z range.
- **Pass 1b:** Builds a Z-axis histogram (`Z_STEP = 0.15 m`). Identifies contiguous bands above 60% of the peak density and merges adjacent bands.
- **Pass 2:** Extracts XYZ points for each surface band.
- **Output:** `c2b_output/horiz_surface_N.xyz` in Cloud2BIM-compatible tab-separated format.

### Stage 3 — Import C2B Floor Levels

**Script:** `pipeline/floor_from_c2b.py`

- Computes the **median Z-height** of each `horiz_surface_N.xyz`.
- **Slab pairing:** Pairs adjacent planes within typical slab thickness. The lower face = confirmed floor level.
- Updates `info.json → floor_levels[]` with `{ floor_y, ceiling_y, storey_height }` per floor, replacing the Stage 1 histogram estimate.

---

### Stage 4 — Dense Wall Slices (GPU-accelerated)

**Script:** `pipeline/preprocess_walls.py`

Streams the full `.xyz` with `pandas.read_csv(engine="c")` in 2 M-line chunks. For each floor, retains points within `[floor_y − 0.05 m, floor_y + 2.65 m]` and converts to 5 cm voxel integer indices.

**Voxel deduplication** runs every 4 chunks to bound RAM/VRAM:
- **GPU (CuPy):** Three `int32` indices are packed into one `int64` key (`21 bits × 3 = 63 bits`), then `cp.unique` runs a native GPU radix sort on the 1D array. This uses ~3× less VRAM and runs 5–10× faster than the naïve `cp.unique(array, axis=0)` on a 2D array (which has no GPU kernel and falls back to a lexicographic sort).
- **CPU fallback:** `np.unique` on the same 1D int64 key, also faster than 2D unique.

Saves each floor's slice as `wall_slice_floor_N.npy` (float32 `(M, 3)` voxel-centred coordinates).

---

### Stage 5 — Detect Walls, Rooms & Export

Runs per-floor in-process. Three sub-stages plus export:

**5a Wall Detection** (`wall_detection_c2b.py`) — Cloud2BIM-style 2D density projection:
1. Height band filter: mid-storey fraction (0.30 → 0.90 × storey height) to exclude floor/ceiling clutter.
2. 2D grid projection onto a configurable 2–5 cm/cell XZ raster.
3. Local relative thresholding (`threshold_frac × max_density`) → binary occupancy grid.
4. `cv2.morphologyEx` (5×5 kernel) stitches broken scan gaps.
5. `cv2.findContours` + `cv2.approxPolyDP` (Douglas-Peucker) → linear segments.
6. Collinear merge + face pairing (parallel pairs within `max_wall_thickness`) → midline wall axis.
7. Manhattan snapping to 0°/90°.

**Output:** `walls_floor_N.json` — `[[x1,z1],[x2,z2]]` metric endpoint pairs.

**Tunable parameters:**

| Parameter | Default | Effect |
|---|---|---|
| `grid_size` | 0.02 m | Voxel resolution; finer = better detail, more RAM |
| `threshold_frac` | 0.01 | Density cutoff fraction |
| `dp_tolerance` | 0.04 m | Douglas-Peucker line simplification |
| `max_wall_thickness` | 0.75 m | Max separation for face-pair grouping |
| `min_wall_m` | 0.40 m | Minimum segment length to keep |
| `snap_to_axis` | `true` | Enable Manhattan snapping |

---

### Stage 5 — Opening Detection

**Script:** `pipeline/opening_detection.py`

For every detected wall segment:

1. **Point projection:** Collects nearby floor-slice points within `±wall_thickness`. Projects them onto the wall's local UV coordinate frame (U = along wall, V = vertical).
2. **Occupancy grid:** Builds a 2-D grid in the (U, V) plane.
3. **Column scanning:** Scans each U-column for vertical empty spans:
   - **Door:** Column is mostly empty from `~0.15 m` to `~1.85 m` height.
   - **Window:** Solid sill below `~0.65 m`, gap to `~2.05 m`.
4. **Clustering:** Merges adjacent positive columns into single opening regions.

**Output:** `openings_floor_N.json` — list of openings with type, position, width, and height.

---

### Stage 6 — Room Detection

**Script:** `pipeline/room_detection.py`

Uses **image processing** rather than computational geometry to avoid polygon union complexity.

1. **Rasterisation:** Renders `walls_floor_N.json` as thick white lines on a large OpenCV canvas (typically 2–5 cm/px).  
   Endpoints are slightly extended to seal T-junctions.
2. **Iterative morphological closing:** Applies kernels of increasing size (10 cm → 50 cm) to close any remaining gaps.
3. **Inversion + connected components:** Inverts so interior space becomes foreground. `cv2.connectedComponentsWithStats` (8-connectivity) labels each enclosed region.
4. **Filtering:**
   - Drops the **exterior** (the largest blob touching the image boundary).
   - Rejects blobs below `min_room_m2` (noise) or above `max_room_m2` (open space).
   - Rejects corridor-like regions narrower than `min_room_width_m`.
5. **Metric conversion:** Converts pixel bounding boxes and areas back to metres.

**Output:** `rooms_floor_N.json` — list of rooms with bounding box, centroid, and area (m²).

---

### Stage 7 — DXF / SVG Export

**Script:** `pipeline/dxf_export.py`

Combines the JSON artefacts into industry-standard 2-D CAD files using **ezdxf**.

| DXF Layer | Contents |
|---|---|
| `A-WALL` | Wall centre-line segments |
| `A-DOOR` | Door gap lines + swing arc (architectural convention) |
| `A-WINDOW` | Window pane offset lines |
| `A-ROOM` | Room bounding rectangle + area text annotation (m²) |

Both a `.dxf` (for CAD) and `.svg` (for browser preview) are generated per floor.

---

## API Reference

The FastAPI server runs on `http://localhost:8000`. All endpoints are prefixed with `/api/`.

### Unified Pipeline

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/pipeline/run` | Start the full 5-stage pipeline for a given `.xyz` path |
| `GET` | `/api/pipeline/status` | Poll running/done/error, current stage, elapsed time, log tail |
| `POST` | `/api/pipeline/cancel` | Placeholder (not yet implemented) |

### Scan File Browser

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/scan/browse` | Walk `SCAN_ROOTS` dirs and return grouped `.xyz` file listings |

### XYZ Path (manual override)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/xyz-path` | Return the currently configured `.xyz` path |
| `POST` | `/api/xyz-path` | Persist a new `.xyz` container-internal path |

### Legacy Single-Stage Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/reprocess` | Clear outputs and rerun Stage 1 only |
| `GET` | `/api/reprocess/status` | Poll Stage 1 reprocess job |
| `POST` | `/api/preprocess-walls` | Run Stage 4 (wall slices) in background |
| `GET` | `/api/preprocess-walls/status` | Poll wall-slice job |
| `GET` | `/api/c2b/status` | List `horiz_surface_*.xyz` files |
| `POST` | `/api/c2b/floors` | Derive floor levels from C2B output |
| `POST` | `/api/c2b/walls` | Run wall detection for one floor (advanced panel) |

### Walls

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/walls/{floor_idx}` | Retrieve vectorised wall data |
| `PUT` | `/api/walls/{floor_idx}` | Save user-edited walls → auto re-detect rooms → re-export |
| `POST` | `/api/walls/{floor_idx}/export` | Regenerate DXF/SVG |
| `GET` | `/api/walls/{floor_idx}/download` | Download `.dxf` file |
| `GET` | `/api/walls/{floor_idx}/svg` | Get `.svg` preview |

### Openings & Rooms

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/openings` | Run opening detection for a floor |
| `GET` | `/api/openings/{floor_idx}` | Retrieve opening data |
| `POST` | `/api/rooms` | Run room detection for a floor |
| `GET` | `/api/rooms/{floor_idx}` | Retrieve room data |

### Status / Point Cloud

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | Overall readiness check (pointcloud.bin + info.json presence) |
| `GET` | `/api/pointcloud` | Stream `pointcloud.bin` to frontend |
| `GET` | `/api/info` | Return `info.json` contents |

---

## Frontend

Built with **React 19 + Vite 8**.

### Components

| Component | Role |
|---|---|
| `App.jsx` | Root layout, status polling loop, 3-D/2-D view switching |
| `Sidebar.jsx` | XYZ file selection, pipeline trigger buttons, parameter controls, progress display |
| `FloorPlanViewer.jsx` | HTML5 `<canvas>` based 2-D floor plan editor |
| `FloorPlanPanel.jsx` | Tab switcher for multiple floors |
| `PointCloud.jsx` | Three.js point cloud renderer (reads `pointcloud.bin`) |
| `OBJModel.jsx` | Three.js OBJ/GLB mesh overlay |
| `LoadingOverlay.jsx` | Fullscreen overlay shown during background jobs |

### FloorPlanViewer Canvas Editor

The 2-D editing toolkit in `FloorPlanViewer.jsx` supports:

- **Pan / Zoom** — mouse wheel + middle-click drag
- **Add Wall** — click two endpoints to draw a new segment
- **Delete Wall** — click near a segment to remove it
- **Snap to Endpoint** — new walls snap to existing endpoints within a configurable pixel radius
- **Undo / Redo** — full history stack
- **Save** — persists edits to the backend, triggers automatic room re-detection and DXF re-export

---

## Getting Started

### Prerequisites

- **Docker Desktop** (Windows/macOS/Linux)
- An NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) for the GPU variant (optional)
- A Matterport `.xyz` scan file on the host

### CPU deployment (standard)

```bat
:: From the scan2floor\ directory:
docker compose up --build -d
:: App available at http://localhost:8000
```

### GPU deployment

```bat
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
```

### Mounting scan data

Edit `docker-compose.yml` and add one volume line per scan location:

```yaml
volumes:
  - C:/scans/project_A:/data/project_A:ro
  - D:/archive/building_2:/data/building_2:ro
```

The `SCAN_ROOTS=/data` environment variable tells the backend where to walk. Add extra roots (comma-separated) if you mount outside `/data`.

### Running the Full Pipeline

1. Open `http://localhost:8000` in a browser.
2. In the **Scan File** panel, click **↺ Refresh** — discovered `.xyz` files under mounted `/data` volumes appear automatically. Click one to select it.
3. Click **▶ Run Full Pipeline** — all 5 stages run sequentially with live stage progress and a log tail.
4. When complete, switch to the **Vector Floor Plan** layer to inspect results.
5. Optionally fine-tune walls on the canvas and click **Save Edits**.
6. Download `.dxf` per floor for use in AutoCAD / Revit / QGIS.

---

## Configuration

### Wall detection parameters (adjustable in the Sidebar UI)

| Parameter | Default | Description |
|---|---|---|
| `grid_size` | `0.02` m | 2-D projection cell size |
| `dp_tolerance` | `0.04` m | Douglas-Peucker simplification tolerance |
| `threshold_frac` | `0.01` | Density binarisation fraction |
| `max_wall_thickness` | `0.75` m | Max face-pair separation |
| `min_wall_m` | `0.40` m | Minimum wall segment length |
| `snap_to_axis` | `true` | Manhattan grid snapping |

### Docker environment variables (`docker-compose.yml`)

| Variable | Default | Purpose |
|---|---|---|
| `PROCESSED_DIR` | `/processed` | Named volume mount — all pipeline outputs |
| `DATA_DIR` | `/data/matterpak` | Default scan folder fallback |
| `C2B_DIR` | `/processed/c2b_output` | C2B surface output location |
| `SCAN_ROOTS` | `/data` | Comma-separated roots for scan file browser |

The active `.xyz` path is persisted to `xyz_path.json` inside `PROCESSED_DIR`.

---

## Data Directory Layout

```
backend/processed/
├── xyz_path.json              # Persisted XYZ file path config
├── pointcloud.bin             # Downsampled binary for frontend viewer
├── info.json                  # Metadata: bounds, floor_levels[], etc.
├── wall_slice_floor_0.npy     # Dense point arrays per floor
├── wall_slice_floor_1.npy
├── walls_floor_0.json         # Vectorised wall segments
├── walls_floor_1.json
├── openings_floor_0.json      # Door/window openings
├── rooms_floor_0.json         # Room bounding boxes + areas
├── floor_0.dxf                # Exportable CAD file
├── floor_0.svg                # Browser-renderable preview
└── (debug .png images)        # Saved when save_debug=true
```

---

## Known Limitations

- **Large file I/O:** Files over ~8 GB may cause high memory spikes during Stage 4 chunked streaming even with the C engine; consider reducing `CHUNK_LINES` if OOM errors occur.
- **Curved walls:** The algorithm assumes rectilinear or near-rectilinear architecture; circular walls are approximated as polygons.
- **Stairwells / voids:** Open vertical elements may be misclassified as very tall rooms and require manual deletion.
- **GPU requirement for best speed:** Stage 4 runs on CPU if CuPy is unavailable (CPU-only container); runtime increases from ~1–2 min to ~3–4 min for a 114 M point file.
- **Single-space XYZ delimiter:** The pandas C engine (`sep=" "`) assumes single-space-delimited `.xyz` files (standard Matterport output). Files with irregular whitespace or tabs would need the Python engine re-enabled.
