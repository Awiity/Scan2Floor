import os, json
import subprocess
import sys
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from pipeline.wall_detection    import detect_walls_for_floor
from pipeline.dxf_export        import export_floor_dxf
from pipeline.opening_detection import detect_openings_for_floor

BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
PROCESSED_DIR = os.path.join(BASE_DIR, 'processed')
MATTERPAK_DIR = os.path.abspath(os.path.join(BASE_DIR, '..', '..', 'data', 'matterpak'))

app = FastAPI(title='Scan2Floor API', version='0.2.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

app.mount('/model', StaticFiles(directory=MATTERPAK_DIR), name='model')


# ── Status / Point Cloud ─────────────────────────────────────────────────────

@app.get('/api/status')
def status():
    bin_path  = os.path.join(PROCESSED_DIR, 'pointcloud.bin')
    info_path = os.path.join(PROCESSED_DIR, 'info.json')
    if os.path.exists(bin_path) and os.path.exists(info_path):
        with open(info_path) as f:
            info = json.load(f)
        return {'status': 'ready', 'info': info}
    return {'status': 'processing', 'info': None}


@app.get('/api/pointcloud')
def pointcloud():
    path = os.path.join(PROCESSED_DIR, 'pointcloud.bin')
    if not os.path.exists(path):
        return JSONResponse({'error': 'Not ready yet — run preprocess.py'}, status_code=404)
    return FileResponse(path, media_type='application/octet-stream',
                        headers={'Cache-Control': 'public, max-age=86400'})


@app.get('/api/info')
def info():
    path = os.path.join(PROCESSED_DIR, 'info.json')
    if not os.path.exists(path):
        subprocess.Popen(["python", "pipeline/preprocess_o3d.py"], cwd=BASE_DIR)
        return JSONResponse({"status": "processing"})
    with open(path) as f:
        return json.load(f)


# ── Phase 4: Wall Detection ───────────────────────────────────────────────────

class WallDetectionParams(BaseModel):
    floor_idx:      int
    grid_size:      float = 0.05
    snap_to_axis:   bool  = True
    # Phase 5 opening params (passed through for auto-run)
    wall_thickness: float = 0.25   # metres — 'tight' or 'loose'
    detect_openings: bool = True   # auto-run opening detection after walls


@app.post("/api/walls")
def generate_walls(params: WallDetectionParams):
    """
    Run wall detection for a floor.
    If detect_openings=True (default), immediately run opening detection too
    and export DXF with all layers.
    """
    try:
        cfg  = params.model_dump()
        lines = detect_walls_for_floor(params.floor_idx, cfg)

        result: dict = {
            "status":      "success",
            "lines_count": len(lines),
            "n_doors":     0,
            "n_windows":   0,
        }

        if params.detect_openings:
            op_result = detect_openings_for_floor(params.floor_idx, cfg)
            result["n_doors"]   = op_result["n_doors"]
            result["n_windows"] = op_result["n_windows"]

        # Export DXF + SVG (includes openings if they were detected)
        export_floor_dxf(params.floor_idx, PROCESSED_DIR)

        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/walls/{floor_idx}")
def get_walls(floor_idx: int):
    wall_path = os.path.join(PROCESSED_DIR, f'walls_floor_{floor_idx}.json')
    if not os.path.exists(wall_path):
        return JSONResponse({"status": "not_processed", "lines": []})
    with open(wall_path) as f:
        return json.load(f)


@app.post("/api/walls/{floor_idx}/export")
def export_walls(floor_idx: int):
    try:
        export_floor_dxf(floor_idx, PROCESSED_DIR)
        return {"status": "success", "dxf": f"/api/walls/{floor_idx}/download"}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/walls/{floor_idx}/download")
def download_dxf(floor_idx: int):
    dxf_path = os.path.join(PROCESSED_DIR, f"floor_{floor_idx}.dxf")
    if not os.path.exists(dxf_path):
        raise HTTPException(status_code=404, detail="DXF not generated yet")
    return FileResponse(dxf_path, media_type="application/dxf",
                        filename=f"floor_{floor_idx}.dxf")


@app.get("/api/walls/{floor_idx}/svg")
def get_svg(floor_idx: int):
    svg_path = os.path.join(PROCESSED_DIR, f"floor_{floor_idx}.svg")
    if not os.path.exists(svg_path):
        raise HTTPException(status_code=404, detail="SVG not generated yet")
    return FileResponse(svg_path, media_type="image/svg+xml")


# ── Phase 5: Opening Detection (standalone) ───────────────────────────────────

class OpeningParams(BaseModel):
    floor_idx:             int
    wall_thickness:        float = 0.25
    min_door_width:        float = 0.70
    min_window_width:      float = 0.50
    door_height_threshold: float = 1.85


@app.post("/api/openings")
def generate_openings(params: OpeningParams):
    """Run opening detection standalone (walls must already exist)."""
    try:
        result = detect_openings_for_floor(params.floor_idx, params.model_dump())
        export_floor_dxf(params.floor_idx, PROCESSED_DIR)
        return {
            "status":    "success",
            "n_doors":   result["n_doors"],
            "n_windows": result["n_windows"],
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/openings/{floor_idx}")
def get_openings(floor_idx: int):
    path = os.path.join(PROCESSED_DIR, f"openings_floor_{floor_idx}.json")
    if not os.path.exists(path):
        return JSONResponse({"status": "not_processed", "openings": []})
    with open(path) as f:
        return json.load(f)


# ── Color plans ───────────────────────────────────────────────────────────────

@app.get('/api/colorplans')
def colorplans():
    return {
        'floors': [
            {'label': 'Floor 1', 'color': '/model/colorplan_000.jpg',
             'ceiling': '/model/ceilingcolorplan_000.jpg'},
            {'label': 'Floor 2', 'color': '/model/colorplan_001.jpg',
             'ceiling': '/model/ceilingcolorplan_001.jpg'},
        ]
    }
