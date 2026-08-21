# ADR-FE-001: Framework & Build Tool — React + Vite

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The frontend needs to render large interactive 3D scenes (point clouds up to 114 M points), a custom 2D vector canvas editor, a pipeline control sidebar, and maintain low-latency polling against a Python FastAPI backend — all in a single-page application with no server-side rendering requirement.

### Forces

- Developers are already productive in JSX / component-oriented UI patterns.
- The 3D rendering ecosystem (@react-three/fiber, @react-three/drei) is deeply integrated with React.
- Development iteration speed is critical: hot-module replacement (HMR) should be near-instant even as individual component files grow large (e.g., FloorPlanViewer.jsx at ~1 000 lines).
- Production builds are copied directly into the FastAPI dist/ folder and served as static files, so the bundler must produce a clean, self-contained asset tree.
- No need for server-side rendering (SSR) or static-site generation (SSG).

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **React + Vite** | Native ESM dev server, sub-100 ms HMR, Rollup-based production bundle, first-class @vitejs/plugin-react | Rollup chunking can require config for very large bundles |
| React + Webpack (CRA) | Mature, widely documented | Slow HMR, deprecated CRA, heavy config overhead |
| Next.js | File-based routing, SSR | SSR adds complexity not needed; file routing overhead for a single-view app |
| Svelte + Vite | Smaller runtime | Poor ecosystem fit with @react-three/fiber |

---

## Decision

Use **React 19** as the UI library and **Vite 8** as the dev server and bundler.

Rationale:
- React Three Fiber (@react-three/fiber ^9) is built specifically for React and provides declarative Three.js rendering with full hook support, which is essential for the camera, clipping planes, and animated focus features.
- Vite's ES-module dev server eliminates cold-start latency and delivers HMR in under 200 ms for component-level changes, even in large single-component files.
- The @vitejs/plugin-react plugin uses Babel with React Fast Refresh, preserving hook state on edits.

---

## Consequences

### Positive
- Fast developer feedback loop; component edits reflect immediately in the browser.
- Vite's uild.outDir can be pointed at ../backend/dist, making the Dockerfile COPY step trivial.
- Full access to the React Three Fiber / Drei ecosystem.

### Negative / Trade-offs
- React 19 + concurrent features require careful use of useRef for mutable state that must not trigger re-renders (e.g., camRef, editedLinesRef inside FloorPlanViewer).
- Vite defaults to a single-chunk build for small apps; large endor chunks (Three.js ~650 kB gzipped) may need manual ollupOptions.output.manualChunks splitting in future.

### Implications for Future Work
- If SSR or incremental static regeneration is ever needed (e.g., a public project gallery), migrating to Next.js (App Router) would be the preferred path.
- Tree-shaking of Three.js sub-modules (	hree/addons) is already in place via named imports in GLTFLoader usage.
