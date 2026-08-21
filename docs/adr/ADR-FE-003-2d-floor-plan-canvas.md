# ADR-FE-003: 2D Floor Plan Renderer — HTML5 Canvas (Imperative)

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The vectorised floor plan (walls, rooms, doors, windows) needs to be displayed in a dedicated 2D panel alongside the 3D viewport. The panel must support:

- **Pan & zoom** with mouse drag and scroll wheel.
- **Add Wall** mode: click two endpoints, snap to existing endpoints or 0.5 m grid.
- **Delete Wall** mode: hover highlights nearest wall segment, click removes it.
- **Undo / redo** (up to 50 steps).
- **Room fills** with individual colour-coded bounding boxes and centroid labels.
- **Door and window symbols** drawn as standard architectural notation.
- **Scale bar** and **compass** overlay.
- **Animated camera pan** to the selected room (300 ms easeInOut) driven from outside the component via highlightedRoomId prop.
- **Save edits** to the backend (PUT /api/walls/{floor}), which triggers a backend room-detection re-run.

The floor plan data changes only when the backend pipeline finishes (not continuously), and mouse-driven redrawing happens at up to 60 fps during pan/zoom/hover.

### Forces

- The rendering must be fully controllable from JavaScript at the pixel level (glow effects, dashed lines for low-confidence openings, snap crosshair indicator).
- React's virtual DOM re-render cycle would add unnecessary overhead for 60 fps canvas redraws driven by mouse events; the scene needs to be scheduled via equestAnimationFrame manually.
- The component must not re-render the full React tree on every mouse move.
- The editor's mutable state (camera offset, hovered line index, snap target, add-wall first point) changes at 60 fps and must never trigger React re-renders.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Imperative HTML5 Canvas + RAF** | Full pixel control, 60 fps without React re-renders, glow / shadow effects trivial | Requires careful ref management to avoid stale closures |
| SVG (declarative in JSX) | Clean DOM-based coordinate transforms; accessibility | Poor performance for 60 fps hover effects on hundreds of segments; CSS filter glow is expensive |
| Konva / react-konva | Abstraction over canvas, React-like API | Extra dependency; abstraction leaks for glow/shadow; adds bundle weight |
| Three.js 2D (orthographic) | Consistent with 3D renderer | Overkill for 2D; no built-in text rendering; hard to achieve sharp pixel-perfect lines |

---

## Decision

Use an **imperative HTML5 <canvas> element** managed through a canvasRef, with all drawing scheduled via equestAnimationFrame through a scheduleDraw() callback. A ResizeObserver keeps canvas pixel dimensions in sync with CSS layout dimensions.

### Architectural pattern — dual-track state

Because mouse events fire at up to 60 fps but React's batched state updates are intentionally coarse, two parallel tracks are maintained:

**React state** (triggers re-renders when changed):
`
editedLines, editMode, hoveredLine, addStep, isDirty, saveState, undoStack, redoStack
`

**Mutable refs** (updated synchronously in event handlers, read by the RAF draw loop):
`
editModeRef, editedLinesRef, addStepRef, hoveredLineRef, snapRef, dragRef, camRef
`

Every setter that updates React state (setEditedLines(...)) also immediately updates the corresponding ref (editedLinesRef.current = ...) so the RAF loop always reads fresh values without needing to schedule a React re-render.

### Draw pipeline

Each scheduleDraw() call cancels any pending RAF and schedules a new one. The draw function executes in order:

1. Clear canvas (fill #070b18)
2. drawGrid — 5 m grid lines in canvas space
3. drawRooms — colour-coded bounding box fills + centroid labels
4. drawEditedWalls — glow outline + solid line for each wall segment; in-progress wall preview dashed line; snap crosshair
5. drawOpenings — door arcs + window dashed lines, sorted so low-confidence (amber dashed) renders on top
6. drawScale — adaptive scale bar (1 / 2 / 5 / 10 / 20 m candidates)
7. drawCompass — red/white north arrow

---

## Consequences

### Positive
- 60 fps pan/zoom with no React reconciliation overhead.
- Arbitrary glow (ctx.shadowBlur), dashed lines (ctx.setLineDash), and gradient fills are trivially composited.
- The entire editor state is self-contained inside FloorPlanViewer.jsx; no external state management library is needed.

### Negative / Trade-offs
- The dual-track ref / state pattern is verbose and requires discipline: forgetting to update a ref after a state setter leaves the RAF loop with stale data. This is the most common source of subtle bugs in this component.
- useEffect dependency arrays for callbacks that read mutable refs must be carefully audited; several effects intentionally carry // eslint-disable-line react-hooks/exhaustive-deps because refs are intentionally excluded from deps.
- Accessibility (screen reader support) is not possible for canvas-drawn content without a separate ARIA layer.

### Implications for Future Work
- If the wall count grows beyond ~5 000 segments, spatial indexing (e.g., an R-tree) should replace the O(n) linear scan in indNearestLine.
- Multi-select and drag-to-move wall editing could be added by extending the editMode state machine without changing the draw pipeline.
