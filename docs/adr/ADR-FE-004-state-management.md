# ADR-FE-004: State Management Strategy — Local React State (No External Store)

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The application manages several categories of state:

| Category | Examples |
|----------|---------|
| **Server status** | ackendStatus, modelInfo |
| **Layer visibility** | showMesh, showCloud, showFloorPlanViewer |
| **Loading progress** | meshLoading, cloudLoading, meshProgress |
| **Cross-component coordination** | selectedRoomId, oomsData, ctiveFloor |
| **Cache invalidation keys** | cloudReloadKey, loorDataVersion |
| **Editor internals** | editedLines, undoStack, editMode, isDirty |

The app is a **single-view SPA** with one primary App.jsx root. There are no multiple routes or independent page trees requiring shared global state.

### Forces

- Adding an external store (Redux, Zustand, Jotai) introduces a dependency, boilerplate, and a new mental model for every contributor.
- All state-sharing happens between App.jsx (parent) and its direct children (Sidebar, FloorPlanViewer, PointCloud, RoomListPanel, CameraFocuser). The component tree is shallow — at most 2 levels deep for any shared state.
- FloorPlanViewer is the most complex component; its internal editor state is entirely private and does not need to be shared upward.
- Version/reload keys (cloudReloadKey, loorDataVersion) need to propagate from Sidebar → App → child viewers, which is straightforward via callback props.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Local useState + prop drilling** | Zero dependencies, explicit data flow, trivial to trace | Prop count grows as components deepen |
| React Context | Avoids prop drilling for deeply nested state | Context re-renders all consumers on every change; overkill for a 2-level tree |
| Zustand | Lightweight, devtools, no provider boilerplate | External dependency; unnecessary abstraction for this scale |
| Redux Toolkit | Excellent devtools, predictable | Heavy for this app size; action/reducer boilerplate |

---

## Decision

Use **local useState + useReducer (where appropriate) + prop callbacks** throughout.

### Key patterns

1. **Version bump keys** — cloudReloadKey and loorDataVersion are plain integers/strings held in App.jsx. Children receive them as props. When the backend pipeline finishes, Sidebar calls onReprocessDone() / onWallsDetected(), which bumps the key, causing dependent useEffects to re-fetch.

2. **Derived state** — highlightedRoom (the full room object for the selected room) is computed inline in App.jsx from selectedRoomId + oomsData rather than stored separately, preventing stale caches.

3. **Private editor state** — All wall editing state (editedLines, undoStack, edoStack, editMode, isDirty, saveState) lives inside FloorPlanViewer and is never exposed upward. Save completion is signalled to the parent through the existing onWallsDetected callback.

4. **Mutable refs for hot-path state** — Values that change on every mouse event (camera offset, hovered line index, snap target) are kept in refs inside FloorPlanViewer and never in React state, preventing unnecessary re-renders in the RAF draw loop (see ADR-FE-003).

---

## Consequences

### Positive
- Zero additional dependencies.
- Data flow is explicit: every prop and callback is visible at the call site.
- The root App.jsx serves as a natural "state registry" for cross-component concerns, making the overall topology easy to understand.

### Negative / Trade-offs
- Sidebar receives ~12 props. If additional panels are added, prop drilling to App.jsx will increase and may warrant introducing React Context for a specific slice (e.g., ModelInfoContext).
- There is no devtools integration for inspecting state history — debugging requires console.log or browser React DevTools.

### Future Trigger for Re-evaluation
- If a second view-level route is added (e.g., a project list page), or if the component tree deepens beyond 3 levels of prop passing, introduce a lightweight store (Zustand) for the cross-cutting state categories listed above.
