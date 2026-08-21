# ADR-FE-002: 3D Rendering Library — React Three Fiber + Three.js

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The primary visualisation surface is a 3D point cloud of up to 114 M downsampled points (stored as a binary pointcloud.bin) plus an optional Matterport GLB mesh overlay. The viewer needs:

- Orbit controls (pan, zoom, rotate)
- Per-floor clipping planes to isolate individual storeys
- Smooth camera animation when a room is selected
- A coordinate gizmo (orientation indicator in the corner)
- Transparent, composited rendering (the point cloud is semi-transparent; a bright room-highlight overlay is rendered on top)

### Forces

- The team already knows React; any 3D library should integrate with React's component model.
- WebGL performance is paramount: THREE.BufferGeometry with typed arrays (Float32Array, Uint8Array) must be used directly to avoid per-frame garbage.
- The point cloud geometry is loaded once and reused across two <points> draw calls (base + room highlight overlay) without cloning.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **React Three Fiber + Drei** | Declarative Three.js in JSX, full hook integration (useFrame, useThree), Drei helpers (OrbitControls, GizmoHelper, Grid) | Slight overhead vs raw Three.js imperative API |
| Raw Three.js + DOM canvas | Maximum control, no abstraction overhead | No React lifecycle integration; manual scene graph management |
| Babylon.js | Mature, built-in physics and GUI | Heavier bundle; weaker React integration; smaller ecosystem for architectural tooling |
| CesiumJS | Excellent geospatial | Excessive for indoor architectural scale; licence complexity |

---

## Decision

Use **@react-three/fiber (R3F) ^9** as the React renderer for Three.js and **@react-three/drei ^10** for helpers.

Key decisions within this choice:

1. **<Canvas>** mounts in a div.canvas-wrap that occupies the entire viewport minus the sidebar, using ntialias: true and localClippingEnabled: true.
2. **<OrbitControls>** from Drei is used via ef so that CameraFocuser can manipulate the target imperatively inside a useFrame loop without triggering React re-renders.
3. **<CameraFocuser>** is a null-render component that lives inside the <Canvas> and drives smooth camera animation (450 ms cubic easeInOut) via useFrame, interpolating both controls.target and camera.position.
4. **<GizmoHelper> + <GizmoViewport>** provide the corner axis indicator without any custom imperative code.

---

## Consequences

### Positive
- R3F's reconciler maps JSX props directly to Three.js object properties, eliminating most imperative mutation boilerplate.
- useThree() provides clean access to camera, gl, and scene inside deep component trees.
- Drei's <Grid> and <OrbitControls> handle edge cases (camera near/far clipping, damping) transparently.
- localClippingEnabled: true on the <Canvas> gl prop is required exactly once; all per-material clipping planes work automatically thereafter.

### Negative / Trade-offs
- R3F's rendering loop runs independently of React's update cycle, which means refs must be used for values that change every frame (camera position, controls target) to avoid triggering expensive React reconciliation.
- Two <points> draw calls share the same BufferGeometry object; care must be taken not to dispose the geometry while both meshes reference it.
- The <primitive object={...}> pattern used for GLB scenes bypasses R3F's reconciler; imperative traversal (obj.traverse) is still required for material and clipping-plane updates on mesh children.

### Implications for Future Work
- If the point count rises beyond ~20 M visible points, consider WebGL instancing or LoD (Level of Detail) streaming from the backend.
- Custom shader materials (e.g., for classification colour-coding by wall/floor/ceiling) can be introduced via <shaderMaterial> without architectural changes.
