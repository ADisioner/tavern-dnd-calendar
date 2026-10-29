import test from 'node:test';
import assert from 'node:assert/strict';
import { areaPoints, distanceFeet, snapMeasurePoint } from '../lib/table/measurement.ts';

const closeTo = (actual, expected, epsilon = 0.001) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} was not within ${epsilon} of ${expected}`);

test('measurement points snap to world-space grid cell centers', () => {
  assert.deepEqual(snapMeasurePoint({ x: 89, y: 124 }, 80), { x: 120, y: 120 });
  assert.deepEqual(snapMeasurePoint({ x: 40, y: 40 }, 80), { x: 40, y: 40 });
});

test('each grid square represents five feet, including geometric diagonal distance', () => {
  closeTo(distanceFeet({ x: 40, y: 40 }, { x: 120, y: 40 }, 80), 5);
  closeTo(distanceFeet({ x: 40, y: 40 }, { x: 120, y: 120 }, 80), 7.1);
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
