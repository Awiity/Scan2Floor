# Scan2Floor — System Architecture & Data Flow

> **Document scope:** This document covers the end-to-end system architecture of Scan2Floor, from raw Matterport `.xyz` input to interactive browser visualisation and CAD export. It is intended for developers who need to understand how the pieces fit together before making changes.
>
> **Companion documents:**
>
> - [Architecture Decision Records →](./adr/README.md)
> - [API Documentation →](../API_DOCUMENTATION_CZ.md)
> - [Component-level reference →](../ARCHITECTURE.md)

---

## 1. System Context

The highest-level view of Scan2Floor and everything it interacts with.

```mermaid
C4Context
    title Scan2Floor — System Context

    Person(arch, "Architect / Surveyor", "Uses the browser UI to upload scans, trigger processing, review and edit floor plans, export CAD files.")

    System_Boundary(s2f, "Scan2Floor") {
        System(app, "Scan2Floor Application", "React SPA + FastAPI backend. Processes 3D point clouds into vectorised 2D floor plans.")
    }

    System_Ext(matterport, "Matterport Scanner", "Produces raw .xyz point cloud files (Z-up, XYZ + RGB per point, up to 4 GB+).")
    System_Ext(cad, "CAD / BIM Tools", "AutoCAD, Revit, FreeCAD — consume exported .dxf files.")
    System_Ext(browser, "Web Browser", "Chrome / Firefox — renders the Three.js 3D scene and HTML5 Canvas 2D editor.")

    Rel(arch, browser, "Opens at localhost:9000 (Docker) or :5173 (dev)")
    Rel(matterport, arch, "Exports .xyz file to host filesystem")
    Rel(arch, cad, "Opens exported .dxf / .svg for further work")
    Rel(browser, app, "REST API calls (fetch + polling)")
    Rel(app, cad, "Writes floor_N.dxf + floor_N.svg")
```

---

## 2. Container Diagram

The two runtime containers and the persistent storage that connects them.

```mermaid
C4Container
    title Scan2Floor — Container Diagram

    Person(arch, "Architect / Surveyor")

    System_Boundary(docker, "Docker Host") {

        Container(spa, "React SPA", "React 19 + Vite 8 / Three.js + R3F", "3D point cloud viewer, 2D floor plan editor, pipeline control sidebar. Served as static files from FastAPI.")

        Container(api, "FastAPI Backend", "Python 3.11 + Uvicorn", "REST API server. Orchestrates the processing pipeline. Serves binary point cloud, JSON data, DXF/SVG exports, and the SPA static bundle.")

        Container(pipeline, "Pipeline Worker", "Python daemon thread + subprocesses", "6-stage background job: cleaning → preprocessing → slab detection → floor levels → wall slices → wall/room/opening detection + DXF export.")

        ContainerDb(vol, "processed_data volume", "Docker named volume", "Persists all pipeline outputs across container restarts: pointcloud.bin, info.json, wall slices (.npy), walls/rooms/openings JSON, DXF/SVG.")

        ContainerDb(scans, "Scan Mount /data", "Host filesystem (read-only bind mount)", "Raw Matterport .xyz scan files. One or more directories mounted under /data/.")
    }

    Rel(arch, spa, "HTTP :9000 (Docker) / :5173 (dev Vite proxy)")
    Rel(spa, api, "REST — fetch() calls to /api/* and /model/*")
    Rel(api, pipeline, "Spawns in daemon thread via threading.Thread")
    Rel(pipeline, vol, "Reads & writes all intermediate + final artefacts")
    Rel(pipeline, scans, "Reads raw .xyz input (read-only)")
    Rel(api, vol, "Reads processed artefacts to serve API responses")
    Rel(api, spa, "Serves dist/ as StaticFiles at /")
```

---

## 3. Deployment Topology

How the application runs in practice — both development and production modes.

```mermaid
flowchart TB
    subgraph HOST["Host Machine"]
        subgraph DEV["Development Mode"]
            direction LR
            VD["Vite Dev Server\n:5173\n(HMR + proxy)"]
            FD["FastAPI / Uvicorn\n:8000\n(--reload)"]
            VD -- "proxy /api /model" --> FD
        end

        subgraph PROD["Production — Docker Compose"]
            direction TB
            subgraph CONTAINER["scan2floor container (port 9000→8000)"]
                UV["Uvicorn\n:8000"]
                SF["StaticFiles\n/app/dist"]
                API2["FastAPI\nREST handlers"]
                PW["Pipeline\nDaemon Thread"]
                UV --> SF
                UV --> API2
                API2 --> PW
            end

            subgraph VOLUMES["Docker Volumes"]
                VOL[("processed_data\n/processed\n(read-write)")]
                DATA[("/data/matterpak\n(read-only bind)")]
            end

            subgraph GPU_OPT["GPU Overlay (optional)"]
                CUDA["CUDA 12.6 base image\nCuPy for voxel dedup\n(Dockerfile.gpu)"]
            end

            CONTAINER -- "writes artefacts" --> VOL
            CONTAINER -- "reads .xyz files" --> DATA
            GPU_OPT -. "replaces base image" .-> CONTAINER
        end
    end

    subgraph BUILD["Build Step (pre-Docker)"]
        NPM["npm run build\n(frontend/)"]
        OUT["backend/dist/\n(Vite output)"]
        NPM --> OUT
    end

    OUT -- "COPY backend/ /app/" --> CONTAINER
```

> **Key environment variables** injected by `docker-compose.yml`:
>
> | Variable | Default | Purpose |
> | ---------- | --------- | --------- |
> | `PROCESSED_DIR` | `/processed` | Root for all pipeline output files |
> | `DATA_DIR` | `/data/matterpak` | Fallback scan folder |
> | `C2B_DIR` | `/processed/c2b_output` | Cloud2BIM slab surface output |
> | `SCAN_ROOTS` | `/data` | Comma-separated roots walked by the file browser |

---

## 4. Pipeline — Stage Flow

The 6-stage background processing pipeline that transforms a raw `.xyz` file into all output artefacts.

```mermaid
flowchart LR
    XYZ["📄 cloud.xyz\nRaw Matterport scan\nZ-up · up to 4 GB"]

    subgraph S1["Stage 1 — subprocess"]
        C["clean_pointcloud.py\nNoise & scanner-stand\nremoval · downsample"]
    end

    subgraph S2["Stage 2 — subprocess"]
        P["preprocess_xyz.py\nZ-up → Y-up · centroid\nfloor histogram · binary export"]
    end

    subgraph S3["Stage 3 — subprocess"]
        C2B["run_c2b.py\nCloud2BIM reimpl.\nHoriz. slab detection"]
    end

    subgraph S4["Stage 4 — in-process"]
        FC["floor_from_c2b.py\nSlab pairing · precise\nfloor_levels update"]
    end

    subgraph S5["Stage 5 — subprocess"]
        PW["preprocess_walls.py\nPer-floor height band\nvoxel dedup (CPU/GPU)"]
    end

    subgraph S6["Stage 6 — in-process"]
        WD["wall_detection_c2b.py\nDensity projection\nwall segments"]
        OD["opening_detection.py\nDoor / window\ngap scanning"]
        RD["room_detection.py\nMorphological\nregion labelling"]
        DX["dxf_export.py\nezdxf · DXF layers\nSVG preview"]
    end

    XYZ --> C
    C --> P
    P --> C2B
    C2B --> FC
    FC --> PW
    PW --> WD
    WD --> OD
    OD --> RD
    RD --> DX

    P -- "pointcloud.bin\ninfo.json (prelim)" --> BIN[("📦 /processed")]
    C2B -- "horiz_surface_N.xyz" --> BIN
    FC -- "info.json updated\nfloor_levels[]" --> BIN
    PW -- "wall_slice_floor_N.npy" --> BIN
    WD -- "walls_floor_N.json" --> BIN
    OD -- "openings_floor_N.json" --> BIN
    RD -- "rooms_floor_N.json" --> BIN
    DX -- "floor_N.dxf\nfloor_N.svg" --> BIN

    style S1 fill:#1a2040,stroke:#334477
    style S2 fill:#1a2040,stroke:#334477
    style S3 fill:#1a2040,stroke:#334477
    style S4 fill:#0d2030,stroke:#2a5070
    style S5 fill:#1a2040,stroke:#334477
    style S6 fill:#0d2030,stroke:#2a5070
    style BIN fill:#0a1525,stroke:#1a4060
```

> **Stage execution model:**
>
> - **Subprocess stages** (1, 2, 3, 5): spawned via `subprocess.Popen` — stdout is streamed line-by-line into the shared log buffer and the pipeline can be cancelled between lines via `_cancel_event`.
> - **In-process stages** (4, 6): Python functions called directly in the daemon thread — faster, no subprocess overhead, but cancellation is checked at stage boundaries only.

---

## 5. Pipeline Concurrency & Status Flow

How the FastAPI main thread, the pipeline daemon thread, subprocesses, and the browser polling loop interact over time.

```mermaid
sequenceDiagram
    actor User as 🧑 Architect
    participant Browser as Browser SPA
    participant FastAPI as FastAPI<br/>(main thread)
    participant Daemon as Pipeline<br/>(daemon thread)
    participant Subprocess as Child Process<br/>(preprocess_xyz etc.)

    User->>Browser: Click "Rerun Full Pipeline"
    Browser->>FastAPI: POST /api/pipeline/run
    FastAPI->>FastAPI: Validate xyz_path, clear stale outputs
    FastAPI->>Daemon: threading.Thread(target=run_pipeline).start()
    FastAPI-->>Browser: 200 {"started": true}

    Note over Browser: Start 2s polling loop

    loop Every 2 seconds while running=true
        Browser->>FastAPI: GET /api/pipeline/status
        FastAPI->>Daemon: Read shared status{} (threading.Lock)
        FastAPI-->>Browser: {"running":true, "stage":2, "stage_name":"Preprocess XYZ", "log":[...]}
        Browser->>Browser: Update stage indicators + log tail
    end

    Daemon->>Daemon: Stage 1 (clean) — skippable
    Daemon->>Subprocess: subprocess.Popen(clean_pointcloud.py)

    loop Stream stdout
        Subprocess-->>Daemon: stdout line
        Daemon->>Daemon: Append to status["log"] (Lock)
    end

    Subprocess-->>Daemon: returncode=0
    Daemon->>Daemon: Stage 2 (preprocess_xyz) — subprocess
    Daemon->>Subprocess: subprocess.Popen(preprocess_xyz.py)
    Subprocess-->>Daemon: Writes pointcloud.bin + info.json
    Daemon->>Daemon: Stages 3→6 continue...

    Note over Daemon: Stage 6 complete

    Daemon->>Daemon: status["running"]=False, status["done"]=True

    Browser->>FastAPI: GET /api/pipeline/status
    FastAPI-->>Browser: {"running":false, "done":true, "elapsed_s":372}
    Browser->>Browser: Stop poll, fire onReprocessDone() + onWallsDetected()
    Browser->>FastAPI: GET /api/pointcloud  (cache-busted)
    FastAPI-->>Browser: Binary ArrayBuffer (pointcloud.bin)
    Browser->>Browser: Rebuild THREE.BufferGeometry, re-render 3D scene

    Note over User,Browser: Optional: User cancels mid-run
    User->>Browser: Click "Cancel"
    Browser->>FastAPI: POST /api/pipeline/cancel
    FastAPI->>Daemon: _cancel_event.set()
    Daemon->>Subprocess: proc.terminate() → proc.kill() (3s timeout)
    Daemon->>Daemon: status["cancelled"]=True, "running"=False
```

---

*Generated: 2026-08-18.
