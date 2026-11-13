#!/usr/bin/env python3
"""Testovací skript — pošle pozici na POST /move, jako by ji posílal cizí systém.

Příklady:
  python send_test_position.py 1.0 2.0 3.0                       # skok na bod, dívá se dál (0,0,0)
  python send_test_position.py 1.0 2.0 3.0 --yaw 90             # skok + otočit na východ (dle SDK)
  python send_test_position.py 1.0 2.0 3.0 --lookat 4 2 1       # skok a dívat se na bod
  python send_test_position.py 1.0 2.0 3.0 --instant            # okamžitý přechod
  python send_test_position.py --url http://server:8000/move ... # vzdálený server
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description="Pošle testovací pozici na /move")
    parser.add_argument("xyz", nargs=3, type=float, metavar=("X", "Y", "Z"),
                        help="souřadnice pozice v bodovém mraku")
    parser.add_argument("--yaw", type=float, default=None,
                        help="otáčka kamery ve stupních (konvence SDK)")
    parser.add_argument("--pitch", type=float, default=0.0,
                        help="naklonění kamery ve stupních (-90..90)")
    parser.add_argument("--lookat", nargs=3, type=float, metavar=("X", "Y", "Z"),
                        help="místo, na které se má kamera dívat")
    parser.add_argument("--instant", action="store_true", help="okamžitý přechod bez animace")
    parser.add_argument("--url", default="http://127.0.0.1:8000/move",
                        help="URL endpointu (default http://127.0.0.1:8000/move)")
    args = parser.parse_args()

    if args.lookat is not None and args.yaw is not None:
        print("Chyba: --lookat a --yaw se vylučují.", file=sys.stderr)
        return 2

    if args.lookat is not None:
        view = {"mode": "lookAt", "x": args.lookat[0], "y": args.lookat[1], "z": args.lookat[2]}
    elif args.yaw is not None:
        view = {"mode": "angles", "yaw": args.yaw, "pitch": args.pitch}
    else:
        view = {"mode": "angles", "yaw": 0.0, "pitch": 0.0}

    msg = {
        "position": {"x": args.xyz[0], "y": args.xyz[1], "z": args.xyz[2]},
        "view": view,
        "mode": "instant" if args.instant else "smooth",
    }

    req = urllib.request.Request(
        args.url,
        data=json.dumps(msg).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            print(f"HTTP {res.status}: {res.read().decode('utf-8')}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8')}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Server nedostupný: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
