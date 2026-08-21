# ADR-FE-006: Coordinate System Convention — Y-up, Horizontally Centred

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

Matterport .xyz files use a **Z-up right-handed coordinate system**:
- X — horizontal east
- Y — horizontal north
- Z — vertical height

Three.js (and WebGL) uses a **Y-up right-handed coordinate system**:
- X — horizontal east
- Y — vertical height
- Z — horizontal depth (towards viewer)

Additionally, real-world building scans may have horizontal centroid offsets of 10–20 m from the origin because the Matterport tripod starts from an arbitrary geodetic position. Large offsets cause numerical precision issues in WebGL (floating-point jitter at large world coordinates) and make orbit controls unintuitive.

The 2D floor plan viewer uses its own **canvas coordinate system** where the world X-axis maps to canvas X and the world Z-axis (Three.js Z) maps to canvas Y, with a configurable { scale, ox, oy } camera transform.

### Forces

- The coordinate transform must be applied **once, server-side**, so all downstream consumers (frontend, DXF export, JSON APIs) operate in the same normalised space.
- The Three.js scene must not require any global rotation matrix; transforms should be either declarative JSX props or absorbed into the geometry.
- The 2D floor plan must use the same horizontal axes as the 3D scene so that room bounding boxes selected in 2D correctly illuminate points in 3D.

---

## Decision

The backend preprocess_xyz.py applies the following canonical transform to every point before writing pointcloud.bin:

`
pos_yup.x  =  raw_x − cx        (centred horizontal east)
pos_yup.y  =  raw_z             (Matterport Z = height → Three.js Y)
pos_yup.z  = −(raw_y − cy)     (centred horizontal north, negated for Three.js Z)
`

Where (cx, cy) is the horizontal centroid of the entire point cloud computed in Pass 1 of preprocessing.

**All JSON outputs** (walls_floor_N.json, ooms_floor_N.json, openings_floor_N.json) use the same (x, z) horizontal convention — world X and world Z — matching Three.js.

**The OBJ/GLB mesh** is served in Matterport's original Z-up convention. The frontend applies the identical transform as a declarative <group> rotation:

`jsx
<group rotation-x={-Math.PI / 2} position={[-cx, 0, cy]}>
  <primitive object={obj} />
</group>
`

This otation-x = −π/2 swaps the Y and Z axes, and the position re-centres the mesh on the point cloud origin.

**The 2D canvas** maps world.x → canvas.x and world.z → canvas.y, so no additional negation is needed for the floor plan view.

---

## Consequences

### Positive
- All three renderers (3D point cloud, 3D mesh, 2D floor plan) operate in the same coordinate space. Selecting a room in the 2D view and focusing on it in the 3D view requires no coordinate conversion.
- Centering eliminates WebGL floating-point precision issues for buildings offset up to ±52 km from origin (matching the backend's ±2²⁰ voxel offset).
- The transform is deterministic and reversible: DXF/SVG export applies the inverse shift to restore real-world metric coordinates for downstream CAD tools.

### Negative / Trade-offs
- The OBJ/GLB alignment depends on modelInfo.centroid_xy arriving from the backend before the mesh is rendered. If modelInfo is null on first render, the mesh appears at the wrong position until the next status poll resolves it. This was the source of a known bug (mesh offset by ~17 m) that was fixed by making cx, cy a declarative derived value on <group> rather than a one-shot imperative effect (documented in OBJModel.jsx header).
- Architects using the raw DXF output must be aware that coordinates are relative to the point cloud centroid, not geodetic coordinates or a project datum.

### Implications for Future Work
- If geodetic alignment (GPS / IFC coordinates) is added, the centroid offset should be stored in info.json alongside loor_levels so it can be added back during DXF export as a INSBASE offset.
