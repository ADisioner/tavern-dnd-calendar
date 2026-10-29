# Compact Table Tools and Rulers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the permanent right inspector, replace the side controls with a compact right dock, and add 5 ft/cell rulers for line, cone, sphere, square, and token movement.

**Architecture:** Keep room/scene data unchanged. The inspector becomes an on-demand overlay; Canvas owns only local, transient measurement gestures and previews. Pure world-coordinate helpers derive grid snapping, geometry, and feet labels from `gridSize`.

**Tech Stack:** React, TypeScript, react-konva, Node test runner.

**Spec:** [2026-10-29-compact-table-tools-design.md](../specs/2026-10-29-compact-table-tools-design.md)

## Global Constraints

- One grid cell represents 5 ft; use the scene's current `gridSize` pixels per cell.
- Keep measurement layers local and transient; do not mutate `TableScene` or shared transport.
- Preserve scene, grid, participant, brush, token edit, and library actions behind the collapsed panel/dock.
- Token move continues to use existing lease, snap, bounds, and group-motion handlers.
- No deployment or GitHub upload without a separate request.

## Review Focus

- A zero-length gesture or a pointer leaving the map must not leave a stale ruler; cover with measurement gesture/cancel tests.
- Camera zoom/pan must not change calculated feet; cover with world-coordinate geometry tests.
- Selecting movement measurement must still select and drag tokens; cover with Canvas regression tests.
- A hidden inspector must be reachable by keyboard and remain scrollable on mobile; check accessible labels and responsive layout.
- Switching tools/Escape must clear previews without touching persistent drawings; cover with Canvas tests.

---

### Task 1: Measurement geometry

**Files:**
- Create: `lib/table/measurement.ts`
- Test: `scripts/table-measurement.test.mjs`
- Modify: `package.json` only if the test command enumerates files explicitly.

**Interfaces:**
- Produces `MeasureMode = 'line' | 'cone' | 'sphere' | 'square' | 'move'`, `snapMeasurePoint(point, gridSize)`, `distanceFeet(from, to, gridSize)`, and `areaPoints(mode, from, to, gridSize)`.
- Distances use world coordinates; one `gridSize` is 5 ft. Area shape endpoints align to cell centers; square side is the larger snapped axis delta.

- [ ] Write tests for 5 ft per cell, diagonal distance, cell-center snapping, line endpoints, cone orientation, sphere radius, equal-sided square, and invalid grid size.
- [ ] Run `node --test scripts/table-measurement.test.mjs` and confirm the new exports fail.
- [ ] Implement the pure helpers in `lib/table/measurement.ts`.
- [ ] Run the focused test and confirm all measurement cases pass.

### Task 2: Local ruler gestures and Canvas preview

**Files:**
- Modify: `app/table/table-canvas.tsx`
- Test: `scripts/table-input.test.mjs`
- Consume: `MeasureMode`, `snapMeasurePoint`, `distanceFeet`, `areaPoints` from Task 1.

- [ ] Add failing Canvas tests for each measurement gesture, feet labels, Escape/tool-switch cleanup, and movement-distance preview during an unchanged token drag.
- [ ] Run the focused input tests and confirm the new cases fail.
- [ ] Add a transient measurement gesture and an overlay layer above the map and below tokens; render line, cone, circle, and square with their distance labels.
- [ ] In movement mode, show the selected/dragged token's start-to-current path and distance while retaining the existing token drag handlers.
- [ ] Run the focused Canvas tests and confirm all ruler gestures pass without adding scene mutations.

### Task 3: Compact tool dock and collapsible inspector

**Files:**
- Modify: `app/table/table-app.tsx`
- Modify: `app/table/table.css`
- Test: `scripts/table-app.test.mjs`

- [ ] Add failing layout/interaction tests for a closed inspector, drawer toggle, compact tool actions, ruler submenu modes, and mode props passed to Canvas.
- [ ] Run the focused table-app tests and confirm the new cases fail.
- [ ] Remove the permanent inspector grid column; render the existing inspector as a closeable overlay and add a compact right-edge dock styled after the supplied reference.
- [ ] Expose select, hand, grid snap, draw, erase, add token, ruler modes, library, and inspector controls with keyboard labels and pressed/expanded state.
- [ ] Run focused app tests and confirm all existing sidebar actions remain available.

### Task 4: Project notes and final verification

**Files:**
- Modify: `knowledge/01 Проект/Текущее состояние.md`
- Modify: `knowledge/02 Система/Игровой стол.md`
- Modify: `knowledge/04 Журнал/YYYY-MM-DD.md`

- [ ] Update notes with the local overlay behavior, grid conversion, and current limitations.
- [ ] Run the affected test suites, `npx tsc --noEmit`, `npm run build`, and `git diff --check`.
- [ ] Record actual outcomes; leave publishing for a separate request.
