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
   - [Stage 2 — Floor Level Extraction (Cloud2BIM)](#stage-2--floor-level-extraction-cloud2bim)
   - [Stage 3 — Dense Wall Slices](#stage-3--dense-wall-slices)
   - [Stage 4 — Wall Detection](#stage-4--wall-detection)
   - [Stage 5 — Opening Detection](#stage-5--opening-detection)
   - [Stage 6 — Room Detection](#stage-6--room-detection)
   - [Stage 7 — DXF / SVG Export](#stage-7--dxf--svg-export)
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
| **Automatic floor detection** | Paired horizontal surface analysis via Cloud2BIM |
| **Wall vectorisation** | 2-D density grid → CV contour → Douglas-Peucker → axis merge |
| **Opening detection** | Per-wall vertical occupancy profile for doors & windows |
| **Room bounding** | Morphological closing + connected-component labelling |
| **Manual editing** | Draw / erase walls on canvas; undo/redo; snap-to-endpoint |
| **Auto re-calculation** | Saving edits triggers room re-detection and DXF re-export automatically |
| **CAD export** | Multi-layer DXF (walls, doors, windows, rooms) + SVG preview |
| **Background jobs** | Long preprocessing pipelines run in threads; status polled via REST |
| **Native file picker** | Backend spawns tkinter subprocess so the browser can open a file dialog |

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

The pipeline is sequential. Each stage produces intermediate artefacts consumed by the next stage. All artefacts land in `backend/processed/`.

```
cloud.xyz (raw Matterport scan)
    │
    ▼ Stage 1 ─ preprocess_xyz.py
pointcloud.bin  +  info.json (basic bounds)
    │
    ▼ Stage 2 ─ floor_from_c2b.py  (reads Cloud2BIM horiz_surface_N.xyz)
info.json  ← updated with accurate floor_levels[]
    │
    ▼ Stage 3 ─ preprocess_walls.py  (streams whole .xyz in chunks)
wall_slice_floor_0.npy
wall_slice_floor_1.npy  …
    │
    ▼ Stage 4 ─ wall_detection_c2b.py
walls_floor_0.json
walls_floor_1.json  …
    │
    ├─▶ Stage 5 ─ opening_detection.py
    │   openings_floor_0.json  …
    │
    ├─▶ Stage 6 ─ room_detection.py
    │   rooms_floor_0.json  …
    │
    └─▶ Stage 7 ─ dxf_export.py
        floor_0.dxf + floor_0.svg  …
```

---

### Stage 1 — XYZ Preprocessing

**Script:** `pipeline/preprocess_xyz.py`

- Reads the raw Matterport `.xyz` file (tab/space-separated `X Y Z R G B`).
- **Coordinate transform:** Converts Matterport's Z-up convention to Three.js Y-up convention (`y_yup = z_raw`), then centres the cloud horizontally for numeric stability.
- **Downsampled binary:** Exports a compact `pointcloud.bin` (float32 XYZ + uint8 RGB) for fast frontend streaming.
- **Metadata:** Writes `info.json` with 3-D bounding box, centroid, and a preliminary floor count estimated from a Y-axis density histogram.

---

### Stage 2 — Floor Level Extraction (Cloud2BIM)

**Script:** `pipeline/floor_from_c2b.py`

> This stage replaces the histogram heuristic with precise slab-level detection.

- Reads pre-computed Cloud2BIM output: `horiz_surface_N.xyz` files, each representing a detected horizontal plane (floor or ceiling).
- Computes the **median Z-height** of each surface file.
- **Slab pairing:** Sorts all median heights and pairs adjacent planes that are within typical concrete-slab thickness. The lower face of each pair is a confirmed floor level.
- Updates `info.json` → `floor_levels[]` with `{ floor_y, ceiling_y, storey_height }` per floor.

---

### Stage 3 — Dense Wall Slices

**Script:** `pipeline/preprocess_walls.py`

Because the full `.xyz` file can exceed 4 GB, this stage **streams** it with Pandas in fixed-size chunks rather than loading it all at once.

- For each `floor_level`, it retains only points within the height band  
  `[floor_y - 0.05 m, floor_y + 2.65 m]` (i.e., ground clearance to just below the ceiling).
- Applies **5 cm voxel downsampling** (`open3d.geometry.VoxelDownSampleDict`) to reduce density while preserving wall structure.
- Saves each floor's slice as a NumPy binary `wall_slice_floor_N.npy` for fast random access.

---

### Stage 4 — Wall Detection

**Script:** `pipeline/wall_detection_c2b.py`  
**Algorithm:** Cloud2BIM-style 2-D density projection

1. **Height band filter:** Takes the mid-height fraction (`0.30 × storey_height` → `0.90 × storey_height`) of the floor slice to exclude floor reflections and ceiling geometry.
2. **2-D grid projection:** Accumulates point density onto a configurable 2–5 cm/cell XZ raster grid.
3. **Binarisation:** Applies **local relative thresholding** (`threshold_frac × max_density`) to create a binary occupancy grid.
4. **Morphological closing:** `cv2.morphologyEx` with a 5 × 5 kernel stitches broken scan gaps.
5. **Contour extraction:** `cv2.findContours` extracts closed regions representing wall bodies.
6. **Simplification:** `cv2.approxPolyDP` (Douglas-Peucker) reduces each contour to linear segments.
7. **Collinear merge:** Adjacent near-collinear segments are merged into single long wall segments.
8. **Face pairing:** Parallel segment pairs within `max_wall_thickness` (default 0.75 m) are grouped; the **midline** becomes the canonical wall axis.
9. **Manhattan snapping:** Walls within a small angular threshold of 0° or 90° are snapped to the axis grid.

**Output:** `walls_floor_N.json` — list of `[[x1, z1], [x2, z2]]` metric endpoint pairs.

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

### XYZ File Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/xyz-path` | Return the currently configured `.xyz` path |
| `POST` | `/api/xyz-path` | Set a new `.xyz` path |
| `GET` | `/api/browse-xyz` | Open a native Windows file-picker and return the chosen path |

### Pipeline Control

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/reprocess` | Clear stale outputs and rerun Stage 1 (preprocess_xyz) |
| `GET` | `/api/reprocess/status` | Poll the reprocess background job |
| `POST` | `/api/preprocess-walls` | Run Stage 3 (wall slice extraction) in background |
| `GET` | `/api/preprocess-walls/status` | Poll wall-slice job with per-file progress |

### Cloud2BIM Integration

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/c2b/status` | List available `horiz_surface_*.xyz` files |
| `POST` | `/api/c2b/floors` | Run Stage 2 (derive floor levels from Cloud2BIM output) |
| `POST` | `/api/c2b/walls` | Run Stage 4 (Cloud2BIM wall detection) for one floor |

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

- Python 3.10+
- Node.js 18+
- Cloud2BIM 1.03 pre-run on the point cloud (outputs `horiz_surface_N.xyz`)
- Matterport `.xyz` scan file

### Backend

```bash
# Install Python dependencies
cd backend
pip install -r requirements.txt

# Start the API server (or double-click start_backend.bat)
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

### Running the Full Pipeline

1. Open the sidebar and use **Browse…** to select your `.xyz` file.
2. Click **Rerun Full Preprocess** → wait for `pointcloud.bin` + `info.json`.
3. Click **Update Floors from Cloud2BIM** → derives precise floor levels.
4. Click **Preprocess Walls** → streams the full file and writes per-floor `.npy` slices (3–8 min).
5. For each floor, click **Detect Walls + Rooms** → runs Stages 4–7 and generates the floor plan.
6. Optionally edit the wall canvas and click **Save Edits**.
7. Download the `.dxf` for use in AutoCAD / Revit / QGIS.

---

## Configuration

### Backend defaults (editable in `main.py` / `C2BWallParams`)

| Parameter | Default | Description |
|---|---|---|
| `grid_size` | `0.02` m | 2-D projection cell size |
| `dp_tolerance` | `0.04` m | Douglas-Peucker simplification tolerance |
| `threshold_frac` | `0.01` | Density binarisation fraction |
| `max_wall_thickness` | `0.75` m | Max face-pair separation |
| `min_wall_m` | `0.40` m | Minimum wall segment length |
| `snap_to_axis` | `true` | Manhattan grid snapping |
| `wall_thickness` | `0.25` m | Used by opening detection |

### Data paths (relative to workspace root)

| Path | Purpose |
|---|---|
| `data/matterpak/cloud.xyz` | Default raw scan input |
| `Cloud2BIM-1.03/output_xyz/` | Cloud2BIM horizontal surface outputs |
| `backend/processed/` | All generated artefacts |

Paths are persisted to `backend/processed/xyz_path.json` when changed via the UI.

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

- **Cloud2BIM dependency:** Stages 2–7 require Cloud2BIM to have been run externally first. An in-process integration is planned.
- **Windows-only file picker:** The native file dialog uses `tkinter` and works only on Windows.
- **Large file performance:** Files over ~6 GB may cause high memory spikes during Stage 3 chunked streaming.
- **Curved walls:** The current algorithm assumes rectilinear or near-rectilinear architecture; circular walls are approximated as polygons.
- **Stairwells / voids:** Open vertical elements may be misclassified as very tall rooms and require manual deletion.
