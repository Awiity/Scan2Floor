"""Konfigurace aplikace Matterport In3D.

Všechny hodnoty lze přepsat proměnnými prostředí (MP_MODEL_ID, MP_APPLICATION_KEY, ...).
Klíč se navíc načítá ze souboru `.env` v kořeni projektu (viz `_load_dotenv`).
"""
from __future__ import annotations

import math
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# .env — jednoduchý parser (bez závislosti na python-dotenv)
#
# Formát: KEY=value, komentáře začínající '#', volitelné uvozovky kolem hodnoty.
# Proměnné prostředí mají přednost před .env.
# ---------------------------------------------------------------------------
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _load_dotenv(path: Path = _ENV_PATH) -> None:
    """Načte `path` do os.environ (existující proměnné nepřepisuje)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

# ---------------------------------------------------------------------------
# Matterport
# ---------------------------------------------------------------------------
# Alternativní názvy klíče v .env (uživatelsky přívětivější než MP_APPLICATION_KEY)
_ENV_KEY_ALIASES = ("matterport_api_key", "MATTERPORT_API_KEY", "MP_APPLICATION_KEY")

# ID modelu (z URL my.matterport.com/show/?m=<MODEL_ID>)
MODEL_ID: str = os.environ.get("MP_MODEL_ID", "yQPhyaCwigp")

# SDK application key — generuje se v Matterport Cloud:
#   Settings (vlevo dole) -> Developer Tools -> SDK Keys -> "Generate key"
# Klíč je svázaný s doménou, ze které běží tato stránka (např. localhost).
# Bez klíče SDK připojení selže — appka pak zobrazí jasné varování.
# Hledá se v .env jako `matterport_api_key` (nebo v prostředí jako MP_APPLICATION_KEY).
APPLICATION_KEY: str = next(
    (os.environ[name].strip() for name in _ENV_KEY_ALIASES if os.environ.get(name, "").strip()),
    "",
)

# ---------------------------------------------------------------------------
# Kalibrace souřadnic: bodový mrak -> souřadnice Matterport modelu
#
# 1) AXIS_MAP: přemapování os. Klíč = osa v modelu, hodnota = osa v mraku.
#    Standardní nastavení {"x": "x", "y": "y", "z": "z"} znamená 1:1.
#    Pokud je mrak v Z-up souřadnicích a model v Y-up, je potřeba osy prohodit.
# 2) COORD_OFFSET: posun v souřadnicích MODELŮ (přičítá se po remapování os).
#
# Kalibraci provedete tlačítkem "Změřit pozici" v UI: porovnejte pozici kamery
# v modelu se souřadnicí téhož místa v mraku a nastavte AXIS_MAP/COORD_OFFSET.
# ---------------------------------------------------------------------------
AXIS_MAP: dict[str, str] = {
    "x": os.environ.get("MP_AXIS_X", "x"),
    "y": os.environ.get("MP_AXIS_Y", "y"),
    "z": os.environ.get("MP_AXIS_Z", "z"),
}
COORD_OFFSET: dict[str, float] = {
    "x": float(os.environ.get("MP_OFFSET_X", "0.0")),
    "y": float(os.environ.get("MP_OFFSET_Y", "0.0")),
    "z": float(os.environ.get("MP_OFFSET_Z", "0.0")),
}

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
HOST: str = os.environ.get("MP_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("MP_PORT", "8000"))
STATIC_DIR: str = os.environ.get("MP_STATIC_DIR", "static")

_PROJECT = Path(__file__).resolve().parent.parent


def resolve_paths(model_id: str | None = None) -> dict[str, Path]:
    """Cesty per prostor — data/<model_id>/ (env MP_* proměnné mají přednost).

    Vrací data_dir, objects_file, points_file, capture_dir. model_id: live
    z env MP_MODEL_ID (ať testy i Docker přepínají prostor), fallback
    konstanta MODEL_ID.
    """
    mid = model_id or os.environ.get("MP_MODEL_ID", "") or MODEL_ID
    data_root = Path(os.environ.get("MP_DATA_DIR", str(_PROJECT / "data"))) / mid
    return {
        "data_dir": data_root,
        "objects_file": Path(
            os.environ.get("MP_OBJECTS_FILE", str(data_root / "objects.json"))
        ),
        "points_file": Path(
            os.environ.get("MP_POINTS_FILE", str(data_root / "points.json"))
        ),
        "capture_dir": Path(
            os.environ.get("MP_CAPTURE_DIR", str(data_root / "capture"))
        ),
    }


_resolved = resolve_paths()


def remote_hint_env() -> str | None:
    """Instrukce pro remote režim (env MP_REMOTE_HINT) — UI tlačítko „3D náhled"."""
    return os.environ.get("MP_REMOTE_HINT") or None

DATA_DIR: Path = _resolved["data_dir"]

# Uložené pozice kamery (pojmenované body pro procházení)
POINTS_FILE: Path = _resolved["points_file"]

# ---------------------------------------------------------------------------
# Rozpoznávání objektů (snímky skenů + AI detekce)
# ---------------------------------------------------------------------------

# Adresář se snímky skenů (vytváří tools/capture_sweeps.py)
CAPTURE_DIR: Path = _resolved["capture_dir"]

# Výsledky detekce (vytváří tools/detect_objects.py)
OBJECTS_FILE: Path = _resolved["objects_file"]

# Horizontální zorné pole snímku ve stupních — měřeno na modelu přes
# Pointer.intersection (paprsky na yaw 0/36/90/180/270/324): fit tan(HFOV/2)
# ≈ 1.2024 ⇒ HFOV ≈ 100,5°. Používá se pro přepočet polohy objektu v obrázku
# na směr pohledu (ATAN model, ne lineární — viz app/objects.py::bearing_for).
CAPTURE_HFOV: float = float(os.environ.get("MP_CAPTURE_HFOV", "100.5"))

# tan(HFOV/2) — konstanta ATAN mapování pixel offsetu na úhel (paprsek skrz
# polohu bboxu). Výpočtem z HFOV, env se přepíše přes MP_CAPTURE_HFOV.
CAPTURE_TAN_HALF: float = math.tan(math.radians(CAPTURE_HFOV / 2.0))

# ---------------------------------------------------------------------------
# Slučování instancí (Fáze 2) — poloměr clusteringu per kategorie, cap průměru
#
# Laditelné tady; defaultní poloměr i přes env MP_MERGE_RADIUS. Racky 0,4
# (vedle sebe ~1 m = 2 objekty), hasicí/hlásič 0,6 (tatáž věc ze 2–3 skenů
# ~0,5 m od sebe), stropní světla 0,8 (široké rozestupy), ostatní default 0,8.
# ---------------------------------------------------------------------------
MERGE_RADIUS_DEFAULT: float = float(os.environ.get("MP_MERGE_RADIUS", "0.8"))

MERGE_RADIOS: dict[str, float] = {
    "serverový rack": 0.4,
    "rozvaděč": 0.4,
    "hasicí přístroj": 0.6,
    "hlásič": 0.6,
    "kamera": 0.6,
    "vypínač": 0.6,
    "zásuvka": 0.6,
    "světlo / zářivka": 0.8,
    "potrubí / vzduchotechnika": 0.8,
}

# Cap průměru clusteru (násobek poloměru) — brání řetězení přes chodbu
MERGE_CAP_FACTOR: float = 2.0

# Znaménko: roste yaw doprava (+1), nebo doleva (-1)? Kalibruje se porovnáním
# dvou po sobě jdoucích pohledů; viz README.
CAPTURE_YAW_SIGN: float = float(os.environ.get("MP_CAPTURE_YAW_SIGN", "-1"))

# AI detektor (OpenAI-kompatibilní gateway DCUK)
AI_BASE_URL: str = os.environ.get("DCUK_BASEURL", "")
AI_API_KEY: str = os.environ.get("DCUK_API_KEY", "")
AI_MODEL: str = os.environ.get("MP_AI_MODEL", "DCUK-AI4-Glm53-Flash")


def cloud_to_model(pos: dict[str, float]) -> dict[str, float]:
    """Přepočte souřadnice z bodového mraku na souřadnice Matterport modelu.

    Aplikuje remapování os (AXIS_MAP) a posun (COORD_OFFSET).
    """
    mapped = {axis: float(pos[src]) for axis, src in AXIS_MAP.items()}
    return {
        axis: mapped[axis] + COORD_OFFSET[axis]
        for axis in ("x", "y", "z")
    }
