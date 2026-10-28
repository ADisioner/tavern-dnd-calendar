export type Point = { x: number; y: number };
export type Camera = Point & { scale: number };
export function screenToWorld(point: Point, camera: Camera): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}
export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}
export function zoomAt(camera: Camera, point: Point, factor: number, minScale = 0.15, maxScale = 3): Camera {
  const world = screenToWorld(point, camera);
  const scale = Math.min(maxScale, Math.max(minScale, camera.scale * factor));
  return { x: point.x - world.x * scale, y: point.y - world.y * scale, scale };
}
export function snapCenter(point: Point, gridSize: number, enabled = true): Point {
  if (!enabled || gridSize <= 0) return { ...point };
  return { x: Math.round((point.x - gridSize / 2) / gridSize) * gridSize + gridSize / 2,
    y: Math.round((point.y - gridSize / 2) / gridSize) * gridSize + gridSize / 2 };
}
export function fitCamera(content: { width: number; height: number }, viewport: { width: number; height: number }, padding = 32): Camera {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = Math.min((viewport.width - padding * 2) / content.width, (viewport.height - padding * 2) / content.height);
  const safeScale = Math.max(0.01, Math.min(3, scale));
  return { x: (viewport.width - content.width * safeScale) / 2, y: (viewport.height - content.height * safeScale) / 2, scale: safeScale };
}
