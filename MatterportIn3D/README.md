# Matterport In3D — ovládání kamery podle souřadnic

Webová aplikace, která zobrazí Matterport model v iframe a **přesune kameru
na zadané souřadnice** — buď živě z cizího systému (WebSocket), jednorázovým
skokem (HTTP POST), nebo ručně přes formulář v UI.

Model: `https://my.matterport.com/show/?m=yQPhyaCwigp`

## Architektura

```
cizí systém ──POST /move / WS /ws──► FastAPI (kalibrace + broadcast)
                                        │
                              WS /ws (živý proud)
                                        ▼
                        prohlížeč: iframe + Matterport SDK
                        Sweep.moveTo() + Camera.lookAt()
```

- **Kamera v „walk" režimu sedá na nejbližší skenovací pozici (sweep)** —
  appka najde sweep nejbližší zadaným souřadnicím a přesune se na něj
  (`Sweep.moveTo`), pohled pak nastaví `Camera.lookAt` / `setRotation`.
- **Rychlejší proud než přesuny** → staré pozice se zahazují, kamera jde
  vždy na nejnovější.
- Více prohlížečů současně = všichni vidí totéž.

## Předpoklady

1. **Model je ve vašem Matterport účtu** (platí pro `yQPhyaCwigp`).
2. **SDK application key** — Matterport Cloud → `Settings` (vlevo dole) →
   `Developer Tools` → sekce SDK keys → *Generate key*.
   Klíč uložte do `.env` v kořeni projektu (soubor se necommituje):

   ```
   matterport_api_key=vase-sdk-klic
   ```

   Klíč je svázaný s doménou, ze které se stránka načítá. V Matterport Cloud
   proto povolte doménu **`localhost`** — `127.0.0.1` Matterport odmítne
   (`This referrer is not allowed to use this X-Matterport-Application-Key`)
   a SDK se nepřipojí. Bezplatný sandbox stačí.
3. Python 3.10+ (testováno na 3.12).

## Spuštění

```bash
cd MatterportIn3D
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# klíč se načte z .env (alternativně: export MP_APPLICATION_KEY="vase-sdk-klic")

uvicorn app.main:app --host 127.0.0.1 --port 8000
# nebo: python -m app.main
```

Otevřete **`http://localhost:8000/`** (kvůli doménovému omezení klíče, ne
`127.0.0.1`) — model se načte, vlevo je panel se stavem (SDK, server), ručním
formulářem a měřením pozice kamery.

## Integrace cizího systému

### Jednorázový skok — `POST /move`

```json
{
  "position": {"x": 1.25, "y": -0.4, "z": 3.1},
  "view": {"mode": "lookAt", "x": 2.0, "y": -0.4, "z": 3.1},
  "mode": "smooth"
}
```

- `position` — pozice v souřadnicích **bodového mraku** (server aplikuje
  kalibraci, viz níže).
- `view` — dvě varianty:
  - `{"mode": "lookAt", "x", "y", "z"}` — kamera se dívá na daný bod;
  - `{"mode": "angles", "yaw", "pitch"}` — přímé úhly dle konvence
    `Camera.pose` z Matterport SDK (`yaw` = `rotation.y`, `pitch` = `rotation.x`).
- `mode` — `"smooth"` (plynulý přechod, default) nebo `"instant"` (skok).

Odpověď: `{"status": "accepted", "sent_to": <počet prohlížečů>, "model_position": {...}}`.
Chybná zpráva → `400` s `{"error": "invalid_message", "details": [...]}`.

Test: `python send_test_position.py 1.0 2.0 3.0 --yaw 90`

### Živý proud — WebSocket `ws://<server>:8000/ws`

Cizí systém se připojí jako **druhý** WS klient a posílá stejné JSON zprávy
(jen `position` je povinné, `view`/`mode` volitelné). Server rozesílá zprávy
všem prohlížečům. Python ukázka:

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:8000/ws") as ws:
        while True:
            pos = muj_system.dalsi_pozice()   # váš kód
            await ws.send(json.dumps({
                "position": {"x": pos.x, "y": pos.y, "z": pos.z},
                "view": {"mode": "angles", "yaw": pos.yaw, "pitch": 0},
                "mode": "smooth",
            }))
            await asyncio.sleep(1.0)

asyncio.run(main())
```

*Pozn.: pro posílání z cizího systému do serveru lze použít i `POST /move`
v cyklu — WS je výhodnější pro vyšší frekvenci.*

### Kontrola dostupnosti — `GET /health`

`{"status": "ok", "clients": 1}` — `clients` = počet připojených prohlížečů.

## Uložené body — procházení modelu

V panelu stačí dojít (nebo se přesunout) na místo, které chcete mít po ruce,
napsat název a kliknout **Uložit** — uloží se `sweep` + pozice + natočení
z `Camera.getPose()`, takže skok je přesný a nezávisí na kalibraci mraku.

- **Jdi** u bodu = plynulý přesun na daný bod (`Sweep.moveTo`),
- **Projít body** = prohlídka všech bodů v pořadí s nastavitelnou pauzou
  (tlačítko se během ní mění na **Zastavit prohlídku**),
- **×** = smazání bodu,
- body se ukládají do `data/<model_id>/points.json` (přežijí restart; cestu
  lze změnit přes `MP_POINTS_FILE`),
- bod uložený v dollhouse pohledu nemá `sweep` — skočí se na nejbližší sken.

### API

| Endpoint | Význam |
|---|---|
| `GET /points` | `{"points": [...]}` — seznam bodů |
| `POST /points` | uloží bod: `{"name": "...", "sweep": "...", "position": {x,y,z}, "rotation": {x,y}, "mode": "mode.inside"}` → `201` |
| `DELETE /points/{id}` | smaže bod → `204`, neznámé id → `404` |
| `POST /points/{id}/goto` | rozešle prohlížečům `{"type":"goto","point":{...}}` → `{"status":"accepted","sent_to":N}` |

```bash
curl -s http://localhost:8000/points
curl -s -X POST http://localhost:8000/points/pt_a1b2c3d4/goto
```

Zpráva `{"type":"goto", ...}` je jediné rozšíření WS protokolu — zprávy
`position`/`view`/`mode` fungují beze změny.

## Rozpoznané objekty (AI detekce + tagy)

Pipeline projde všechny skeny modelu, vyfotí je z 4 směrů (0/90/180/270°),
nechá AI model rozpoznat viditelné objekty a nabízí je v UI jako tagy s
směrem, na který se kamera umí otočit.

### 1. Sběr snímků — `tools/capture_sweeps.py`

Playwright projde všech 145 skenů (přes `window.__mp` v `static/app.js`,
režim `?capture=1` vypíná WebSocket) a vyfotí do `capture/<sweepId>/yawNNN.jpg`
(1280×720, JPEG 88, spodní lišta Matterportu ořezaná). Znovu spustitelný —
existující snímky přeskočí, zaseknutý prohlížeč se restartuje sám.

```bash
/usr/bin/python3 tools/capture_sweeps.py           # vše (~35–40 min)
/usr/bin/python3 tools/capture_sweeps.py --limit 5 # pilot
```

### 2. Detekce — `tools/detect_objects.py`

Každý snímek = jeden požadavek na vision model přes DCUK gateway
(`DCUK_BASEURL` + `DCUK_API_KEY` z `.env`), default `DCUK-AI4-Glm53-Flash`.
3 požadavky souběžně, výsledky se průběžně ukládají do `objects.json`
(surové per-view bboxy + jistota). Znovu spustitelný, `--keep-raw` uloží i
surovou odpověď modelu.

```bash
/usr/bin/python3 tools/detect_objects.py                # vše (~10–15 min)
/usr/bin/python3 tools/detect_objects.py --concurrency 4
```

### 3. Tagy v UI a API

Objekty se agregují: stejný štítek viděný ze sousedních pohledů se sloučí
(spolítku se přičítá, `hits` = kolikrát nalezen), z polohy v obrázku se
spočítá **směr (bearing)** — klik na tag otočí kameru přes `Sweep.moveTo(sweep,
{rotation:{y:bearing}})`. Znaménko orientace (`MP_CAPTURE_YAW_SIGN`, default
−1) i zorné pole (`MP_CAPTURE_HFOV`, default 100,5° — naměřeno na modelu) jsou
v `app/config.py`.

| Endpoint | Význam |
|---|---|
| `GET /objects` | přehled: počty labelů + tagy pro každý sken |
| `GET /objects/{sweep}` | tagy jednoho skenu |

V panelu je záložka **„Objekty"** — načte se podle místa, kde kamera stojí
(sleduje se každých 1,5 s), filtr textem, klik = otočení kamery. U tagu, který
má globální instanci, je tlačítko **↗** („tatáž věc viděná z více skenů" —
skok rovnou k ní). Ikonka a kategorie (požární, IT, elektro…) jsou součástí tagu.

### 4. Anchory — `tools/anchor_objects.py`

Tagy říkají jen směr. Aby se z detekcí mohl skládat globální katalog, dostane
každá detekce **anchor** — skutečný 3D bod na objektu: Playwright přes SDK
`Pointer.intersection` (trusted mouse raycast, ~2 s/detekci, model v iframe
`#showcase` — syntetické eventy SDK ignoruje; HUD se musí skrýt, jinak pohltí
raycasty vlevo nahoře). Kde paprsek nezamířil, se anchor odhadne z polohy
bboxu (`anchor_estimated`). Znovu spustitelný per sken (resumable).

```bash
/usr/bin/python3 tools/anchor_objects.py              # vše (~1,5–2 h)
/usr/bin/python3 tools/anchor_objects.py --sweep <sid>  # jeden sken
```

### 5. Inventář instancí — `tools/merge_objects.py`

Sloučí anchory všech skenů do **globálních instancí fyzických objektů** —
hasicí přístroj viděný ze 3 skenů je JEDEN objekt (`hits`/sweeps = z kolika
skenu byl viděn). Greedy clustering per štítek s poloměrem per kategorie
(racky 0,4 m, hasicí/hlásič 0,6 m, světla 0,8 m — `MERGE_RADIOS` v
`app/config.py`, default přes env `MP_MERGE_RADIUS`) a capem průměru
2× poloměr (brání řetězení přes chodbu). Surová per-view data zůstávají —
běh je idempotentní.

```bash
/usr/bin/python3 tools/merge_objects.py     # zapíše sekci instances do objects.json
```

| Endpoint | Význam |
|---|---|
| `GET /inventory` | počty per kategorie + celý katalog instancí |
| `GET /inventory/{label}?near=x,y,z` | instance štítku seřazené dle vzdálenosti |
| `GET /inventory/where/{label}` | „Kde jsou" — pole bodů (sweep + pozice + yaw), `near` přidá `dist` a seřadí |
| `POST /inventory/save-as-points/{label}` | instance štítku jako pojmenované body `"<label> <n>"` (Projít body je projede) → `201` |
| `POST /goto-instance/{id}` | broadcast — UI skočí na nejlepší sken + otočí se |

V panelu je záložka **„Inventář"**: počty per kategorie (chips), instance
seřazené dle vzdálenosti od kamery, filtr a **prohlídka dle výběru**:

- **Filtr / chip omezuje výběr** — tlačítko tour se přepíná mezi
  **„Provést kolem všech"** a **„Provést kolem vybraných"** (např. filtr
  „hasicí" → prohlídka jen po hasicích přístrojích, každý krok skok k
  nejlepšímu skenu + otočení na objekt, pauza nastavitelná),
- **„Uložit jako body"** — instance jednotného štítku (chip nebo filtr) se
  uloží jako body „hasicí přístroj 1..15" do `points.json` — objeví se v
  záločce **Body** a projdou stávající mechanikou „Projít body",
- **„Kde jsou"** — API pole bodů: `GET /inventory/where/hasicí přístroj`
  vrátí 15 bodů (sweep + pozice + `rotation.y` = yaw objektu), s
  `?near=x,y,z` seřazeno nejbližší jako `dist`.

QA přehled anchoring/projekci: `tools/qa_overlay.py` nakreslí do snímků
`capture/<sid>/qa_yawNNN.jpg` bboxy detekcí, zpětně promítané anchory
(zelené/červené = estimated) a promítané instance (`--max-dist` omezuje
vzdálenost promítaných instancí, ať červená plocha neplní obraz).

### Reálná čísla (prostor `yQPhyaCwigp`)

- **145 skenů**, **2 302 raw detekcí** (AI detekce ze 4 směrů per sken)
- anchor pass: **2 231 ok + 71 estimated** (2302/2302, miss 0)
- merge → **1 204 instancí** (po fixu jednotek anchorů — 22 mm-anchorů
  převedeno na m, 12 se připojilo k existujícím instancím), idempotentní
  (opakovaný běh = stejné počty)
- nejčastější kategorie: přístup 264, elektro 183, vzduchotechnika 178,
  IT 147, osvětlení 121, nábytek 107, orientace 89, **požární 55**
  (z toho **15 hasicích přístrojů**, 14× s jistotou ≥ 0,7)
- demo otázka „Kolik hasicích přístrojů má objekt a kde jsou?": `GET
  /inventory/hasicí přístroj` → 15 instancí s pozicí (x,y,z), nejlepším
  skenem a bearing; nejsilnější viděny z 9 skenů (jistota 0,95),
  nejslabší 1× (0,60); pole bodů `GET /inventory/where/hasicí přístroj` →
  15 bodů (sweep + pozice + yaw objektu) — stejná data v UI
  („Uložit jako body" → 15 bodů prohlídky)

## Export do BIM (IFC)

Inventář instancí + uložené body lze vyexportovat do souboru **IFC 4**
(`export.ifc`) pro import v BIM software (Revit, Blender, …).

### Co soubor obsahuje

- **Hierarchie** `IfcProject → IfcSite → IfcBuilding` — proxy produkty jsou
  obsažené v budově (`IfcRelContainedInSpatialStructure`), jednotky mm
  (délka) + rad, area, volume.
- **Produkty** — každá instance inventáře a každý uložený bod je samostatný
  prvek na pozici anchor centroidu, minimální klikatelná geometrie
  (**IfcSphere r 0,1 m** — bez ní by Revit proxy nezobrazil).
- **Souřadnice** — model coords (SDK, Y-up) se převádějí do IFC Z-up:
  `IFC_X = x·1000`, `IFC_Y = z·1000`, `IFC_Z = y·1000` (Y-up → Z-up, m → mm).
  Kalibrace mrak → model (AXIS_MAP/COORD_OFFSET) se NEAPLIKUJE — pozice
  instancí i bodů jsou už v model coords.
- **Jednotky SDK pozicí** — `Camera.getPose().position` je v metrech, ale
  `Pointer.intersection` position pro `intersectedobject.unknown` vrací
  **milimetry** (pro `.model`/`.sweep` metry). `anchor_from_event` proto eventy
  s průsečíkem dále než 1 000 m konvertuje ÷1000; clustering navíc vyloučí
  anchor nad 100 m (varování v logu). Stará data se přepočítají skriptem
  `tools/normalize_anchor_units.py` (idempotentní, backup `.pre-units`).
- **Property set „Matterport"** na každém produktu — data detekce
  pro filtraci v BIM software:

| Vlastnost (instance) | Význam |
|---|---|
| `label` | štítek („hasicí přístroj", …) |
| `kategorie` | kategorie („požární", „elektro", …) — filtrace dle ní, IFC typ není 1:1 |
| `jistota` | max. jistota detekce v % (0–100) |
| `hits` | z kolika skenu byl objekt viděn |
| `sweep`, `bearing` | nejlepší sken + azimut na objekt |
| `anchor_estimated` | anchor centroid je odhad (true = nižší přesnost) |

Body (z `points.json`) mají v property setu `name`, `sweep`, `yaw`,
`pitch`.

- **Mapování kategorií → IFC typy** (IFC 4 nemá typ pro všechny kategorie;
  filtrace v BIM přes `Matterport.kategorie`):

| Kategorie | IFC typ |
|---|---|
| požární | IfcDiscreteAccessory |
| elektro, IT, zabezpečení | IfcDistributionFlowElement |
| osvětlení | IfcLightFixture |
| hygiena | IfcSanitaryTerminal |
| nábytek | IfcFurniture |
| zbytek (přístup, vzduchotechnika, orientace, …) | IfcBuildingElementProxy |

Pokud instance má známé skeny, dává export i `sweep`/`bearing` — **sken s
nejvyšší jistotou** (ne první v seznamu).

### Jak exportovat

```bash
# CLI — zapíše data/<model_id>/export.ifc
.venv/bin/python -m tools.export_ifc
```

- **API** — `GET /export/ifc` → soubor jako attachment (`model/ifc`),
  generovaný **on-demand** (vždy čerstvý, funguje i v Docker slim image —
  `tools/export_ifc.py` + `ifcopenshell` jsou ve slim variantě), bez
  inventáře → 404,
- **UI** — záložka **Inventář** → tlačítko **„Export IFC"** (stáhne
  `export.ifc`).

### Ověření importem v Blenderu

Ověřeno importem v **Blender 4.2 LTS** s rozšířením **Bonsai** (IfcOpenShell;
v Blenderu 5.x Bonsai nefunguje — nutné 4.2). Skript
`tools/blender_ifc_check.py` importuje soubor headless, spočítá objekty,
porovná pozice proti IFC a vyrenderuje QA screenshot:

```bash
blender --background --python tools/blender_ifc_check.py -- \
    --ifc data/<model_id>/export.ifc --png qa_blender.png
```

Reálný prostor `yQPhyaCwigp` (1 204 instancí + 46 bodů): import v Blenderu
→ **1 250 mesh objektů** (počet sedí), kolekce
`IfcProject/… → IfcSite/… → IfcBuilding/…`, všech 1 250 pozic souhlasí
s IFC (Blender kontrola: 1250 bad=0, max odchylka 0,0 mm).

### Omezení

- **Bodová geometrie** — produkty mají jen klikatelnou kouli r 0,1 m, ne
  rozměry objektů (obrysy v BIM chybí).
- **Bez podlaží** — vše je obsaženo přímo v IfcBuilding (model nemá
  podlahy; spatial hierarchy Project/Site/Building).
- **Kategorie v property setu** — IFC typy nejsou 1:1 s kategoriemi
  (požární přístroje jsou IfcDiscreteAccessory); filtrace dle
  `Matterport.kategorie`.
- **Outlieři detekce** — anchor s pozicí mimo rozsah modelu (SDK bug:
  `intersectedobject.unknown` eventy v mm) se dnes řeší u zdroje: capture
  konvertuje eventy v mm na metry, clustering vyloučí anchor nad 100 m
  (varování v logu) a `tools/normalize_anchor_units.py` opravil stará data —
  v reálných datech už žádná instance nepřesahuje 100 m.

## Kalibrace souřadnic (mrak → model)

Souřadnice mraku a Matterport modelu nemusí být totožné (počátek, pořadí os,
měřítko). Ověření:

1. Spusťte appku, klikněte **„Změřit aktuální pozici kamery"** — UI zobrazí
   `position` a `rotation` v souřadnicích modelu.
2. Stůj na stejném místě v mraku a porovnejte.
3. Nastavte v `app/config.py` (nebo proměnnými `MP_AXIS_X/Y/Z`, `MP_OFFSET_X/Y/Z`):
   - `AXIS_MAP` — remap os: `{"x": "x", "y": "z", "z": "y"}` znamená, že osa Y
     modelu odpovídá ose Z mraku (typické pro Z-up mrak),
   - `COORD_OFFSET` — posun přičítaný v souřadnicích modelu.

Formulář v UI zobrazuje pod poli X/Y/Z přepočet na souřadnice modelu, takže
kalibraci lze ladit přímo v aplikaci.

## Omezení

- Kamera v walk režimu skáče jen mezi skeny — mezi skany „mezi polohami"
  se kamera dostane jen v dollhouse/floorplan režimu.
- Bod uložený v dollhouse pohledu nemá `sweep`, při skoku se použije nejbližší
  sken (a tedy i jiná pozice, než jaká byla uložena).
- Přesun trvá ~1–2 s; rychlejší proud znamená zpoždění za nejnovější pozicí.
- Matterport SDK funguje jen přes `http(s)` — ne `file://`.
- SDK application key je vázaný na doménu.

## Provoz v síti (přístup z jiných zařízení)

Server umí dva režimy, ať SDK klíč je vázaný jen na `localhost`:

**API a WebSocket z jiného počítače** — cizí systém posílá pozice z IP:

```bash
MP_HOST=0.0.0.0 uvicorn app.main:app --host 0.0.0.0 --port 8000

curl http://<IP-pocitace>:8000/health
python send_test_position.py 1.0 2.0 3.0 --url http://<IP-pocitace>:8000/move
```

**Prohlížeč z jiného zařízení — remote režim** — Matterport SDK se z jiné
domény nepřipojí (klíč je na `localhost`), takže appka otevřená přes IP
automatizky přepne do **remote režimu**: místo 3D iframe ukazuje **QA snímek
aktuálního skenu** (`/captures/<sweep>/qa_yaw000.jpg` — „kde kamera stojí" jako
fotka, včetně yaw z `/objects`), přesuny se v UI hlásí instrukcí („3D náhled")
a tlačítko **„3D náhled (localhost)"** otevře plné 3D v prohlížeči na počítači
s SDK. Remote režim se pozná sám — hostname není `localhost`/`127.0.0.1`
(`app.js`: `remoteMode`; lze ovlivnit hintem `MP_REMOTE_HINT` v `/config`).

**SSH tunel — plné 3D zvenčí** — tunel je z pohledu SDK stále `localhost`:

```bash
ssh -N -L 8017:localhost:8017 <server>   # prohlížeč: http://localhost:8017
```

Stejnou situaci (appka u sebe) pokrývá Docker Compose — viz níže; data
prostoru a body pak cestují přes centrální registr (další kapitola).

## Docker Compose — spuštění u sebe

SDK application key je vázaný na doménu — **funguje jen z originu
`localhost`**. Nejjednodušší cesta je vlastní Docker stack:

```bash
cp .env.example .env            # + váš Matterport SDK klíč (ať neleze do image)
docker compose up -d            # slim varianta — UI + API + inventář
# → http://localhost:8017
MP_MODEL_ID=<jiný-model> docker compose up -d  # přepnutí prostoru
```

- Port se váže jen na `127.0.0.1` (ať se origin nezveřejní — licenční
  omezení). Přístup z cizího počítače = SSH tunel, který je z pohledu SDK
  stále localhost:
  `ssh -N -L 8017:localhost:8017 <server>`.
- Data prostoru leží v `./data/<model_id>/` (inventář, snímky, body) —
  přepíná se proměnnou `MP_MODEL_ID`, do image neleze.
- Varianty image: `slim` (UI/API, ~184 MB) a `full` (~1,4 GB; přidá
  Playwright + Chromium pro pipeline capture/detect/anchor/merge):

  ```bash
  MP_DOCKER_TARGET=full docker compose up -d --build
  docker build --target full -t mp-in3d:full .
  ```

- Pipeline u sebe: `MP_DOCKER_TARGET=full docker compose run app python
  tools/capture_sweeps.py --base http://localhost:8017` (dál detect → anchor →
  merge; snímky a `objects.json` zůstávají v `./data/<model_id>/`). **Slim
  varianta pipeline neumí** — `tools/` je jen ve `full` image.
- Remote režim: appka otevřená přes IP (ne localhost) zobrazí místo 3D
  QA snímky a tlačítko „3D náhled (localhost)" — viz výše.

`.env` se mountuje do kontejneru — chybí-li, `docker compose up` spadne
hláškou `no such file or directory` (vyřeší `cp .env.example .env`).

## Centrální registr — data mezi stroji

Když appka běží u sebe (Docker/localhost) a pipeline (capture/detect/anchor/
merge) na jiném stroji, data prostoru spojí **centrální registr** — nezávislá
FastAPI služba na `:8019`, která ukládá **inventář (`objects.json`) i snímky
(`capture/`)** a umí push/pull.

```bash
docker compose --profile registry up -d      # registr jako service :8019
# nebo samostatně: uvicorn app.registry:app --host 0.0.0.0 --port 8019
```

> **Pozor:** registr nemá autentizaci — kdo má síťový přístup, může přepsat
> inventář i snímky. Nezveřejňujte ho; jen za firewall / SSH tunel / VPN.

`MP_REGISTRY_URL` v `.env` — v rámci téhož Compose stacku je správná
`http://registry:8019` (název service, ne `localhost`); pro appku na jiném
stroji `http://<server>:8019`. Selhání synchronizace při startu se loguje
do konzole (warning), appka normálně poběží.

| Endpoint | Význam |
|---|---|
| `GET /spaces` | seznam prostorů v registraci (včetně `saved_at`) |
| `POST /spaces/{model_id}` | uložení `objects.json` (meta `saved_at`, sha256) |
| `GET /spaces/{model_id}` | stažení `objects.json` (nebo 404) |
| `POST /spaces/{model_id}/capture` | ZIP celého `capture/` (zip-slip guard) |
| `GET /spaces/{model_id}/capture` | ZIP snímků k downloadu |
| `POST …/capture/file`, `GET …/capture/file`, `GET …/capture/manifest` | jednotlivé soubory + manifest (per-soubor diff) |

**Auto synchronizace** — appka synchronizuje sama, stačí `MP_REGISTRY_URL`
(`docker-compose.yml` ji přičte z `.env`):

- **při startu appky** (`run_startup_sync`) — jednorázové `sync_once`,
- **po každém merge/capture** (`push_after_change` — volá `tools/
  merge_objects.py` a `tools/capture_sweeps.py`).

Synchronizace je **hash-first**: srovnává sha256 `objects.json` a jen při
rozdílu rozhoduje `saved_at` (novější vyhrává; lokál bez `saved_at` = push).
Snímky se diffovají **per soubor** přes manifesty (lokální
`.capture_sync` vs. meta registrace) — push jen nové, pull jen chybějící,
takže po „none" (stejný objects.json) se snímky pořád doplní. Zapsaný stav je
`.sync_state` vedle dat prostoru.

**Pozor na SDK:** API a WebSocket fungují z jakékoli IP, ale Matterport SDK
se připojí jen z domény povolené u klíče. Pro prohlížeč na jiném zařízení je
proto nutné v Matterport Cloud u klíče doplnit jeho adresu (IP nebo hostname),
např. `192.168.37.200`. Prohlížeč na tomto počítači stačí otevřít přes
`http://localhost:<port>/`.

Při odmítnuté doméně se v UI zobrazí
`Failed to fetch dynamically imported module … sdk.es6.js` a v konzoli
prohlížeče `400 This referrer is not allowed to use this X-Matterport-Application-Key`.

## Řešení potíží

| Příznak | Příčina / řešení |
|---|---|
| `Failed to fetch dynamically imported module … sdk.es6.js?applicationKey=…` | Matterport odmítl klíč (`400`). Otevřete stránku přes `http://localhost:…` a ověřte, že je `localhost` povolený u klíče v Matterport Cloud. |
| `This referrer is not allowed to use this X-Matterport-Application-Key` | Klíč je platný, ale je registrovaný na jinou doménu. |
| Stav SDK červený, model se ale načte | Klíč chybí nebo je z jiného účtu, než kde je model. |
| Přesun kamery se občas nepovede hned po načtení | SDK blokuje nový přechod, dokud běží úvodní animace — appka to zkusí znovu. |

## Testy

```bash
pytest tests/ -v
```

## Struktura

```
app/main.py        FastAPI: POST /move, /points*, /objects*, /inventory* (where, save-as-points), POST /goto-instance, GET /export/ifc, WS /ws, /health, /config, /captures (static)
app/config.py      Model ID, SDK klíč, kalibrace, cesty (data/<model_id>/), AI model, poloměry slučování, remote hint
app/points.py      ukládání pojmenovaných bodů (atomický zápis JSON)
app/objects.py     slovník štítků, bearing + ray geometrie, agregace tagů, clustering instancí, ObjectStore
app/registry.py    centrální registr: /spaces* (objects.json + capture ZIP + per-file)
app/registry_sync.py  auto sync s registrem: startup sync, push po merge/capture, hash-first + per-file captures
static/index.html  UI (taby Body|Objekty|Inventář, remote view, formulář, uložené body)
static/app.js      SDK připojení, WS, přesuny kamery, body + prohlídka, objekty, inventář (filtr/chip, tour výběru, „Uložit jako body"), remote režim, window.__mp
tools/capture_sweeps.py  sběr snímků všech skenů (Playwright, resumable) + auto push do registru
tools/detect_objects.py  AI detekce objektů na snímcích (DCUK gateway, 3 souběžně)
tools/anchor_objects.py  anchory detekcí přes SDK Pointer.intersection (trusted ray, resumable)
tools/merge_objects.py   globální instance — clustering anchorů do objects.json["instances"] + auto push
tools/export_ifc.py      IFC 4 export — instance + uložené body → data/<model_id>/export.ifc (proxy + property set „Matterport")
tools/normalize_anchor_units.py  jednorázová migrace jednotek anchorů (mm→m) v objects.json (idempotentní, backup .pre-units)
tools/blender_ifc_check.py  ověření exportu importem v Blenderu (Bonsai, headless) — počty, pozice, QA screenshot
tools/qa_overlay.py      QA přehled detekcí/anchorů/instancí do capture snímků (--max-dist)
Dockerfile          multi-stage slim/full (full přidá Playwright + Chromium)
docker-compose.yml  app :8017 (127.0.0.1) + registry :8019 (profile) + mount ./data
tests/test_api.py  testy API
tests/test_points.py  testy ukládání bodů
tests/test_objects.py  testy detekce, geometrie, clusteringu a endpointů /objects + /inventory
tests/test_registry.py  testy centrálního registru
tests/test_registry_sync.py  testy auto synchronizace (hash-first, per-file captures)
tests/test_remote.py  testy remote režimu + /inventory/where + save-as-points
tests/test_ifc_export.py  testy IFC 4 exportu (schema, hierarchie, pozice mm/Z-up, typy, property sety)
tests/test_export_api.py  testy endpointu GET /export/ifc (attachment, on-demand, 404)
tests/test_config.py  testy cest data/<model_id>/
tests/test_detect_parse.py  testy parsování odpovědí vision modelu
tests/test_qa_overlay.py  testy QA overlay (dist3d filtr)
send_test_position.py  testovací odesílač pozic
data/<model_id>/   data prostoru: objects.json, points.json, export.ifc, capture/ (Docker mount)
```

Starší cesty v kořeni (`capture/`, `points.json`, `objects.json`) po migraci
zůstávají jen uvnitř `data/<model_id>/` — cesty řeší `app/config.py`
(`resolve_paths`).
