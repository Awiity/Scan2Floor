# ADR-FE-005: API Communication Pattern — Native Fetch + Polling

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The frontend communicates with the FastAPI backend for:

1. **Status checks** — GET /api/status to determine whether the point cloud is ready.
2. **File browser** — GET /api/scan/browse to list .xyz files on the server.
3. **Pipeline control** — POST /api/pipeline/run, POST /api/pipeline/cancel, GET /api/pipeline/status.
4. **Data reads** — GET /api/pointcloud (binary), GET /api/walls/{floor}, GET /api/rooms/{floor}, GET /api/openings/{floor}.
5. **Data writes** — PUT /api/walls/{floor} (wall edits), POST /api/xyz-path (manual path entry).
6. **Long-running operation monitoring** — the backend pipeline can take 6–10 minutes; the frontend must show live stage progress and a log tail.

### Forces

- The backend does not support WebSockets or Server-Sent Events (SSE) — it is a standard FastAPI REST server.
- The pointcloud.bin response can be hundreds of megabytes and must be streamed as an ArrayBuffer (not JSON).
- For pipeline monitoring, real-time updates are desirable but the latency of 2-second polling is acceptable given that pipeline stages each take 1–4 minutes.
- No authentication is required (local / Docker deployment only).
- Adding an HTTP client library (Axios, SWR, React Query) would provide caching, retries, and devtools, but adds a dependency.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Native etch + setInterval polling** | Zero dependencies, familiar API, fine-grained control over binary streaming | Manual error handling and cleanup required |
| React Query / TanStack Query | Cache management, background refetch, devtools | Dependency; polling interval config is per-query, not global |
| SWR | Lightweight, revalidation on focus | Less control over binary responses; opinionated cache |
| WebSocket (if backend supported) | True push; no polling overhead | Backend would need significant refactoring |
| Axios | Interceptors, cancellation | Dependency; no benefit over fetch for this use case |

---

## Decision

Use the **native browser etch API** for all API calls, with **setInterval-based polling** for long-running operations.

### Polling strategy

Two separate polling loops run independently:

| Loop | Interval | Location | Purpose |
|------|----------|----------|---------|
| Backend health | 7 s (POLL_MS) | App.jsx useEffect | Sets ackendStatus + modelInfo |
| Pipeline progress | 2 s | Sidebar.jsx startPoll() / stopPoll() | Updates pipeStatus, stage indicators, log tail |

The pipeline poll is started on POST /api/pipeline/run success and stopped as soon as status.running becomes alse. A useEffect cleanup returns stopPoll to prevent the interval from leaking on unmount.

### Cancellation pattern

All data-fetching useEffect hooks follow the cancelled-flag pattern to prevent state updates after unmount:

`js
useEffect(() => {
  let cancelled = false;
  fetch('/api/rooms/' + floor)
    .then(r => r.json())
    .then(d => { if (!cancelled) setRooms(d?.rooms ?? []); })
    .catch(() => { if (!cancelled) setRooms([]); });
  return () => { cancelled = true; };
}, [floor, dataVersion]);
`

### Binary streaming

GET /api/pointcloud returns a custom binary format (uint32 count + loat32 positions + uint8 colours). The response is consumed as .arrayBuffer() and directly wrapped in typed arrays (Float32Array, Uint8Array) without any intermediate copy, then attached to a THREE.BufferGeometry.

### Cache busting

Because the browser aggressively caches binary responses:
- pointcloud.bin is fetched with ?v=<timestamp> after a pipeline reprocess.
- mesh.glb is fetched with ?v=<Date.now()> on every mount.

---

## Consequences

### Positive
- No dependencies beyond the browser's built-in etch.
- Binary streaming is straightforward with .arrayBuffer().
- Polling cleanup is explicit and verifiable.

### Negative / Trade-offs
- No automatic retry on transient network failure (backend container restart mid-session). The UI falls back to showing "Backend offline" and recovers on the next poll cycle.
- Each component that needs data fetches independently (e.g., RoomListPanel and App.jsx both fetch /api/rooms/{floor}). This duplicates HTTP requests. A shared data layer (React Query) would deduplicate these.
- Polling 2 s during a 10-minute pipeline generates ~300 HTTP requests. This is negligible for a local deployment but would need redesign for multi-user or cloud scenarios.

### Future Trigger for Re-evaluation
- If a public cloud deployment is added, replace polling with SSE (GET /api/pipeline/events) and add React Query for caching /api/walls, /api/rooms, and /api/openings.
