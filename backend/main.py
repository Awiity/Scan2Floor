import ctypes
import json
import math
import os
import struct
import subprocess
import sys
import threading
import time

import cv2
import numpy as np

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from pipeline.dxf_export import export_floor_dxf
from pipeline.ifc_export import export_floor_ifc, export_all_floors_ifc
from pipeline.opening_detection import detect_openings_for_floor
from pipeline.room_detection import detect_rooms_for_floor
from pipeline.wall_detection_c2b import detect_walls_c2b_for_floor
from pipeline.floor_from_c2b import update_floor_levels_from_c2b
import pipeline.run_pipeline as _pipeline
from matterport.config import MODEL_ID, bootstrap_model_data, resolve_paths as resolve_mp_paths
from matterport.coords import enrich_instance as enrich_mp_instance, load_s2f_context as load_mp_s2f_context
from matterport.objects import (
    ObjectStore as MpObjectStore,
    SUPPORTED_EQUIPMENT_LABELS as MP_SUPPORTED_EQUIPMENT_LABELS,
    normalize_label as normalize_mp_label,
)
from matterport.points import PointStore as MpPointStore
from matterport.registry_sync import start_sync_loop as start_mp_sync_loop
from matterport.router import (
    get_stores as get_mp_stores,
    invalidate_store_cache as invalidate_mp_cache,
    router as matterport_router,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Path configuration ─────────────────────────────────────────────────────────
# All paths can be overridden by environment variables so the Docker image
# works out-of-the-box without hard-coded host paths.
PROCESSED_DIR = os.environ.get(
    "PROCESSED_DIR", os.path.join(BASE_DIR, "processed")
)
MATTERPAK_DIR = os.environ.get(
    "DATA_DIR",
    os.path.abspath(os.path.join(BASE_DIR, "..", "..", "data", "matterpak")),
)
# C2B_DIR: where Cloud2BIM horiz_surface_*.xyz files live.
# Default is the internal pipeline output (no host mount required).
# Override with C2B_DIR env var to point at a pre-computed host folder.
_C2B_OUTPUT_DIR = os.environ.get(
    "C2B_DIR",
    os.path.join(PROCESSED_DIR, "c2b_output"),
)
# SCAN_ROOTS: comma-separated list of directories to search for .xyz files
_SCAN_ROOTS = [
    r.strip()
    for r in os.environ.get("SCAN_ROOTS", "/data").split(",")
    if r.strip()
]
_DEFAULT_XYZ_PATH = os.path.join(MATTERPAK_DIR, "cloud.xyz")
_XYZ_CONFIG_PATH = os.path.join(PROCESSED_DIR, "xyz_path.json")


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
app.include_router(matterport_router)


@app.on_event("startup")
def _startup_matterport() -> None:
    """Seed Matterport dataset (if present) and start optional DCUK registry sync."""
    bootstrap_model_data(MODEL_ID)
    mp_paths = resolve_mp_paths(MODEL_ID)
    ps = MpPointStore(path=mp_paths["points"], model_id=MODEL_ID)
    os_store = MpObjectStore(path=mp_paths["objects"], model_id=MODEL_ID)
    start_mp_sync_loop(ps, os_store, model_id=MODEL_ID)

# -- Photo-textured mesh layer ------------------------------------------------
# mesh_textured.glb is produced by pipeline/convert_textured_glb.py from the
# matterpak OBJ + jpg atlases. Looked up next to the active cloud.xyz first, then
# MATTERPAK_DIR, then sibling matterpak* folders (matterpak_3 preferred).


def _find_textured_mesh() -> Optional[str]:
    cands = []
    try:
        cands.append(os.path.dirname(_get_xyz_path()))
    except Exception:
        pass
    cands.append(MATTERPAK_DIR)
    parent = os.path.dirname(MATTERPAK_DIR)
    if os.path.isdir(parent):
        sibs = sorted(
            (d for d in os.listdir(parent) if d.startswith("matterpak")),
            key=lambda d: (d != "matterpak_3", d),
        )
        cands += [os.path.join(parent, d) for d in sibs]
    for d in cands:
        p = os.path.join(d, "mesh_textured.glb")
        if os.path.isfile(p):
            return p
    return None


@app.get("/api/textured-mesh/status")
def textured_mesh_status():
    p = _find_textured_mesh()
    return {"available": p is not None, "path": p,
            "size_mb": round(os.path.getsize(p) / 1e6, 1) if p else None}


@app.get("/api/textured-mesh")
def textured_mesh():
    p = _find_textured_mesh()
    if not p:
        raise HTTPException(
            status_code=404,
            detail="mesh_textured.glb not found. Run: python backend/pipeline/convert_textured_glb.py data/matterpak_3",
        )
    return FileResponse(p, media_type="model/gltf-binary")


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


# NOTE: The native Windows tkinter file-picker (browse-xyz) has been removed.
# In the Docker deployment the backend runs headless inside a container and
# cannot open a GUI dialog. Users set the XYZ path via POST /api/xyz-path,
# typing the container-internal mount path (e.g. /data/matterpak/cloud.xyz).


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


def _get_memory_info() -> dict:
    """Return process RSS and system RAM usage in bytes (cross-platform, zero deps)."""
    proc_rss = 0
    sys_used = 0
    sys_total = 0

    try:
        if os.name == "nt":
            class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong),
                    ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_uint64),
                    ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64),
                    ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64),
                    ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64),
                ]

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            k32.K32GetProcessMemoryInfo.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(_PROCESS_MEMORY_COUNTERS),
                ctypes.c_ulong,
            ]
            k32.K32GetProcessMemoryInfo.restype = ctypes.c_int
            k32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MEMORYSTATUSEX)]
            k32.GlobalMemoryStatusEx.restype = ctypes.c_int

            pmc = _PROCESS_MEMORY_COUNTERS()
            pmc.cb = ctypes.sizeof(pmc)
            if k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                proc_rss = int(pmc.WorkingSetSize)

            mem = _MEMORYSTATUSEX()
            mem.dwLength = ctypes.sizeof(mem)
            if k32.GlobalMemoryStatusEx(ctypes.byref(mem)):
                sys_total = int(mem.ullTotalPhys)
                sys_used = max(0, sys_total - int(mem.ullAvailPhys))
        else:
            if os.path.exists("/proc/self/status"):
                with open("/proc/self/status") as f:
                    for line in f:
                        if line.startswith("VmRSS:"):
                            parts = line.split()
                            if len(parts) >= 2:
                                proc_rss = int(parts[1]) * 1024
                            break
            if os.path.exists("/proc/meminfo"):
                meminfo = {}
                with open("/proc/meminfo") as f:
                    for line in f:
                        parts = line.split()
                        if len(parts) >= 2:
                            key = parts[0].rstrip(":")
                            if key in ("MemTotal", "MemAvailable"):
                                meminfo[key] = int(parts[1]) * 1024
                sys_total = meminfo.get("MemTotal", 0)
                sys_avail = meminfo.get("MemAvailable", 0)
                if sys_total > 0:
                    sys_used = max(0, sys_total - sys_avail)
    except Exception:
        pass

    return {
        "proc_rss_bytes": proc_rss,
        "sys_used_bytes": sys_used,
        "sys_total_bytes": sys_total,
    }


@app.get("/api/status")
def status():
    memory = _get_memory_info()
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

        return {"status": "ready", "info": info, "memory": memory}

    # No pointcloud.bin / info.json — distinguish between actively running vs idle
    with _reprocess_lock:
        is_running = _reprocess_status["running"]
    return {"status": "processing" if is_running else "idle", "info": None, "memory": memory}


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


@app.get("/api/pointcloud/room")
def pointcloud_room(
    xmin: float,
    xmax: float,
    zmin: float,
    zmax: float,
    ymin: float | None = None,
    ymax: float | None = None,
    pad:  float = 0.35,
):
    """
    Return a dense subset of pointcloud.bin filtered to the room bounding box.

    The global pointcloud.bin is already a 1-in-100 sample of the raw scan.
    For a single room that occupies ~1/10 of the floor area the global cloud
    contributes only ~0.1% of original points to that area.  Returning ALL
    bin-file points inside the room bbox gives ~10x the spatial density for
    the room highlight overlay, without touching the original raw scan.

    Binary response format (same as /api/pointcloud):
        [uint32 N] [float32 N*3 positions]
    """
    path = os.path.join(PROCESSED_DIR, "pointcloud.bin")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="pointcloud.bin not found")

    # ── Read the full binary ──────────────────────────────────────────────────
    with open(path, "rb") as fh:
        (N,) = struct.unpack_from("<I", fh.read(4))
        pos_bytes = fh.read(N * 3 * 4)  # float32 positions only

    positions = np.frombuffer(pos_bytes, dtype=np.float32).reshape(N, 3)
    # Coordinate layout in the binary: [X, Y, Z] (Y-up, centred by preprocess)

    # ── Spatial filter ────────────────────────────────────────────────────────
    x = positions[:, 0]
    y = positions[:, 1]
    z = positions[:, 2]

    mask = (
        (x >= xmin - pad) & (x <= xmax + pad) &
        (z >= zmin - pad) & (z <= zmax + pad)
    )
    if ymin is not None:
        mask &= (y >= ymin)
    if ymax is not None:
        mask &= (y <= ymax)

    dense = positions[mask]  # shape (M, 3)
    M = len(dense)

    # ── Pack response in the same binary format ───────────────────────────────
    out = struct.pack("<I", M) + dense.astype(np.float32).tobytes()

    from fastapi.responses import Response
    return Response(
        content=out,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/info")
def info():
    path = os.path.join(PROCESSED_DIR, "info.json")
    if not os.path.exists(path):
        raise HTTPException(
            status_code=404,
            detail="info.json not found — run the pipeline first (POST /api/pipeline/run).",
        )
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
            encoding="utf-8",
            errors="replace",
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
    grid_size: float = 0.02
    snap_to_axis: bool = True
    min_wall_m: float = 0.40
    max_wall_thickness: float = 0.75
    dp_tolerance: float = 0.04
    threshold_frac: float = 0.01
    wall_reach_frac: float = 0.70
    save_debug: bool = True
    # Variable-thickness detector (v2)
    default_thickness: float = 0.12   # thickness for walls scanned from one side only
    min_support: float = 0.50         # min fraction of a wall backed by real scan points
    min_isolated_m: float = 0.90      # drop short stubs that touch no other wall
    # Auto-run downstream phases
    detect_openings: bool = True
    detect_rooms: bool = True
    wall_thickness: float = 0.25
    polygon_rooms: bool = True   # True = polygon mode; False = legacy rectangular



@app.get("/api/walls/{floor_idx}")
def get_walls(floor_idx: int):
    wall_path = os.path.join(PROCESSED_DIR, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        return JSONResponse({"status": "not_processed", "lines": []})
    with open(wall_path) as f:
        return json.load(f)


def _load_ortho_floor_points(proc_dir: str, floor_idx: int):
    """Load Y-up floor slice points and per-point relative height above local floor."""
    info = {}
    for cand in (os.path.join(proc_dir, "info.json"), os.path.join(PROCESSED_DIR, "info.json")):
        if os.path.isfile(cand):
            try:
                with open(cand) as fh:
                    info = json.load(fh)
                break
            except Exception:
                pass

    levels = info.get("floor_levels") or []
    floor_y = float(levels[floor_idx]) if 0 <= floor_idx < len(levels) else floor_idx * 2.8
    storey_h = (float(levels[floor_idx + 1]) - floor_y) if floor_idx + 1 < len(levels) else 3.0
    storey_h = max(storey_h, 2.4)

    pts = None
    used_dir = proc_dir
    slice_cand = os.path.join(proc_dir, f"wall_slice_floor_{floor_idx}.npy")
    if not os.path.isfile(slice_cand):
        slice_cand = os.path.join(PROCESSED_DIR, f"wall_slice_floor_{floor_idx}.npy")
        used_dir = PROCESSED_DIR
    if os.path.isfile(slice_cand):
        pts = np.load(slice_cand)
    else:
        bin_cand = os.path.join(proc_dir, "pointcloud.bin")
        if not os.path.isfile(bin_cand):
            bin_cand = os.path.join(PROCESSED_DIR, "pointcloud.bin")
        if os.path.isfile(bin_cand):
            with open(bin_cand, "rb") as fh:
                (n_pts,) = struct.unpack_from("<I", fh.read(4))
                pos_bytes = fh.read(n_pts * 3 * 4)
            all_pts = np.frombuffer(pos_bytes, dtype=np.float32).reshape(n_pts, 3)
            band = (all_pts[:, 1] >= floor_y - 0.5) & (all_pts[:, 1] <= floor_y + storey_h + 0.3)
            pts = all_pts[band]

    if pts is None or len(pts) == 0:
        return None, None, storey_h

    hm_path = os.path.join(used_dir, f"floor_heightmap_{floor_idx}.npy")
    hm_meta = (info.get("wall_slices") or {}).get(f"floor_heightmap_{floor_idx}")
    if os.path.isfile(hm_path) and hm_meta:
        hm = np.load(hm_path)
        cell = float(hm_meta["cell_size"])
        rows, cols = int(hm_meta["rows"]), int(hm_meta["cols"])
        cx = np.clip(np.floor((pts[:, 0] - float(hm_meta["x_min"])) / cell).astype(np.int32), 0, cols - 1)
        cz = np.clip(np.floor((pts[:, 2] - float(hm_meta["z_min"])) / cell).astype(np.int32), 0, rows - 1)
        rel_h = pts[:, 1] - hm[cz, cx].astype(np.float32)
    else:
        rel_h = pts[:, 1] - floor_y

    return pts, rel_h, storey_h


def _render_pointcloud_ortho_png(
    proc_dir: str,
    floor_idx: int,
    mode: str = "walls",
    bottom_cut: float = 0.30,
    top_cut: float = 0.35,
    grid_size: float = 0.02,
) -> Response:
    """Render a geo-referenced top-down RGBA PNG of the point cloud omitting floor/ceiling."""
    pts, rel_h, storey_h = _load_ortho_floor_points(proc_dir, floor_idx)
    if pts is None:
        raise HTTPException(status_code=404, detail=f"No point cloud data available for floor {floor_idx}")

    mode = "slice" if mode == "slice" else "walls"
    bottom_cut = max(0.02, min(2.2, float(bottom_cut)))
    top_cut = max(0.02, min(2.2, float(top_cut)))
    max_h = max(bottom_cut + 0.40, storey_h - top_cut)

    keep = (rel_h >= bottom_cut) & (rel_h <= max_h)
    pts_f = pts[keep]
    rh_f = rel_h[keep]
    if len(pts_f) < 10:
        raise HTTPException(status_code=404, detail=f"No points inside height band for floor {floor_idx}")

    pad = 0.25
    x_min = float(pts_f[:, 0].min()) - pad
    z_min = float(pts_f[:, 2].min()) - pad
    x_raw_max = float(pts_f[:, 0].max()) + pad
    z_raw_max = float(pts_f[:, 2].max()) + pad

    gs = max(float(grid_size), (x_raw_max - x_min) / 2600.0, (z_raw_max - z_min) / 2600.0)
    width = max(16, int(math.ceil((x_raw_max - x_min) / gs)))
    height = max(16, int(math.ceil((z_raw_max - z_min) / gs)))
    # Align upper bounds to exact pixel edge for 1:1 toCanvas alignment
    x_max = x_min + width * gs
    z_max = z_min + height * gs

    px = np.clip(np.floor((pts_f[:, 0] - x_min) / gs).astype(np.int32), 0, width - 1)
    pz = np.clip(np.floor((pts_f[:, 2] - z_min) / gs).astype(np.int32), 0, height - 1)
    flat_idx = pz.astype(np.int64) * width + px.astype(np.int64)
    n_pix = height * width

    cnt = np.bincount(flat_idx, minlength=n_pix).reshape(height, width).astype(np.float32)
    norm = np.clip(np.log1p(cnt) / math.log1p(10.0), 0.0, 1.0)
    bgra = np.zeros((height, width, 4), dtype=np.uint8)

    if mode == "walls":
        low_end = min(max_h - 0.50, max(bottom_cut + 0.35, 1.00))
        high_start = min(max_h - 0.25, max(low_end + 0.35, max_h - 0.90))

        c_low = np.bincount(flat_idx[rh_f < low_end], minlength=n_pix).reshape(height, width)
        c_mid = np.bincount(flat_idx[(rh_f >= low_end) & (rh_f < high_start)], minlength=n_pix).reshape(height, width)
        c_high = np.bincount(flat_idx[rh_f >= high_start], minlength=n_pix).reshape(height, width)

        k3 = np.ones((3, 3), np.uint8)
        high_dil = cv2.dilate((c_high > 0).astype(np.uint8), k3) > 0
        low_mid_dil = cv2.dilate(((c_low + c_mid) > 0).astype(np.uint8), k3) > 0

        wall_cells = ((c_high > 0) & low_mid_dil) | (high_dil & ((c_low + c_mid) > 0))
        clutter_cells = (cnt > 0) & (~wall_cells)

        # True vertical walls -> bright cyan to white (BGRA)
        bgra[wall_cells, 0] = 255
        bgra[wall_cells, 1] = (210.0 + 42.0 * norm[wall_cells]).astype(np.uint8)
        bgra[wall_cells, 2] = (55.0 + 185.0 * norm[wall_cells]).astype(np.uint8)
        bgra[wall_cells, 3] = (120.0 + 130.0 * norm[wall_cells]).astype(np.uint8)

        # Mid-room furniture/clutter -> very faint context
        bgra[clutter_cells, 0] = 175
        bgra[clutter_cells, 1] = 160
        bgra[clutter_cells, 2] = 145
        bgra[clutter_cells, 3] = np.clip(10.0 + 22.0 * norm[clutter_cells], 0, 32).astype(np.uint8)
    else:
        sum_h = np.bincount(flat_idx, weights=rh_f, minlength=n_pix).reshape(height, width)
        mean_h = sum_h / np.maximum(cnt, 1.0)
        h_frac = np.clip((mean_h - bottom_cut) / max(0.2, max_h - bottom_cut), 0.0, 1.0)
        occ = cnt > 0
        # Height gradient: warm gold (low) -> bright cyan (upper wall)
        bgra[occ, 0] = (55.0 + 200.0 * h_frac[occ]).astype(np.uint8)
        bgra[occ, 1] = (175.0 + 60.0 * h_frac[occ]).astype(np.uint8)
        bgra[occ, 2] = (240.0 - 140.0 * h_frac[occ]).astype(np.uint8)
        bgra[occ, 3] = (90.0 + 155.0 * norm[occ]).astype(np.uint8)

    # Connect 5cm voxel spacing into continuous strokes symmetrically when pixel size < 3cm
    if gs <= 0.025:
        k_sym = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        bgra = cv2.dilate(bgra, k_sym)

    ok, png_buf = cv2.imencode(".png", bgra)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to encode orthographic PNG")

    bounds_hdrs = {
        "X-Bounds-XMin": f"{x_min:.6f}",
        "X-Bounds-XMax": f"{x_max:.6f}",
        "X-Bounds-ZMin": f"{z_min:.6f}",
        "X-Bounds-ZMax": f"{z_max:.6f}",
        "Access-Control-Expose-Headers": "X-Bounds-XMin, X-Bounds-XMax, X-Bounds-ZMin, X-Bounds-ZMax",
        "Cache-Control": "no-cache",
    }
    return Response(content=png_buf.tobytes(), media_type="image/png", headers=bounds_hdrs)


@app.get("/api/walls/{floor_idx}/pointcloud-ortho")
def get_pointcloud_ortho(
    floor_idx: int,
    mode: str = "walls",
    bottom_cut: float = 0.30,
    top_cut: float = 0.35,
    grid_size: float = 0.02,
):
    """Top-down orthographic RGBA PNG of point cloud with floor and ceiling omitted."""
    return _render_pointcloud_ortho_png(PROCESSED_DIR, floor_idx, mode, bottom_cut, top_cut, grid_size)


def _apply_thicknesses(existing: dict, payload) -> None:
    """Store per-wall thicknesses when the editor sends them; otherwise drop stale ones."""
    th = getattr(payload, "thicknesses", None)
    n = len(payload.lines)
    if isinstance(th, list) and len(th) == n:
        existing["thicknesses"] = [round(float(x), 3) for x in th]
        existing["thickness_source"] = ["edited"] * n
    else:
        # Line list changed without thickness info → old array no longer matches
        old = existing.get("thicknesses")
        if not (isinstance(old, list) and len(old) == n):
            existing.pop("thicknesses", None)
            existing.pop("thickness_source", None)



class WallsEditPayload(BaseModel):
    lines: list          # list of [[x1, z1], [x2, z2]] pairs
    thicknesses: Optional[list] = None   # optional per-wall thickness (m), same order as lines
    polygon_rooms: bool = True   # True = polygon mode; False = legacy rectangular


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
    _apply_thicknesses(existing, payload)
    existing["source"] = f"user-edited ({len(payload.lines)} walls)"

    with open(wall_path, "w") as f:
        json.dump(existing, f)

    # Re-run room detection with default parameters
    n_rooms = 0
    room_warning = None
    try:
        room_cfg = {
            "floor_idx":              floor_idx,
            "wall_thickness_m":       0.20,
            "extend_m":               0.45,
            "min_seg_m":              0.40,
            "min_room_m2":            0.80,
            "max_room_m2":            800.0,
            "min_room_width_m":       0.60,
            "polygon_rooms":          payload.polygon_rooms,
            "polygon_approx_m":       0.05,
            "manhattan_snap_polygon": True,
            "polygon_smooth_m":       0.15,
            "save_debug":             True,
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
    # Ensure DXF is fresh with latest walls + openings
    try:
        export_floor_dxf(floor_idx, PROCESSED_DIR)
    except Exception:
        pass
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


@app.get("/api/walls/{floor_idx}/download-ifc")
def download_ifc(floor_idx: int):
    """Generate (or re-generate) and download an IFC 2x3 file for a single floor."""
    ifc_path = os.path.join(PROCESSED_DIR, f"floor_{floor_idx}.ifc")
    try:
        export_floor_ifc(floor_idx, PROCESSED_DIR, output_path=ifc_path)
    except ImportError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileResponse(
        ifc_path,
        media_type="application/x-step",
        filename=f"floor_{floor_idx}.ifc",
    )


@app.get("/api/building/download-ifc")
def download_building_ifc():
    """Generate and download a single IFC 2x3 file containing ALL detected floors."""
    ifc_path = os.path.join(PROCESSED_DIR, "building.ifc")
    try:
        export_all_floors_ifc(PROCESSED_DIR, output_path=ifc_path)
    except ImportError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileResponse(
        ifc_path,
        media_type="application/x-step",
        filename="building.ifc",
    )


# ── Phase 5: Opening Detection (standalone) ───────────────────────────────────


class OpeningParams(BaseModel):
    floor_idx: int
    wall_thickness: float = 0.25
    min_door_width: float = 0.70
    min_window_width: float = 0.50
    door_height_threshold: float = 1.85


@app.post("/api/openings")
def generate_openings(params: OpeningParams):
    """Run opening detection standalone — currently disabled (results unreliable)."""
    # TODO: Door/Window detection disabled — results were unreliable.
    return {"status": "disabled", "n_doors": 0, "n_windows": 0}


@app.get("/api/openings/{floor_idx}")
def get_openings(floor_idx: int):
    path = os.path.join(PROCESSED_DIR, f"openings_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "openings": [], "user_openings": []})
    with open(path) as f:
        return json.load(f)


class UserOpeningsPayload(BaseModel):
    user_openings: list  # list of manually-placed door/window objects
    openings: Optional[list] = None  # optional list of auto-detected openings if modified/deleted


@app.put("/api/openings/{floor_idx}")
def save_user_openings(floor_idx: int, payload: UserOpeningsPayload):
    """
    Persist manually-placed doors and windows from the Room Editor.
    Stores in the `user_openings` field of openings_floor_N.json,
    keeping any auto-detected openings intact (unless explicitly updated).
    """
    path = os.path.join(PROCESSED_DIR, f"openings_floor_{floor_idx}.json")
    existing: dict = {"status": "not_processed", "openings": []}
    if os.path.exists(path):
        with open(path) as f:
            existing = json.load(f)
    existing["user_openings"] = payload.user_openings
    if payload.openings is not None:
        existing["openings"] = payload.openings
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

    # Re-export DXF + SVG so manual openings are immediately reflected in exports
    try:
        export_floor_dxf(floor_idx, PROCESSED_DIR)
    except Exception as exc:
        print(f"Warning: DXF export failed during opening save: {exc}")

    return {"status": "saved", "n_user_openings": len(payload.user_openings)}


# ── Phase M3: Room Detection ──────────────────────────────────────────────────


class RoomDetectionParams(BaseModel):
    floor_idx: int
    wall_thickness_m: float = 0.20
    extend_m: float = 0.45
    min_seg_m: float = 0.4
    min_room_m2: float = 0.8
    max_room_m2: float = 800.0
    min_room_width_m: float = 0.60
    polygon_rooms: bool = True           # True = polygon mode; False = legacy rectangular
    polygon_approx_m: float = 0.05
    manhattan_snap_polygon: bool = True
    polygon_smooth_m: float = 0.15
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


# ── Scan File Browser ────────────────────────────────────────────────────────


@app.get("/api/scan/browse")
def scan_browse(root: str | None = None):
    """
    List all .xyz files found recursively under the given folder.

    - If `root` query param is supplied, scan that directory tree.
    - Otherwise fall back to the SCAN_ROOTS env-configured directories.

    Returns groups keyed by a path *relative to the scanned root* so the UI
    can show compact labels (e.g. "data/matterpak" instead of "/data/matterpak").
    """
    roots_to_scan = [root] if root else _SCAN_ROOTS

    groups = []
    for scan_root in roots_to_scan:
        scan_root = scan_root.rstrip("/\\")
        if not os.path.isdir(scan_root):
            continue
        for dirpath, _dirs, filenames in os.walk(scan_root):
            xyz_files = sorted(f for f in filenames if f.lower().endswith(".xyz"))
            if not xyz_files:
                continue
            # Compute a relative label; fall back to the absolute path if needed
            try:
                rel_dir = os.path.relpath(dirpath, os.path.dirname(scan_root))
            except ValueError:
                rel_dir = dirpath
            entries = []
            for fname in xyz_files:
                fpath = os.path.join(dirpath, fname)
                try:
                    size_mb = round(os.path.getsize(fpath) / 1_048_576, 1)
                except Exception:
                    size_mb = -1
                entries.append({"name": fname, "path": fpath, "size_mb": size_mb})
            groups.append({"dir": rel_dir, "abs_dir": dirpath, "files": entries})

    return {
        "roots": roots_to_scan,
        "groups": groups,
        "total": sum(len(g["files"]) for g in groups),
    }


# ── Unified Pipeline ──────────────────────────────────────────────────────────


class PipelineRunPayload(BaseModel):
    xyz_path:       str
    run_c2b:        bool  = True
    run_slices:     bool  = True
    detect_floors:  list[int] | None = None
    # point cloud cleaning options
    enable_cleaning:       bool  = True
    clean_downsample_pct:  float = 20.0
    clean_span_min:        float = 0.65
    clean_span_max:        float = 1.00
    # wall detection overrides (all optional)
    grid_size:          float = 0.02
    snap_to_axis:       bool  = True
    min_wall_m:         float = 0.40
    max_wall_thickness: float = 0.75
    dp_tolerance:       float = 0.04
    threshold_frac:     float = 0.01
    wall_reach_frac:    float = 0.35
    # room shape mode
    polygon_rooms:      bool  = True    # True = polygon; False = legacy rectangular


@app.post("/api/pipeline/run")
def pipeline_run(payload: PipelineRunPayload):
    """
    Start the unified 6-stage pipeline in the background:
      1. Clean Point Cloud → cloud_cleaned.xyz (downsamples & removes foreign objects)
      2. Preprocess XYZ   → pointcloud.bin + info.json
      3. Cloud2BIM C2B    → horiz_surface_N.xyz
      4. Import C2B Floors → update floor_levels in info.json
      5. Extract Slices   → wall_slice_floor_N.npy
      6. Detect Walls & Rooms → walls_floor_N.json + DXF
    Poll /api/pipeline/status for progress.
    """
    p = payload.xyz_path.strip()
    if not p.lower().endswith(".xyz"):
        raise HTTPException(status_code=400, detail="Path must end with .xyz")
    if not os.path.exists(p):
        raise HTTPException(
            status_code=404,
            detail=f".xyz file not found: {p}",
        )

    # Persist the path so other endpoints can pick it up
    _set_xyz_path(p)

    wall_cfg = {
        "grid_size":          payload.grid_size,
        "snap_to_axis":       payload.snap_to_axis,
        "min_wall_m":         payload.min_wall_m,
        "max_wall_thickness": payload.max_wall_thickness,
        "dp_tolerance":       payload.dp_tolerance,
        "threshold_frac":     payload.threshold_frac,
        "wall_reach_frac":    payload.wall_reach_frac,
    }

    started = _pipeline.start_pipeline(
        xyz_path=p,
        run_c2b=payload.run_c2b,
        run_slices=payload.run_slices,
        detect_floors=payload.detect_floors,
        wall_cfg=wall_cfg,
        room_cfg_overrides={"polygon_rooms": payload.polygon_rooms},
        enable_cleaning=payload.enable_cleaning,
        clean_downsample_pct=payload.clean_downsample_pct,
        clean_span_min=payload.clean_span_min,
        clean_span_max=payload.clean_span_max,
    )

    if not started:
        return JSONResponse({"status": "already_running",
                             "message": "Pipeline is already running."})

    return JSONResponse({"status": "started", "xyz_path": p,
                         "message": "Pipeline started. Poll /api/pipeline/status."})


@app.get("/api/pipeline/status")
def pipeline_status():
    """Poll the current status of the unified pipeline."""
    return _pipeline.get_status()


@app.post("/api/pipeline/cancel")
def pipeline_cancel():
    """
    Request cancellation of the currently running pipeline.
    The background thread will stop at the next safe checkpoint (between
    stages, or mid-subprocess on the next stdout line read).
    Returns immediately; poll /api/pipeline/status to confirm running → False.
    """
    sent = _pipeline.cancel_pipeline()
    if sent:
        return JSONResponse({
            "status": "cancelling",
            "message": "Cancel signal sent. Poll /api/pipeline/status until running is false.",
        })
    return JSONResponse({
        "status": "not_running",
        "message": "No pipeline is currently running.",
    })


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
            detail="info.json not found — run the pipeline first (POST /api/pipeline/run).",
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

        # Auto door/window detection is disabled — openings come from
        # manual placement in the Room Editor (user_openings in the JSON).

        if params.detect_rooms and real_lines:
            try:
                room_cfg = {
                    **cfg,
                    "wall_thickness_m":       0.20,
                    "extend_m":               0.45,
                    "min_seg_m":              0.4,
                    "min_room_m2":            0.8,
                    "max_room_m2":            800.0,
                    "min_room_width_m":       0.60,
                    "polygon_rooms":          params.polygon_rooms,
                    "polygon_approx_m":       0.05,
                    "manhattan_snap_polygon": True,
                    "polygon_smooth_m":       0.15,
                    "save_debug":             True,
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


# ── Output Saves ──────────────────────────────────────────────────────────────

SAVES_DIR = os.path.join(PROCESSED_DIR, "saves")

# Files copied from processed/ into each save folder
_SAVE_PATTERNS = [
    "walls_floor_*.json",
    "rooms_floor_*.json",
    "openings_floor_*.json",
    "equipment_floor_*.json",
    "floor_*.dxf",
    "floor_*.svg",
    "info.json",
]


def _save_dir(name: str) -> str:
    """Return the absolute path for a save folder (no path traversal)."""
    safe = os.path.basename(name)
    return os.path.join(SAVES_DIR, safe)


def _read_meta(save_path: str) -> dict | None:
    meta_path = os.path.join(save_path, "meta.json")
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path) as fh:
            return json.load(fh)
    except Exception:
        return None


class SavePayload(BaseModel):
    name: str | None = None   # None → derive from xyz path
    wall_color:  str | None = "#f5f5f5"   # CSS hex for wall points
    floor_color: str | None = "#2ed16b"   # CSS hex for floor/ceiling points


@app.get("/api/saves")
def list_saves():
    """List all saved outputs (subfolders in processed/saves/)."""
    if not os.path.isdir(SAVES_DIR):
        return {"saves": []}
    saves = []
    for entry in sorted(os.scandir(SAVES_DIR), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        meta = _read_meta(entry.path)
        if meta is None:
            continue
        # Count how many floor DXF/wall files are present
        import glob as _glob
        n_floors = len(_glob.glob(os.path.join(entry.path, "walls_floor_*.json")))
        saves.append({
            "name":        entry.name,
            "timestamp":   meta.get("timestamp"),
            "xyz_path":    meta.get("xyz_path", ""),
            "n_floors":    n_floors,
            "has_matterport": os.path.isfile(os.path.join(entry.path, "mp_objects.json")),
            "wall_color":  meta.get("wall_color",  "#f5f5f5"),
            "floor_color": meta.get("floor_color", "#2ed16b"),
        })
    return {"saves": saves}


@app.post("/api/saves")
def create_save(payload: SavePayload):
    """
    Copy current processed output (walls, rooms, DXF, SVG, info.json) into
    a named subfolder under processed/saves/.  Overwrites if already exists.
    The default name is derived from the parent directory of the .xyz file.
    """
    import glob as _glob
    import shutil

    xyz_path = _get_xyz_path()

    # Derive default name from xyz parent directory
    if payload.name and payload.name.strip():
        name = payload.name.strip()
    else:
        name = os.path.basename(os.path.dirname(xyz_path))
        if not name or name in (".", ""):
            name = "output"

    # Sanitise: keep only alphanumerics, hyphens, underscores, dots
    import re as _re
    name = _re.sub(r"[^A-Za-z0-9._-]", "_", name)

    save_path = _save_dir(name)
    os.makedirs(save_path, exist_ok=True)

    # Re-export DXF for all floors before copying so save has latest openings
    for pat in _glob.glob(os.path.join(PROCESSED_DIR, "walls_floor_*.json")):
        try:
            fname = os.path.basename(pat)
            f_idx = int(fname.split("_")[-1].replace(".json", ""))
            export_floor_dxf(f_idx, PROCESSED_DIR)
        except Exception:
            pass

    copied = []
    for pat in _SAVE_PATTERNS:
        for src in _glob.glob(os.path.join(PROCESSED_DIR, pat)):
            dst = os.path.join(save_path, os.path.basename(src))
            shutil.copy2(src, dst)
            copied.append(os.path.basename(src))

    # Also snapshot active Matterport viewpoints and equipment inventory
    try:
        mp_paths = resolve_mp_paths(MODEL_ID)
        for src_key, dst_name in (("points", "mp_points.json"), ("objects", "mp_objects.json")):
            src_mp = str(mp_paths[src_key])
            if os.path.isfile(src_mp):
                shutil.copy2(src_mp, os.path.join(save_path, dst_name))
                copied.append(dst_name)
        invalidate_mp_cache(name)
    except Exception:
        pass

    # Write meta
    import time as _time
    meta = {
        "name":        name,
        "timestamp":   _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "xyz_path":    xyz_path,
        "wall_color":  payload.wall_color  or "#f5f5f5",
        "floor_color": payload.floor_color or "#2ed16b",
    }
    with open(os.path.join(save_path, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    return {"status": "ok", "name": name, "files_saved": len(copied), "files": copied}


@app.post("/api/saves/{name}/matterport")
def attach_matterport_to_save(name: str, overwrite: bool = False):
    """
    Add the Matterport 360 / equipment snapshot (mp_points.json, mp_objects.json)
    to a save that was created before the Matterport module existed.

    Copies the current live Matterport data of MODEL_ID into the save folder.
    Existing snapshot files are kept unless ``overwrite=true`` (so viewpoints
    created inside a save are not lost). Walls / rooms / openings are untouched.
    """
    import shutil
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    try:
        bootstrap_model_data(MODEL_ID)
    except Exception:
        pass
    mp_paths = resolve_mp_paths(MODEL_ID)
    copied, skipped, missing = [], [], []
    for key, dst_name in (("points", "mp_points.json"), ("objects", "mp_objects.json")):
        src = str(mp_paths[key])
        dst = os.path.join(save_path, dst_name)
        if not os.path.isfile(src):
            missing.append(dst_name)
        elif os.path.isfile(dst) and not overwrite:
            skipped.append(dst_name)
        else:
            shutil.copy2(src, dst)
            copied.append(dst_name)
    invalidate_mp_cache(name)
    if missing and not copied and not skipped:
        raise HTTPException(status_code=404, detail="No live Matterport data available to attach.")
    return {"status": "ok", "name": name, "copied": copied, "skipped": skipped, "missing": missing}


@app.delete("/api/saves/{name}")
def delete_save(name: str):
    """Delete a saved output folder."""
    import shutil
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    shutil.rmtree(save_path)
    return {"status": "deleted", "name": name}


@app.get("/api/saves/{name}/walls/{floor_idx}")
def save_get_walls(name: str, floor_idx: int):
    save_path = _save_dir(name)
    wall_path = os.path.join(save_path, f"walls_floor_{floor_idx}.json")
    if not os.path.exists(wall_path):
        return JSONResponse({"status": "not_processed", "lines": []})
    with open(wall_path) as f:
        return json.load(f)


@app.get("/api/saves/{name}/walls/{floor_idx}/pointcloud-ortho")
def save_get_pointcloud_ortho(
    name: str,
    floor_idx: int,
    mode: str = "walls",
    bottom_cut: float = 0.30,
    top_cut: float = 0.35,
    grid_size: float = 0.02,
):
    """Top-down orthographic point cloud PNG for a saved output."""
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    return _render_pointcloud_ortho_png(save_path, floor_idx, mode, bottom_cut, top_cut, grid_size)


@app.put("/api/saves/{name}/walls/{floor_idx}")
def save_edit_walls(name: str, floor_idx: int, payload: WallsEditPayload):
    """
    Persist user-edited wall lines for a saved output → re-run room detection
    → re-export DXF/SVG inside the save folder.
    """
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")

    wall_path = os.path.join(save_path, f"walls_floor_{floor_idx}.json")
    existing: dict = {"floor_idx": floor_idx}
    if os.path.exists(wall_path):
        with open(wall_path) as f:
            existing = json.load(f)
    existing["lines"] = payload.lines
    _apply_thicknesses(existing, payload)
    existing["source"] = f"user-edited ({len(payload.lines)} walls)"
    with open(wall_path, "w") as f:
        json.dump(existing, f)

    # Re-run room detection inside save folder
    n_rooms = 0
    room_warning = None
    try:
        room_cfg = {
            "floor_idx":              floor_idx,
            "wall_thickness_m":       0.20,
            "extend_m":               0.45,
            "min_seg_m":              0.40,
            "min_room_m2":            0.80,
            "max_room_m2":            800.0,
            "min_room_width_m":       0.60,
            "polygon_rooms":          payload.polygon_rooms,
            "polygon_approx_m":       0.05,
            "manhattan_snap_polygon": True,
            "polygon_smooth_m":       0.15,
            "save_debug":             False,
        }
        rm = detect_rooms_for_floor(floor_idx, room_cfg, processed_dir=save_path)
        n_rooms = rm["n_rooms"]
    except Exception as exc:
        room_warning = str(exc)

    # Re-export DXF + SVG into save folder
    dxf_warning = None
    try:
        export_floor_dxf(floor_idx, save_path)
    except Exception as exc:
        dxf_warning = str(exc)

    result = {"status": "saved", "n_walls": len(payload.lines), "n_rooms": n_rooms}
    if room_warning:
        result["room_warning"] = room_warning
    if dxf_warning:
        result["dxf_warning"] = dxf_warning
    return result


@app.get("/api/saves/{name}/rooms/{floor_idx}")
def save_get_rooms(name: str, floor_idx: int):
    save_path = _save_dir(name)
    path = os.path.join(save_path, f"rooms_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "rooms": []})
    with open(path) as f:
        return json.load(f)


@app.get("/api/saves/{name}/openings/{floor_idx}")
def save_get_openings(name: str, floor_idx: int):
    save_path = _save_dir(name)
    path = os.path.join(save_path, f"openings_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "openings": [], "user_openings": []})
    with open(path) as f:
        return json.load(f)


@app.put("/api/saves/{name}/openings/{floor_idx}")
def save_put_user_openings(name: str, floor_idx: int, payload: UserOpeningsPayload):
    """
    Persist manually-placed doors and windows for a named save.
    Stores in the `user_openings` field of openings_floor_N.json inside the save folder.
    """
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    path = os.path.join(save_path, f"openings_floor_{floor_idx}.json")
    existing: dict = {"status": "not_processed", "openings": []}
    if os.path.exists(path):
        with open(path) as f:
            existing = json.load(f)
    existing["user_openings"] = payload.user_openings
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

    # Re-export DXF + SVG inside save folder
    try:
        export_floor_dxf(floor_idx, save_path)
    except Exception as exc:
        print(f"Warning: DXF export failed in save: {exc}")

    return {"status": "saved", "n_user_openings": len(payload.user_openings)}


@app.get("/api/saves/{name}/svg/{floor_idx}")
def save_get_svg(name: str, floor_idx: int):
    save_path = _save_dir(name)
    svg_path = os.path.join(save_path, f"floor_{floor_idx}.svg")
    if not os.path.exists(svg_path):
        raise HTTPException(status_code=404, detail="SVG not found in this save.")
    return FileResponse(svg_path, media_type="image/svg+xml")


@app.get("/api/saves/{name}/download/{floor_idx}")
def save_download_dxf(name: str, floor_idx: int):
    save_path = _save_dir(name)
    try:
        export_floor_dxf(floor_idx, save_path)
    except Exception:
        pass
    dxf_path = os.path.join(save_path, f"floor_{floor_idx}.dxf")
    if not os.path.exists(dxf_path):
        raise HTTPException(status_code=404, detail="DXF not found in this save.")
    return FileResponse(
        dxf_path, media_type="application/dxf",
        filename=f"{name}_floor_{floor_idx}.dxf"
    )


@app.get("/api/saves/{name}/download-ifc/{floor_idx}")
def save_download_ifc(name: str, floor_idx: int):
    """Generate and download an IFC 2x3 file for one floor from a named save."""
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    ifc_path = os.path.join(save_path, f"floor_{floor_idx}.ifc")
    try:
        export_floor_ifc(floor_idx, save_path, output_path=ifc_path)
    except ImportError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileResponse(
        ifc_path,
        media_type="application/x-step",
        filename=f"{name}_floor_{floor_idx}.ifc",
    )


@app.get("/api/saves/{name}/download-ifc-all")
def save_download_ifc_all(name: str):
    """Generate and download a single IFC file with ALL floors from a named save."""
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    ifc_path = os.path.join(save_path, "building.ifc")
    try:
        export_all_floors_ifc(save_path, output_path=ifc_path)
    except ImportError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileResponse(
        ifc_path,
        media_type="application/x-step",
        filename=f"{name}_building.ifc",
    )


@app.get("/api/saves/{name}/info")
def save_get_info(name: str):
    """Return info.json from a save (contains floor_levels etc.)."""
    save_path = _save_dir(name)
    path = os.path.join(save_path, "info.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="info.json not found in this save.")
    with open(path) as f:
        return json.load(f)


# ── Placed 3D Equipment (sourced from MatterportIn3D) ─────────────────────────


class EquipmentFloorPayload(BaseModel):
    items: list[dict]


class AddMpEquipmentPayload(BaseModel):
    instance_ids: Optional[list[str]] = None
    labels: Optional[list[str]] = None
    floor_idx: Optional[int] = None


def _get_equipment_for_dir(base_dir: str, floor_idx: int) -> dict:
    path = os.path.join(base_dir, f"equipment_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return {"floor_idx": floor_idx, "items": []}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return {
        "floor_idx": floor_idx,
        "items": data.get("items", []) if isinstance(data, dict) else [],
    }


def _put_equipment_for_dir(base_dir: str, floor_idx: int, items: list[dict]) -> dict:
    os.makedirs(base_dir, exist_ok=True)
    path = os.path.join(base_dir, f"equipment_floor_{floor_idx}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"floor_idx": floor_idx, "items": items}, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    try:
        export_floor_dxf(floor_idx, base_dir)
    except Exception:
        pass
    return {"status": "saved", "floor_idx": floor_idx, "count": len(items)}


def _mp_instance_to_equipment_record(inst: dict, floor_idx: int) -> dict:
    snapped = inst.get("snapped_s2f_position") or inst["s2f_position"]
    raw_s2f = inst["s2f_position"]
    iid = inst["instance_id"]
    lbl = inst["label"]
    return {
        "id": f"eq_{iid}",
        "instance_id": iid,
        "label": lbl,
        "type": "fire_extinguisher" if lbl == "hasici_pristroj" else "light_source",
        "floor_idx": floor_idx,
        "x": snapped["x"],
        "y": snapped["y"],
        "z": snapped["z"],
        "raw_x": raw_s2f["x"],
        "raw_y": raw_s2f["y"],
        "raw_z": raw_s2f["z"],
        "rotation_y": inst.get("rotation_y", 0.0),
        "mount_type": inst.get("mount_type", "wall"),
        "wall_idx": inst.get("wall_idx"),
        "floor_y": inst.get("floor_y"),
        "ceil_y": inst.get("ceil_y"),
        "room_id": inst.get("room_id"),
        "room_name": inst.get("room_name"),
        "max_score": inst.get("max_score", 0.0),
        "observation_count": inst.get("observation_count", 1),
        "sweep_ids": inst.get("sweep_ids", []),
        "observations": inst.get("observations", []),
        "anchor": inst.get("anchor"),
    }


def _add_mp_equipment_for_dir(
    base_dir: str,
    payload: AddMpEquipmentPayload,
    save_name: Optional[str] = None,
) -> dict:
    _, os_store, _ = get_mp_stores(save_name=save_name)
    ctx = load_mp_s2f_context(save_name=save_name)
    supported_set = set(MP_SUPPORTED_EQUIPMENT_LABELS)
    target_labels = (
        {normalize_mp_label(lbl) for lbl in payload.labels} & supported_set
        if payload.labels is not None
        else supported_set
    )
    target_ids = set(payload.instance_ids) if payload.instance_ids is not None else None

    by_floor: dict[int, list[dict]] = {}
    for inst in os_store.instances():
        enriched = enrich_mp_instance(inst, ctx)
        lbl = enriched.get("label")
        if lbl not in supported_set or lbl not in target_labels:
            continue
        if target_ids is not None and enriched.get("instance_id") not in target_ids:
            continue
        f_idx = enriched.get("floor_idx")
        if f_idx is None:
            continue
        f_idx_int = int(f_idx)
        if payload.floor_idx is not None and f_idx_int != int(payload.floor_idx):
            continue
        by_floor.setdefault(f_idx_int, []).append(enriched)

    added_total = 0
    items_by_floor: dict[int, list[dict]] = {}
    for f_idx, matched in sorted(by_floor.items()):
        existing = list(_get_equipment_for_dir(base_dir, f_idx)["items"])
        existing_iids = {it.get("instance_id") for it in existing if it.get("instance_id")}
        added_here = 0
        for inst in matched:
            iid = inst.get("instance_id")
            if not iid or iid in existing_iids:
                continue
            existing.append(_mp_instance_to_equipment_record(inst, f_idx))
            existing_iids.add(iid)
            added_here += 1
        if added_here > 0:
            _put_equipment_for_dir(base_dir, f_idx, existing)
            added_total += added_here
        items_by_floor[f_idx] = existing

    return {"status": "ok", "added": added_total, "items_by_floor": items_by_floor}


@app.get("/api/equipment/{floor_idx}")
def get_equipment(floor_idx: int):
    return _get_equipment_for_dir(PROCESSED_DIR, floor_idx)


@app.put("/api/equipment/{floor_idx}")
def save_equipment(floor_idx: int, payload: EquipmentFloorPayload):
    return _put_equipment_for_dir(PROCESSED_DIR, floor_idx, payload.items)


@app.post("/api/equipment/add-from-mp")
def add_equipment_from_mp(payload: AddMpEquipmentPayload):
    return _add_mp_equipment_for_dir(PROCESSED_DIR, payload, save_name=None)


@app.get("/api/saves/{name}/equipment/{floor_idx}")
def save_get_equipment(name: str, floor_idx: int):
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    return _get_equipment_for_dir(save_path, floor_idx)


@app.put("/api/saves/{name}/equipment/{floor_idx}")
def save_put_equipment(name: str, floor_idx: int, payload: EquipmentFloorPayload):
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    return _put_equipment_for_dir(save_path, floor_idx, payload.items)


@app.post("/api/saves/{name}/equipment/add-from-mp")
def save_add_equipment_from_mp(name: str, payload: AddMpEquipmentPayload):
    save_path = _save_dir(name)
    if not os.path.isdir(save_path):
        raise HTTPException(status_code=404, detail=f"Save '{name}' not found.")
    return _add_mp_equipment_for_dir(save_path, payload, save_name=name)


# ── Serve React frontend ──────────────────────────────────────────────────────
# Mount the compiled Vite bundle as the root static site.
# IMPORTANT: this mount must come LAST — FastAPI routes registered above it
# take precedence, so /api/* and /model/* are never captured by the catch-all.
_DIST_DIR = os.path.join(BASE_DIR, "dist")
if os.path.isdir(_DIST_DIR):
    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="static")
