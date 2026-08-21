# ADR-FE-009: Build Output Co-location with Backend

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The application is deployed as a **single Docker container** that serves both the FastAPI backend (on port 8000) and the React frontend as static files. Two deployment modes exist:

1. **Development:** Vite dev server on :5173 proxies /api and /model requests to FastAPI on :8000.
2. **Production / Docker:** FastAPI uses StaticFiles middleware to serve the Vite production build from a dist/ directory alongside the Python package.

The Dockerfile must copy the compiled frontend assets into the container image. The simplest and most reliable approach is to have the Vite build write directly into the backend's directory tree, so a single COPY backend/ /app/ step in the Dockerfile captures everything.

### Forces

- The Docker build context does not include a separate frontend build step in the current docker-compose.yml; the frontend must be pre-built on the host before docker build.
- The backend's StaticFiles mount path is dist/ relative to the FastAPI app root (ackend/).
- Keeping the build output outside ackend/ would require either a multi-stage Docker build (adding complexity) or a separate COPY instruction for frontend assets.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **outDir: '../backend/dist'** | Single COPY backend/ in Dockerfile; no multi-stage build | Frontend dist/ appears inside the backend source tree; git clean would remove it |
| outDir: 'dist' (default) + multi-stage Docker build | Clean separation of concerns | More complex Dockerfile; requires Node.js stage in Docker |
| outDir: 'dist' + explicit COPY frontend/dist backend/dist | Clean | Two source trees to manage in Dockerfile; easy to forget |
| Monorepo workspace (turborepo/nx) | Best-practice separation | Significant setup overhead for a two-package project |

---

## Decision

Set Vite's uild.outDir to '../backend/dist' in [ite.config.js](file:///c:/Users/AWIT/Desktop/WORK/scan2floor/frontend/vite.config.js):

`js
build: {
  outDir: '../backend/dist',
  emptyOutDir: true,
},
`

This means:
- Running 
pm run build in rontend/ writes index.html, ssets/, etc. directly into ackend/dist/.
- The Dockerfile COPY backend/ /app/ picks up the compiled frontend automatically.
- emptyOutDir: true ensures stale assets from previous builds are purged.

The Vite dev server proxy configuration avoids CORS issues during development:

`js
server: {
  port: 5173,
  proxy: {
    '/model': { target: 'http://localhost:8000', changeOrigin: true },
    '/api':   { target: 'http://localhost:8000', changeOrigin: true },
  },
},
`

---

## Consequences

### Positive
- The Dockerfile remains simple: no multi-stage build, no separate frontend COPY instruction.
- ackend/dist/ is the single source of truth for deployable frontend assets.
- emptyOutDir: true prevents stale chunk files accumulating across builds.

### Negative / Trade-offs
- ackend/dist/ is a generated directory that should be added to .gitignore. Developers who forget to run 
pm run build before docker build will include an old or empty dist/.
- The ackend/dist/ directory appearing in the backend package tree can confuse static analysis tools or IDE import resolution.
- If the project ever adopts CI/CD, the build pipeline must run 
pm run build in rontend/ before building the Docker image.

### Mitigations
- ackend/dist/ is listed in .gitignore (confirmed).
- docker-build.bat should be updated to run 
pm run build in rontend/ before docker build to enforce correct ordering (currently a manual step).

### Implications for Future Work
- If a separate CDN deployment of frontend assets is needed, the outDir can be reverted to dist/ and a multi-stage Dockerfile adopted. The only file to change is ite.config.js.
