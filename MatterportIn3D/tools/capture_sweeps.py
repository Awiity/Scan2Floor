#!/usr/bin/env python3
"""Projde všechny skeny Matterport modelu a vyfotí je z několika směrů.

Výstup:
    capture/<sweepId>/yaw000.jpg, yaw090.jpg, …   (snímky bez UI lišty)
    capture/manifest.json                          (pozice skenů + stav)

Skript je znovu spustitelný — existující snímky přeskočí, takže lze přerušit
a pokračovat. Používá `window.__mp` rozhraní z `static/app.js` (režim
?capture=1 navíc vypíná WebSocket, aby broadcasty cizích klientů nepřesunuly
kameru uprostřed fotení).

Odolnost: každý krok má timeout, a když se prohlížeč zasekne (SwiftShader
občas spěchá), session se automaticky restartuje a běh pokračuje od místa
zaseknutí.

Použití:
    /usr/bin/python3 tools/capture_sweeps.py                # všech 145 skenů
    /usr/bin/python3 tools/capture_sweeps.py --limit 5      # jen prvních 5
    /usr/bin/python3 tools/capture_sweeps.py --only ID1 ID2
    /usr/bin/python3 tools/capture_sweeps.py --views 0 90   # jen dva směry
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import CAPTURE_DIR  # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = CAPTURE_DIR
DEFAULT_BASE = "http://localhost:8017"
DEFAULT_VIEWS = (0, 90, 180, 270)

SWIFT_SHADER_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--force-device-scale-factor=1",
    # méně ruchu v pozadí = rychlejší a stabilnější rendering
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
]

GO_EXPR = "async ([id, yaw]) => { await window.__mp.go(id, yaw); await window.__mp.settle(); }"
RAF_EXPR = (
    "() => new Promise(r => requestAnimationFrame("
    "() => requestAnimationFrame(() => setTimeout(r, 60))))"
)
POSE_EXPR = (
    "async () => { const p = await window.__mp.sdk().Camera.getPose();"
    " return {position: p.position, rotation: p.rotation,"
    " sweep: p.sweep, mode: p.mode}; }"
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_manifest(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"model": None, "created": now(), "sweeps": {}}


def save_manifest(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


async def evaluate(page, expr, arg=None, timeout_s: float = 45.0):
    """Evaluate s timeoutem — bez něj visí Playwright na zaseknutá SDK volání."""
    return await asyncio.wait_for(page.evaluate(expr, arg), timeout=timeout_s)


async def wait_for_sdk(page, timeout_s: float = 300) -> bool:
    """Čeká, až se SDK připojí a načte seznam skenů (bývá to i >90 s)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        state = await page.evaluate(
            "() => {const d=document.getElementById('sdkDot');"
            "if(!d) return 'missing';"
            "return d.classList.contains('ok') ? 'ok' :"
            "(d.classList.contains('err') ? 'err' : 'pending')}"
        )
        if state == "ok":
            try:
                ready = await page.evaluate(
                    "() => Boolean(window.__mp && window.__mp.ready())"
                )
                if ready:
                    return True
            except Exception:
                pass
        elif state in ("err", "missing"):
            return False
        await asyncio.sleep(0.5)
    return False


async def open_session(pw, args) -> tuple[object, object, bool]:
    """Otevře nový prohlížeč s page v capture režimu a počká na SDK."""
    browser = await pw.chromium.launch(headless=True, args=SWIFT_SHADER_ARGS)
    try:
        ctx = await browser.new_context(
            viewport={"width": args.width, "height": args.height + args.chrome},
            locale="cs-CZ",
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            device_scale_factor=1,
        )
        page = await ctx.new_page()
        page.on("pageerror", lambda e: None)  # chyby jen logujeme, nesmí brzdit

        await page.goto(args.base + "/?capture=1", wait_until="domcontentloaded", timeout=120_000)
        ok = await wait_for_sdk(page, args.sdk_timeout)
        if not ok:
            await browser.close()
            return None, None, False

        await page.evaluate(
            """() => {
                window.__mp.hideUi();
                document.body.style.cursor = 'none';
            }"""
        )
        await asyncio.sleep(1.0)
        return browser, page, True
    except Exception:
        try:
            await browser.close()
        except Exception:
            pass
        raise


async def capture(args) -> int:
    out_dir: Path = Path(args.out).resolve()
    manifest_path = out_dir / "manifest.json"
    manifest = load_manifest(manifest_path)
    manifest["model_id_base"] = args.base
    out_dir.mkdir(parents=True, exist_ok=True)

    views = [int(v) % 360 for v in args.views]
    manifest["views"] = views
    manifest["size"] = [args.width, args.height]
    manifest.setdefault("sweeps", {})
    manifest.setdefault("failures", [])

    shots = 0
    skipped = 0
    started = time.monotonic()
    restarts = 0
    fail_streak = 0
    remaining: list[dict] = []
    failed: list[dict] = []
    sweep_meta: dict[str, dict] = {}

    async with async_playwright() as pw:
        browser = None
        while True:
            restarts += 1
            if restarts > 6 and remaining:
                failed.extend(remaining)
                print(
                    f"[capture] vzdávám {len(remaining)} úloh po {restarts} restartech "
                    "— spusť skript znovu, existující snímky přeskočí",
                    flush=True,
                )
                break

            # session: čerstvý prohlížeč
            try:
                browser, page, ok = await open_session(pw, args)
            except Exception as exc:
                print(f"[capture] session selhala: {exc}", flush=True)
                await asyncio.sleep(10)
                continue
            if not ok:
                print("[capture] CHYBA: SDK se nepřipojilo — opakuji…", flush=True)
                await asyncio.sleep(10)
                continue

            # metadata všech skenů (pozice, sousedi) — jednou za běh stačí,
            # ale po restartu je načteme znovu, je to levné
            sweeps_meta = await evaluate(page, "() => window.__mp.sweeps()", timeout_s=30.0)
            for s in sweeps_meta:
                sid = s["id"]
                sweep_meta.setdefault(
                    sid,
                    {
                        "position": s.get("position"),
                        "rotation": s.get("rotation"),
                        "neighbors": s.get("neighbors"),
                    },
                )
            # metadata všech skenů (pozice, sousedi) — merge, ale zachovej
            # už uložené pohledy dokončených skenů
            original_views = {sid: dict(manifest["sweeps"].get(sid) or {}) for sid in sweep_meta}
            manifest["sweeps"].update(
                {sid: {**sweep_meta[sid], **original_views[sid]} for sid in sweep_meta}
            )
            save_manifest(manifest_path, manifest)
            print(f"[capture] skenů v modelu: {len(sweep_meta)}", flush=True)

            if not remaining:  # poprvé: postav frontu úloh
                order = [s["id"] for s in sweeps_meta]
                if args.only:
                    wanted = set(args.only)
                    order = [sid for sid in order if sid in wanted]
                if args.limit:
                    order = order[: args.limit]
                for sid in order:
                    for yaw in views:
                        name = f"yaw{yaw:03d}.jpg"
                        target = out_dir / sid / name
                        if (
                            target.exists()
                            and target.stat().st_size > 1000
                            and not args.fresh
                        ):
                            skipped += 1
                            continue
                        remaining.append({"sid": sid, "yaw": yaw, "target": target})
                print(
                    f"[capture] úloh: {len(remaining)} (přeskočeno {skipped} existujících)",
                    flush=True,
                )
            elif args.fresh and not failed:
                pass  # --fresh: fronta už je postavená, nerebuildovat

            fail_streak = 0
            try:
                while remaining and fail_streak < 3:
                    job = remaining.pop(0)
                    sid, yaw, target = job["sid"], job["yaw"], job["target"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    captured = False
                    for attempt in range(2):
                        try:
                            await evaluate(page, GO_EXPR, [sid, yaw], timeout_s=45.0)
                            await evaluate(page, RAF_EXPR, timeout_s=10.0)
                            await page.screenshot(
                                path=str(target),
                                type="jpeg",
                                quality=args.quality,
                                timeout=60_000,
                                # ořežeme spodní lištu Matterportu
                                clip={
                                    "x": 0,
                                    "y": 0,
                                    "width": args.width,
                                    "height": args.height,
                                },
                            )
                            captured = True
                            break
                        except Exception as exc:  # noqa: BLE001
                            fail_streak += 1
                            print(
                                f"  ! {sid[:10]} yaw{yaw} (pokus {attempt + 1}): {str(exc)[:100]}",
                                flush=True,
                            )
                            await asyncio.sleep(2)
                            if fail_streak >= 3:
                                remaining.insert(0, job)
                                break
                    if not captured and fail_streak >= 3:
                        break  # restart session — úloha zůstává ve frontě
                    if not captured:
                        continue

                    fail_streak = 0
                    try:
                        pose = await evaluate(page, POSE_EXPR, timeout_s=20.0)
                    except Exception:
                        pose = {}
                    entry = manifest["sweeps"].get(sid) or {}
                    entry.setdefault("views", {})
                    entry["views"][str(yaw)] = {
                        "file": f"{sid}/{target.name}",
                        "pose": pose,
                        "bytes": target.stat().st_size,
                        "captured": now(),
                    }
                    manifest["sweeps"][sid] = entry
                    shots += 1
                    if shots % 8 == 0 or not remaining:
                        save_manifest(manifest_path, manifest)

                    done = shots + skipped
                    elapsed = time.monotonic() - started
                    total = len(remaining) + shots + skipped
                    # ETA jen z reálné práce (přeskočené úlohy jsou okamžité)
                    rate = shots / max(elapsed, 1e-6)
                    eta = len(remaining) / rate / 60 if rate and shots else 0
                    print(
                        f"[{done:3d}/{total}] {sid[:10]} yaw{yaw:03d}  "
                        f"+{shots} nových  {elapsed:5.0f}s  ETA {eta:4.1f} min",
                        flush=True,
                    )
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass
                browser = None
                if fail_streak >= 3:
                    print("[capture] prohlížeč se zasekl — restartuji session…", flush=True)
                    await asyncio.sleep(5)

            if not remaining:
                break  # vše vyfoceno (nebo přeskočeno) — hotovo

    manifest["finished"] = now()
    manifest["total_sweeps"] = len(manifest["sweeps"])
    manifest["failures"] = [f"{j['sid']}/yaw{j['yaw']:03d}" for j in failed]
    save_manifest(manifest_path, manifest)

    print(
        f"[capture] hotovo: {shots} nových snímků ({skipped} přeskočeno, "
        f"{len(failed)} selhalo) → {out_dir}",
        flush=True,
    )
    for f in manifest["failures"]:
        print("   !", f, flush=True)

    # auto-push nových snímků do registru (jen když je MP_REGISTRY_URL)
    from app.config import OBJECTS_FILE
    from app.registry_sync import push_after_change

    action = push_after_change(OBJECTS_FILE.parent)
    if action:
        print(f"[capture] registry: {action}", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=DEFAULT_BASE, help="adresa běžící aplikace")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="výstupní adresář")
    ap.add_argument(
        "--views",
        type=int,
        nargs="+",
        default=list(DEFAULT_VIEWS),
        help="směry pohledu ve stupních (default 0 90 180 270)",
    )
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument(
        "--chrome",
        type=int,
        default=96,
        help="o kolik je viewport vyšší než snímek (spodní lišta Matterportu)",
    )
    ap.add_argument("--quality", type=int, default=88, help="JPEG kvalita 1–100")
    ap.add_argument("--limit", type=int, default=0, help="jen prvních N skenů")
    ap.add_argument("--only", nargs="+", default=[], help="konkrétní ID skenů")
    ap.add_argument("--fresh", action="store_true", help="přepsat existující snímky")
    ap.add_argument("--sdk-timeout", type=float, default=300.0)
    args = ap.parse_args(argv)
    return asyncio.run(capture(args))


if __name__ == "__main__":
    sys.exit(main())
