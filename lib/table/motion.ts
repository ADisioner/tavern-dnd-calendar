import { z } from 'zod';
import { linkedTokens, boundedGroupPoint, type TableToken, type TableScene } from './scene.ts';

export const MAX_TABLE_MESSAGE_BYTES = 65536;
export const MOTION_INTERVAL = 50;
export const MOTION_LEASE_MS = 3000;
const position = { x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(1120) };
const identity = { motionId: z.string().uuid(), sceneId: z.string().uuid(), tokenId: z.string().uuid() };
export const motionMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('motion-start'), ...identity, expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('motion-frame'), ...identity, seq: z.number().int().nonnegative(), ...position }).strict(),
  z.object({ type: z.literal('motion-end'), ...identity, seq: z.number().int().nonnegative(), ...position }).strict(),
  z.object({ type: z.literal('motion-cancel'), ...identity }).strict(),
]);
export type MotionMessage = z.infer<typeof motionMessageSchema>;
export type MotionPoint = { x: number; y: number };
type Track = { motionId: string; from: MotionPoint; target: MotionPoint; started: number; duration: number; expires: number; local: boolean; finished?: boolean; userId?: string; name?: string };
export function boundedPoint(token: TableToken, gridSize: number, point: MotionPoint): MotionPoint {
  const r = token.size * gridSize / 2;
  return { x: Math.max(r, Math.min(1600 - r, point.x)), y: Math.max(r, Math.min(1120 - r, point.y)) };
}
// Include whole intersected groups so metadata/removal cannot change a leased group.
export function affectedMotionTokens(scene: TableScene, command: { type: string; tokenId?: string; tokenIds?: string[]; tokens?: { tokenId: string }[] }): TableToken[] {
  const ids = command.type === 'group' || command.type === 'ungroup' ? command.tokenIds ?? []
    : command.type === 'remove-many' ? command.tokens?.map(value => value.tokenId) ?? []
    : ['move', 'update', 'remove'].includes(command.type) && command.tokenId ? [command.tokenId] : [];
  return [...new Map(ids.flatMap(id => { const token = scene.tokens.find(value => value.id === id); return token ? linkedTokens(scene, token) : []; }).map(token => [token.id, token])).values()];
}
// This store is sampled directly by Konva's animation loop: no React tree update per frame.
export class MotionStore {
  tracks = new Map<string, Track>();
  position(tokenId: string, fallback: MotionPoint, now = performance.now()): MotionPoint {
    const track = this.tracks.get(tokenId);
    if (!track) return fallback;
    if (track.expires < now) { this.tracks.delete(tokenId); return fallback; }
    const t = track.duration ? Math.max(0, Math.min(1, (now - track.started) / track.duration)) : 1;
    return { x: track.from.x + (track.target.x - track.from.x) * t, y: track.from.y + (track.target.y - track.from.y) * t };
  }
  target(token: TableToken) { return this.tracks.get(token.id)?.target ?? { x: token.x, y: token.y }; }
  update(tokenId: string, motionId: string, point: MotionPoint, fallback: MotionPoint, options: { local?: boolean; duration?: number; userId?: string; name?: string; now?: number } = {}) {
    const now = options.now ?? performance.now();
    const existing = this.tracks.get(tokenId);
    if (existing?.local && !options.local && existing.motionId !== motionId) return;
    this.tracks.set(tokenId, { motionId, from: this.position(tokenId, fallback, now), target: point, started: now,
      duration: options.duration ?? (options.local ? 0 : 85), expires: now + MOTION_LEASE_MS + 1000, local: !!options.local, userId: options.userId, name: options.name });
  }
  updateGroup(scene: TableScene, token: TableToken, motionId: string, point: MotionPoint, options: Parameters<MotionStore['update']>[4] = {}) {
    const bounded = boundedGroupPoint(scene, token, point), dx = bounded.x - token.x, dy = bounded.y - token.y;
    for (const member of linkedTokens(scene, token)) this.update(member.id, motionId, { x: member.x + dx, y: member.y + dy }, member, options);
  }
  cancelMotion(motionId: string) { for (const [id, track] of this.tracks) if (track.motionId === motionId) this.tracks.delete(id); }
  finish(tokenId: string, motionId: string, point: MotionPoint, fallback: MotionPoint) {
    const track = this.tracks.get(tokenId);
    if (track && track.motionId !== motionId) return;
    this.update(tokenId, motionId, point, fallback, { local: track?.local, duration: 85 });
    this.tracks.get(tokenId)!.expires = performance.now() + 200;
    this.tracks.get(tokenId)!.finished = true;
  }
  cancel(tokenId: string, motionId: string) { if (this.tracks.get(tokenId)?.motionId === motionId) this.tracks.delete(tokenId); }
  clear() { this.tracks.clear(); }
}
