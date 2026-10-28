import type { Point } from './geometry.ts';
import type { TableScene } from './scene.ts';

export function tokensInRect(scene: TableScene, from: Point, to: Point): string[] {
  const left = Math.min(from.x, to.x), right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y), bottom = Math.max(from.y, to.y);
  return scene.tokens.filter(token => {
    const closestX = Math.max(left, Math.min(right, token.x));
    const closestY = Math.max(top, Math.min(bottom, token.y));
    return Math.hypot(token.x - closestX, token.y - closestY) <= token.size * scene.gridSize / 2;
  }).map(token => token.id);
}
