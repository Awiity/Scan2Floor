"""Anchor pass — 3D průsečíky tagů (Fáze 1 inventáře).

Pro každý raw objekt v objects.json vyšle paprsek skrz střed bboxu na snímku
(syntetická myš na viewport canvasu) a přečte poslední event observable
`Pointer.intersection` — průsečík paprsku se scénou (position/normal/object).
Anchor se uloží do raw objektu; když paprsek neuspěje (žádný event nebo
zastaralý event — odchylka nad MAX_ANGLE_DEG od očekávaného směru), použije
se fallback: odhad vzdálenosti z úhlové šířky bboxu + směr z kalibrace
(`ray_direction`), pole `anchor_estimated: true`.

Resumable — objekty s hotovým anchor (a ne estimated) se přeskočí. Ukládá se
po každém skenu (atomický zápis přes ObjectStore).

Spustitelné jen s /usr/bin/python3 (Playwright + SwiftShader args, viz
tools/capture_sweeps.py — stejný vzor).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import CAPTURE_TAN_HALF, OBJECTS_FILE  # noqa: E402
from app.objects import (  # noqa: E402
    ObjectStore,
    estimate_distance,
    normalize_label,
    ray_direction,
    validate_anchor,
)

# Vzor z tools/capture_sweeps.py — headless Chromium se SwiftShaderem
SWIFT_SHADER_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
]
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Snímek 1280×720 je ořez viewportu 1280×(720+96) — střed canvasu y=408
IMG_W, IMG_H, VIEWPORT_H = 1280, 720, 816
MAX_ANGLE_DEG = 6.0  # nad tím je event „zastaralý" (jiný pixel než požadovaný)
# SDK `Pointer.intersection` position pro `intersectedobject.unknown` je v mm
# (pro `.model`/`.sweep` v m) — dist nad práh znamená event v mm → konverze ÷1000
MM_SCALE = 1000.0
MM_DIST_M = 1000.0  # max rozumná vzdálenost průsečíku od kamery (model ~ ±35 m)

GOTO_JS = """async ([id, yaw]) => {
    const s = window.__mp.sdk();
    const race = (p, ms) => Promise.race([
        p, new Promise((r) => setTimeout(() => r(null), ms)),
    ]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pose = async () => await race(s.Camera.getPose(), 5000);
    for (let i = 0; i < 12; i++) {
        const p = await pose();
        if (p && !/transitioning/i.test(p.mode || '')) break;
        await sleep(500);
    }
    for (let a = 0; a < 6; a++) {
        await race(s.Sweep.moveTo(id, {
            transition: s.Camera.TransitionType.INSTANT,
            transitionTime: 0,
            rotation: {x: 0, y: Number(yaw)},
        }), 5000);
        await race(window.__mp.settle(), 9000);
        const p = await pose();
        if (p && p.sweep === id && p.mode === 'mode.inside') {
            return {position: p.position, rotation: p.rotation,
                    sweep: p.sweep, mode: p.mode};
        }
        await sleep(1500 * (a + 1));
    }
    const p = await pose();
    return p ? {position: p.position, rotation: p.rotation,
                sweep: p.sweep, mode: p.mode} : null;
}"""

SUBSCRIBE_JS = """() => {
    const s = window.__mp.sdk();
    window.__events = [];
    window.__sub = s.Pointer.intersection.subscribe((d) => {
        window.__events.push({t: Date.now(), position: d.position,
                              normal: d.normal, object: d.object});
    });
}"""

# „Parkoviště“ myši — zajišťuje pohyb před každým ray (na stejné px se event
# nevyvolá). Alternativní roh, když pixel paprsku kolizuje s parkovištěm.
PARK_A = (4, 4)
PARK_B = (1270, 12)


def park_for(px: tuple[int, int]) -> tuple[int, int]:
    """Parkoviště daleko od pixelu paprsku (jiné rohy viewportu)."""
    if abs(px[0] - PARK_A[0]) < 12 and abs(px[1] - PARK_A[1]) < 12:
        return PARK_B
    return PARK_A


async def ray_trusted(page, px: tuple[int, int]) -> dict | None:
    """Jeden paprsek skutečnou myší — spolehlivý protokol (měřeno 8/8).

    Přesun z parkoviště (zajistí pohyb), 0,4 s pauza na dotransport PARK
    raycastu, vyčistit eventy, přesun na pixel, adaptivní čtení poslední
    eventy (0,25 s kroky, do ~1,6 s).
    """
    park = park_for(px)
    try:
        await asyncio.wait_for(page.mouse.move(*park), timeout=10.0)
        await asyncio.sleep(0.4)
        await asyncio.wait_for(page.evaluate("() => {window.__events = []}"), timeout=8.0)
        await asyncio.wait_for(page.mouse.move(*px), timeout=10.0)
    except asyncio.TimeoutError:
        return None
    events: list = []
    for _ in range(6):
        await asyncio.sleep(0.25)
        try:
            events = await asyncio.wait_for(
                page.evaluate("() => window.__events || []"), timeout=8.0
            )
        except asyncio.TimeoutError:
            return None
        if events:
            return events[-1]
    return None


def pixel_center(bbox: list[float]) -> tuple[int, int]:
    """Střed bboxu (norm 0–1) na pixelech snímku (== viewport px, clip shora)."""
    xc = (float(bbox[0]) + float(bbox[2])) / 2.0
    yc = (float(bbox[1]) + float(bbox[3])) / 2.0
    return (round(xc * IMG_W), round(yc * IMG_H))


def anchor_from_event(job, pose, event: dict | None) -> tuple[dict, float]:
    """Z event observable postaví anchor; None/jiný pixel → (fallback, 180°)."""
    sid, yaw, idx, bbox, label_raw = (
        job["sid"], job["yaw"], job["idx"], job["bbox"], job["label_raw"],
    )
    xc = (float(bbox[0]) + float(bbox[2])) / 2.0
    yc = (float(bbox[1]) + float(bbox[3])) / 2.0
    yc_px = yc * IMG_H  # bbox je normalizovaný 0–1 na snímku (výška IMG_H)

    if event is not None:
        try:
            angle, dist = validate_anchor(
                pose["position"], event, float(yaw), xc, yc_px, CAPTURE_TAN_HALF
            )
        except (KeyError, TypeError, ValueError):
            angle, dist = 180.0, 0.0
        if angle <= MAX_ANGLE_DEG and dist > MM_DIST_M:
            # SDK position pro `intersectedobject.unknown` je v mm (místo m) —
            # konverze ÷1000 a znovu validace; při selhání jde do fallbacku.
            event = {
                **event,
                "position": {
                    k: float(v) / MM_SCALE for k, v in event["position"].items()
                },
            }
            try:
                angle, dist = validate_anchor(
                    pose["position"], event, float(yaw), xc, yc_px, CAPTURE_TAN_HALF
                )
            except (KeyError, TypeError, ValueError):
                angle, dist = 180.0, 0.0
        if angle <= MAX_ANGLE_DEG:
            return {
                "anchor": {
                    "x": round(float(event["position"]["x"]), 4),
                    "y": round(float(event["position"]["y"]), 4),
                    "z": round(float(event["position"]["z"]), 4),
                },
                "anchor_dist": round(dist, 3),
                "anchor_angle": round(angle, 2),
                "anchor_obj": event.get("object"),
                "anchor_estimated": False,
            }, angle

    # Fallback: směr z kalibrace, vzdálenost z úhlové šířky bboxu
    label, _cat, _icon = normalize_label(label_raw)
    dist = estimate_distance(label, bbox, CAPTURE_TAN_HALF)
    direction = ray_direction(float(yaw), xc, yc_px, CAPTURE_TAN_HALF)
    anchor = {
        "x": round(float(pose["position"]["x"]) + dist * direction[0], 4),
        "y": round(float(pose["position"]["y"]) + dist * direction[1], 4),
        "z": round(float(pose["position"]["z"]) + dist * direction[2], 4),
    }
    return {
        "anchor": anchor,
        "anchor_dist": round(dist, 3),
        "anchor_estimated": True,
    }, 180.0


async def anchor_object(page, job, pose) -> tuple[dict, float]:
    """Paprsek skrz bbox střed (skutečná myš, 2 pokusy) → (anchor, °)."""
    px = pixel_center(job["bbox"])
    anchor, angle = None, 180.0
    for _attempt in range(2):
        event = await ray_trusted(page, px)
        anchor, angle = anchor_from_event(job, pose, event)
        if not anchor.get("anchor_estimated"):
            return anchor, angle
        await asyncio.sleep(0.5)
    return anchor, angle


async def goto_view(page, sid: str, yaw: int) -> dict | None:
    for _attempt in range(2):
        try:
            pose = await asyncio.wait_for(
                page.evaluate(GOTO_JS, [sid, yaw]), timeout=90.0
            )
            if pose and pose.get("sweep") == sid and str(pose.get("mode")) == "mode.inside":
                return pose
            await asyncio.sleep(3.0)
        except (asyncio.TimeoutError, Exception):
            return None
    return pose if isinstance(pose, dict) else None


async def run(args) -> int:
    store = ObjectStore(Path(args.out))
    data = store.load()
    sweeps = data.get("sweeps", {})

    # job list — resumable: hotové (ne estimated) přeskočit
    jobs: list[dict] = []
    for sid, entry in sweeps.items():
        for yaw_key, view in (entry.get("views") or {}).items():
            try:
                yaw = int(float(yaw_key)) % 360
            except (TypeError, ValueError):
                continue
            for idx, obj in enumerate(view.get("objects") or []):
                bbox = obj.get("bbox") or []
                if len(bbox) != 4:
                    continue
                if obj.get("anchor") is not None and not obj.get("anchor_estimated"):
                    continue
                if args.sweep and sid != args.sweep:
                    continue
                jobs.append(
                    {"sid": sid, "yaw": yaw, "idx": idx, "bbox": bbox,
                     "label_raw": obj.get("label", ""), "view_key": yaw_key}
                )
    if args.limit:
        jobs = jobs[: args.limit]
    total_done = sum(
        1
        for entry in sweeps.values()
        for view in (entry.get("views") or {}).values()
        for obj in (view.get("objects") or [])
        if obj.get("anchor") is not None
    )
    print(f"hotových anchorů: {total_done}, k paprsku: {len(jobs)}")
    if not jobs:
        return 0

    jobs.sort(key=lambda j: (j["sid"], j["yaw"]))
    by_sweep: dict[str, list[dict]] = {}
    for job in jobs:
        by_sweep.setdefault(job["sid"], []).append(job)

    from playwright.async_api import async_playwright

    stats = {"ok": 0, "estimated": 0, "miss": 0}
    fail_streak = 0

    pw = await async_playwright().start()
    try:
        for sid, sweep_jobs in by_sweep.items():
            if fail_streak >= 3:
                break
            for attempt in range(3):
                browser = None
                try:
                    browser = await pw.chromium.launch(
                        headless=True, args=SWIFT_SHADER_ARGS
                    )
                    ctx = await browser.new_context(
                        viewport={"width": IMG_W, "height": VIEWPORT_H},
                        locale="cs-CZ",
                        user_agent=UA,
                        device_scale_factor=1,
                    )
                    page = await ctx.new_page()
                    await page.goto(
                        args.base + "/?capture=1", wait_until="domcontentloaded",
                        timeout=120_000,
                    )
                    deadline = asyncio.get_event_loop().time() + args.sdk_timeout
                    while asyncio.get_event_loop().time() < deadline:
                        state = await page.evaluate(
                            "() => {const d=document.getElementById('sdkDot');"
                            "if(!d) return 'missing';"
                            "return d.classList.contains('ok') ? 'ok' : 'pending'}"
                        )
                        if state == "ok" and await page.evaluate(
                            "() => Boolean(window.__mp && window.__mp.ready())"
                        ):
                            break
                        await asyncio.sleep(0.5)
                    else:
                        raise asyncio.TimeoutError("SDK se nepřipojil")
                    await asyncio.sleep(8.0)  # ať doběhne úvodní animace
                    # skrýt HUD — panel vlevo nahoře překrývá canvas a pohltí
                    # mousemove (pixely pod ním nikdy nevyvolají raycast)
                    await asyncio.wait_for(
                        page.evaluate("() => window.__mp.hideUi()"), timeout=10.0
                    )
                    await asyncio.wait_for(page.evaluate(SUBSCRIBE_JS), timeout=10.0)

                    by_yaw: dict[int, list[dict]] = {}
                    for job in sweep_jobs:
                        by_yaw.setdefault(job["yaw"], []).append(job)
                    for yaw, yaw_jobs in sorted(by_yaw.items()):
                        pose = await goto_view(page, sid, yaw)
                        if (
                            not pose or pose.get("sweep") != sid
                            or str(pose.get("mode")) != "mode.inside"
                        ):
                            fail_streak += 1
                            raise asyncio.TimeoutError(f"goto {sid[:10]} yaw{yaw}")
                        fail_streak = 0
                        ok_now = est_now = 0
                        # --- sekvenční trusted ray per objekt (spolehlivé) ---
                        for job in yaw_jobs:
                            anchor, angle = await anchor_object(page, job, pose)
                            obj = sweeps[sid]["views"][job["view_key"]]["objects"][job["idx"]]
                            obj.update(anchor)
                            if anchor.get("anchor_estimated"):
                                est_now += 1
                                stats["estimated"] += 1
                            else:
                                ok_now += 1
                                stats["ok"] += 1
                                print(
                                    f"  ✓ {sid[:10]} yaw{yaw:>3} idx{job['idx']} "
                                    f"{job['label_raw'][:18]}: dist {anchor['anchor_dist']}",
                                    flush=True,
                                )
                        await asyncio.sleep(0.2)
                    await browser.close()
                    store.save(data)
                    print(
                        f"{sid[:10]}: paprsků {ok_now} ok, {est_now} fallback "
                        f"(celkem ok {stats['ok']}, fallback {stats['estimated']})",
                        flush=True,
                    )
                    break
                except Exception as exc:  # noqa: BLE001
                    fail_streak += 1
                    print(
                        f"  ! {sid[:10]}: pokus {attempt + 1}: {str(exc)[:120]}",
                        flush=True,
                    )
                    if browser is not None:
                        try:
                            await browser.close()
                        except Exception:  # noqa: BLE001
                            pass
                    await asyncio.sleep(3)
            else:
                continue
    finally:
        await pw.stop()

    store.save(data)
    print(
        f"anchor pass hotov: ok {stats['ok']}, fallback {stats['estimated']}, "
        f"miss {stats['miss']}",
        flush=True,
    )
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://localhost:8017")
    ap.add_argument("--out", default=str(OBJECTS_FILE))
    ap.add_argument("--limit", type=int, default=0, help="pilot: jen N objektů")
    ap.add_argument("--sweep", default="", help="jen objekty daného skenu (pilot)")
    ap.add_argument(
        "--sdk-timeout", type=float, default=300.0,
        help="čekání na připojení SDK (s)",
    )
    args = ap.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
