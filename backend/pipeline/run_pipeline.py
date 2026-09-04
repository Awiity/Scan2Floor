"""
run_pipeline.py  —  Unified 5-stage Scan2Floor pipeline
========================================================
Runs all pipeline stages sequentially in a background thread:

  Stage 1 — Preprocess XYZ  : produces pointcloud.bin + info.json
  Stage 2 — Cloud2BIM C2B   : produces horiz_surface_N.xyz files
  Stage 3 — Import C2B Floors: updates floor_levels in info.json
  Stage 4 — Extract Wall Slices: produces wall_slice_floor_N.npy
  Stage 5 — Detect Walls & Rooms: walls_floor_N.json + DXF per floor

Status is published to a shared dict polled by /api/pipeline/status.
Cancellation is coordinated via a threading.Event (_cancel_event).
"""

from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

# ── Path defaults ─────────────────────────────────────────────────────────────
_THIS_FILE    = Path(__file__).resolve()
BASE_DIR      = _THIS_FILE.parent.parent
PROCESSED_DIR = Path(os.environ.get("PROCESSED_DIR", str(BASE_DIR / "processed")))
C2B_OUT_DIR   = PROCESSED_DIR / "c2b_output"

# ── Cancellation event ────────────────────────────────────────────────────────
# Set by cancel_pipeline(); checked at every stage boundary and subprocess loop.
_cancel_event = threading.Event()

# ── Shared status dict (thread-safe via _lock) ────────────────────────────────
_lock = threading.Lock()

STAGES = [
    "Clean Point Cloud",
    "Preprocess XYZ",
    "Cloud2BIM Slab Detection",
    "Import C2B Floor Levels",
    "Extract Wall Slices",
    "Detect Walls & Rooms",
]

status: dict[str, Any] = {
    "running":     False,
    "done":        False,
    "cancelled":   False,
    "error":       None,
    "stage":       0,          # 1-indexed current stage (0 = not started)
    "stage_name":  "",
    "stages_done": [],         # list of completed stage indices (1-indexed)
    "started_at":  None,
    "finished_at": None,
    "elapsed_s":   None,
    "log":         [],         # last N log lines across all stages
    "xyz_path":    None,
}

_MAX_LOG = 120


def _emit(msg: str) -> None:
    print(msg, flush=True)
    with _lock:
        status["log"].append(msg)
        if len(status["log"]) > _MAX_LOG:
            status["log"] = status["log"][-_MAX_LOG:]


def _set_stage(n: int) -> None:
    with _lock:
        status["stage"]      = n
        status["stage_name"] = STAGES[n - 1] if 1 <= n <= len(STAGES) else ""
    _emit(f"\n{'='*55}")
    _emit(f"  Stage {n}/{len(STAGES)}: {STAGES[n-1]}")
    _emit(f"{'='*55}")


def _stage_done(n: int) -> None:
    with _lock:
        if n not in status["stages_done"]:
            status["stages_done"].append(n)
    _emit(f"  ✓ Stage {n} complete")


def _run_subprocess(args: list[str], cwd: str | None = None) -> bool:
    """
    Run a child process, stream its stdout to _emit, return True on success.
    Monitors _cancel_event: if set while the process is running, the child is
    terminated (SIGTERM then SIGKILL after 3 s) and False is returned.
    """
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=cwd,
            encoding="utf-8",
            errors="replace",
        )
        for line in proc.stdout:
            if _cancel_event.is_set():
                _emit("  ⚠ Cancellation requested — killing subprocess…")
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                return False
            _emit(line.rstrip())
        proc.wait()
        if _cancel_event.is_set():
            return False
        return proc.returncode == 0
    except Exception as exc:
        _emit(f"  ✗ subprocess error: {exc}")
        return False


def run_pipeline(
    xyz_path:              str,
    run_c2b:               bool  = True,
    run_slices:            bool  = True,
    detect_floors:         list[int] | None = None,   # None → all floors
    wall_cfg:              dict  | None = None,
    enable_cleaning:       bool  = True,
    clean_downsample_pct:  float = 20.0,
    clean_span_min:        float = 0.65,
    clean_span_max:        float = 1.00,
) -> None:
    """
    Execute the full 6-stage pipeline. Call this in a daemon thread.
    `detect_floors` restricts wall detection to specific floor indices.
    `wall_cfg` is passed to detect_walls_c2b_for_floor (optional overrides).
    """
    global status

    with _lock:
        status.update({
            "running":     True,
            "done":        False,
            "cancelled":   False,
            "error":       None,
            "stage":       0,
            "stage_name":  "Initialising",
            "stages_done": [],
            "started_at":  time.time(),
            "finished_at": None,
            "elapsed_s":   None,
            "log":         [f"Pipeline started for: {xyz_path}"],
            "xyz_path":    xyz_path,
        })

    t0 = time.time()

    def _fail(msg: str) -> None:
        _emit(f"\n✗ PIPELINE FAILED: {msg}")
        with _lock:
            status["running"]     = False
            status["error"]       = msg
            status["finished_at"] = time.time()
            status["elapsed_s"]   = round(time.time() - t0, 1)

    def _check_cancel() -> bool:
        """Return True (and update status) if cancellation was requested."""
        if _cancel_event.is_set():
            elapsed = round(time.time() - t0, 1)
            _emit("\n⚠ PIPELINE CANCELLED by user request")
            with _lock:
                status["running"]     = False
                status["cancelled"]   = True
                status["error"]       = "Cancelled by user"
                status["finished_at"] = time.time()
                status["elapsed_s"]   = elapsed
            return True
        return False

    try:
        PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

        # ── Clear stale outputs ───────────────────────────────────────────
        _emit("\n[init] Clearing stale pipeline outputs…")
        preserve = {"xyz_path.json"}
        stale_globs = ["pointcloud.bin", "info.json", "*.npy", "walls_floor_*.json",
                       "openings_floor_*.json", "rooms_floor_*.json",
                       "*.dxf", "*.svg", "debug_c2b_*"]
        for pat in stale_globs:
            for p in glob.glob(str(PROCESSED_DIR / pat)):
                if os.path.basename(p) in preserve:
                    continue
                try:
                    os.remove(p)
                except Exception as e:
                    _emit(f"  [warn] could not remove {os.path.basename(p)}: {e}")

        # Also clear old C2B output so we always have fresh surfaces
        for p in glob.glob(str(C2B_OUT_DIR / "horiz_surface_*.xyz")):
            try:
                os.remove(p)
            except Exception:
                pass

        active_xyz = xyz_path

        # ── Stage 1: Clean Point Cloud ─────────────────────────────────────
        if _check_cancel(): return
        if enable_cleaning:
            _set_stage(1)
            script_clean = str(BASE_DIR / "pipeline" / "clean_pointcloud.py")
            cleaned_xyz = str(PROCESSED_DIR / "cloud_cleaned.xyz")
            ok = _run_subprocess(
                [
                    sys.executable, script_clean,
                    "--xyz", xyz_path,
                    "--out", cleaned_xyz,
                    "--downsample-pct", str(clean_downsample_pct),
                    "--span-min", str(clean_span_min),
                    "--span-max", str(clean_span_max),
                ],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                _emit("  ⚠ Point cloud cleaning failed — falling back to raw point cloud")
            else:
                if os.path.exists(cleaned_xyz):
                    active_xyz = cleaned_xyz
                    _emit(f"  ✓ Using cleaned point cloud: {active_xyz}")
                _stage_done(1)
        else:
            _emit("[skip] Stage 1 (Point Cloud Cleaning) skipped by caller")
            with _lock:
                status["stages_done"].append(1)

        # ── Stage 2: Preprocess XYZ ───────────────────────────────────────
        if _check_cancel(): return
        _set_stage(2)
        script1 = str(BASE_DIR / "pipeline" / "preprocess_xyz.py")
        ok = _run_subprocess(
            [sys.executable, script1, "--xyz", active_xyz],
            cwd=str(BASE_DIR),
        )
        if _check_cancel(): return
        if not ok:
            return _fail("preprocess_xyz.py failed")
        _stage_done(2)

        # ── Stage 3: Cloud2BIM slab detection ─────────────────────────────
        if _check_cancel(): return
        if run_c2b:
            _set_stage(3)
            script2 = str(BASE_DIR / "pipeline" / "run_c2b.py")
            ok = _run_subprocess(
                [sys.executable, script2,
                 "--xyz", active_xyz,
                 "--out-dir", str(C2B_OUT_DIR)],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                _emit("  ⚠ Cloud2BIM slab detection failed — using histogram floor levels from Stage 2")
            else:
                _stage_done(3)
        else:
            _emit("[skip] Stage 3 (Cloud2BIM) skipped by caller")
            with _lock:
                status["stages_done"].append(3)

        # ── Stage 4: Import C2B floor levels ──────────────────────────────
        if _check_cancel(): return
        _set_stage(4)
        info_path = PROCESSED_DIR / "info.json"
        if not info_path.exists():
            return _fail("info.json not found after Stage 2")

        if C2B_OUT_DIR.is_dir() and list(C2B_OUT_DIR.glob("horiz_surface_*.xyz")):
            try:
                from pipeline.floor_from_c2b import update_floor_levels_from_c2b
                result = update_floor_levels_from_c2b(
                    c2b_output_dir=str(C2B_OUT_DIR),
                    processed_dir=str(PROCESSED_DIR),
                )
                if result.get("status") == "ok":
                    _emit(f"  ✓ Floor levels: {result.get('new_floor_levels')}")
                else:
                    _emit(f"  ⚠ {result.get('message', 'C2B floor import issue')}")
            except Exception as exc:
                _emit(f"  ⚠ floor_from_c2b failed: {exc} — keeping Stage 2 levels")
        else:
            _emit("  ⚠ No horiz_surface_*.xyz found — keeping histogram floor levels")

        _stage_done(4)

        # ── Stage 5: Extract wall slices ──────────────────────────────────
        if _check_cancel(): return
        if run_slices:
            _set_stage(5)
            script4 = str(BASE_DIR / "pipeline" / "preprocess_walls.py")
            ok = _run_subprocess(
                [sys.executable, script4, "--xyz", active_xyz],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                return _fail("preprocess_walls.py failed")
            _stage_done(5)
        else:
            _emit("[skip] Stage 5 (wall slices) skipped")
            with _lock:
                status["stages_done"].append(5)

        # ── Stage 6: Detect walls & rooms per floor ───────────────────────
        if _check_cancel(): return
        _set_stage(6)
        with open(info_path) as fh:
            info = json.load(fh)
        n_floors = len(info.get("floor_levels", []))

        if n_floors == 0:
            _emit("  ⚠ No floor levels in info.json — skipping wall detection")
            _stage_done(6)
        else:
            floors_to_run = detect_floors if detect_floors is not None else list(range(n_floors))
            _emit(f"  Detecting walls for floors: {floors_to_run}")

            from pipeline.wall_detection_c2b import detect_walls_c2b_for_floor
            from pipeline.opening_detection  import detect_openings_for_floor
            from pipeline.room_detection     import detect_rooms_for_floor
            from pipeline.dxf_export         import export_floor_dxf

            cfg = {
                "grid_size":          0.02,
                "snap_to_axis":       True,
                "min_wall_m":         0.40,
                "max_wall_thickness": 0.75,
                "dp_tolerance":       0.04,
                "threshold_frac":     0.01,
                "save_debug":         True,
                **(wall_cfg or {}),
            }
            room_cfg = {
                "wall_thickness_m":  0.20,
                "extend_m":          0.55,
                "min_seg_m":         0.40,
                "min_room_m2":       0.80,
                "max_room_m2":       800.0,
                "min_room_width_m":  0.60,
                "save_debug":        True,
            }

            for fi in floors_to_run:
                # Check cancellation before each floor so partial results are
                # still usable when the user only wanted to stop early.
                if _check_cancel(): return
                _emit(f"\n  --- Floor {fi} ---")
                try:
                    lines = detect_walls_c2b_for_floor(fi, cfg)
                    _emit(f"  Walls: {len(lines)}")
                except Exception as exc:
                    _emit(f"  ✗ wall detection floor {fi}: {exc}")
                    continue

                # TODO: Door/Window detection disabled — results were unreliable.
                # try:
                #     op = detect_openings_for_floor(fi, cfg)
                #     _emit(f"  Openings: {op.get('n_doors',0)}D {op.get('n_windows',0)}W")
                # except Exception as exc:
                #     _emit(f"  ⚠ opening detection floor {fi}: {exc}")

                try:
                    rm = detect_rooms_for_floor(fi, {**cfg, **room_cfg, "floor_idx": fi})
                    _emit(f"  Rooms: {rm.get('n_rooms',0)}")
                except Exception as exc:
                    _emit(f"  ⚠ room detection floor {fi}: {exc}")

                try:
                    export_floor_dxf(fi, str(PROCESSED_DIR))
                    _emit(f"  DXF exported")
                except Exception as exc:
                    _emit(f"  ⚠ DXF export floor {fi}: {exc}")

            _stage_done(6)

        # ── Done ──────────────────────────────────────────────────────────
        elapsed = round(time.time() - t0, 1)
        _emit(f"\n✓ PIPELINE COMPLETE in {elapsed} s ({elapsed/60:.1f} min)")
        with _lock:
            status["running"]     = False
            status["done"]        = True
            status["finished_at"] = time.time()
            status["elapsed_s"]   = elapsed

    except Exception as exc:
        _fail(str(exc))


def start_pipeline(xyz_path: str, **kwargs) -> bool:
    """
    Launch the pipeline in a daemon thread if not already running.
    Returns True if started, False if already running.
    """
    with _lock:
        if status["running"]:
            return False

    # Clear any leftover cancel signal from a previous run
    _cancel_event.clear()

    t = threading.Thread(
        target=run_pipeline,
        args=(xyz_path,),
        kwargs=kwargs,
        daemon=True,
    )
    t.start()
    return True


def cancel_pipeline() -> bool:
    """
    Request cancellation of the currently running pipeline.
    Returns True if the pipeline was running (signal sent),
    False if nothing was running.
    """
    with _lock:
        if not status["running"]:
            return False
    _cancel_event.set()
    _emit("  ⚠ Cancel signal sent — waiting for current operation to stop…")
    return True


def is_cancelled() -> bool:
    """Return True if a cancel was requested (event is set)."""
    return _cancel_event.is_set()


def get_status() -> dict:
    """Return a snapshot of the current pipeline status."""
    with _lock:
        snap = dict(status)
        snap["log"] = list(status["log"])
    if snap.get("started_at"):
        snap["elapsed_s"] = round(
            (snap.get("finished_at") or time.time()) - snap["started_at"], 1
        )
    return snap
