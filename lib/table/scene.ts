import { z } from 'zod';
import type { Point } from './geometry.ts';
import { CONDITION_IDS } from './conditions.ts';

export type TableMember = { userId: string; name: string; role: string };
export type TableActor = { userId: string; name: string; role: 'master' | 'player' };
const maxDrawingCoordinates = 40_000;
const tokenMenuFields = { locked: z.boolean().optional(), rotation: z.number().finite().min(0).max(359).optional(),
  layer: z.number().int().min(-10000).max(10000).optional(), showLabel: z.boolean().optional(),
  statuses: z.array(z.enum(CONDITION_IDS)).max(CONDITION_IDS.length).refine(ids => new Set(ids).size === ids.length, 'Состояния не должны повторяться.').optional(),
  exhaustionLevel: z.number().int().min(1).max(6).optional() };
export const tokenSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(40),
  x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(1120),
  size: z.number().min(0.5).max(3), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ownerId: z.string().uuid().nullable(), version: z.number().int().nonnegative(),
  assetId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  ...tokenMenuFields,
}).strict();
export const drawingSchema = z.object({
  id: z.string().uuid(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().finite().min(1).max(40),
  points: z.array(z.number().finite().min(0)).min(4).max(2048)
    .refine(points => points.length % 2 === 0 && points.every((value, index) => value <= (index % 2 ? 1120 : 1600)), 'Координаты штриха выходят за границы сцены.'),
}).strict();
export const sceneSchema = z.object({
  id: z.string().uuid().default(() => crypto.randomUUID()),
  schemaVersion: z.literal(1), campaignId: z.string().uuid(), name: z.string().max(100),
  revision: z.number().int().nonnegative(), width: z.literal(1600), height: z.literal(1120),
  gridSize: z.number().int().min(20).max(160), gridVisible: z.boolean(),
  gridColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#decea1'),
  gridOpacity: z.number().min(0).max(1).default(0.18),
  tokens: z.array(tokenSchema).max(150), updatedAt: z.number().int(),
  mapAssetId: z.string().uuid().nullable().optional(),
  drawings: z.array(drawingSchema).max(300)
    .refine(drawings => drawings.reduce((total, drawing) => total + drawing.points.length, 0) <= maxDrawingCoordinates, 'На сцене доступно до 40000 координат штрихов.').default([]),
}).strict();
const envelope = z.object({ id: z.string().uuid(), baseRevision: z.number().int().nonnegative(), sceneId: z.string().uuid().optional() });
const tokenIds = z.array(z.string().uuid()).min(1).max(150).refine(ids => new Set(ids).size === ids.length, 'Токены не должны повторяться.');
export const commandSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('move'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), x: z.number().finite(), y: z.number().finite() }).strict(),
  envelope.extend({ type: z.literal('update'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(40), size: z.number().min(0.5).max(3), ownerId: z.string().uuid().nullable(), ...tokenMenuFields }).strict(),
  envelope.extend({ type: z.literal('duplicate'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict(),
  envelope.extend({ type: z.literal('remove'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict(),
  envelope.extend({ type: z.literal('add'), ownerId: z.string().uuid().nullable(), assetId: z.string().uuid().optional(), name: z.string().trim().min(1).max(40).optional() }).strict(),
  envelope.extend({ type: z.literal('map'), assetId: z.string().uuid().nullable() }).strict(),
  envelope.extend({ type: z.literal('grid'), gridSize: z.number().int().min(20).max(160), gridVisible: z.boolean(),
    gridColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), gridOpacity: z.number().min(0).max(1) }).strict(),
  envelope.extend({ type: z.literal('benchmark') }).strict(),
  envelope.extend({ type: z.literal('draw'), drawing: drawingSchema }).strict(),
  envelope.extend({ type: z.literal('erase'), drawingId: z.string().uuid() }).strict(),
  envelope.extend({ type: z.literal('group'), tokenIds }).strict(),
  envelope.extend({ type: z.literal('ungroup'), tokenIds }).strict(),
  envelope.extend({ type: z.literal('remove-many'), tokens: z.array(z.object({ tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict()).min(1).max(150)
    .refine(tokens => new Set(tokens.map(token => token.tokenId)).size === tokens.length, 'Токены не должны повторяться.') }).strict(),
]);
export type TableScene = z.infer<typeof sceneSchema>;
export type TableToken = z.infer<typeof tokenSchema>;
export type TableDrawing = z.infer<typeof drawingSchema>;
export type Drawing = TableDrawing;
export type TableCommand = z.infer<typeof commandSchema>;
export class CommandError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function canMoveToken(token: TableToken, actor: TableActor) {
  return !token.locked && (actor.role === 'master' || actor.role === 'player');
}
export function linkedTokens(scene: TableScene, token: TableToken): TableToken[] {
  return scene.tokens.filter(value => token.groupId ? value.groupId === token.groupId : value.id === token.id)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function boundedGroupPoint(scene: TableScene, token: TableToken, point: Point): Point {
  let minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity;
  for (const member of linkedTokens(scene, token)) {
    const radius = member.size * scene.gridSize / 2;
    minX = Math.max(minX, radius - member.x); maxX = Math.min(maxX, scene.width - radius - member.x);
    minY = Math.max(minY, radius - member.y); maxY = Math.min(maxY, scene.height - radius - member.y);
  }
  return { x: token.x + Math.max(minX, Math.min(maxX, point.x - token.x)),
    y: token.y + Math.max(minY, Math.min(maxY, point.y - token.y)) };
}
export function boundedSelectionPoint(scene: TableScene, selection: TableToken[], anchor: TableToken, point: Point): Point {
  const members = new Map<string, TableToken>();
  for (const token of selection.length ? selection : [anchor]) for (const member of linkedTokens(scene, token)) members.set(member.id, member);
  let minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity;
  for (const member of members.values()) {
    const radius = member.size * scene.gridSize / 2;
    minX = Math.max(minX, radius - member.x); maxX = Math.min(maxX, scene.width - radius - member.x);
    minY = Math.max(minY, radius - member.y); maxY = Math.min(maxY, scene.height - radius - member.y);
  }
  const dx = Math.max(minX, Math.min(maxX, point.x - anchor.x));
  const dy = Math.max(minY, Math.min(maxY, point.y - anchor.y));
  return { x: anchor.x + dx, y: anchor.y + dy };
}
const colors = ['#a8bc8a', '#d4b276', '#87b2c2', '#b49bc9', '#c9939b'];
function makeToken(index: number, member?: TableMember): TableToken {
  return { id: crypto.randomUUID(), name: member?.name ?? `Противник ${index + 1}`,
    x: 120 + (index % 18) * 80, y: 120 + Math.floor(index / 18) * 80,
    size: 1, color: member ? colors[index % colors.length] : '#ad717b',
    ownerId: member?.userId ?? null, version: 0 };
}
export function createPrototypeScene(campaignId: string, roster: TableMember[]): TableScene {
  return { id: crypto.randomUUID(), schemaVersion: 1, campaignId, name: 'Таверна у старого тракта', revision: 0,
    width: 1600, height: 1120, gridSize: 80, gridVisible: true, gridColor: '#decea1', gridOpacity: 0.18, updatedAt: Date.now(),
    tokens: Array.from({ length: Math.max(8, roster.length) }, (_, i) => makeToken(i, roster[i])), drawings: [] };
}
export function applyTableCommand(scene: TableScene, command: TableCommand, actor: TableActor, roster: TableMember[]): TableScene {
  if (actor.role !== 'master' && actor.role !== 'player') throw new CommandError('forbidden', 'Нет доступа к изменению сцены.');
  if (command.sceneId && command.sceneId !== scene.id) throw new CommandError('forbidden', 'Эта сцена недоступна.');
  if (command.baseRevision > scene.revision) throw new CommandError('revision', 'Обновите состояние сцены.');
  const next: TableScene = { ...scene, tokens: scene.tokens.map(t => ({ ...t })), drawings: (scene.drawings ?? []).map(d => ({ ...d, points: [...d.points] })), revision: scene.revision + 1, updatedAt: Date.now() };
  if (command.type === 'remove-many') {
    for (const expected of command.tokens) {
      const token = next.tokens.find(value => value.id === expected.tokenId);
      if (!token) throw new CommandError('missing', 'Токен больше не существует.');
      if (token.version !== expected.expectedVersion) throw new CommandError('conflict', 'Токен уже изменён. Повторите действие.');
    }
    const ids = new Set(command.tokens.map(value => value.tokenId));
    next.tokens = next.tokens.filter(token => !ids.has(token.id));
    return sceneSchema.parse(next);
  }
  if (command.type === 'draw' || command.type === 'erase' || command.type === 'group' || command.type === 'ungroup') {
    if ((command.type === 'group' || command.type === 'ungroup') && command.baseRevision !== scene.revision) throw new CommandError('conflict', 'Сцена изменилась. Повторите действие.');
    if (command.type === 'draw') {
      if (next.drawings.some(drawing => drawing.id === command.drawing.id)) throw new CommandError('conflict', 'Штрих уже существует.');
      if (next.drawings.length >= 300) throw new CommandError('limit', 'На сцене доступно до 300 штрихов.');
      if (next.drawings.reduce((total, drawing) => total + drawing.points.length, command.drawing.points.length) > maxDrawingCoordinates) throw new CommandError('limit', 'На сцене доступно до 40000 координат штрихов.');
      next.drawings.push({ ...command.drawing, points: [...command.drawing.points] });
    } else if (command.type === 'erase') {
      if (!next.drawings.some(drawing => drawing.id === command.drawingId)) throw new CommandError('missing', 'Штрих больше не существует.');
      next.drawings = next.drawings.filter(drawing => drawing.id !== command.drawingId);
    } else {
      const selected = command.tokenIds.map(id => {
        const token = next.tokens.find(value => value.id === id);
        if (!token) throw new CommandError('missing', 'Токен больше не существует.');
        return token;
      });
      const ids = new Set(selected.flatMap(token => linkedTokens(next, token).map(value => value.id)));
      if (command.type === 'group' && ids.size < 2) throw new CommandError('selection', 'Выберите хотя бы две фигуры.');
      for (const token of next.tokens) if (ids.has(token.id)) {
        if (command.type === 'group') { token.groupId = command.id; token.version++; }
        else if (token.groupId) { delete token.groupId; token.version++; }
      }
    }
    return sceneSchema.parse(next);
  }
  if (command.type === 'move' || command.type === 'update' || command.type === 'remove' || command.type === 'duplicate') {
    const token = next.tokens.find(t => t.id === command.tokenId);
    if (!token) throw new CommandError('missing', 'Токен больше не существует.');
    if (token.version !== command.expectedVersion) throw new CommandError('conflict', 'Токен уже изменён. Повторите действие.');
    if (command.type === 'duplicate') {
      if (next.tokens.some(value => value.id === command.id)) throw new CommandError('conflict', 'Копия уже существует.');
      if (next.tokens.length >= 150) throw new CommandError('limit', 'На сцене доступно до 150 токенов.');
      const copy = { ...token, id: command.id, locked: false, version: 0 };
      delete copy.groupId;
      Object.assign(copy, boundedGroupPoint({ ...next, tokens: [copy] }, copy, { x: token.x + scene.gridSize / 2, y: token.y + scene.gridSize / 2 }));
      next.tokens.push(copy);
      return sceneSchema.parse(next);
    }
    if (command.type === 'remove') {
      next.tokens = next.tokens.filter(value => value.id !== token.id);
      return sceneSchema.parse(next);
    }
    if (command.type === 'move') {
      if (linkedTokens(next, token).some(member => !canMoveToken(member, actor))) throw new CommandError('locked', 'Движение этой фигуры или её группы заблокировано.');
      const point = boundedGroupPoint(next, token, command), dx = point.x - token.x, dy = point.y - token.y;
      for (const member of linkedTokens(next, token)) {
        member.x += dx; member.y += dy; member.version++;
      }
      return sceneSchema.parse(next);
    } else {
      if (command.ownerId && !roster.some(m => m.userId === command.ownerId)) throw new CommandError('owner', 'Управляющий должен состоять в кампании.');
      Object.assign(token, { name: command.name, size: command.size, ownerId: command.ownerId });
      for (const key of ['locked', 'rotation', 'layer', 'showLabel', 'statuses', 'exhaustionLevel'] as const) if (command[key] !== undefined) Object.assign(token, { [key]: command[key] });
      const radius = token.size * scene.gridSize / 2;
      token.x = Math.max(radius, Math.min(scene.width - radius, token.x));
      token.y = Math.max(radius, Math.min(scene.height - radius, token.y));
    }
    token.version++;
  } else {
    if (actor.role !== 'master' && command.type !== 'add') throw new CommandError('forbidden', 'Этот инструмент доступен мастеру.');
    if (command.baseRevision !== scene.revision) throw new CommandError('conflict', 'Сцена изменилась. Повторите действие.');
    if (command.type === 'map') {
      next.mapAssetId = command.assetId;
    } else if (command.type === 'grid') {
      next.gridSize = command.gridSize; next.gridVisible = command.gridVisible;
      next.gridColor = command.gridColor; next.gridOpacity = command.gridOpacity;
    } else if (command.type === 'add') {
      if (next.tokens.length >= 150) throw new CommandError('limit', 'В прототипе доступно до 150 токенов.');
      const ownerId = actor.role === 'master' ? command.ownerId : actor.userId;
      const member = roster.find(m => m.userId === ownerId);
      if (ownerId && !member) throw new CommandError('owner', 'Владелец должен состоять в кампании.');
      const token = makeToken(next.tokens.length, member);
      if (command.assetId) token.assetId = command.assetId;
      if (command.name) token.name = command.name;
      next.tokens.push(token);
    } else {
      let positionIndex = 0;
      while (next.tokens.length < 100) {
        const token = makeToken(next.tokens.length, roster[next.tokens.length]);
        let placed = false;
        while (positionIndex < 216) {
          const candidate = { x: 120 + (positionIndex % 18) * 80, y: 120 + Math.floor(positionIndex / 18) * 80 }; positionIndex++;
          const radius = token.size * scene.gridSize / 2;
          if (candidate.x + radius > scene.width || candidate.y + radius > scene.height) continue;
          if (next.tokens.some(other => Math.hypot(other.x - candidate.x, other.y - candidate.y) < scene.gridSize * (other.size + token.size) / 2)) continue;
          Object.assign(token, candidate); placed = true; break;
        }
        if (!placed) throw new CommandError('space', 'Недостаточно места для 100 фигур при выбранной сетке.');
        next.tokens.push(token);
      }
    }
  }
  return sceneSchema.parse(next);
}
