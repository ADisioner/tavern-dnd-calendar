import type { Point } from './geometry.ts';

export type MeasureMode = 'line' | 'cone' | 'sphere' | 'square' | 'move';
export type AreaMode = Exclude<MeasureMode, 'move'>;

function assertGridSize(gridSize: number) {
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new RangeError('Размер клетки должен быть положительным числом.');
}

export function snapMeasurePoint(point: Point, gridSize: number): Point {
  assertGridSize(gridSize);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Координаты измерения должны быть конечными.');
  return {
    x: Math.round((point.x - gridSize / 2) / gridSize) * gridSize + gridSize / 2,
    y: Math.round((point.y - gridSize / 2) / gridSize) * gridSize + gridSize / 2,
  };
}

export function distanceFeet(from: Point, to: Point, gridSize: number): number {
  const a = snapMeasurePoint(from, gridSize), b = snapMeasurePoint(to, gridSize);
  return Number((Math.hypot(b.x - a.x, b.y - a.y) / gridSize * 5).toFixed(1));
}

export function areaPoints(mode: AreaMode, from: Point, to: Point, gridSize: number): Point[] {
  const origin = snapMeasurePoint(from, gridSize), target = snapMeasurePoint(to, gridSize);
  if (mode === 'line') return [origin, target];
  if (mode === 'square') {
    const dx = target.x - origin.x, dy = target.y - origin.y;
    const side = Math.max(gridSize, Math.abs(dx), Math.abs(dy));
    const signX = dx < 0 ? -1 : 1, signY = dy < 0 ? -1 : 1;
    return [origin, { x: origin.x + signX * side, y: origin.y },
      { x: origin.x + signX * side, y: origin.y + signY * side }, { x: origin.x, y: origin.y + signY * side }];
  }
  const dx = target.x - origin.x, dy = target.y - origin.y;
  const length = Math.max(gridSize, Math.hypot(dx, dy)), angle = Math.atan2(dy, dx);
  if (mode === 'sphere') {
    return Array.from({ length: 32 }, (_, index) => {
      const theta = Math.PI * 2 * index / 32;
      return { x: origin.x + Math.cos(theta) * length, y: origin.y + Math.sin(theta) * length };
    });
  }
  // 5e cones widen to half their range at the far edge.
  const halfAngle = Math.atan(0.5), segments = 16;
  return [origin, ...Array.from({ length: segments + 1 }, (_, index) => {
    const theta = angle - halfAngle + (halfAngle * 2 * index / segments);
    return { x: origin.x + Math.cos(theta) * length, y: origin.y + Math.sin(theta) * length };
  }), origin];
}
