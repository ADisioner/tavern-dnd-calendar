import { z } from 'zod';
import { sceneSchema, commandSchema, createPrototypeScene, applyTableCommand, CommandError, type TableActor, type TableMember } from './scene.ts';

export const storedSceneSchema = z.object({ scene: sceneSchema, archived: z.boolean() }).strict();
export const roomDataSchema = z.object({
  schemaVersion: z.literal(2), campaignId: z.string().uuid(), revision: z.number().int().nonnegative(),
  activeSceneId: z.string().uuid(), scenes: z.array(storedSceneSchema).min(1).max(50),
}).strict().superRefine((room, ctx) => {
  if (!room.scenes.some(entry => entry.scene.id === room.activeSceneId && !entry.archived)) ctx.addIssue({ code: 'custom', message: 'Active scene is missing or archived' });
  if (room.scenes.some(entry => entry.scene.campaignId !== room.campaignId)) ctx.addIssue({ code: 'custom', message: 'Foreign scene in room' });
  if (new Set(room.scenes.map(entry => entry.scene.id)).size !== room.scenes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate scene IDs' });
});
const envelope = z.object({ id: z.string().uuid(), baseRevision: z.number().int().nonnegative(), sceneId: z.string().uuid().optional(), expectedRoomRevision: z.number().int().nonnegative() });
const name = z.string().trim().min(1).max(100);
const target = { targetSceneId: z.string().uuid() };
export const roomCommandSchema = z.discriminatedUnion('type', [
  ...commandSchema.options,
  envelope.extend({ type: z.literal('scene-create'), name }).strict(),
  envelope.extend({ type: z.literal('scene-rename'), ...target, name }).strict(),
  envelope.extend({ type: z.literal('scene-duplicate'), ...target, name }).strict(),
  envelope.extend({ type: z.literal('scene-archive'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-restore'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-activate'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-view'), ...target }).strict(),
]);
export const sceneSummarySchema = z.object({ id: z.string().uuid(), name: z.string(), archived: z.boolean(), tokenCount: z.number().int(), updatedAt: z.number().int() });
export type TableRoomData = z.infer<typeof roomDataSchema>;
export type RoomCommand = z.infer<typeof roomCommandSchema>;
export type SceneSummary = z.infer<typeof sceneSummarySchema>;

export function migrateLegacyRoom(campaignId: string, scene: unknown): TableRoomData {
  const parsed = sceneSchema.parse(scene);
  return roomDataSchema.parse({ schemaVersion: 2, campaignId, revision: 0, activeSceneId: parsed.id, scenes: [{ scene: parsed, archived: false }] });
}
export function createRoom(campaignId: string, roster: TableMember[]): TableRoomData {
  return migrateLegacyRoom(campaignId, createPrototypeScene(campaignId, roster));
}
export function roomView(data: TableRoomData, actor: TableActor, previewSceneId?: string) {
  const entries = actor.role === 'master' ? data.scenes : data.scenes.filter(entry => entry.scene.id === data.activeSceneId);
  const selected = actor.role === 'master' && previewSceneId ? entries.find(entry => entry.scene.id === previewSceneId && !entry.archived) : null;
  return { scene: (selected ?? data.scenes.find(entry => entry.scene.id === data.activeSceneId))!.scene,
    scenes: entries.map(({ scene, archived }) => ({ id: scene.id, name: scene.name, archived, tokenCount: scene.tokens.length, updatedAt: scene.updatedAt })),
    activeSceneId: data.activeSceneId, roomRevision: data.revision };
}
export function applyRoomCommand(data: TableRoomData, command: RoomCommand, actor: TableActor, roster: TableMember[]): { data: TableRoomData; viewSceneId?: string } {
  if (!command.sceneId) throw new CommandError('protocol', 'Обновите страницу игрового стола.');
  if (!command.type.startsWith('scene-')) {
    const entry = data.scenes.find(entry => entry.scene.id === command.sceneId);
    if (!entry || entry.archived) throw new CommandError('missing', 'Сцена недоступна.');
    if (actor.role !== 'master' && entry.scene.id !== data.activeSceneId) throw new CommandError('forbidden', 'Мастер уже переключил сцену. Повторите действие на текущей карте.');
    // Parsing also narrows the management-command union for TypeScript.
    const scene = applyTableCommand(entry.scene, commandSchema.parse(command), actor, roster);
    return { data: { ...data, scenes: data.scenes.map(value => value === entry ? { ...entry, scene } : value) } };
  }
  if (actor.role !== 'master') throw new CommandError('forbidden', 'Сценами управляет мастер кампании.');
  if (!('expectedRoomRevision' in command)) throw new CommandError('invalid', 'Некорректная команда сцены.');
  const entry = 'targetSceneId' in command ? data.scenes.find(entry => entry.scene.id === command.targetSceneId) : undefined;
  if (command.type === 'scene-view') {
    if (!entry || entry.archived) throw new CommandError('missing', 'Сцена недоступна.');
    return { data, viewSceneId: entry.scene.id };
  }
  if (command.expectedRoomRevision !== data.revision) throw new CommandError('conflict', 'Список сцен изменился. Повторите действие.');
  let next: TableRoomData = { ...data, revision: data.revision + 1, scenes: data.scenes.map(value => ({ ...value, scene: { ...value.scene } })) };
  let viewSceneId: string | undefined;
  if (command.type === 'scene-create' || command.type === 'scene-duplicate') {
    if (data.scenes.length >= 50) throw new CommandError('limit', 'В кампании доступно до 50 сцен, включая архив.');
    if (command.type === 'scene-duplicate' && (!entry || entry.archived)) throw new CommandError('missing', 'Сцена недоступна.');
    const scene = command.type === 'scene-create' ? { ...createPrototypeScene(data.campaignId, []), tokens: [], name: command.name } : {
      ...entry!.scene, id: crypto.randomUUID(), name: command.name, revision: 0, updatedAt: Date.now(),
      tokens: entry!.scene.tokens.map(token => ({ ...token, id: crypto.randomUUID(), version: 0 })),
    };
    next.scenes.push({ scene, archived: false }); viewSceneId = scene.id;
  } else {
    if (!entry) throw new CommandError('missing', 'Сцена больше не существует.');
    const changed = next.scenes.find(value => value.scene.id === entry.scene.id)!;
    if (command.type !== 'scene-restore' && entry.archived) throw new CommandError('archived', 'Сначала восстановите сцену из архива.');
    if (command.type === 'scene-rename') { changed.scene.name = command.name; changed.scene.revision++; changed.scene.updatedAt = Date.now(); }
    else if (command.type === 'scene-archive') {
      if (data.activeSceneId === entry.scene.id) throw new CommandError('active', 'Сначала покажите игрокам другую сцену.');
      changed.archived = true;
    } else if (command.type === 'scene-restore') changed.archived = false;
    else if (command.type === 'scene-activate') { next.activeSceneId = entry.scene.id; viewSceneId = entry.scene.id; }
  }
  next = roomDataSchema.parse(next);
  return { data: next, viewSceneId };
}
