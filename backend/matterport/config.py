"""Configuration, environment loading, and dataset bootstrapping for the Matterport module."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

# Axis mapping from Matterport SDK space (x, y_up, z) to point-cloud XYZ space.
AXIS_MAP: tuple[tuple[int, float], tuple[int, float], tuple[int, float]] = (
    (0, 1.0),
    (2, -1.0),
    (1, 1.0),
)
COORD_OFFSET: tuple[float, float, float] = (0.0, 0.0, 0.0)

CAPTURE_HFOV: float = 100.5
CAPTURE_TAN_HALF: float = 1.20236
CAPTURE_YAW_SIGN: float = -1.0
MERGE_RADIUS: float = 0.75

AI_PORT: int = 8018
AI_WORKERS: int = 8
AI_THRESHOLD: float = 0.25

BACKEND_DIR: Path = Path(__file__).resolve().parent.parent
PROJECT_ROOT: Path = BACKEND_DIR.parent


def _candidate_env_paths() -> list[Path]:
    return [
        PROJECT_ROOT / ".env",
        PROJECT_ROOT / "MatterportIn3D" / ".env",
        BACKEND_DIR / ".env",
    ]


def load_env() -> None:
    """Load key=value pairs from .env files without overriding existing OS environment vars."""
    for env_path in _candidate_env_paths():
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in {"'", '"'}:
                val = val[1:-1]
            os.environ.setdefault(key, val)


load_env()

PROCESSED_DIR: Path = Path(
    os.getenv("S2F_PROCESSED_DIR")
    or os.getenv("PROCESSED_DIR")
    or str(BACKEND_DIR / "processed")
).resolve()
SAVES_DIR: Path = Path(
    os.getenv("S2F_SAVES_DIR") or str(BACKEND_DIR / "saves")
).resolve()
DATA_ROOT: Path = PROCESSED_DIR / "matterport"

MODEL_ID: str = os.getenv("MP_MODEL_ID", "yQPhyaCwigp")
APPLICATION_KEY: str = (
    os.getenv("matterport_api_key")
    or os.getenv("MATTERPORT_API_KEY")
    or os.getenv("MP_APPLICATION_KEY")
    or os.getenv("MP_SDK_KEY")
    or ""
)

AI_MODEL_URL: str = os.getenv(
    "MP_AI_URL", f"http://localhost:{AI_PORT}/api/infer/url"
)
AI_FILE_URL: str = os.getenv(
    "MP_AI_FILE_URL", f"http://localhost:{AI_PORT}/api/infer/file"
)
AI_AUTH_TOKEN: str = os.getenv("MP_AI_TOKEN", "")
if not AI_AUTH_TOKEN:
    _token_file = Path.home() / ".dcuk_jwt"
    if _token_file.is_file():
        AI_AUTH_TOKEN = _token_file.read_text(encoding="utf-8").strip()

DCUK_REGISTRY_URL: str = os.getenv(
    "DCUK_REGISTRY_URL", "http://localhost:8019"
).rstrip("/")
DCUK_SYNC_INTERVAL: float = float(os.getenv("DCUK_SYNC_INTERVAL", "300"))
DCUK_PORTAL_URL: str = os.getenv("DCUK_PORTAL_URL", "").rstrip("/")
DCUK_USERNAME: str = os.getenv("DCUK_USERNAME", "")
DCUK_PASSWORD: str = os.getenv("DCUK_PASSWORD", "")

ALLOWED_DATA_ROOTS: list[Path] = [
    DATA_ROOT,
    SAVES_DIR,
    PROJECT_ROOT / "MatterportIn3D" / "data",
    Path("/matterport_data"),
]


def _legacy_data_root() -> Path | None:
    """Locate legacy MatterportIn3D/data folder when present on disk or mounted."""
    candidates = [
        Path(os.getenv("MP_LEGACY_DATA_DIR", ""))
        if os.getenv("MP_LEGACY_DATA_DIR")
        else None,
        PROJECT_ROOT / "MatterportIn3D" / "data",
        Path("/matterport_data"),
    ]
    for cand in candidates:
        if cand is not None and cand.is_dir():
            return cand
    return None


def resolve_paths(model_id: str | None = None, save_name: str | None = None) -> dict[str, Path]:
    """Return resolved file paths for a Matterport model (live or saved snapshot)."""
    mid = (model_id or MODEL_ID).strip() or MODEL_ID
    if save_name:
        save_dir = (SAVES_DIR / save_name).resolve()
        if not str(save_dir).startswith(str(SAVES_DIR)):
            raise ValueError(f"Invalid save_name: {save_name}")
        return {
            "base": save_dir,
            "points": save_dir / "mp_points.json",
            "objects": save_dir / "mp_objects.json",
            "captures": DATA_ROOT / mid / "captures",
        }

    base = (DATA_ROOT / mid).resolve()
    base.mkdir(parents=True, exist_ok=True)
    return {
        "base": base,
        "points": base / "points.json",
        "objects": base / "objects.json",
        "captures": base / "captures",
    }


def cloud_to_model(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Convert point-cloud (x, y, z) coordinates back to Matterport SDK space."""
    ox, oy, oz = COORD_OFFSET
    raw = [x - ox, y - oy, z - oz]
    out = [0.0, 0.0, 0.0]
    for sdk_axis, (cloud_axis, sign) in enumerate(AXIS_MAP):
        out[sdk_axis] = raw[cloud_axis] * sign
    return (round(out[0], 4), round(out[1], 4), round(out[2], 4))


def model_to_cloud(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Convert Matterport SDK (x, y_up, z) coordinates to point-cloud XYZ space."""
    ox, oy, oz = COORD_OFFSET
    vec = [x, y, z]
    out = [0.0, 0.0, 0.0]
    for sdk_axis, (cloud_axis, sign) in enumerate(AXIS_MAP):
        out[cloud_axis] = vec[sdk_axis] * sign
    return (
        round(out[0] + ox, 4),
        round(out[1] + oy, 4),
        round(out[2] + oz, 4),
    )


def bootstrap_model_data(model_id: str | None = None, force: bool = False) -> dict[str, Any]:
    """Seed processed Matterport points.json and normalized objects.json if missing.

    Reads from ``MatterportIn3D/data/<model_id>/`` (or ``/matterport_data/<model_id>``).
    When only ``objects.json.pre-units`` exists, normalizes millimeter anchors and
    clusters per-sweep anchors into deduplicated instances.
    """
    from .objects import cluster_anchor_objects, normalize_anchor_units_data

    mid = (model_id or MODEL_ID).strip() or MODEL_ID
    paths = resolve_paths(mid)
    legacy_root = _legacy_data_root()
    src_dir = (legacy_root / mid) if legacy_root is not None else None
    summary: dict[str, Any] = {
        "model_id": mid,
        "points_seeded": False,
        "objects_built": False,
        "instances": 0,
        "sweeps": 0,
    }

    if src_dir is None or not src_dir.is_dir():
        return summary

    # Seed points.json
    src_points = src_dir / "points.json"
    if src_points.is_file() and (force or not paths["points"].is_file()):
        paths["points"].parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_points, paths["points"])
        summary["points_seeded"] = True

    # Seed captures directory symlink/copy only if local captures exist and target empty
    src_captures = src_dir / "captures"
    if src_captures.is_dir() and not paths["captures"].exists():
        paths["captures"].mkdir(parents=True, exist_ok=True)
        for item in src_captures.iterdir():
            dst = paths["captures"] / item.name
            if item.is_dir() and not dst.exists():
                shutil.copytree(item, dst)

    # Seed or rebuild objects.json
    if force or not paths["objects"].is_file():
        src_objects = src_dir / "objects.json"
        src_pre = src_dir / "objects.json.pre-units"
        if src_objects.is_file():
            raw = json.loads(src_objects.read_text(encoding="utf-8"))
            paths["objects"].write_text(
                json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            summary["objects_built"] = True
            summary["instances"] = len(raw.get("instances", []))
            summary["sweeps"] = len(raw.get("sweeps", {}))
        elif src_pre.is_file():
            raw = json.loads(src_pre.read_text(encoding="utf-8"))
            fixed_data, _ = normalize_anchor_units_data(raw)
            sweeps = fixed_data.get("sweeps", {}) or {}
            instances = cluster_anchor_objects(sweeps, merge_radius=MERGE_RADIUS)
            fixed_data["instances"] = instances
            paths["objects"].write_text(
                json.dumps(fixed_data, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            summary["objects_built"] = True
            summary["instances"] = len(instances)
            summary["sweeps"] = len(sweeps)

    return summary
