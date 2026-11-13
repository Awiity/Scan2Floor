#!/usr/bin/env python3
"""Rozpozná objekty na snímcích skenů pomocí AI modelu (DCUK gateway).

Pro každý snímek z `capture/<sweep>/yawNNN.jpg` pošle jeden požadavek na
OpenAI-kompatibilní endpoint a uloží nalezené objekty (štítek + bbox +
jistota) do `objects.json`. Běží souběžně (default 3 požadavky), je
znovu spustitelný — hotové pohledy přeskočí.

Použití:
    /usr/bin/python3 tools/detect_objects.py                 # vše, 3 souběžně
    /usr/bin/python3 tools/detect_objects.py --concurrency 4
    /usr/bin/python3 tools/detect_objects.py --limit 5 --fresh
    /usr/bin/python3 tools/detect_objects.py --only <sweepId>
    /usr/bin/python3 tools/detect_objects.py --dry-run       # jen spočítá práci
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from app import config  # noqa: E402
from app.objects import ObjectStore, now_iso, normalize_label  # noqa: E402

PROMPT_VERSION = "v1"

VOCAB = [
    "dveře",
    "okno",
    "východ (únikový, nouzový)",
    "hasicí přístroj",
    "hydrant",
    "hlásič / detektor kouře",
    "serverový rack",
    "rozvaděč / elektrická skříň",
    "klimatizace",
    "potrubí / vzduchotechnika",
    "kabelový žlab",
    "světlo / zářivka",
    "cedule / označení",
    "schodiště",
    "výtah",
    "kamera",
    "vypínač",
    "zásuvka",
    "stůl",
    "židle",
    "skříň",
    "umyvadlo",
    "WC",
    "kuchyňka",
    "rostlina",
]

PROMPT = f"""Jsi přesný detektor objektů v interiéru (fotografie z 3D skenu).
Najdi objekty z této množiny: {", ".join(VOCAB)}.

Pravidla:
- Jeden objekt = jeden box. Dva samostatné objekty (např. dvoje dveře) = dva boxy.
- Bbox je [x0, y0, x1, y1] NORMALIZOVANÝ na 0–1 vůči celému obrázku
  (0,0 = levý horní roh; 1,1 = pravý dolní roh). Nikdy nepoužívej pixely.
- Ignoruj vodoznak "Matterport", logo a ikony v rozích obrazu.
- Když si nejsi jistý, objekt vynech. Max 12 objektů.
- Odpověz POUZE JSON, bez vysvětlování a bez markdown bloků.

Formát:
{{"objects":[{{"label":"dveře","bbox":[0.10,0.20,0.35,0.90],"conf":0.9}}]}}"""


def load_manifest(capture_dir: Path) -> dict[str, Any]:
    path = capture_dir / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"sweeps": {}}


def build_jobs(
    manifest: dict[str, Any],
    capture_dir: Path,
    store: ObjectStore,
    views_filter: set[int] | None,
    only: set[str],
    limit: int,
    fresh: bool,
) -> list[tuple[str, int, Path]]:
    done = store.load().get("sweeps", {})
    jobs: list[tuple[str, int, Path]] = []
    sweeps = list(manifest.get("sweeps", {}).items())
    if only:
        sweeps = [(sid, e) for sid, e in sweeps if sid in only]
    if limit:
        sweeps = sweeps[:limit]

    for sid, entry in sweeps:
        for yaw_key, view in (entry.get("views") or {}).items():
            try:
                yaw = int(float(yaw_key))
            except ValueError:
                continue
            if views_filter and yaw not in views_filter:
                continue
            image = view.get("file")
            if not image:
                continue
            path = capture_dir / image
            if not path.exists():
                continue
            if not fresh and (done.get(sid, {}).get("views", {}).get(str(yaw))):
                continue
            jobs.append((sid, yaw, path))
    return jobs


def encode_image(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def call_model(
    base_url: str,
    api_key: str,
    model: str,
    image_b64: str,
    timeout: float,
    max_tokens: int,
) -> tuple[str, dict[str, Any]]:
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                ],
            }
        ],
    }
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    content = data["choices"][0]["message"].get("content") or ""
    return content, data.get("usage") or {}


def parse_objects(text: str, width: int, height: int) -> list[dict[str, Any]]:
    """Vytáhne ze odpovědi seznam objektů a sjednotí formát."""
    if not text:
        return []
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    match = re.search(r"\{.*\}", cleaned, re.S) or re.search(r"\[.*\]", cleaned, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []

    objects = data.get("objects") if isinstance(data, dict) else data
    if not isinstance(objects, list):
        return []

    result: list[dict[str, Any]] = []
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        bbox = obj.get("bbox") or obj.get("box") or []
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        try:
            x0, y0, x1, y1 = (float(v) for v in bbox)
        except (TypeError, ValueError):
            continue

        # někteří modeli vrací pixely — pozná se to podle hodnot > 1,5
        if max(x0, y0, x1, y1) > 1.5:
            x0, x1 = x0 / width, x1 / width
            y0, y1 = y0 / height, y1 / height

        x0, x1 = sorted((min(max(x0, 0.0), 1.0), min(max(x1, 0.0), 1.0)))
        y0, y1 = sorted((min(max(y0, 0.0), 1.0), min(max(y1, 0.0), 1.0)))
        if x1 - x0 < 0.01 or y1 - y0 < 0.01:
            continue

        label = str(obj.get("label") or obj.get("name") or "").strip()
        if not label:
            continue
        try:
            conf = float(obj.get("conf", obj.get("confidence", 0.5)))
        except (TypeError, ValueError):
            conf = 0.5
        conf = min(max(conf, 0.0), 1.0)

        result.append(
            {
                "label": label,
                "label_norm": normalize_label(label)[0],
                "bbox": [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)],
                "conf": round(conf, 2),
            }
        )

    # stejný štítek víckrát na téměř stejném místě = duplikát
    unique: list[dict[str, Any]] = []
    for obj in result:
        dup = False
        for kept in unique:
            if kept["label_norm"] != obj["label_norm"]:
                continue
            ax = sum(kept["bbox"][0::2]) / 2
            bx = sum(obj["bbox"][0::2]) / 2
            ay = sum(kept["bbox"][1::2]) / 2
            by = sum(obj["bbox"][1::2]) / 2
            if abs(ax - bx) < 0.05 and abs(ay - by) < 0.05:
                dup = True
                break
        if not dup:
            unique.append(obj)
    return unique


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--capture", default=str(config.CAPTURE_DIR), help="adresář se snímky"
    )
    ap.add_argument("--out", default=str(config.OBJECTS_FILE), help="výstupní JSON")
    ap.add_argument("--model", default=config.AI_MODEL)
    ap.add_argument("--base-url", default=config.AI_BASE_URL)
    ap.add_argument("--api-key", default=config.AI_API_KEY)
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--max-tokens", type=int, default=800)
    ap.add_argument("--retries", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0, help="jen prvních N skenů")
    ap.add_argument("--only", nargs="+", default=[], help="konkrétní ID skenů")
    ap.add_argument("--views", type=int, nargs="+", default=[], help="jen tyto směry")
    ap.add_argument("--fresh", action="store_true", help="přepočítat i hotové")
    ap.add_argument("--keep-raw", action="store_true", help="ukládat i surovou odpověď")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not args.base_url or not args.api_key:
        print("CHYBA: chybí DCUK_BASEURL / DCUK_API_KEY v .env", file=sys.stderr)
        return 2

    capture_dir = Path(args.capture).resolve()
    manifest = load_manifest(capture_dir)
    if not manifest.get("sweeps"):
        print(f"CHYBA: v {capture_dir} není manifest se snímky", file=sys.stderr)
        return 2
    img_w, img_h = (manifest.get("size") or [1280, 720])[:2]

    store = ObjectStore(Path(args.out))
    jobs = build_jobs(
        manifest,
        capture_dir,
        store,
        set(args.views) or None,
        set(args.only),
        args.limit,
        args.fresh,
    )
    total_sweeps = len({sid for sid, _, _ in jobs})
    print(
        f"[detect] model={args.model}  snímků k analýze: {len(jobs)} "
        f"({total_sweeps} skenů)  souběžně: {args.concurrency}",
        flush=True,
    )
    if args.dry_run or not jobs:
        if not jobs:
            print("[detect] nic k práci — vše už je hotové", flush=True)
        return 0

    data = store.load()
    data["model"] = args.model
    data["prompt_version"] = PROMPT_VERSION
    data["capture_dir"] = str(capture_dir)
    lock = threading.Lock()
    stats = {"ok": 0, "objects": 0, "empty": 0, "errors": 0, "tokens": 0}
    errors: list[str] = []
    started = time.monotonic()

    def work(sid: str, yaw: int, path: Path) -> None:
        last_error: Exception | None = None
        for attempt in range(args.retries + 1):
            try:
                content, usage = call_model(
                    args.base_url,
                    args.api_key,
                    args.model,
                    encode_image(path),
                    args.timeout,
                    args.max_tokens,
                )
                objects = parse_objects(content, img_w, img_h)
                with lock:
                    entry = data["sweeps"].setdefault(sid, {})
                    if not entry.get("position"):
                        src = manifest["sweeps"].get(sid, {})
                        entry["position"] = src.get("position")
                        entry["neighbors"] = src.get("neighbors")
                    views = entry.setdefault("views", {})
                    views[str(yaw)] = {
                        "file": f"{sid}/{path.name}",
                        "objects": objects,
                        "raw": content[:4000] if args.keep_raw else None,
                        "tokens": usage.get("total_tokens"),
                        "at": now_iso(),
                    }
                    stats["ok"] += 1
                    stats["objects"] += len(objects)
                    stats["tokens"] += int(usage.get("total_tokens") or 0)
                    if not objects:
                        stats["empty"] += 1
                return
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, KeyError,
                    json.JSONDecodeError, TimeoutError) as exc:
                last_error = exc
                if attempt < args.retries:
                    time.sleep(1.5 * (attempt + 1))
        with lock:
            stats["errors"] += 1
            if len(errors) < 12:
                errors.append(f"{sid} yaw{yaw}: {type(last_error).__name__}: {last_error}")

    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {pool.submit(work, *job): job for job in jobs}
            done = 0
            for future in as_completed(futures):
                future.result()
                done += 1
                if done % 10 == 0 or done == len(jobs):
                    elapsed = time.monotonic() - started
                    rate = done / elapsed if elapsed else 0
                    eta = (len(jobs) - done) / rate if rate else 0
                    with lock:
                        snapshot = dict(stats)
                        data["updated"] = now_iso()
                        store.save(data)
                    print(
                        f"[{done:4d}/{len(jobs)}] ok={snapshot['ok']} "
                        f"prázdné={snapshot['empty']} chyby={snapshot['errors']} "
                        f"objektů={snapshot['objects']}  {elapsed:5.0f}s "
                        f"ETA {eta / 60:4.1f} min",
                        flush=True,
                    )
    finally:
        with lock:
            data["updated"] = now_iso()
            data["prompt_version"] = PROMPT_VERSION
            data["stats"] = dict(stats)
            store.save(data)

    print(
        f"[detect] hotovo za {(time.monotonic() - started) / 60:.1f} min — "
        f"{stats['ok']} pohledů, {stats['objects']} objektů, "
        f"{stats['empty']} prázdných, {stats['errors']} chyb, "
        f"{stats['tokens']} tokenů → {args.out}",
        flush=True,
    )
    for err in errors:
        print("   !", err, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
