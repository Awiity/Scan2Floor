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
    xyz_path:          str,
    run_c2b:           bool      = True,
    run_slices:        bool      = True,
    detect_floors:     list[int] | None = None,   # None → all floors
    wall_cfg:          dict      | None = None,
    resume_from_stage: int       = 1,              # 1 = full run, N = skip stages <N
) -> None:
    """
    Execute the full pipeline.  Call this in a daemon thread.
    `detect_floors` restricts wall detection to specific floor indices.
    `wall_cfg` is passed to detect_walls_c2b_for_floor (optional overrides).
    `resume_from_stage` allows resuming after a cancellation without re-running
    earlier stages:  1 = full fresh run, 4 = skip stages 1-3 (keep existing
    pointcloud.bin / info.json / c2b outputs), 5 = keep wall slices too.
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
            "log":         [f"Pipeline started for: {xyz_path}" +
                            (f" (resuming from stage {resume_from_stage})" if resume_from_stage > 1 else "")],
            "xyz_path":    xyz_path,
            "resume_from": resume_from_stage,
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

        # ── Selective wipe: only clear outputs from stages we will re-run ──
        if resume_from_stage <= 1:
            # Full fresh run — wipe everything except the persisted XYZ path
            _emit("\n[init] Full run — clearing all stale pipeline outputs…")
            preserve = {"xyz_path.json"}
            stale_globs = ["pointcloud.bin", "info.json", "*.npy",
                           "walls_floor_*.json", "openings_floor_*.json",
                           "rooms_floor_*.json", "*.dxf", "*.svg", "debug_c2b_*"]
            for pat in stale_globs:
                for p in glob.glob(str(PROCESSED_DIR / pat)):
                    if os.path.basename(p) in preserve:
                        continue
                    try:
                        os.remove(p)
                    except Exception as e:
                        _emit(f"  [warn] could not remove {os.path.basename(p)}: {e}")
            for p in glob.glob(str(C2B_OUT_DIR / "horiz_surface_*.xyz")):
                try:
                    os.remove(p)
                except Exception:
                    pass
        else:
            # Resuming — only wipe outputs produced by the stages we will re-run
            _emit(f"\n[init] Resuming from stage {resume_from_stage} — preserving earlier outputs…")
            # Stage 5 outputs (wall/opening/room JSON + DXF/SVG) are always re-generated
            downstream_globs = ["walls_floor_*.json", "openings_floor_*.json",
                                 "rooms_floor_*.json", "*.dxf", "*.svg"]
            # If re-running from stage 4 or earlier, also wipe the wall slices
            if resume_from_stage <= 4:
                downstream_globs.append("*.npy")
            # If re-running from stage 3 or earlier, also wipe C2B surfaces
            if resume_from_stage <= 3:
                for p in glob.glob(str(C2B_OUT_DIR / "horiz_surface_*.xyz")):
                    try:
                        os.remove(p)
                    except Exception:
                        pass
            # If re-running from stage 2 or earlier, also wipe pointcloud + info
            if resume_from_stage <= 2:
                downstream_globs += ["pointcloud.bin", "info.json"]
            preserve = {"xyz_path.json"}
            for pat in downstream_globs:
                for p in glob.glob(str(PROCESSED_DIR / pat)):
                    if os.path.basename(p) in preserve:
                        continue
                    try:
                        os.remove(p)
                    except Exception as e:
                        _emit(f"  [warn] could not remove {os.path.basename(p)}: {e}")

        # ── Stage 1: Preprocess XYZ ───────────────────────────────────────────────
        if _check_cancel(): return
        if resume_from_stage <= 1:
            _set_stage(1)
            script1 = str(BASE_DIR / "pipeline" / "preprocess_xyz.py")
            ok = _run_subprocess(
                [sys.executable, script1, "--xyz", xyz_path],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                return _fail("preprocess_xyz.py failed")
            _stage_done(1)
        else:
            _emit("[skip] Stage 1 (preprocess XYZ) — using existing pointcloud.bin + info.json")
            with _lock:
                status["stages_done"].append(1)

        # ── Stage 2: Cloud2BIM slab detection ────────────────────────────────────────
        if _check_cancel(): return
        if resume_from_stage <= 2 and run_c2b:
            _set_stage(2)
            script2 = str(BASE_DIR / "pipeline" / "run_c2b.py")
            ok = _run_subprocess(
                [sys.executable, script2,
                 "--xyz", xyz_path,
                 "--out-dir", str(C2B_OUT_DIR)],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                _emit("  ⚠ Cloud2BIM slab detection failed — using histogram floor levels from Stage 1")
            else:
                _stage_done(2)
        else:
            reason = "skipped by caller" if not run_c2b else f"resuming from stage {resume_from_stage}"
            _emit(f"[skip] Stage 2 (Cloud2BIM) — {reason}")
            with _lock:
                status["stages_done"].append(2)

        # ── Stage 3: Import C2B floor levels ──────────────────────────────
        if _check_cancel(): return
        if resume_from_stage <= 3:
            _set_stage(3)
            info_path = PROCESSED_DIR / "info.json"
            if not info_path.exists():
                return _fail("info.json not found after Stage 1")

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
                    _emit(f"  ⚠ floor_from_c2b failed: {exc} — keeping Stage 1 levels")
            else:
                _emit("  ⚠ No horiz_surface_*.xyz found — keeping histogram floor levels")

            _stage_done(3)
        else:
            _emit(f"[skip] Stage 3 (Import C2B) — resuming from stage {resume_from_stage}")
            with _lock:
                status["stages_done"].append(3)

        # ── Stage 4: Extract wall slices ──────────────────────────────────────────────
        if _check_cancel(): return
        if resume_from_stage <= 4 and run_slices:
            _set_stage(4)
            script4 = str(BASE_DIR / "pipeline" / "preprocess_walls.py")
            ok = _run_subprocess(
                [sys.executable, script4, "--xyz", xyz_path],
                cwd=str(BASE_DIR),
            )
            if _check_cancel(): return
            if not ok:
                return _fail("preprocess_walls.py failed")
            _stage_done(4)
        else:
            reason = "skipped by caller" if not run_slices else f"resuming from stage {resume_from_stage}"
            _emit(f"[skip] Stage 4 (wall slices) — {reason}")
            with _lock:
                status["stages_done"].append(4)

        # ── Stage 5: Detect walls & rooms per floor ───────────────────────
        if _check_cancel(): return
        _set_stage(5)
        info_path = PROCESSED_DIR / "info.json"   # re-assign in case stage 3 was skipped
        with open(info_path) as fh:
            info = json.load(fh)
        n_floors = len(info.get("floor_levels", []))

        if n_floors == 0:
            _emit("  ⚠ No floor levels in info.json — skipping wall detection")
            _stage_done(5)
        else:
            floors_to_run = detect_floors if detect_floors is not None else list(range(n_floors))
            _emit(f"  Detecting walls for floors: {floors_to_run}")

            from pipeline.wall_detection_c2b import detect_walls_c2b_for_floor
            from pipeline.opening_detection  import detect_openings_for_floor
            from pipeline.room_detection     import detect_rooms_for_floor
            from pipeline.dxf_export         import export_floor_dxf

            cfg = {
                "grid_size":          0.05,
                "snap_to_axis":       True,
                "min_wall_m":         0.40,
                "max_wall_thickness": 0.75,
                "dp_tolerance":       0.04,
                "threshold_frac":     0.01,
                "static_threshold":   2.0,
                "save_debug":         True,
                **(wall_cfg or {}),
            }
            room_cfg = {
                "wall_thickness_m":  0.20,
                "extend_m":          0.45,
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

                try:
                    op = detect_openings_for_floor(fi, cfg)
                    _emit(f"  Openings: {op.get('n_doors',0)}D {op.get('n_windows',0)}W")
                except Exception as exc:
                    _emit(f"  ⚠ opening detection floor {fi}: {exc}")

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

            _stage_done(5)

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
