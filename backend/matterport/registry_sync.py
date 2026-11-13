"""Background bidirectional sync between local Matterport stores and DCUK Registry."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

try:
    import httpx
except ImportError:
    httpx = None  # optional when local Python doesn't have httpx installed

from .config import (
    DCUK_PASSWORD,
    DCUK_PORTAL_URL,
    DCUK_REGISTRY_URL,
    DCUK_SYNC_INTERVAL,
    DCUK_USERNAME,
    MODEL_ID,
)

log = logging.getLogger("matterport.registry_sync")


def _auth_headers() -> dict[str, str]:
    if httpx is None or not (DCUK_PORTAL_URL and DCUK_USERNAME and DCUK_PASSWORD):
        return {}
    try:
        resp = httpx.post(
            f"{DCUK_PORTAL_URL}/api/auth/login",
            json={"username": DCUK_USERNAME, "password": DCUK_PASSWORD},
            timeout=10.0,
        )
        if resp.status_code == 200:
            token = resp.json().get("access_token") or resp.json().get("token")
            if token:
                return {"Authorization": f"Bearer {token}"}
    except Exception as exc:
        log.debug("Portal auth skipped: %s", exc)
    return {}


def sync_once(
    point_store: Any,
    object_store: Any,
    model_id: str = MODEL_ID,
    registry_url: str = DCUK_REGISTRY_URL,
) -> dict[str, Any]:
    """Synchronize viewpoints and object inventory with the DCUK Registry service."""
    if not registry_url or httpx is None:
        return {"status": "disabled"}

    headers = _auth_headers()
    try:
        with httpx.Client(timeout=10.0, headers=headers) as client:
            health = client.get(f"{registry_url}/health")
            if health.status_code != 200:
                return {"status": "unreachable", "code": health.status_code}

            local_points = point_store.list()
            resp_pts = client.get(f"{registry_url}/models/{model_id}/points")
            if resp_pts.status_code == 200:
                remote_points = resp_pts.json().get("points", [])
                remote_ids = {p.get("id") for p in remote_points}
                pushed = 0
                for pt in local_points:
                    if pt.get("id") not in remote_ids:
                        client.post(f"{registry_url}/models/{model_id}/points", json=pt)
                        pushed += 1
            else:
                pushed = 0

            # Push object inventory summary snapshot
            inv = object_store.inventory_summary()
            client.put(
                f"{registry_url}/models/{model_id}/inventory",
                json={"model_id": model_id, "inventory": inv},
            )
            return {"status": "ok", "pushed_points": pushed, "inventory_classes": len(inv)}
    except Exception as exc:
        log.debug("Registry sync skipped (%s): %s", registry_url, exc)
        return {"status": "error", "detail": str(exc)}


def push_after_change(point_store: Any, object_store: Any, model_id: str = MODEL_ID) -> None:
    """Fire-and-forget background push after a local point/object mutation."""
    if not DCUK_REGISTRY_URL:
        return
    threading.Thread(
        target=sync_once,
        args=(point_store, object_store, model_id, DCUK_REGISTRY_URL),
        daemon=True,
    ).start()


def start_sync_loop(
    point_store: Any,
    object_store: Any,
    model_id: str = MODEL_ID,
    interval: float = DCUK_SYNC_INTERVAL,
) -> threading.Thread | None:
    """Start periodic background sync daemon thread when interval > 0 and registry URL is configured."""
    if not DCUK_REGISTRY_URL or interval <= 0:
        return None

    def _loop() -> None:
        while True:
            sync_once(point_store, object_store, model_id, DCUK_REGISTRY_URL)
            time.sleep(max(15.0, interval))

    th = threading.Thread(target=_loop, daemon=True, name="mp-registry-sync")
    th.start()
    return th
