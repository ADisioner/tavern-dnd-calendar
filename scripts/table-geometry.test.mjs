import test from 'node:test';
import assert from 'node:assert/strict';
import {
  screenToWorld,
  worldToScreen,
  zoomAt,
  snapCenter,
  fitCamera,
} from '../lib/table/geometry.ts';

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`);

test('screen and world transforms invert with fractional camera values', () => {
  const camera = { x: 123.75, y: -48.5, scale: 0.83 };
  const point = { x: -47.25, y: 319.6 };
  const screen = worldToScreen(point, camera);
  const world = screenToWorld(screen, camera);
  close(world.x, point.x);
  close(world.y, point.y);
});

test('zoom keeps the world point under the cursor fixed', () => {
  const camera = { x: 135.25, y: -62.75, scale: 0.72 };
  const cursor = { x: 417.5, y: 286.25 };
  const worldBefore = screenToWorld(cursor, camera);
  const zoomed = zoomAt(camera, cursor, 1.6);
  const worldAfter = screenToWorld(cursor, zoomed);
  close(worldAfter.x, worldBefore.x);
  close(worldAfter.y, worldBefore.y);
  assert.equal(zoomed.scale, camera.scale * 1.6);
});

test('zoom clamps scale to its minimum and maximum', () => {
  assert.equal(zoomAt({ x: 0, y: 0, scale: 0.2 }, { x: 30, y: 40 }, 0.1, 0.15, 3).scale, 0.15);
  assert.equal(zoomAt({ x: 0, y: 0, scale: 2 }, { x: 30, y: 40 }, 4, 0.15, 3).scale, 3);
});

test('snapCenter selects cell centers for positive and negative coordinates', () => {
  assert.deepEqual(snapCenter({ x: 0, y: 39 }, 80), { x: 40, y: 40 });
  assert.deepEqual(snapCenter({ x: -41, y: -121 }, 80), { x: -40, y: -120 });
});

test('snapCenter leaves coordinates untouched when disabled', () => {
  const point = { x: -17.125, y: 82.75 };
  assert.deepEqual(snapCenter(point, 80, false), point);
});

test('fitCamera centers the map and keeps its bounds inside viewport padding', () => {
  const content = { width: 1600, height: 1120 };
  const viewport = { width: 1000, height: 720 };
  const padding = 32;
  const camera = fitCamera(content, viewport, padding);
  const topLeft = worldToScreen({ x: 0, y: 0 }, camera);
  const bottomRight = worldToScreen({ x: content.width, y: content.height }, camera);

  close((topLeft.x + bottomRight.x) / 2, viewport.width / 2);
  close((topLeft.y + bottomRight.y) / 2, viewport.height / 2);
  assert.ok(topLeft.x >= padding - 1e-9);
  assert.ok(topLeft.y >= padding - 1e-9);
  assert.ok(bottomRight.x <= viewport.width - padding + 1e-9);
  assert.ok(bottomRight.y <= viewport.height - padding + 1e-9);
});

