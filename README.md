# Scan2Floor

> **Point cloud → vectorized architectural floor plan & BIM model, end-to-end.**

Scan2Floor ingests raw Matterport `.xyz` 3-D point clouds and produces analysis-ready 2-D floor plans and 3-D BIM models — complete with vector wall segments, door/window openings, room boundaries, area calculations, CAD exports (**DXF**, **SVG**), and open BIM (**IFC 2x3**) models. A React frontend provides interactive 3-D point cloud viewing, a 3-D BIM Inspector with bidirectional element selection, and a live 2-D canvas for manual wall adjustments.

---

## ⚡ Quickstart: Running Locally

You can run Scan2Floor directly on your machine without Docker for development, or run it containerized with Docker.

### Option A: Local Development (Recommended for Development)

#### Prerequisites
- **Python 3.10+** (3.11 or 3.12 recommended)
- **Node.js 18+** & `npm`
- (Optional) NVIDIA GPU with CUDA for accelerated point cloud processing

#### 1. Setup & Launch Backend

```bash
# Navigate to the backend directory
cd backend

# Create and activate a Python virtual environment
python -m venv venv

# Windows (Command Prompt / PowerShell):
.\venv\Scripts\activate
# macOS / Linux:
source venv/bin/activate

# Install dependencies (including FastAPI, OpenCV, ezdxf, ifcopenshell, etc.)
pip install -r requirements.txt
```

Launch the backend with hot-reload:
```bash
# On Windows, you can simply run the root batch script:
..\start_backend.bat

# Or run manually via uvicorn:
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
- The backend will be live at: **`http://localhost:8000`**
- Interactive Swagger API docs: **`http://localhost:8000/docs`**

> **Tip:** You can configure where your scan files live by setting the `DATA_ROOT` environment variable in `start_backend.bat` (e.g., `set DATA_ROOT=C:\path\to\scans`).

#### 2. Setup & Launch Frontend

In a separate terminal window:
```bash
# Navigate to frontend directory
cd frontend

# Install Node dependencies
npm install

# Start Vite development server
npm run dev
```
- The web app will be accessible at: **`http://localhost:5173`**
- Requests to `/api` and `/model` are automatically proxied to `http://localhost:8000`.

---

### Option B: Docker Deployment (One-Click)

#### Standard CPU Launch:
```bat
:: From repository root (Windows):
docker-build.bat

:: Or using Docker Compose directly:
docker compose up --build -d
```
- The complete application is served at: **`http://localhost:8000`** (or mapped port `http://localhost:9000` depending on compose port settings).
- To stop the containers: `docker-stop.bat` or `docker compose down`.

#### GPU-Accelerated Docker Launch (NVIDIA):
```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
```

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
   - [Stage 5 — Detect Walls, Openings & Rooms](#stage-5--detect-walls-openings--rooms)
   - [Stage 6 — CAD & BIM Export (DXF, SVG, IFC)](#stage-6--cad--bim-export-dxf-svg-ifc)
5. [BIM & IFC Export](#bim--ifc-export)
6. [Saves & Version Management](#saves--version-management)
7. [API Reference](#api-reference)
8. [Frontend Components & Tools](#frontend-components--tools)
9. [Configuration](#configuration)
10. [Data Directory Layout](#data-directory-layout)
11. [Known Limitations](#known-limitations)

---

## Features

| Capability | Detail |
|---|---|
| **3-D Point Cloud Viewer** | High-performance Three.js point cloud renderer streaming compact binary (`pointcloud.bin`) + optional OBJ/GLB mesh overlays |
| **3-D BIM Inspector** | Interactive 3D building inspection: real-time extruded walls, 3D door frames/leaves, window panes, and spaces with bidirectional selection sync with 2D views |
| **Unified 5-Stage Pipeline** | One-click autonomous run: XYZ → Slabs → Floor Levels → Wall Slices → Vector Walls/Openings/Rooms → CAD & BIM |
| **BIM IFC Export** | Industry standard **IFC 2x3** export (`IfcWallStandardCase`, `IfcDoor`, `IfcWindow`, `IfcSpace`) for single storeys or full multi-storey buildings |
| **Point Cloud Cleaner** | Filter out foreign objects (furniture, tables, clutter) and isolate structural planes (slabs, ceiling, walls) |
| **Built-in Slab Detection** | Cloud2BIM-compatible histogram slice detection — no external software required |
| **Wall Vectorisation** | 2-D density grid projection → OpenCV contour analysis → Douglas-Peucker simplification → Manhattan snapping |
| **Opening Detection** | Vertical occupancy profile scanning per wall segment for realistic door and window placement |
| **Room Bounding & Calculation** | Morphological closing + connected component labelling with automatic square metre area calculation |
| **Interactive 2D Editor** | Live canvas editor to add, move, or delete walls with snap-to-endpoint, undo/redo, and real-time room recomputation |
| **Project Saves & Snapshots** | Create named snapshots of processed results and edits, switch between saves, and export deliverables at any point |
| **CAD Export** | Multi-layer DXF (`A-WALL`, `A-DOOR`, `A-WINDOW`, `A-ROOM`) + browser-native SVG vector plans |
| **GPU Acceleration** | Optional CuPy-powered voxel deduplication in Stage 4 (1D int64 radix sort for ~3× less VRAM) |

---

## Project Structure

```
scan2floor/
├── backend/
│   ├── main.py                     # FastAPI application & all REST endpoints
│   ├── requirements.txt            # Python dependencies (ezdxf, ifcopenshell, etc.)
│   ├── Dockerfile                  # Python container definition
│   ├── dist/                       # Compiled production frontend (built by Vite)
│   ├── processed/                  # Working directory for pipeline outputs and saves
│   └── pipeline/
│       ├── run_pipeline.py         # Sequential pipeline coordinator
│       ├── preprocess_xyz.py       # Stage 1 — coordinate transform & downsampled bin export
│       ├── clean_pointcloud.py     # Structural filtering & clutter removal
│       ├── run_c2b.py              # Stage 2 — Cloud2BIM slab detection
│       ├── floor_from_c2b.py       # Stage 3 — Storey level derivation & pairing
│       ├── preprocess_walls.py     # Stage 4 — Chunked XYZ → per-floor wall slices (NPY)
│       ├── wall_detection_c2b.py   # Stage 5a — 2D density grid → vectorised walls
│       ├── opening_detection.py    # Stage 5b — Door & window gap analysis
│       ├── room_detection.py       # Stage 5c — Connected-component room polygon bounding
│       ├── dxf_export.py           # Stage 6a — Multi-layer DXF & SVG generator
│       ├── ifc_export.py           # Stage 6b — BIM IFC 2x3 exporter (ifcopenshell)
│       └── convert_glb.py          # GLB/OBJ mesh conversion helper
│
├── frontend/
│   ├── index.html
│   ├── vite.config.js              # Vite configuration (proxies /api to port 8000)
│   ├── package.json
│   └── src/
│       ├── main.jsx                # React entry point
│       ├── App.jsx                 # Main state coordinator & view tabs
│       ├── index.css               # Design system & dark mode tokens
│       └── components/
│           ├── Sidebar.jsx         # Pipeline controls, file browser, saves manager
│           ├── FloorPlanViewer.jsx # 2-D vector canvas editor & export toolbar
│           ├── FloorPlanPanel.jsx  # Multi-floor navigation switcher
│           ├── PointCloud.jsx      # Three.js point cloud renderer
│           ├── OBJModel.jsx        # 3D textured mesh overlay
│           ├── DetectedBim3D.jsx   # 3D BIM model viewer with extruded geometry
│           ├── BimInspectorOverlay.jsx # Inspector HUD & property panels
│           ├── RoomEditorPanel.jsx # Room metadata & label editor
│           └── LoadingOverlay.jsx  # Job execution spinner & live log tail
│
├── docker-compose.yml              # CPU Docker Compose stack
├── docker-compose.gpu.yml          # GPU Docker Compose override
├── docker-build.bat                # Windows build & launch script
├── docker-stop.bat                 # Windows container stop script
├── start_backend.bat               # Windows local backend launch script
└── README.md                       # ← Documentation
```

---

## Tech Stack

### Backend
- **FastAPI & Uvicorn**: High-performance asynchronous REST API server.
- **NumPy & Pandas**: Rapid streaming of multi-GB `.xyz` files with chunked C-engine processing.
- **OpenCV (`opencv-python-headless`)**: Morphological operations, contour extraction, and connected component analysis.
- **SciPy & Open3D**: Histogram analysis, peak detection, and point cloud transformations.
- **ifcopenshell**: Industry Foundation Classes (IFC 2x3) generation with complete building hierarchy and geometric representations.
- **ezdxf**: Multi-layer CAD DXF file construction.

### Frontend
- **React 19 & Vite 8**: Modern, ultra-responsive user interface.
- **Three.js & @react-three/fiber / @react-three/drei**: Interactive 3D WebGL viewport for point clouds and BIM geometry.
- **HTML5 Canvas**: Hardware-accelerated 2D floor plan rendering, selection, and vector editing.

---

## Processing Pipeline

```
cloud.xyz  (Raw Matterport point cloud)
    │
    ▼ Stage 1 ─ preprocess_xyz.py
pointcloud.bin + info.json              (Bounds, horizontal centroid, preliminary floors)
    │
    ▼ Stage 2 ─ run_c2b.py
c2b_output/horiz_surface_N.xyz          (Horizontal slab slice point clouds)
    │
    ▼ Stage 3 ─ floor_from_c2b.py
info.json updated                       (Precise floor levels & storey heights)
    │
    ▼ Stage 4 ─ preprocess_walls.py     (Streaming C-engine + CuPy / NumPy deduplication)
wall_slice_floor_N.npy                  (Filtered 5 cm voxel points per floor)
    │
    ▼ Stage 5 ─ Vectorisation & Analysis
    ├─▶ wall_detection_c2b.py  →  walls_floor_N.json
    ├─▶ opening_detection.py   →  openings_floor_N.json
    ├─▶ room_detection.py      →  rooms_floor_N.json
    │
    ▼ Stage 6 ─ CAD & BIM Export
    ├─▶ dxf_export.py          →  floor_N.dxf + floor_N.svg
    └─▶ ifc_export.py          →  floor_N.ifc + building.ifc (IFC 2x3)
```

---

## BIM & IFC Export

Scan2Floor can export results to **IFC 2x3** (Industry Foundation Classes) format, making the generated models directly importable into BIM software such as **Autodesk Revit**, **GRAPHISOFT Archicad**, **Solibri**, **BIMcollab**, **FreeCAD**, or **BlenderBIM**.

### Export Features:
- **Spatial Structure**: Automatically builds the IFC hierarchy:
  `IfcProject` → `IfcSite` → `IfcBuilding` → `IfcBuildingStorey`
- **Standardized Walls (`IfcWallStandardCase`)**: Extruded solid geometry derived from midline wall vectors, storey height, and assigned wall thickness.
- **Doors & Windows (`IfcDoor`, `IfcWindow`)**: Positioned accurately along wall hosts with precise width and height.
- **Rooms & Spaces (`IfcSpace`)**: 3D spatial volumes with floor area attributes.
- **Two Export Modes**:
  1. **Single Floor IFC**: Exports an individual storey (`floor_{idx}.ifc`).
  2. **Full Building IFC**: Merges all storeys into a single coordinated BIM file (`building.ifc`).

Export buttons (**↓ IFC** and **↓ IFC All**) are accessible directly from the Floor Plan Viewer toolbar and the REST API.

---

## Saves & Version Management

Scan2Floor supports creating named snapshots of your project. Each save encapsulates:
- Vector wall coordinates (`walls_floor_*.json`)
- Room boundaries & areas (`rooms_floor_*.json`)
- Door and window openings (`openings_floor_*.json`)
- Exported CAD files (`floor_*.dxf`, `floor_*.svg`)
- Exported BIM models (`floor_*.ifc`, `building.ifc`)
- Metadata (`info.json` and `meta.json`)

### Storage Location:
- **Local Run**: `backend/processed/saves/<save_name>/`
- **Docker Run**: `/processed/saves/<save_name>/` inside the persistent `processed_data` volume.

Users can create saves, switch between the current working buffer and previous snapshots, delete old saves, or export deliverables directly from any saved state.

---

## API Reference

The backend API operates at `http://localhost:8000/api`.

### Pipeline Execution
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/pipeline/run` | Start full pipeline execution for selected `.xyz` |
| `GET` | `/api/pipeline/status` | Poll job state, progress percentage, current stage, and log output |
| `POST` | `/api/pipeline/cancel` | Cancel current background job |

### Scan File Selection
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/scan/browse` | Discover available `.xyz` point cloud files |
| `GET` | `/api/xyz-path` | Get the currently selected scan file path |
| `POST` | `/api/xyz-path` | Set the active scan file path |

### Walls & CAD/BIM Exports
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/walls/{floor_idx}` | Retrieve detected wall segments for a floor |
| `PUT` | `/api/walls/{floor_idx}` | Save manual edits (triggers automatic room recalculation) |
| `GET` | `/api/walls/{floor_idx}/download` | Download DXF file for single floor |
| `GET` | `/api/walls/{floor_idx}/download-ifc` | Download IFC 2x3 BIM file for single floor |
| `GET` | `/api/building/download-ifc` | Download full multi-storey IFC 2x3 building model |
| `GET` | `/api/walls/{floor_idx}/svg` | Retrieve SVG floor plan preview |

### Openings & Rooms
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/openings/{floor_idx}` | Retrieve detected door and window openings |
| `PUT` | `/api/openings/{floor_idx}` | Update opening properties |
| `GET` | `/api/rooms/{floor_idx}` | Retrieve detected room polygons and areas |

### Saves & Snapshots
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/saves` | List all saved snapshots |
| `POST` | `/api/saves` | Create a new named snapshot of the current state |
| `DELETE` | `/api/saves/{name}` | Delete a saved snapshot |
| `GET` | `/api/saves/{name}/info` | Retrieve metadata for a specific save |
| `GET` | `/api/saves/{name}/download/{floor_idx}` | Download DXF from a saved snapshot |
| `GET` | `/api/saves/{name}/download-ifc/{floor_idx}` | Download single-floor IFC from a saved snapshot |
| `GET` | `/api/saves/{name}/download-ifc-all` | Download multi-storey IFC from a saved snapshot |

---

## Frontend Components & Tools

- **`FloorPlanViewer.jsx`**:
  Interactive 2D vector editor supporting canvas pan/zoom, drawing new walls, segment deletion, endpoint snapping, undo/redo stacks, and CAD/BIM download links.
- **`DetectedBim3D.jsx` & `BimInspectorOverlay.jsx`**:
  A 3D spatial BIM viewer that extrudes 2D walls into solid geometry with textured finishes, generates 3D doors and windows, and highlights selected elements across both 2D and 3D views.
- **`PointCloud.jsx`**:
  Three.js point cloud renderer streaming compact binary representations with customizable point size and height color ramps.
- **`Sidebar.jsx`**:
  Provides controls for pipeline execution, scan file selection, density threshold tuning, and save management.

---

## Configuration

### Tunable Pipeline Parameters (Sidebar UI)
- **`grid_size`** (`default: 0.02 m`): 2-D raster projection cell size.
- **`threshold_frac`** (`default: 0.01`): Relative density cutoff fraction.
- **`dp_tolerance`** (`default: 0.04 m`): Douglas-Peucker simplification tolerance.
- **`max_wall_thickness`** (`default: 0.75 m`): Maximum wall face pairing distance.
- **`min_wall_m`** (`default: 0.40 m`): Minimum wall length to retain.
- **`snap_to_axis`** (`default: true`): Manhattan orthogonal angle snapping.

### Environment Variables
- `PROCESSED_DIR`: Directory where output files and saves are written (`default: backend/processed`).
- `DATA_DIR`: Fallback path to default scan directory (`default: data/matterpak`).
- `SCAN_ROOTS`: Comma-separated paths searched by the scan browser.

---

## Data Directory Layout

```
backend/processed/
├── pointcloud.bin             # Downsampled binary point cloud
├── info.json                  # Metadata, storey elevations, bounds
├── wall_slice_floor_0.npy     # Filtered voxel slices per floor
├── walls_floor_0.json         # Vector wall segments
├── openings_floor_0.json      # Door & window definitions
├── rooms_floor_0.json         # Room boundary polygons & areas
├── floor_0.dxf                # AutoCAD-compatible DXF
├── floor_0.svg                # Browser SVG preview
├── floor_0.ifc                # IFC 2x3 single-floor BIM file
├── building.ifc               # IFC 2x3 multi-floor full BIM file
└── saves/                     # Named snapshots
    └── <save_name>/
        ├── meta.json
        ├── info.json
        ├── walls_floor_*.json
        └── ...
```

---

## Known Limitations

- **Rectilinear Bias**: Wall vectorization and snapping optimize for Manhattan or orthogonal geometry; curved walls will be represented as simplified polygonal chains.
- **Dense Scan Memory Spikes**: Extremely large scans (>100M points) should use chunked streaming (enabled by default) to stay within RAM limits.
- **Single-Space XYZ Format**: Default streaming uses fast C-engine parsing assuming space-delimited coordinates.
