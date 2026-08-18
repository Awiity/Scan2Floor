# Dokumentace API – Scan2Floor (v0.3.0)

**Scan2Floor** je full-stack rozhraní určené pro automatizovanou konverzi 3D bodových mračen (ve formátu Matterport `.xyz`) na 2D vektorové architektonické půdorysy ve formátech **DXF** a **SVG**.

Tato dokumentace popisuje RESTful a streaming API poskytované backendovým rozhraním **FastAPI**.

---

## Obsah
1. [Základní Informace a Konfigurace](#1-základní-informace-a-konfigurace)
2. [Přehled Datových Modelů (Pydantic)](#2-přehled-datových-modelů-pydantic)
3. [Koncové Body (Endpoints)](#3-koncové-body-endpoints)
   - [3.1 Správa Cest a Prohlížeč Souborů](#31-správa-cest-a-prohlížeč-souborů)
   - [3.2 Stav Systému a Data Mračna Bodů](#32-stav-systému-a-data-mračna-bodů)
   - [3.3 Reprocesing Mračna Bodů](#33-reprocesing-mračna-bodů)
   - [3.4 Extrakce Hustých Řezů Stěn](#34-extrakce-hustých-řezů-stěn)
   - [3.5 Sjednocená Pipeline (Unified Pipeline)](#35-sjednocená-pipeline-unified-pipeline)
   - [3.6 Detekce a Editace Stěn](#36-detekce-a-editace-stěn)
   - [3.7 Detekce Otvorů (Dveře a Okna)](#37-detekce-otvorů-dveře-a-okna)
   - [3.8 Detekce Místností (Rooms)](#38-detekce-místností-rooms)
   - [3.9 Integrace Cloud2BIM](#39-integrace-cloud2bim)
   - [3.10 Barevné Půdorysy a Statické Soubory](#310-barevné-půdorysy-a-statické-soubory)
4. [Kódy Odpovědí a Chybové Stavy](#4-kódy-odpovědí-a-chybové-stavy)
5. [Příklady Použití (cURL / Python)](#5-příklady-použití-curl--python)

---

## 1. Základní Informace a Konfigurace

- **Verze API:** `0.3.0`
- **Framework:** FastAPI (Python)
- **Základní URL:** `http://localhost:8000` (případně dle konfigurovaného portu Dockeru)
- **Formát dat:** `application/json`, `application/octet-stream` (pro mračno bodů), `application/dxf`, `image/svg+xml`
- **CORS:** Povoleno pro všechny původy (`*`), metody i hlavičky.
- **Proměnné prostředí backendu:**
  - `PROCESSED_DIR`: Adresář pro uložení zpracovaných meziproduktů (výchozí: `./processed`).
  - `DATA_DIR`: Adresář s daty Matterpak (výchozí: `../../data/matterpak`).
  - `C2B_DIR`: Adresář pro výstupy Cloud2BIM (výchozí: `./processed/c2b_output`).
  - `SCAN_ROOTS`: Čárkou oddělený seznam adresářů s `.xyz` soubory pro prohlížeč skenů (výchozí: `/data`).

---

## 2. Přehled Datových Modelů (Pydantic)

### `XYZPathPayload`
```json
{
  "xyz_path": "string (absolutní cesta k .xyz souboru)"
}
```

### `WallsEditPayload`
```json
{
  "lines": [
    [[x1, z1], [x2, z2]],
    [[x1, z1], [x2, z2]]
  ]
}
```

### `OpeningParams`
```json
{
  "floor_idx": 0,
  "wall_thickness": 0.25,
  "min_door_width": 0.70,
  "min_window_width": 0.50,
  "door_height_threshold": 1.85
}
```

### `RoomDetectionParams`
```json
{
  "floor_idx": 0,
  "wall_thickness_m": 0.20,
  "extend_m": 0.45,
  "min_seg_m": 0.40,
  "min_room_m2": 0.80,
  "max_room_m2": 800.0,
  "min_room_width_m": 0.60,
  "save_debug": true
}
```

### `C2BWallParams`
```json
{
  "floor_idx": 0,
  "grid_size": 0.02,
  "snap_to_axis": true,
  "min_wall_m": 0.40,
  "max_wall_thickness": 0.75,
  "dp_tolerance": 0.04,
  "threshold_frac": 0.01,
  "wall_reach_frac": 0.70,
  "save_debug": true,
  "detect_openings": true,
  "detect_rooms": true,
  "wall_thickness": 0.25
}
```

### `PipelineRunPayload`
```json
{
  "xyz_path": "string",
  "run_c2b": true,
  "run_slices": true,
  "detect_floors": [0, 1],
  "enable_cleaning": true,
  "clean_downsample_pct": 20.0,
  "clean_span_min": 0.65,
  "clean_span_max": 1.00,
  "grid_size": 0.02,
  "snap_to_axis": true,
  "min_wall_m": 0.40,
  "max_wall_thickness": 0.75,
  "dp_tolerance": 0.04,
  "threshold_frac": 0.01,
  "wall_reach_frac": 0.35
}
```

---

## 3. Koncové Body (Endpoints)

### 3.1 Správa Cest a Prohlížeč Souborů

#### `GET /api/xyz-path`
Vrátí aktuálně nastavenou cestu k `.xyz` souboru s bodovým mračnem a informaci o jeho existenci.

- **Odpověď (200 OK):**
  ```json
  {
    "xyz_path": "/data/matterpak/cloud.xyz",
    "exists": true
  }
  ```

#### `POST /api/xyz-path`
Uloží novou cestu k `.xyz` souboru vybranou uživatelem.

- **Payload:** `XYZPathPayload`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "ok",
    "xyz_path": "/data/matterpak/cloud.xyz",
    "exists": true
  }
  ```
- **Chyba (400 Bad Request):** Pokud cesta nekončí příponou `.xyz`.

#### `GET /api/scan/browse`
Prohledá zadané kořenové adresáře (`SCAN_ROOTS`) a vrátí seznam všech dostupných `.xyz` souborů seskupených podle složek.

- **Odpověď (200 OK):**
  ```json
  {
    "roots": ["/data"],
    "groups": [
      {
        "dir": "/data/matterpak",
        "files": [
          {
            "name": "cloud.xyz",
            "path": "/data/matterpak/cloud.xyz",
            "size_mb": 1420.5
          }
        ]
      }
    ],
    "total": 1
  }
  ```

---

### 3.2 Stav Systému a Data Mračna Bodů

#### `GET /api/status`
Zjistí celkový stav připravenosti dat mračna bodů.

- **Odpověď (200 OK - Příklad v případě připravenosti):**
  ```json
  {
    "status": "ready",
    "info": {
      "num_points": 1250000,
      "bounds": { "min": [-10.2, -0.5, -8.1], "max": [12.4, 6.2, 9.3] },
      "floor_levels": [
        { "floor_y": 0.12, "ceiling_y": 2.85, "height": 2.73 }
      ],
      "wall_slices_ready": true,
      "preprocess_walls_running": false
    }
  }
  ```
- **Odpověď (200 OK - Pokud probíhá zpracování nebo jsou data nepřipravená):**
  ```json
  {
    "status": "processing",
    "info": null
  }
  ```

#### `GET /api/pointcloud`
Stáhne zjednodušený binární soubor mračna bodů (`pointcloud.bin`) určený pro Three.js prohlížeč ve frontendu.

- **Formát odpovědi:** `application/octet-stream` (Struktura: `uint32` počet bodů + pole `float32` XYZ + `uint8` RGB).
- **Chyba (404 Not Found):** Pokud soubor ještě nebol vygenerován.

#### `GET /api/info`
Vrátí kompletní metadata ze souboru `info.json`.

- **Odpověď (200 OK):** JSON objekt s rozměry, centroidem a polem `floor_levels`.
- **Chyba (404 Not Found):** Pokud `info.json` neexistuje.

---

### 3.3 Reprocesing Mračna Bodů

#### `POST /api/reprocess`
Vymaže zastaralé meziprodukty (`pointcloud.bin`, `info.json`, obrázky, DXF) a spustí skript `preprocess_xyz.py` na pozadí.

- **Odpověď (200 OK):**
  ```json
  {
    "status": "started",
    "xyz_path": "/data/matterpak/cloud.xyz",
    "message": "Full reprocess pipeline started. Poll /api/reprocess/status for progress."
  }
  ```

#### `GET /api/reprocess/status`
Vrací aktuální stav běhu úlohy reprocesingu na pozadí.

- **Odpověď (200 OK):**
  ```json
  {
    "running": false,
    "done": true,
    "error": null,
    "started_at": 1723980000.0,
    "finished_at": 1723980045.2,
    "log": ["Clearing stale outputs...", "✓ Finished successfully."],
    "elapsed_s": 45.2
  }
  ```

---

### 3.4 Extrakce Hustých Řezů Stěn

#### `POST /api/preprocess-walls`
Spustí na pozadí proces generování hustých 2D řezů stěn (`wall_slice_floor_<N>.npy`) pro každé zjištěné podlaží. Náročný proces (cca 3–8 minut).

- **Odpověď (200 OK):**
  ```json
  {
    "status": "started",
    "xyz_path": "/data/matterpak/cloud.xyz",
    "message": "Wall-slice preprocessing started in the background. Poll /api/preprocess-walls/status for progress."
  }
  ```

#### `GET /api/preprocess-walls/status`
Sleduje průběh extrakce řezů stěn na pozadí a uvádí seznam vytvořených `.npy` souborů.

- **Odpověď (200 OK):**
  ```json
  {
    "running": false,
    "done": true,
    "error": null,
    "slices_present": [
      "wall_slice_floor_0.npy  (45.2 MB)",
      "wall_slice_floor_1.npy  (38.6 MB)"
    ],
    "elapsed_s": 210.5
  }
  ```

---

### 3.5 Sjednocená Pipeline (Unified Pipeline)

#### `POST /api/pipeline/run`
Spustí na pozadí kompletní sjednocený 6-fázový proces:
1. **Clean Point Cloud** (`cloud_cleaned.xyz`)
2. **Preprocess XYZ** (`pointcloud.bin` + `info.json`)
3. **Cloud2BIM C2B** (`horiz_surface_N.xyz`)
4. **Import C2B Floors** (Aktualizace podlaží v `info.json`)
5. **Extract Slices** (`wall_slice_floor_N.npy`)
6. **Detect Walls & Rooms** (`walls`, `openings`, `rooms`, `floor_N.dxf`)

- **Payload:** `PipelineRunPayload`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "started",
    "xyz_path": "/data/matterpak/cloud.xyz",
    "message": "Pipeline started. Poll /api/pipeline/status."
  }
  ```

#### `GET /api/pipeline/status`
Sleduje stav a detailní logy sjednocené pipeline.

- **Odpověď (200 OK):**
  ```json
  {
    "running": true,
    "stage": 3,
    "stage_name": "Cloud2BIM C2B",
    "progress_pct": 50,
    "log": ["Stage 3/6: Running Cloud2BIM surface extraction..."],
    "error": null
  }
  ```

#### `POST /api/pipeline/cancel`
Vyšle požadavek na bezpečné přerušení a zrušení běžící pipeline.

- **Odpověď (200 OK):**
  ```json
  {
    "status": "cancelling",
    "message": "Cancel signal sent. Poll /api/pipeline/status until running is false."
  }
  ```

---

### 3.6 Detekce a Editace Stěn

#### `GET /api/walls/{floor_idx}`
Vrátí uložené úsečky stěn pro zadané podlaží `{floor_idx}`.

- **Odpověď (200 OK):**
  ```json
  {
    "floor_idx": 0,
    "lines": [
      [[-2.5, 1.2], [4.1, 1.2]],
      [[4.1, 1.2], [4.1, -3.5]]
    ],
    "source": "c2b-wall-detector"
  }
  ```
- **Pokud nezpracováno:** `{"status": "not_processed", "lines": []}`.

#### `PUT /api/walls/{floor_idx}`
Uloží uživatelem upravené úsečky stěn z 2D plátna (Canvas Editor), automaticky přepočítá detekci místností a přepíše soubory **DXF** i **SVG**.

- **Payload:** `WallsEditPayload`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "saved",
    "n_walls": 14,
    "n_rooms": 5
  }
  ```

#### `POST /api/walls/{floor_idx}/export`
Spustí export DXF souboru pro dané podlaží.

- **Odpověď (200 OK):**
  ```json
  {
    "status": "success",
    "dxf": "/api/walls/0/download"
  }
  ```

#### `GET /api/walls/{floor_idx}/download`
Stáhne vygenerovaný výkres ve formátu CAD DXF.

- **Odpověď:** Soubor `floor_<floor_idx>.dxf` s MIME typem `application/dxf`.

#### `GET /api/walls/{floor_idx}/svg`
Vrátí náhled výkresu ve formátu SVG.

- **Odpověď:** Soubor `floor_<floor_idx>.svg` s MIME typem `image/svg+xml`.

---

### 3.7 Detekce Otvorů (Dveře a Okna)

#### `POST /api/openings`
Spustí samostatnou detekci dveří a oken nad již vygenerovanými stěnami.

- **Payload:** `OpeningParams`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "success",
    "n_doors": 4,
    "n_windows": 6
  }
  ```

#### `GET /api/openings/{floor_idx}`
Vrátí seznam detekovaných dveří a oken pro zadané podlaží.

- **Odpověď (200 OK):**
  ```json
  {
    "floor_idx": 0,
    "openings": [
      {
        "type": "door",
        "wall_idx": 2,
        "p1": [-1.2, 1.2],
        "p2": [-0.4, 1.2],
        "width": 0.80
      }
    ]
  }
  ```

---

### 3.8 Detekce Místností (Rooms)

#### `POST /api/rooms`
Spustí detekci uzavřených ploch místností a výpočet jejich podlahové výměry v m².

- **Payload:** `RoomDetectionParams`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "success",
    "n_rooms": 3,
    "rooms": [
      {
        "id": 1,
        "area_m2": 18.5,
        "bbox": [-2.5, -1.0, 3.0, 4.0],
        "centroid": [0.25, 1.5]
      }
    ]
  }
  ```

#### `GET /api/rooms/{floor_idx}`
Vrátí načtený seznam místností ze souboru `rooms_floor_<floor_idx>.json`.

- **Odpověď (200 OK):**
  ```json
  {
    "floor_idx": 0,
    "rooms": [...]
  }
  ```

---

### 3.9 Integrace Cloud2BIM

#### `GET /api/c2b/status`
Zjistí stav předpočítaných horizontálních ploch z algoritmu Cloud2BIM (`horiz_surface_*.xyz`).

- **Odpověď (200 OK):**
  ```json
  {
    "c2b_output_dir": "/app/processed/c2b_output",
    "dir_exists": true,
    "n_surfaces": 2,
    "files": [
      { "name": "horiz_surface_000.xyz", "size_mb": 12.4 },
      { "name": "horiz_surface_001.xyz", "size_mb": 11.8 }
    ]
  }
  ```

#### `POST /api/c2b/floors`
Načte soubory `horiz_surface_*.xyz` a určí přesné výškové úrovně podlaží, které uloží do `info.json`. Po tomto volání se doporučuje spustit `POST /api/preprocess-walls`.

- **Odpověď (200 OK):**
  ```json
  {
    "status": "success",
    "updated_floors": 2,
    "floor_levels": [...]
  }
  ```

#### `POST /api/c2b/walls`
Spustí detekci stěn podle algoritmu Cloud2BIM (2D projekce hustoty -> prahování -> kontury -> Douglas-Peucker -> Manhattan snapping). Volitelně spouští i detekci otvorů a místností.

- **Payload:** `C2BWallParams`
- **Odpověď (200 OK):**
  ```json
  {
    "status": "success",
    "algorithm": "cloud2bim",
    "lines_count": 18,
    "n_doors": 5,
    "n_windows": 4,
    "n_rooms": 4
  }
  ```

---

### 3.10 Barevné Půdorysy a Statické Soubory

#### `GET /api/colorplans`
Vrátí seznam cest k barevným rastrovým náhledům podlah a stropů.

- **Odpověď (200 OK):**
  ```json
  {
    "floors": [
      {
        "label": "Floor 1",
        "color": "/model/colorplan_000.jpg",
        "ceiling": "/model/ceilingcolorplan_000.jpg"
      }
    ]
  }
  ```

#### `GET /model/{filepath:path}`
Statický mount složky s podklady skenu (`MATTERPAK_DIR`).

#### `GET /{filepath:path}`
Statický mount produkční zkompilované React aplikace (Single Page App z adresáře `dist`).

---

## 4. Kódy Odpovědí a Chybové Stavy

| Kód HTTP | Význam | Příčina |
|---|---|---|
| **200 OK** | Úspěšný požadavek | Operace proběhla v pořádku. |
| **400 Bad Request** | Neplatné parametry | Cesta nesplňuje příponu `.xyz` nebo neplatné vstupní hodnoty. |
| **404 Not Found** | Nenalezeno | Požadovaný `.xyz`, `.bin`, `info.json`, `.dxf` nebo `.svg` soubor neexistuje. |
| **500 Internal Error** | Vnitřní chyba serveru | Neočekávaná chyba při zpracování pipeline nebo exportu CAD. |

---

## 5. Příklady Použití (cURL / Python)

### Příklad 1: Nastavení cesty a spustění sjednocené pipeline (cURL)
```bash
# 1. Nastavení cesty k mračnu
curl -X POST "http://localhost:8000/api/xyz-path" \
     -H "Content-Type: application/json" \
     -d '{"xyz_path": "/data/matterpak/cloud.xyz"}'

# 2. Spuštění sjednocené pipeline
curl -X POST "http://localhost:8000/api/pipeline/run" \
     -H "Content-Type: application/json" \
     -d '{
       "xyz_path": "/data/matterpak/cloud.xyz",
       "run_c2b": true,
       "run_slices": true,
       "grid_size": 0.02,
       "snap_to_axis": true
     }'

# 3. Kontrola stavu
curl -X GET "http://localhost:8000/api/pipeline/status"
```

### Příklad 2: Načtení a uložení upravených stěn v Pythonu
```python
import requests

BASE_URL = "http://localhost:8000"

# Načtení stěn pro podlaží 0
response = requests.get(f"{BASE_URL}/api/walls/0")
walls_data = response.json()

lines = walls_data.get("lines", [])
print(f"Načteno {len(lines)} stěn.")

# Přidání nové stěny a uložení
lines.append([[0.0, 0.0], [5.0, 0.0]])

save_response = requests.put(
    f"{BASE_URL}/api/walls/0",
    json={"lines": lines}
)

print("Výsledek uložení:", save_response.json())
```
