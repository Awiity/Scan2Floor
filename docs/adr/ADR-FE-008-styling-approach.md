# ADR-FE-008: Styling Approach — Vanilla CSS + CSS Custom Properties

**Date:** 2026-08-21  
**Status:** Accepted  
**Deciders:** Scan2Floor core team

---

## Context

The application uses a dark, glassmorphism-inspired design language. UI elements require:

- A consistent colour palette (cyan, purple, amber, green, red semantic colours).
- Glassmorphism surfaces with ackdrop-filter: blur(...) and semi-transparent backgrounds.
- Responsive sidebar collapse animation (width + overflow transition).
- Component-level micro-animations (hover glow, status dot pulse, button transitions).
- Inline styles for components that compute values dynamically at runtime (e.g., FloorPlanViewer toolbar where active-tool colour is driven by state).

### Forces

- The design palette is small and fixed — a handful of semantic tokens covering backgrounds, borders, text levels, and accent colours. There is no need for a utility-class system of hundreds of tokens.
- ackdrop-filter and gba transparency require real CSS; they cannot be fully expressed in Tailwind's utility set without arbitrary values.
- Several components (FloorPlanViewer toolbar, RoomListPanel items) need **CSS custom properties set per-element** (e.g., --room-accent: #00c8e0) so that hover styles can reference the per-item accent via ar(--room-accent). This is not easily achieved with Tailwind.
- The project has a single developer / small team; a CSS-in-JS solution adds a runtime dependency and complicates server-rendering if ever adopted.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Vanilla CSS + CSS custom properties** | Zero dependency, full CSS feature set, native ar() for per-element tokens | Global namespace — class name collision risk in large codebases |
| Tailwind CSS | Utility-first, no dead CSS | Requires arbitrary values for most glassmorphism effects; ar() per-element not idiomatic |
| CSS Modules | Scoped class names | Extra build step, verbose styles.xxx imports |
| Styled-components / Emotion | Scoped, JS-driven | Runtime overhead; SSR hydration complexity |

---

## Decision

Use **vanilla CSS in index.css** with a global design token layer defined in :root, supplemented by **inline style={{...}} props** for values computed at runtime.

### Token structure (index.css :root)

`css
:root {
  --bg:          #070b18;
  --surface:     rgba(13, 20, 45, 0.88);
  --surface-2:   rgba(20, 30, 60, 0.75);
  --border:      rgba(0, 180, 255, 0.12);
  --border-hi:   rgba(0, 200, 255, 0.35);
  --cyan:        #00c8ff;
  --purple:      #8b5cf6;
  --green:       #10b981;
  --amber:       #f59e0b;
  --red:         #ef4444;
  --text-1:  #e2e8f0;   /* primary */
  --text-2:  #94a3b8;   /* secondary */
  --text-3:  #475569;   /* muted */
  --sidebar-w: 280px;
  --topbar-h:  56px;
}
`

### Per-element CSS custom properties (Room accent pattern)

RoomListPanel sets per-item accent via inline style, then a CSS rule picks it up:

`jsx
<button style={{ "--room-accent": accent, "--room-accent-dim": ${accent}22 }}>
`
`css
.room-list-item.selected {
  border-color: var(--room-accent);
  background: var(--room-accent-dim);
}
`

This avoids generating 10 individual colour utility classes per room.

### Inline styles policy

Inline style={{...}} props are used **only** when the value is computed from React state at render time (e.g., the sidebar toggle position left: sidebarCollapsed ? 0 : 'var(--sidebar-w)'). Static visual rules always go in index.css.

---

## Consequences

### Positive
- No dependency or build overhead for styling.
- CSS custom properties enable dynamic theming (dark → light) by swapping :root values without touching component code.
- Per-element --room-accent pattern is clean and performant.

### Negative / Trade-offs
- Global index.css namespace risks class name collision if the project grows to multiple pages. Mitigation: all class names are namespaced by component prefix (e.g., .room-list-panel, .room-list-item).
- Inline styles in FloorPlanViewer's toolbar sub-components are verbose. In a larger team, CSS Modules would be preferable for these components.
- No automatic dead-code elimination for unused CSS rules — Vite's @vitejs/plugin-purge or PurgeCSS would need to be added if bundle size becomes a concern.

### Implications for Future Work
- If a second theme (light mode, high-contrast) is required, add a data-theme="light" attribute to <html> and override :root tokens in a [data-theme="light"] block.
