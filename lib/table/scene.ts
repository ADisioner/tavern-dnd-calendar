import { z } from 'zod';

export type TableMember = { userId: string; name: string; role: string };
export type TableActor = { userId: string; name: string; role: 'master' | 'player' };
export const tokenSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(40),
  x: z.number().finite().min(0).max(1600), y: z.number().finite().min(0).max(1120),
  size: z.number().min(0.5).max(3), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ownerId: z.string().uuid().nullable(), version: z.number().int().nonnegative(),
  assetId: z.string().uuid().optional(),
}).strict();
export const sceneSchema = z.object({
  id: z.string().uuid().default(() => crypto.randomUUID()),
  schemaVersion: z.literal(1), campaignId: z.string().uuid(), name: z.string().max(100),
  revision: z.number().int().nonnegative(), width: z.literal(1600), height: z.literal(1120),
  gridSize: z.number().int().min(20).max(160), gridVisible: z.boolean(),
  tokens: z.array(tokenSchema).max(150), updatedAt: z.number().int(),
  mapAssetId: z.string().uuid().nullable().optional(),
}).strict();
const envelope = z.object({ id: z.string().uuid(), baseRevision: z.number().int().nonnegative(), sceneId: z.string().uuid().optional() });
export const commandSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('move'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), x: z.number().finite(), y: z.number().finite() }).strict(),
  envelope.extend({ type: z.literal('update'), tokenId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(40), size: z.number().min(0.5).max(3), ownerId: z.string().uuid().nullable() }).strict(),
  envelope.extend({ type: z.literal('add'), ownerId: z.string().uuid().nullable(), assetId: z.string().uuid().optional(), name: z.string().trim().min(1).max(40).optional() }).strict(),
  envelope.extend({ type: z.literal('map'), assetId: z.string().uuid().nullable() }).strict(),
  envelope.extend({ type: z.literal('grid'), gridSize: z.number().int().min(20).max(160), gridVisible: z.boolean() }).strict(),
  envelope.extend({ type: z.literal('benchmark') }).strict(),
]);
export type TableScene = z.infer<typeof sceneSchema>;
export type TableToken = z.infer<typeof tokenSchema>;
export type TableCommand = z.infer<typeof commandSchema>;
export class CommandError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function canMoveToken(_token: TableToken, actor: TableActor) {
  return actor.role === 'master' || actor.role === 'player';
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
    width: 1600, height: 1120, gridSize: 80, gridVisible: true, updatedAt: Date.now(),
    tokens: Array.from({ length: Math.max(8, roster.length) }, (_, i) => makeToken(i, roster[i])) };
}
export function applyTableCommand(scene: TableScene, command: TableCommand, actor: TableActor, roster: TableMember[]): TableScene {
  if (command.baseRevision > scene.revision) throw new CommandError('revision', 'Обновите состояние сцены.');
  const next: TableScene = { ...scene, tokens: scene.tokens.map(t => ({ ...t })), revision: scene.revision + 1, updatedAt: Date.now() };
  if (command.type === 'move' || command.type === 'update') {
    const token = next.tokens.find(t => t.id === command.tokenId);
    if (!token) throw new CommandError('missing', 'Токен больше не существует.');
    if (!canMoveToken(token, actor)) throw new CommandError('forbidden', 'Нет доступа к движению токенов.');
    if (token.version !== command.expectedVersion) throw new CommandError('conflict', 'Токен уже изменён. Повторите действие.');
    if (command.type === 'move') {
      const radius = token.size * scene.gridSize / 2;
      token.x = Math.max(radius, Math.min(scene.width - radius, command.x));
      token.y = Math.max(radius, Math.min(scene.height - radius, command.y));
    } else {
      if (actor.role !== 'master') throw new CommandError('forbidden', 'Свойства токена меняет мастер.');
      if (command.ownerId && !roster.some(m => m.userId === command.ownerId)) throw new CommandError('owner', 'Управляющий должен состоять в кампании.');
      Object.assign(token, { name: command.name, size: command.size, ownerId: command.ownerId });
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
