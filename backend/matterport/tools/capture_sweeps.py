"""CLI tool: capture panoramic sweep images via Playwright or local headless Chromium."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from ..config import MODEL_ID, resolve_paths
from ..objects import ObjectStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture 4-direction JPG views for each Matterport sweep.")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="scan2floor backend base URL")
    parser.add_argument("--ui-url", default="http://127.0.0.1:5173", help="Frontend URL hosting Showcase")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--headings", default="0,90,180,270")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit("Playwright is required: pip install playwright && playwright install chromium") from exc

    paths = resolve_paths(args.model_id)
    out_dir = paths["captures"]
    out_dir.mkdir(parents=True, exist_ok=True)
    headings = [int(h.strip()) for h in args.headings.split(",") if h.strip()]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto(args.ui_url, wait_until="networkidle")
        page.wait_for_function("() => Boolean(window.__mp && window.__mp.sweeps)", timeout=30000)
        sweeps: list[dict[str, Any]] = page.evaluate("() => window.__mp.sweeps()")
        if args.limit > 0:
            sweeps = sweeps[: args.limit]

        store = ObjectStore(path=paths["objects"], model_id=args.model_id)
        for idx, sw in enumerate(sweeps):
            sid = sw.get("id") or sw.get("sweep_id")
            if not sid:
                continue
            sdir = out_dir / sid
            sdir.mkdir(parents=True, exist_ok=True)
            for hdg in headings:
                img_path = sdir / f"h{hdg}.jpg"
                if img_path.is_file():
                    continue
                urllib.request.urlopen(
                    urllib.request.Request(
                        f"{args.server}/api/mp/move",
                        data=json.dumps({"sweep_id": sid, "rotation": {"x": 0, "y": hdg}}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                )
                time.sleep(0.8)
                page.screenshot(path=str(img_path), type="jpeg", quality=88)
            store.upsert_sweep_detections(
                sid,
                {"position": sw.get("position"), "floor": sw.get("floor"), "index": idx},
                (store.get_sweep(sid) or {}).get("detections", []),
            )
        browser.close()


if __name__ == "__main__":
    main()

