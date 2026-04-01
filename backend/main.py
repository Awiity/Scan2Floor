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
from pipeline.wall_detection import detect_walls_for_floor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROCESSED_DIR = os.path.join(BASE_DIR, "processed")
MATTERPAK_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "data", "matterpak"))
XYZ_PATH = os.path.abspath(
    os.path.join(BASE_DIR, "..", "..", "data", "matterpak", "cloud.xyz")
)

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

app = FastAPI(title="Scan2Floor API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/model", StaticFiles(directory=MATTERPAK_DIR), name="model")


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
        headers={"Cache-Control": "public, max-age=86400"},
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


def _run_preprocess_walls_bg() -> None:
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
                "log": ["Starting preprocess_walls.py …"],
            }
        )

    script = os.path.join(BASE_DIR, "pipeline", "preprocess_walls.py")
    try:
        proc = subprocess.Popen(
            [sys.executable, script],
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
    Streams cloud.xyz → wall_slice_floor_<N>.npy  (one per floor).
    Expected runtime: 3–8 minutes.
    Returns immediately with job status.
    """
    if not os.path.exists(XYZ_PATH):
        raise HTTPException(
            status_code=404,
            detail=f"cloud.xyz not found at {XYZ_PATH}",
        )

    with _preprocess_lock:
        if _preprocess_status["running"]:
            return JSONResponse(
                {
                    "status": "already_running",
                    "message": "Preprocessing is already in progress.",
                }
            )

    thread = threading.Thread(target=_run_preprocess_walls_bg, daemon=True)
    thread.start()
    return JSONResponse(
        {
            "status": "started",
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


class WallDetectionParams(BaseModel):
    floor_idx: int
    grid_size: float = 0.05
    snap_to_axis: bool = True
    min_wall_m: float = 0.80  # minimum wall segment length in metres
    hough_threshold: int = 40  # minimum Hough vote count
    max_gap_m: float = 0.25  # maximum gap to bridge in metres
    car_filter: bool = True  # vertical-extent car/furniture filter
    car_top_m: float = 1.55  # height above floor considered "above cars"
    ceiling_cap_m: float = 2.05  # mid-zone upper cap (below parking ceiling)
    save_debug: bool = True  # save per-floor debug PNGs to processed/
    # Phase 5 opening params (passed through for auto-run)
    wall_thickness: float = 0.25  # metres — 'tight' or 'loose'
    detect_openings: bool = True  # auto-run opening detection after walls


@app.post("/api/walls")
def generate_walls(params: WallDetectionParams):
    """
    Run wall detection for a floor.
    If detect_openings=True (default), immediately run opening detection too
    and export DXF with all layers.
    """
    try:
        cfg = params.model_dump()
        lines = detect_walls_for_floor(params.floor_idx, cfg)

        result: dict = {
            "status": "success",
            "lines_count": len(lines),
            "n_doors": 0,
            "n_windows": 0,
        }

        if params.detect_openings:
            op_result = detect_openings_for_floor(params.floor_idx, cfg)
            result["n_doors"] = op_result["n_doors"]
            result["n_windows"] = op_result["n_windows"]

        # Export DXF + SVG (includes openings if they were detected)
        export_floor_dxf(params.floor_idx, PROCESSED_DIR)

        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/walls/{floor_idx}")
def get_walls(floor_idx: int):
    wall_path = os.path.join(PROCESSED_DIR, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        return JSONResponse({"status": "not_processed", "lines": []})
    with open(wall_path) as f:
        return json.load(f)


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
