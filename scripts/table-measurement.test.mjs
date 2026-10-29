import test from 'node:test';
import assert from 'node:assert/strict';
import { areaPoints, distanceFeet, measurementMessageSchema, snapMeasurePoint } from '../lib/table/measurement.ts';

const closeTo = (actual, expected, epsilon = 0.001) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} was not within ${epsilon} of ${expected}`);

test('measurement points snap to world-space grid cell centers', () => {
  assert.deepEqual(snapMeasurePoint({ x: 89, y: 124 }, 80), { x: 120, y: 120 });
  assert.deepEqual(snapMeasurePoint({ x: 40, y: 40 }, 80), { x: 40, y: 40 });
});

test('each crossed grid cell represents five feet regardless of point position', () => {
  closeTo(distanceFeet({ x: 4, y: 4 }, { x: 75, y: 75 }, 80), 0);
  closeTo(distanceFeet({ x: 4, y: 4 }, { x: 84, y: 84 }, 80), 5);
  closeTo(distanceFeet({ x: 4, y: 4 }, { x: 279, y: 199 }, 80), 15);
});

test('line and square measurements align to grid cells', () => {
  assert.deepEqual(areaPoints('line', { x: 40, y: 40 }, { x: 121, y: 201 }, 80), [
    { x: 40, y: 40 }, { x: 120, y: 200 },
  ]);
  const square = areaPoints('square', { x: 40, y: 40 }, { x: 120, y: 200 }, 80);
  assert.deepEqual(square, [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 200 }, { x: 40, y: 200 }]);
});

test('sphere preview uses the dragged radius and cone points toward the drag endpoint', () => {
  const sphere = areaPoints('sphere', { x: 40, y: 40 }, { x: 200, y: 40 }, 80);
  assert.equal(sphere.length, 32);
  closeTo(Math.hypot(sphere[0].x - 40, sphere[0].y - 40), 160);
  const cone = areaPoints('cone', { x: 40, y: 40 }, { x: 200, y: 40 }, 80);
  assert.equal(cone[0].x, 40); assert.equal(cone[0].y, 40);
  assert.equal(cone.at(-1).x, 40); assert.equal(cone.at(-1).y, 40);
  assert.ok(cone.slice(1, -1).every(point => point.x > 40));
});

test('shared measurements validate bounded-shaped ephemeral frames and explicit clears', () => {
  const measurementId = crypto.randomUUID(), sceneId = crypto.randomUUID();
  assert.equal(measurementMessageSchema.parse({ type: 'measurement-frame', measurementId, sceneId, seq: 2, mode: 'cone', from: { x: 0, y: 0 }, to: { x: 80, y: 160 } }).type, 'measurement-frame');
  assert.equal(measurementMessageSchema.parse({ type: 'measurement-frame', measurementId, sceneId, seq: 2, mode: 'move', from: { x: 0, y: 0 }, to: { x: 80, y: 160 } }).mode, 'move');
  assert.equal(measurementMessageSchema.parse({ type: 'measurement-clear', measurementId, sceneId, seq: 3 }).type, 'measurement-clear');
  assert.equal(measurementMessageSchema.safeParse({ type: 'measurement-frame', measurementId, sceneId, seq: 1, mode: 'square', from: { x: NaN, y: 0 }, to: { x: 0, y: 0 } }).success, false);
});
