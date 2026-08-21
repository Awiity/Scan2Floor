# Architecture Decision Records — Scan2Floor Frontend

This directory contains Architecture Decision Records (ADRs) for the **frontend** of the Scan2Floor application.

ADRs capture significant technical decisions made during development, including the context, the options considered, and the rationale for the choice made.

## Format

Each ADR follows the [MADR](https://adr.github.io/madr/) template:

- **Status** — Proposed / Accepted / Deprecated / Superseded
- **Context** — The problem being solved and the forces at play
- **Decision** — What was decided
- **Consequences** — The resulting trade-offs

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-FE-001](./ADR-FE-001-framework-and-build-tool.md) | Framework & Build Tool (React + Vite) | Accepted |
| [ADR-FE-002](./ADR-FE-002-3d-rendering-library.md) | 3D Rendering Library (React Three Fiber + Three.js) | Accepted |
| [ADR-FE-003](./ADR-FE-003-2d-floor-plan-canvas.md) | 2D Floor Plan Renderer (HTML5 Canvas) | Accepted |
| [ADR-FE-004](./ADR-FE-004-state-management.md) | State Management Strategy (Local React State) | Accepted |
| [ADR-FE-005](./ADR-FE-005-api-communication.md) | API Communication Pattern (Fetch + Polling) | Accepted |
| [ADR-FE-006](./ADR-FE-006-coordinate-system.md) | Coordinate System Convention (Y-up, centred) | Accepted |
| [ADR-FE-007](./ADR-FE-007-binary-pointcloud-format.md) | Binary Point Cloud Streaming Format | Accepted |
| [ADR-FE-008](./ADR-FE-008-styling-approach.md) | Styling Approach (Vanilla CSS + CSS Variables) | Accepted |
| [ADR-FE-009](./ADR-FE-009-build-output-colocation.md) | Build Output Co-location with Backend | Accepted |
| [ADR-FE-010](./ADR-FE-010-floor-clipping-planes.md) | Per-floor Isolation via WebGL Clipping Planes | Accepted |
