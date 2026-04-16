import json
import os
import subprocess
import sys
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from pipeline.dxf_export import export_floor_dxf
from pipeline.opening_detection import detect_openings_for_floor
from pipeline.room_detection import detect_rooms_for_floor
from pipeline.wall_detection_c2b import detect_walls_c2b_for_floor
from pipeline.floor_from_c2b import update_floor_levels_from_c2b

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROCESSED_DIR = os.path.join(BASE_DIR, "processed")
MATTERPAK_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "data", "matterpak"))
_DEFAULT_XYZ_PATH = os.path.abspath(
    os.path.join(BASE_DIR, "..", "..", "data", "matterpak", "cloud.xyz")
)
# Cloud2BIM output directory (pre-computed from cloud.xyz)
_C2B_OUTPUT_DIR = os.path.abspath(
    os.path.join(BASE_DIR, "..", "..", "Cloud2BIM-1.03", "output_xyz")
)
_XYZ_CONFIG_PATH = os.path.join(BASE_DIR, "processed", "xyz_path.json")


def _get_xyz_path() -> str:
    """Return the currently configured XYZ path (persisted or default)."""
    if os.path.exists(_XYZ_CONFIG_PATH):
        try:
            with open(_XYZ_CONFIG_PATH) as fh:
                return json.load(fh).get("xyz_path", _DEFAULT_XYZ_PATH)
        except Exception:
            pass
    return _DEFAULT_XYZ_PATH


def _set_xyz_path(path: str) -> None:
    """Persist a new XYZ path to disk."""
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    with open(_XYZ_CONFIG_PATH, "w") as fh:
        json.dump({"xyz_path": path}, fh, indent=2)

# ── Background preprocess-walls job state ─────────────────────────────────────
_preprocess_lock = threading.Lock()
_preprocess_status = {
    "running": False,
    "done": False,
    "error": None,
    "started_at": None,
    "finished_at": None,
    "log": [],
}

# ── Background full-reprocess job state ───────────────────────────────────────
_reprocess_lock = threading.Lock()
_reprocess_status = {
    "running": False,
    "done": False,
    "error": None,
    "started_at": None,
    "finished_at": None,
    "log": [],
}

app = FastAPI(title="Scan2Floor API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/model", StaticFiles(directory=MATTERPAK_DIR), name="model")


# ── XYZ Path Configuration ──────────────────────────────────────────────────


class XYZPathPayload(BaseModel):
    xyz_path: str


@app.get("/api/xyz-path")
def get_xyz_path():
    """Return the currently configured .xyz file path."""
    path = _get_xyz_path()
    return {"xyz_path": path, "exists": os.path.isfile(path)}


@app.post("/api/xyz-path")
def set_xyz_path(payload: XYZPathPayload):
    """Persist a new .xyz file path chosen by the user."""
    p = payload.xyz_path.strip()
    if not p.lower().endswith(".xyz"):
        raise HTTPException(status_code=400, detail="Path must point to a .xyz file.")
    _set_xyz_path(p)
    return {"status": "ok", "xyz_path": p, "exists": os.path.isfile(p)}


@app.get("/api/browse-xyz")
def browse_xyz():
    """
    Open a native Windows file-picker dialog and return the selected .xyz path.
    Uses a tiny tkinter subprocess so it never blocks the FastAPI event loop.
    """
    tk_script = (
        "import tkinter as tk; "
        "from tkinter import filedialog; "
        "root = tk.Tk(); root.withdraw(); root.wm_attributes('-topmost', True); "
        "p = filedialog.askopenfilename("
        "    title='Select point cloud file',"
        "    filetypes=[('XYZ point cloud', '*.xyz'), ('All files', '*.*')]"
        "); print(p, end='')"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", tk_script],
            capture_output=True, text=True, timeout=120
        )
        chosen = result.stdout.strip()
        if not chosen:
            return {"cancelled": True, "xyz_path": None}
        return {"cancelled": False, "xyz_path": chosen, "exists": os.path.isfile(chosen)}
    except subprocess.TimeoutExpired:
        return JSONResponse({"error": "File dialog timed out"}, status_code=408)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Full Reprocess Pipeline ──────────────────────────────────────────────────


def _run_reprocess_bg(xyz_path: str) -> None:
    """
    Background thread: clears stale outputs then runs preprocess_xyz.py so the
    UI gets a fresh pointcloud.bin + info.json for the newly chosen file.
    """
    global _reprocess_status
    with _reprocess_lock:
        _reprocess_status.update({
            "running": True,
            "done": False,
            "error": None,
            "started_at": time.time(),
            "finished_at": None,
            "log": [f"Clearing stale outputs and reprocessing: {xyz_path}"],
        })

    # Delete all stale processed files to start with a truly clean slate
    import glob
    stale_patterns = [
        "pointcloud.bin", "info.json",
        "*.npy", "*.json", "*.dxf", "*.svg", "*.png", "*.jpg"
    ]
    for pat in stale_patterns:
        for p in glob.glob(os.path.join(PROCESSED_DIR, pat)):
            # preserve the xyz path configuration
            if os.path.basename(p) == "xyz_path.json":
                continue
            try:
                os.remove(p)
            except Exception as exc:
                with _reprocess_lock:
                    _reprocess_status["log"].append(f"[warn] could not delete {os.path.basename(p)}: {exc}")

    script = os.path.join(BASE_DIR, "pipeline", "preprocess_xyz.py")
    try:
        proc = subprocess.Popen(
            [sys.executable, script, "--xyz", xyz_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=BASE_DIR,
            encoding="utf-8",
            errors="replace",
        )
        log_lines: list[str] = []
        for line in proc.stdout:
            line = line.rstrip()
            log_lines.append(line)
            if len(log_lines) > 100:
                log_lines = log_lines[-100:]
            with _reprocess_lock:
                _reprocess_status["log"] = log_lines

        proc.wait()
        with _reprocess_lock:
            if proc.returncode == 0:
                _reprocess_status["done"] = True
                _reprocess_status["log"].append("\u2713 Finished successfully.")
            else:
                _reprocess_status["error"] = f"Exit code {proc.returncode}"
                _reprocess_status["log"].append(
                    f"\u2717 Failed with exit code {proc.returncode}"
                )
    except Exception as exc:
        with _reprocess_lock:
            _reprocess_status["error"] = str(exc)
            _reprocess_status["log"].append(f"\u2717 Exception: {exc}")
    finally:
        with _reprocess_lock:
            _reprocess_status["running"] = False
            _reprocess_status["finished_at"] = time.time()


@app.post("/api/reprocess")
def reprocess_start():
    """
    Delete stale pointcloud.bin / info.json and rerun preprocess_xyz.py
    for the currently configured .xyz file. Returns immediately; poll
    /api/reprocess/status for progress.
    """
    xyz_path = _get_xyz_path()
    if not os.path.exists(xyz_path):
        raise HTTPException(
            status_code=404,
            detail=f".xyz file not found at {xyz_path}. Set the correct path first.",
        )

    with _reprocess_lock:
        if _reprocess_status["running"]:
            return JSONResponse({
                "status": "already_running",
                "message": "Full reprocess is already in progress.",
            })

    thread = threading.Thread(
        target=_run_reprocess_bg, args=(xyz_path,), daemon=True
    )
    thread.start()
    return JSONResponse({
        "status": "started",
        "xyz_path": xyz_path,
        "message": "Full reprocess pipeline started. Poll /api/reprocess/status for progress.",
    })


@app.get("/api/reprocess/status")
def reprocess_status():
    """Poll the current status of the full-reprocess background job."""
    with _reprocess_lock:
        snap = dict(_reprocess_status)
    if snap.get("started_at"):
        snap["elapsed_s"] = round(
            (snap.get("finished_at") or time.time()) - snap["started_at"], 1
        )
    return snap


# ── Status / Point Cloud ─────────────────────────────────────────────────────


@app.get("/api/status")
def status():
    bin_path = os.path.join(PROCESSED_DIR, "pointcloud.bin")
    info_path = os.path.join(PROCESSED_DIR, "info.json")
    if os.path.exists(bin_path) and os.path.exists(info_path):
        with open(info_path) as f:
            info = json.load(f)

        # Annotate with wall-slice availability so the UI can show a hint
        n_floors = len(info.get("floor_levels", []))
        slices_ready = (
            all(
                os.path.exists(os.path.join(PROCESSED_DIR, f"wall_slice_floor_{i}.npy"))
                for i in range(n_floors)
            )
            if n_floors > 0
            else False
        )
        info["wall_slices_ready"] = slices_ready
        info["preprocess_walls_running"] = _preprocess_status["running"]

        return {"status": "ready", "info": info}
    return {"status": "processing", "info": None}


@app.get("/api/pointcloud")
def pointcloud():
    path = os.path.join(PROCESSED_DIR, "pointcloud.bin")
    if not os.path.exists(path):
        return JSONResponse(
            {"error": "Not ready yet — run preprocess.py"}, status_code=404
        )
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/api/info")
def info():
    path = os.path.join(PROCESSED_DIR, "info.json")
    if not os.path.exists(path):
        subprocess.Popen(["python", "pipeline/preprocess_o3d.py"], cwd=BASE_DIR)
        return JSONResponse({"status": "processing"})
    with open(path) as f:
        return json.load(f)


# ── Preprocess Walls (full-density slice extractor) ──────────────────────────


def _run_preprocess_walls_bg(xyz_path: str) -> None:
    """
    Background thread target — runs preprocess_walls.py and updates the global
    _preprocess_status dict so the API can report progress.
    """
    global _preprocess_status
    with _preprocess_lock:
        _preprocess_status.update(
            {
                "running": True,
                "done": False,
                "error": None,
                "started_at": time.time(),
                "finished_at": None,
                "log": [f"Starting preprocess_walls.py with {xyz_path} …"],
            }
        )

    script = os.path.join(BASE_DIR, "pipeline", "preprocess_walls.py")
    try:
        proc = subprocess.Popen(
            [sys.executable, script, "--xyz", xyz_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=BASE_DIR,
        )
        log_lines = []
        for line in proc.stdout:
            line = line.rstrip()
            log_lines.append(line)
            # Keep only last 60 log lines to avoid unbounded growth
            if len(log_lines) > 60:
                log_lines = log_lines[-60:]
            with _preprocess_lock:
                _preprocess_status["log"] = log_lines

        proc.wait()
        with _preprocess_lock:
            if proc.returncode == 0:
                _preprocess_status["done"] = True
                _preprocess_status["log"].append("✓ Finished successfully.")
            else:
                _preprocess_status["error"] = f"Exit code {proc.returncode}"
                _preprocess_status["log"].append(
                    f"✗ Failed with exit code {proc.returncode}"
                )
    except Exception as exc:
        with _preprocess_lock:
            _preprocess_status["error"] = str(exc)
            _preprocess_status["log"].append(f"✗ Exception: {exc}")
    finally:
        with _preprocess_lock:
            _preprocess_status["running"] = False
            _preprocess_status["finished_at"] = time.time()


@app.post("/api/preprocess-walls")
def preprocess_walls_start():
    """
    Kick off the full-density wall-slice extraction in the background.
    Streams the configured .xyz file → wall_slice_floor_<N>.npy (one per floor).
    Expected runtime: 3–8 minutes.
    Returns immediately with job status.
    """
    xyz_path = _get_xyz_path()
    if not os.path.exists(xyz_path):
        raise HTTPException(
            status_code=404,
            detail=f".xyz file not found at {xyz_path}. Set it via POST /api/xyz-path first.",
        )

    with _preprocess_lock:
        if _preprocess_status["running"]:
            return JSONResponse(
                {
                    "status": "already_running",
                    "message": "Preprocessing is already in progress.",
                }
            )

    thread = threading.Thread(
        target=_run_preprocess_walls_bg, args=(xyz_path,), daemon=True
    )
    thread.start()
    return JSONResponse(
        {
            "status": "started",
            "xyz_path": xyz_path,
            "message": "Wall-slice preprocessing started in the background. "
            "Poll /api/preprocess-walls/status for progress.",
        }
    )


@app.get("/api/preprocess-walls/status")
def preprocess_walls_status():
    """
    Poll the current status of the background preprocessing job.
    Also reports which wall_slice_floor_<N>.npy files already exist.
    """
    with _preprocess_lock:
        snap = dict(_preprocess_status)

    # Which slice files already exist?
    info_path = os.path.join(PROCESSED_DIR, "info.json")
    slices_present: list[str] = []
    if os.path.exists(info_path):
        with open(info_path) as fh:
            info = json.load(fh)
        for i in range(len(info.get("floor_levels", []))):
            p = os.path.join(PROCESSED_DIR, f"wall_slice_floor_{i}.npy")
            if os.path.exists(p):
                size_mb = os.path.getsize(p) / 1_048_576
                slices_present.append(f"wall_slice_floor_{i}.npy  ({size_mb:.1f} MB)")

    snap["slices_present"] = slices_present
    if snap.get("started_at"):
        snap["elapsed_s"] = round(
            (snap.get("finished_at") or time.time()) - snap["started_at"], 1
        )
    return snap


# ── Phase 4: Wall Detection ───────────────────────────────────────────────────



class C2BWallParams(BaseModel):
    """Parameters for the Cloud2BIM-style wall detector."""
    floor_idx: int
    grid_size: float = 0.02          # finer grid = better accuracy, more RAM
    snap_to_axis: bool = True
    min_wall_m: float = 0.40         # shorter minimum — contour segs are smaller
    max_wall_thickness: float = 0.75 # maximum slab thickness for face-pairing
    dp_tolerance: float = 0.04       # Douglas-Peucker tolerance in metres
    threshold_frac: float = 0.01     # relative density threshold for binarisation
    save_debug: bool = True
    # Auto-run downstream phases
    detect_openings: bool = True
    detect_rooms: bool = True
    wall_thickness: float = 0.25     # used by opening detection



@app.get("/api/walls/{floor_idx}")
def get_walls(floor_idx: int):
    wall_path = os.path.join(PROCESSED_DIR, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        return JSONResponse({"status": "not_processed", "lines": []})
    with open(wall_path) as f:
        return json.load(f)


class WallsEditPayload(BaseModel):
    lines: list   # list of [[x1, z1], [x2, z2]] pairs


@app.put("/api/walls/{floor_idx}")
def save_walls_edit(floor_idx: int, payload: WallsEditPayload):
    """
    Persist user-edited wall lines → re-run room detection → re-export DXF/SVG.
    Called by the canvas editor's Save button.
    """
    wall_path = os.path.join(PROCESSED_DIR, f"walls_floor_{floor_idx}.json")

    # Load existing header metadata (grid_size, bounds etc.) to keep provenance
    existing: dict = {"floor_idx": floor_idx}
    if os.path.exists(wall_path):
        with open(wall_path) as f:
            existing = json.load(f)

    existing["lines"] = payload.lines
    existing["source"] = f"user-edited ({len(payload.lines)} walls)"

    with open(wall_path, "w") as f:
        json.dump(existing, f)

    # Re-run room detection with default parameters
    n_rooms = 0
    room_warning = None
    try:
        room_cfg = {
            "floor_idx":       floor_idx,
            "wall_thickness_m": 0.20,
            "extend_m":        0.45,
            "min_seg_m":       0.40,
            "min_room_m2":     0.80,
            "max_room_m2":     800.0,
            "min_room_width_m": 0.60,
            "save_debug":      True,
        }
        rm = detect_rooms_for_floor(floor_idx, room_cfg)
        n_rooms = rm["n_rooms"]
    except Exception as exc:
        room_warning = str(exc)

    # Re-export DXF + SVG
    dxf_warning = None
    try:
        export_floor_dxf(floor_idx, PROCESSED_DIR)
    except Exception as exc:
        dxf_warning = str(exc)

    result = {
        "status":   "saved",
        "n_walls":  len(payload.lines),
        "n_rooms":  n_rooms,
    }
    if room_warning: result["room_warning"] = room_warning
    if dxf_warning:  result["dxf_warning"]  = dxf_warning
    return result


@app.post("/api/walls/{floor_idx}/export")
def export_walls(floor_idx: int):
    try:
        export_floor_dxf(floor_idx, PROCESSED_DIR)
        return {"status": "success", "dxf": f"/api/walls/{floor_idx}/download"}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/walls/{floor_idx}/download")
def download_dxf(floor_idx: int):
    dxf_path = os.path.join(PROCESSED_DIR, f"floor_{floor_idx}.dxf")
    if not os.path.exists(dxf_path):
        raise HTTPException(status_code=404, detail="DXF not generated yet")
    return FileResponse(
        dxf_path, media_type="application/dxf", filename=f"floor_{floor_idx}.dxf"
    )


@app.get("/api/walls/{floor_idx}/svg")
def get_svg(floor_idx: int):
    svg_path = os.path.join(PROCESSED_DIR, f"floor_{floor_idx}.svg")
    if not os.path.exists(svg_path):
        raise HTTPException(status_code=404, detail="SVG not generated yet")
    return FileResponse(svg_path, media_type="image/svg+xml")


# ── Phase 5: Opening Detection (standalone) ───────────────────────────────────


class OpeningParams(BaseModel):
    floor_idx: int
    wall_thickness: float = 0.25
    min_door_width: float = 0.70
    min_window_width: float = 0.50
    door_height_threshold: float = 1.85


@app.post("/api/openings")
def generate_openings(params: OpeningParams):
    """Run opening detection standalone (walls must already exist)."""
    try:
        result = detect_openings_for_floor(params.floor_idx, params.model_dump())
        export_floor_dxf(params.floor_idx, PROCESSED_DIR)
        return {
            "status": "success",
            "n_doors": result["n_doors"],
            "n_windows": result["n_windows"],
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/openings/{floor_idx}")
def get_openings(floor_idx: int):
    path = os.path.join(PROCESSED_DIR, f"openings_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "openings": []})
    with open(path) as f:
        return json.load(f)


# ── Phase M3: Room Detection ──────────────────────────────────────────────────


class RoomDetectionParams(BaseModel):
    floor_idx: int
    wall_thickness_m: float = 0.20   # drawn wall half-width in metres (auto-scales to px)
    extend_m: float = 0.45           # endpoint extension to seal T-junctions (metres)
    min_seg_m: float = 0.4           # ignore wall segments shorter than this
    min_room_m2: float = 0.8         # drop regions smaller than this
    max_room_m2: float = 800.0       # drop regions larger than this
    min_room_width_m: float = 0.60   # reject rooms thinner than this (aspect filter)
    save_debug: bool = True


@app.post("/api/rooms")
def generate_rooms(params: RoomDetectionParams):
    """Run room boundary detection for a floor (walls must already exist)."""
    try:
        result = detect_rooms_for_floor(params.floor_idx, params.model_dump())
        export_floor_dxf(params.floor_idx, PROCESSED_DIR)
        return {
            "status": "success",
            "n_rooms": result["n_rooms"],
            "rooms": result["rooms"],
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rooms/{floor_idx}")
def get_rooms(floor_idx: int):
    path = os.path.join(PROCESSED_DIR, f"rooms_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "rooms": []})
    with open(path) as f:
        return json.load(f)


# ── Color plans ───────────────────────────────────────────────────────────────


@app.get("/api/colorplans")
def colorplans():
    return {
        "floors": [
            {
                "label": "Floor 1",
                "color": "/model/colorplan_000.jpg",
                "ceiling": "/model/ceilingcolorplan_000.jpg",
            },
            {
                "label": "Floor 2",
                "color": "/model/colorplan_001.jpg",
                "ceiling": "/model/ceilingcolorplan_001.jpg",
            },
        ]
    }


# ── Cloud2BIM Integration ─────────────────────────────────────────────────────


@app.get("/api/c2b/status")
def c2b_status():
    """
    Report the status of Cloud2BIM pre-computed data.
    Checks which horiz_surface_*.xyz files are present and returns their sizes.
    """
    import glob

    xyz_files = sorted(glob.glob(os.path.join(_C2B_OUTPUT_DIR, "horiz_surface_*.xyz")))
    files_info = [
        {
            "name": os.path.basename(f),
            "size_mb": round(os.path.getsize(f) / 1_048_576, 1),
        }
        for f in xyz_files
    ]
    return {
        "c2b_output_dir": _C2B_OUTPUT_DIR,
        "dir_exists": os.path.isdir(_C2B_OUTPUT_DIR),
        "n_surfaces": len(xyz_files),
        "files": files_info,
    }


@app.post("/api/c2b/floors")
def c2b_update_floors():
    """
    Read Cloud2BIM horiz_surface_*.xyz files and derive accurate floor levels.
    Updates info.json with the new floor_levels array.

    After calling this endpoint you should re-run POST /api/preprocess-walls
    so that wall_slice_floor_N.npy files are re-computed with the corrected
    height bands.
    """
    if not os.path.isdir(_C2B_OUTPUT_DIR):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Cloud2BIM output directory not found: {_C2B_OUTPUT_DIR}\n"
                "Make sure Cloud2BIM-1.03/output_xyz/ exists in the WORK folder."
            ),
        )

    info_path = os.path.join(PROCESSED_DIR, "info.json")
    if not os.path.exists(info_path):
        raise HTTPException(
            status_code=404,
            detail="info.json not found. Run preprocess_o3d.py first.",
        )

    try:
        result = update_floor_levels_from_c2b(
            c2b_output_dir=_C2B_OUTPUT_DIR,
            processed_dir=PROCESSED_DIR,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("message", "Unknown error"))

    return result


@app.post("/api/c2b/walls")
def c2b_generate_walls(params: C2BWallParams):
    """
    Run the Cloud2BIM-style wall detector for one floor.

    Algorithm: 2-D density histogram → threshold → morphological close
               → contour tracing → Douglas-Peucker → collinear merge
               → parallel face-pair grouping → wall-axis extraction.

    This produces the same walls_floor_N.json output as POST /api/walls
    so the frontend works transparently with either algorithm.
    Optionally runs opening and room detection afterwards.
    """
    try:
        cfg = params.model_dump()
        real_lines = detect_walls_c2b_for_floor(params.floor_idx, cfg)

        result: dict = {
            "status": "success",
            "algorithm": "cloud2bim",
            "lines_count": len(real_lines),
            "n_doors": 0,
            "n_windows": 0,
            "n_rooms": 0,
        }

        if params.detect_openings and real_lines:
            try:
                op = detect_openings_for_floor(params.floor_idx, cfg)
                result["n_doors"]   = op["n_doors"]
                result["n_windows"] = op["n_windows"]
            except Exception as exc:
                result["opening_warning"] = str(exc)

        if params.detect_rooms and real_lines:
            try:
                room_cfg = {
                    **cfg,
                    "wall_thickness_m":  0.20,
                    "extend_m":          0.45,
                    "min_seg_m":         0.4,
                    "min_room_m2":       0.8,
                    "max_room_m2":       800.0,
                    "min_room_width_m":  0.60,
                    "save_debug":        True,
                }
                rm = detect_rooms_for_floor(params.floor_idx, room_cfg)
                result["n_rooms"] = rm["n_rooms"]
            except Exception as exc:
                result["room_warning"] = str(exc)

        # Export DXF + SVG with all layers
        try:
            export_floor_dxf(params.floor_idx, PROCESSED_DIR)
        except Exception as exc:
            result["dxf_warning"] = str(exc)

        return result

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
