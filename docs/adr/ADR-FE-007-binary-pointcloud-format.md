# ADR-FE-007: Binary Point Cloud Streaming Format

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The downsampled point cloud (typically 500 K–5 M points after 1-in-N decimation) must be transferred from the FastAPI backend to the browser and loaded into a THREE.BufferGeometry with zero unnecessary memory copies.

Approaches for transferring large typed-array data to the browser:

| Format | Notes |
|--------|-------|
| JSON array of [x,y,z,r,g,b] tuples | Human-readable but 3–5× larger than binary; JSON.parse is slow for millions of elements |
| Comma-separated text (CSV / XYZ) | Similar to JSON — large, slow to parse |
| **Custom binary blob** | Compact; directly usable as TypedArray views without copying |
| glTF/GLB (point cloud mode) | Self-describing, standardised, but the Three.js point loader requires mesh parsing overhead |

### Forces

- A 5 M-point cloud at loat32 XYZ + uint8 RGB = 15 + 3 = 18 bytes/point weighs **90 MB** in binary vs ~270 MB as JSON text.
- Three.js BufferGeometry attributes require Float32Array for positions and can accept Float32Array for normalised colours. The data should be usable with zero-copy typed-array views where possible.
- The format must be writable in pure Python (NumPy) without a heavy serialisation library.

---

## Decision

Use a **custom little-endian binary format** served at GET /api/pointcloud:

`
Offset  Type       Size         Description
──────  ─────────  ──────────   ─────────────────────────────────
0       uint32     4 bytes      N — number of points (little-endian)
4       float32[]  N × 12 B     XYZ positions (little-endian, interleaved)
4+N*12  uint8[]    N × 3 B      RGB colours (0–255, no alpha)
`

**Python write side** (preprocess_xyz.py):
`python
with open(out_path, "wb") as f:
    f.write(struct.pack("<I", N))
    positions.astype("<f4").tofile(f)
    colors.astype("u1").tofile(f)
`

**JavaScript read side** (PointCloud.jsx):
`js
const view = new DataView(buf);
const N = view.getUint32(0, true);               // little-endian
const posData = new Float32Array(buf, 4, N * 3); // zero-copy view
const rawCol  = new Uint8Array(buf, 4 + N * 12, N * 3);
const colData = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) colData[i] = rawCol[i] / 255; // normalise
`

> **Note on the colour copy:** awCol cannot be used directly as a ertexColors attribute because Three.js expects loat32 in [0, 1]. A single normalisation loop over N × 3 values is unavoidable, but it is a sequential memory access and completes in under 30 ms even for 5 M points in modern V8.

### Cache busting

After a full pipeline reprocess, App.jsx bumps cloudReloadKey to a timestamp string. PointCloud.jsx appends it as ?v=<key> to defeat the browser cache and force a fresh fetch.

---

## Consequences

### Positive
- Transfer size is minimal: ~18 B/point vs ~60–80 B/point for JSON.
- posData is a true zero-copy Float32Array view into the ArrayBuffer; no intermediate allocation is needed before attaching it to BufferGeometry.
- The format is trivially writable in any language with a binary I/O library.

### Negative / Trade-offs
- The format is not self-describing. If the field layout changes (e.g., adding normals or intensity), both the Python writer and the JavaScript reader must be updated in lockstep, and there is no schema validation at either end.
- The colour normalisation loop (uint8 → float32) allocates N × 4 × 3 = 12N extra bytes. For 5 M points this is 60 MB additional heap. An alternative is to use an InterleavedBuffer with a custom shader that reads uint8 colour directly on the GPU, but this adds shader complexity.

### Implications for Future Work
- Adding a 1-byte classification field (floor / wall / ceiling / clutter) per point would enable colour-by-class in the viewer. The format would change to uint32 N | float32 N*3 XYZ | uint8 N*3 RGB | uint8 N classification; the JavaScript reader would need a corresponding classData typed array.
- For very large clouds (>20 M points), consider a streaming / tiled approach: the backend serves multiple binary chunks keyed by spatial tile, and the frontend loads only tiles visible in the current camera frustum.
