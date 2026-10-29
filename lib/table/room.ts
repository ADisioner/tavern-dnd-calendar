import { z } from 'zod';
import { sceneSchema, commandSchema, createPrototypeScene, applyTableCommand, CommandError, type TableActor, type TableMember } from './scene.ts';
import { rollRecordSchema, rollModeSchema, rollVisibilitySchema, evaluateDice, canSeeRoll } from './dice.ts';
import { projectScene } from './fog.ts';
import { emptyCombat } from './combat.ts';

export const storedSceneSchema = z.object({ scene: sceneSchema, archived: z.boolean() }).strict();
export const musicTrackSchema = z.object({ id: z.string().uuid(), videoId: z.string().regex(/^[a-zA-Z0-9_-]{11}$/),
  title: z.string().trim().min(1).max(200).optional(), label: z.string().trim().min(1).max(60).optional(), addedById: z.string().uuid(), addedByName: z.string().trim().min(1).max(80), addedAt: z.number().int() }).strict();
export const musicStateSchema = z.object({ tracks: z.array(musicTrackSchema).max(40), currentTrackId: z.string().uuid().nullable(),
  playing: z.boolean(), positionSeconds: z.number().finite().min(0).max(100000000), startedAt: z.number().int().nullable() }).strict()
  .superRefine((music, ctx) => {
    if (music.currentTrackId && !music.tracks.some(track => track.id === music.currentTrackId)) ctx.addIssue({ code: 'custom', message: 'Текущий трек отсутствует в списке.' });
    if (music.playing !== (music.startedAt !== null) || (music.playing && !music.currentTrackId)) ctx.addIssue({ code: 'custom', message: 'Некорректное состояние воспроизведения.' });
  });
const emptyMusic = () => ({ tracks: [], currentTrackId: null, playing: false, positionSeconds: 0, startedAt: null });
export const roomDataSchema = z.object({
  schemaVersion: z.literal(2), campaignId: z.string().uuid(), revision: z.number().int().nonnegative(),
  activeSceneId: z.string().uuid(), scenes: z.array(storedSceneSchema).min(1).max(50), music: musicStateSchema.default(emptyMusic), rolls: z.array(rollRecordSchema).max(5000).default([]),
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
  envelope.extend({ type: z.literal('dice-roll'), formula: z.string().trim().min(1).max(160), mode: rollModeSchema, visibility: rollVisibilitySchema, npc: z.string().trim().min(1).max(80).optional() }).strict(),
  envelope.extend({ type: z.literal('music-add'), videoId: z.string().regex(/^[a-zA-Z0-9_-]{11}$/), label: z.string().trim().min(1).max(60).optional() }).strict(),
  envelope.extend({ type: z.literal('music-select'), trackId: z.string().uuid() }).strict(),
  envelope.extend({ type: z.literal('music-play'), trackId: z.string().uuid(), positionSeconds: z.number().finite().min(0).max(100000000) }).strict(),
  envelope.extend({ type: z.literal('music-pause'), trackId: z.string().uuid(), positionSeconds: z.number().finite().min(0).max(100000000) }).strict(),
  envelope.extend({ type: z.literal('music-remove'), trackId: z.string().uuid() }).strict(),
  envelope.extend({ type: z.literal('scene-create'), name }).strict(),
  envelope.extend({ type: z.literal('scene-rename'), ...target, name }).strict(),
  envelope.extend({ type: z.literal('scene-duplicate'), ...target, name }).strict(),
  envelope.extend({ type: z.literal('scene-archive'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-restore'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-activate'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-view'), ...target }).strict(),
  envelope.extend({ type: z.literal('scene-view-player'), viewerId: z.string().uuid().nullable() }).strict(),
]);
export const sceneSummarySchema = z.object({ id: z.string().uuid(), name: z.string(), archived: z.boolean(), tokenCount: z.number().int(), updatedAt: z.number().int() });
export type TableRoomData = z.infer<typeof roomDataSchema>;
export type MusicState = z.infer<typeof musicStateSchema>;
export type RoomCommand = z.infer<typeof roomCommandSchema>;
type MusicCommand = Extract<RoomCommand, { type: 'music-add' | 'music-select' | 'music-play' | 'music-pause' | 'music-remove' }>;
export type SceneSummary = z.infer<typeof sceneSummarySchema>;

export function migrateLegacyRoom(campaignId: string, scene: unknown): TableRoomData {
  const parsed = sceneSchema.parse(scene);
  return roomDataSchema.parse({ schemaVersion: 2, campaignId, revision: 0, activeSceneId: parsed.id, scenes: [{ scene: parsed, archived: false }] });
}
export function createRoom(campaignId: string, roster: TableMember[]): TableRoomData {
  return migrateLegacyRoom(campaignId, createPrototypeScene(campaignId, roster));
}
export function roomView(data: TableRoomData, actor: TableActor, previewSceneId?: string, playerViewId?: string | null) {
  const entries = actor.role === 'master' ? data.scenes : data.scenes.filter(entry => entry.scene.id === data.activeSceneId);
  const selected = actor.role === 'master' && previewSceneId ? entries.find(entry => entry.scene.id === previewSceneId && !entry.archived) : null;
  const viewer=actor.role==='master'&&playerViewId?{...actor,userId:playerViewId,role:'player' as const}:actor;
  return { scene: projectScene((selected ?? data.scenes.find(entry => entry.scene.id === data.activeSceneId))!.scene,viewer),
    scenes: entries.map(({ scene, archived }) => ({ id: scene.id, name: scene.name, archived, tokenCount: projectScene(scene,viewer).tokens.length, updatedAt: scene.updatedAt })),
    activeSceneId: data.activeSceneId, roomRevision: data.revision, music: data.music, rolls: (data.rolls ?? []).filter(roll => canSeeRoll(roll, viewer)).slice(-200), playerViewId: actor.role==='master'?playerViewId??null:null };
}
export function viewVersion(view: unknown) { const text = JSON.stringify(view); let hash = 2166136261; for (let i=0;i<text.length;i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return hash >>> 0; }
export function applyRoomCommand(data: TableRoomData, command: RoomCommand, actor: TableActor, roster: TableMember[], options: { youtubeTitle?: string; diceResult?: ReturnType<typeof evaluateDice>; random?:(sides:number)=>number } = {}): { data: TableRoomData; viewSceneId?: string; playerViewId?: string | null } {
  if (!command.sceneId) throw new CommandError('protocol', 'Обновите страницу игрового стола.');
  if(command.type==='scene-view-player'){
    if(actor.role!=='master'||command.viewerId&&!roster.some(member=>member.userId===command.viewerId))throw new CommandError('forbidden','Предпросмотр доступен только мастеру.');
    return {data,playerViewId:command.viewerId};
  }
  if (command.type === 'dice-roll') {
    if (!['master','player'].includes(actor.role) || command.npc && actor.role !== 'master') throw new CommandError('forbidden', 'За NPC бросает только мастер.');
    if (!data.scenes.some(entry => !entry.archived && entry.scene.id === command.sceneId && (actor.role === 'master' || entry.scene.id === data.activeSceneId))) throw new CommandError('forbidden', 'Сцена недоступна.');
    if ((data.rolls ?? []).some(roll => roll.id === command.id)) return { data };
    let result; try { result = options.diceResult ?? evaluateDice(command.formula, command.mode); } catch (error) { throw new CommandError('invalid', (error as Error).message); }
    const roll = rollRecordSchema.parse({ ...result, id: command.id, authorId: actor.userId, authorName: actor.name, visibility: command.visibility, ...(command.npc ? { npc: command.npc } : {}), createdAt: Date.now() });
    const sameAudience=(value:typeof roll)=>value.visibility===roll.visibility&&(roll.visibility!=='private'||value.authorId===roll.authorId);
    const bucket=[...(data.rolls??[]).filter(sameAudience),roll].slice(roll.visibility==='private'?-50:-200),ids=new Set(bucket.map(value=>value.id));
    const rolls=[...(data.rolls??[]).filter(value=>!sameAudience(value)||ids.has(value.id)),roll];
    if(rolls.length>5000)throw new CommandError('limit','История бросков заполнена.');
    return { data: { ...data, rolls } };
  }
  if (command.type.startsWith('music-')) {
    const musicCommand = command as MusicCommand;
    if (!['master', 'player'].includes(actor.role)) throw new CommandError('forbidden', 'В музыкальном плеере могут участвовать только члены стола.');
    const scene = data.scenes.find(entry => entry.scene.id === command.sceneId && !entry.archived);
    if (!scene || (actor.role !== 'master' && scene.scene.id !== data.activeSceneId)) throw new CommandError('forbidden', 'Музыка доступна только участникам активной сцены.');
    if (musicCommand.expectedRoomRevision !== data.revision) throw new CommandError('conflict', 'Список музыки изменился. Повторите действие.');
    const music = { ...data.music, tracks: [...data.music.tracks] };
    if (musicCommand.type === 'music-add') {
      if (music.tracks.length >= 40) throw new CommandError('limit', 'В музыкальном списке доступно до 40 видео.');
      if (music.tracks.some(track => track.id === musicCommand.id)) throw new CommandError('conflict', 'Этот музыкальный трек уже добавляется.');
      music.tracks.push({ id: musicCommand.id, videoId: musicCommand.videoId, title: options.youtubeTitle ?? musicCommand.label ?? musicCommand.videoId,
        ...(musicCommand.label ? { label: musicCommand.label } : {}), addedById: actor.userId, addedByName: actor.name, addedAt: Date.now() });
    } else if (musicCommand.type === 'music-select') {
      if (!music.tracks.some(track => track.id === musicCommand.trackId)) throw new CommandError('missing', 'Видео больше нет в музыкальном списке.');
      music.currentTrackId = musicCommand.trackId; music.playing = false; music.positionSeconds = 0; music.startedAt = null;
    } else if (musicCommand.type === 'music-play') {
      if (!music.tracks.some(track => track.id === musicCommand.trackId)) throw new CommandError('missing', 'Видео больше нет в музыкальном списке.');
      music.currentTrackId = musicCommand.trackId; music.playing = true; music.positionSeconds = musicCommand.positionSeconds; music.startedAt = Date.now();
    } else if (musicCommand.type === 'music-pause') {
      if (music.currentTrackId !== musicCommand.trackId) throw new CommandError('conflict', 'Сейчас играет другой трек.');
      music.playing = false; music.positionSeconds = musicCommand.positionSeconds; music.startedAt = null;
    } else {
      if (!music.tracks.some(track => track.id === musicCommand.trackId)) throw new CommandError('missing', 'Видео больше нет в музыкальном списке.');
      music.tracks = music.tracks.filter(track => track.id !== musicCommand.trackId);
      if (music.currentTrackId === musicCommand.trackId) { music.currentTrackId = null; music.playing = false; music.positionSeconds = 0; music.startedAt = null; }
    }
    return { data: roomDataSchema.parse({ ...data, revision: data.revision + 1, music }) };
  }
  if (!command.type.startsWith('scene-')) {
    const entry = data.scenes.find(entry => entry.scene.id === command.sceneId);
    if (!entry || entry.archived) throw new CommandError('missing', 'Сцена недоступна.');
    if (actor.role !== 'master' && entry.scene.id !== data.activeSceneId) throw new CommandError('forbidden', 'Мастер уже переключил сцену. Повторите действие на текущей карте.');
    // Parsing also narrows the management-command union for TypeScript.
    const scene = applyTableCommand(entry.scene, commandSchema.parse(command), actor, roster,options);
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
      fog:{...entry!.scene.fog,explored:{}},combat:emptyCombat(),
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
