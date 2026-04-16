# Scan2Floor Architecture & Documentation

Scan2Floor is a full-stack application designed to process 3D point cloud data (Matterport `.xyz` format) into 2D vectorized architectural floor plans (DXF/SVG). It bridges the gap between raw unstructured 3D scans and structured 2D architectural vectors by sequentially extracting floor levels, wall segments, structural openings (doors/windows), and enclosed rooms.

## System Overview

The system is composed of two primary parts:
1. **Frontend:** A React + Vite web application utilizing Three.js (`@react-three/fiber`) for 3D point cloud visualization, and a custom 2D canvas editor for reviewing and tweaking vectorized wall segment data.
2. **Backend:** A Python FastAPI server that serves as both a file manager and the core point cloud processing pipeline, heavily relying on NumPy, OpenCV, and structural heuristics.

---

## 1. Data Ingestion & Preprocessing

### 1.1 First-Stage Transformation (`preprocess_xyz.py`)
- **Input:** Matterport raw `.xyz` point cloud.
- **Conversion:** Transforms the coordinate system from Matterport's Z-up space to Three.js's Y-up space (`y_yup = z_raw`), centers the point cloud horizontally to improve numeric stability, and extracts a downsampled `pointcloud.bin` file for rapid frontend visualization.
- **Output:** `pointcloud.bin` and a base `info.json` containing bounds, centroids, and a rudimentary check on room heights via a density histogram peak-finder.

### 1.2 Height & Floor Extraction (`floor_from_c2b.py`)
- **Cloud2BIM Integration:** Leverages pre-computed Cloud2BIM output surfaces (`horiz_surface_N.xyz`) that capture floor and ceiling planes.
- **Pairing:** Reads the median Z-heights of these horizontal surface slices, sorting and pairing them up. A pair of close parallel planes identifies a physical concrete slab, and the lower face denotes a definitive floor level.
- **Output:** Updates `info.json` with accurate vertical bands (`floor_levels`), dictating how the point cloud will be sliced horizontally.

### 1.3 Dense Wall Slices (`preprocess_walls.py`)
- **Purpose:** Voxelization on the entire 4.4GB file is memory-intensive. To overcome this, the script streams the `.xyz` file using Pandas chunks.
- **Slicing:** For each detected floor level, it captures only points within a specific height band (`[floor_y - 0.05, floor_y + 2.65]`).
- **Downsampling:** Applies a 5cm voxel downsampling to these thin slabs to maintain high density at the wall locations while discarding superfluous ceilings and floors.
- **Output:** `wall_slice_floor_N.npy` arrays.

---

## 2. Structural Component Detection

### 2.1 Wall Detection (`wall_detection_c2b.py`)
- **Algorithm Strategy:** Adopts a Cloud2BIM-style 2D projection approach.
- **Projection & Histogram:** Slices a mid-height band (`0.30 * storey_height` to `0.90 * storey_height`) from the dense numpy arrays to ignore floor clutter. Projects this down to a 2D XZ density grid (typically with 2cm-5cm cells).
- **Computer Vision Extraction:**
   1. Applies local relative thresholding to binarize the density map.
   2. Uses morphological closing (`cv2.morphologyEx`) with a 5x5 kernel to stitch together adjacent broken scan points.
   3. Extracts contours (`cv2.findContours`) and simplifies them into linear segments via Douglas-Peucker (`cv2.approxPolyDP`).
- **Wall Axis & Thickness:** Iteratively merges collinear segments. Parallel segments within typical wall thicknesses are grouped together to define the center axis (midline) of the wall and its calculated thickness.
- **Manhattan Snapping:** Near-axis walls are snapped to horizontal and vertical (0°/90°) rules.
- **Output:** `walls_floor_N.json` (vectorized endpoints in metric coordinates).

### 2.2 Opening Detection (`opening_detection.py`)
- **Strategy:** Detects windows and doors by scanning inside the footprint of the detected 2D wall lines.
- **Profile Generation:** For each extracted wall segment, it grabs nearby points from the full floor slice (`±wall_thickness`). It projects them onto the 1D length of the wall (u-axis) and vertical height (v-axis).
- **Gap Identifying:** 
   - Generates a 2D occupancy grid spanning the vertical wall plane.
   - Scans columns for vertical gaps. 
   - **Doors:** Expected to be mostly empty from `~0.15m` up to `~1.85m`.
   - **Windows:** Expected to have solid wall (sill) under `0.65m` and gap until `~2.05m`.
- **Output:** `openings_floor_N.json`.

### 2.3 Room Bounding (`room_detection.py`)
- **Strategy:** Identifies enclosed architectural areas (rooms) using image processing techniques without complex computational geometry.
- **Rasterization:** Draws the calculated `walls_floor_N.json` into a large blank OpenCV canvas using thick white lines, expanding endpoints slightly to seal T-junction gaps.
- **Morphological Closing:** Iteratively closes gaps varying from 10cm to 50cm using OpenCV kernels.
- **Connected Components:** Inverts the image so empty space is `255` and walls are `0`. Uses 8-connected component labeling (`cv2.connectedComponentsWithStats`) to find the isolated interior objects.
- **Filtering:** Filters out the "exterior" (the largest blob touching the image boundary) and rejects very small, very large, or overly thin (corridor-like) noise artifacts.
- **Output:** `rooms_floor_N.json` detailing bounding boxes, centroids, and areas in square meters.

---

## 3. Post-Processing and Output

### DXF and SVG Export (`dxf_export.py`)
- **Composition:** Combines the JSON metadata into standard CAD formats using `ezdxf`.
- **Layers:**
   - `A-WALL`: Line segments representing walls.
   - `A-DOOR`: Door openings and standard architectural arcs representing door swing direction/radius.
   - `A-WINDOW`: Narrow offsets indicating window panes.
   - `A-ROOM`: Room boundary boxes and text annotations for calculated square meter areas.
- **Output:** Downloadable `floor_N.dxf` native CAD files and an interactive SVG preview (`floor_N.svg`).

---

## 4. Web Interface (Frontend)

- **3D Viewer Component (`PointCloud.jsx` & `OBJModel.jsx`):** Uses `@react-three/drei` and `@react-three/fiber` to display the `pointcloud.bin` and the raw mesh in 3D-space, allowing spatial reasoning overlaying of 2D data planes.
- **2D Editing Component (`FloorPlanViewer.jsx`):** Handles the rendering of vectors on an HTML5 `<canvas>`. Includes an interactive toolkit that permits manual intervention (drawing missing walls, erasing ghost walls, undo/redo logic).
- **Orchestration / File Loading:** The UI queries the FastAPI backend periodically to report progress levels (processing vs extracting vs ready). It handles `.xyz` file selection via a native system dialogue triggered by the Python backend. Editable saves trigger automatic room-recalculations in the backend to ensure room areas reflect the latest user-defined layout.
