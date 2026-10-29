import { z } from 'zod';
import { authorizeHosted, readHostedRoom, requireDb, saveHostedRoom, type HostedActor, type HostedEnv } from './hosted-store.ts';
import { applyRoomCommand, roomCommandSchema, roomView, viewVersion, type TableRoomData } from './room.ts';
import { evaluateDice, randomDie } from './dice.ts';
import { affectedMotionTokens, motionMessageSchema } from './motion.ts';
import { CommandError, linkedTokens, boundedGroupPoint } from './scene.ts';
import { hostedImage } from './hosted-library.ts';
import { getYouTubeVideoStatus } from './youtube.ts';
import { measurementMessageSchema, snapMeasurePoint } from './measurement.ts';
import { projectScene, tokenVisible, pointVisible } from './fog.ts';

export type HostedClient = { id: string; campaignId: string; preview?: string; playerViewId?: string | null; version: number; sceneId: string; generation: number; touched: number; seen: Map<string,string>; permissions?: string; measurementSnapshot?: string; measureWindow?: number; measureCount?: number };
export function hostedClient(id: string, campaignId: string, preview?: string): HostedClient {
  z.string().uuid().parse(id); z.string().uuid().parse(campaignId); if (preview) z.string().uuid().parse(preview);
  return { id, campaignId, preview, version: -1, sceneId: '', generation: 0, touched: 0, seen: new Map() };
}
type MotionRow = { campaign_id: string; scene_id: string; token_id: string; motion_id: string; client_id: string; user_id: string; name: string; expected_version: number; seq: number; x: number; y: number; expires: number; status: string; result: string | null };
function allowedScene(data: TableRoomData, actor: HostedActor, id: string) {
  const entry = data.scenes.find(value => value.scene.id === id && !value.archived);
  if (!entry || actor.actor.role !== 'master' && id !== data.activeSceneId) throw new CommandError('forbidden', 'Эта сцена недоступна.');
  return entry.scene;
}
async function presence(env: HostedEnv, actor: HostedActor) {
  return (await requireDb(env).prepare(`SELECT DISTINCT m.user_id AS userId,m.name,CASE WHEN m.role IN ('master','master,player') THEN 'master' ELSE 'player' END AS role FROM test_table_peers p JOIN members m ON m.user_id=p.user_id AND m.campaign_id=p.campaign_id JOIN campaigns c ON c.id=m.campaign_id JOIN users u ON u.id=m.user_id WHERE p.campaign_id=? AND p.expires>? AND u.disabled=0`).bind(actor.campaignId, Date.now()).all()).results;
}
export async function pollHosted(env: HostedEnv, actor: HostedActor, client: HostedClient, force = false, commandId?: string):Promise<{version:number;events:Record<string,unknown>[];previewSceneId?:string;playerViewId?:string|null}> {
  const db = requireDb(env), generation = client.generation, events: Record<string, unknown>[] = [];
  const touched = Date.now() - client.touched > 3000;
  if (touched) { await db.prepare('INSERT INTO test_table_peers(client_id,campaign_id,user_id,expires) VALUES(?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET expires=excluded.expires WHERE campaign_id=excluded.campaign_id AND user_id=excluded.user_id AND expires<?').bind(client.id, actor.campaignId, actor.actor.userId, Date.now() + 12000, Date.now() + 8000).run(); client.touched = Date.now(); }
  if(actor.actor.role!=='master')client.playerViewId=null;
  const room = await readHostedRoom(env, actor);
  const view = roomView(room.state.data, actor.actor, client.preview, client.playerViewId), sceneId = view.scene.id;
  const viewer=client.playerViewId?{...actor.actor,userId:client.playerViewId,role:'player' as const}:actor.actor;
  const rawScene=room.state.data.scenes.find(entry=>entry.scene.id===sceneId)!.scene;
  const version = viewVersion(view);
  const permissions = JSON.stringify([actor.actor, actor.roster]);
  if (force || version !== client.version || client.sceneId !== sceneId || client.permissions !== permissions) {
    client.permissions = permissions;
    events.push({ type: 'snapshot', ...view, actor: actor.actor, roster: actor.roster, peers: await presence(env, actor), commandId: commandId ?? [...room.state.receipts].reverse().find(receipt => receipt.userId === actor.actor.userId)?.id });
    if (client.version >= 0) events.push({ type: 'library-changed' });
  } else if (touched) events.push({ type: 'presence', peers: await presence(env, actor) });
  if (sceneId) {
    const rows = (await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND expires>?').bind(actor.campaignId, sceneId, Date.now()).all<MotionRow>()).results;
    for (const row of rows) {
      const visibleToken=view.scene.tokens.find(token=>token.id===row.token_id);
      if(!visibleToken||rawScene.fog?.enabled&&viewer.role!=='master'&&visibleToken.ownerId!==viewer.userId)continue;
      const key = row.motion_id + ':' + row.seq + ':' + row.status;
      if (client.seen.get(row.motion_id) === key) continue;
      if (row.status === 'done' && row.result) { const event=JSON.parse(row.result);events.push({...event,token:visibleToken,tokens:view.scene.tokens.filter(t=>(event.tokens??[]).some((source:{id:string})=>source.id===t.id))}); }
      else if (row.status === 'cancelled') events.push({ type: 'motion-cancelled', motionId: row.motion_id, sceneId, tokenId: row.token_id });
      else events.push({ type: row.seq < 0 ? 'motion-started' : 'motion-frame', motionId: row.motion_id, sceneId, tokenId: row.token_id, seq: row.seq, userId: row.user_id, name: row.name, x: row.x, y: row.y });
    }
    if (generation !== client.generation) return { version: client.version, events: [], previewSceneId: client.preview };
    for (const row of rows) client.seen.set(row.motion_id, row.motion_id + ':' + row.seq + ':' + row.status);
    if (client.seen.size > 500) client.seen.clear();
  }
  const measurementRows = sceneId ? (await db.prepare(`SELECT m.payload FROM test_table_measurements m JOIN test_table_peers p ON p.client_id=m.client_id AND p.campaign_id=m.campaign_id AND p.user_id=m.user_id WHERE m.campaign_id=? AND m.scene_id=? AND p.expires>?`).bind(actor.campaignId, sceneId, Date.now()).all<{ payload: string }>()).results : [];
  const measurements = measurementRows.map(row => JSON.parse(row.payload)).filter(m=>pointVisible(rawScene,viewer,m.from)&&pointVisible(rawScene,viewer,m.to));
  const measurementSnapshot = JSON.stringify(measurements);
  if (client.measurementSnapshot !== measurementSnapshot) { client.measurementSnapshot = measurementSnapshot; events.push({ type: 'measurement-state', sceneId, measurements }); }
  if (generation !== client.generation) return { version: client.version, events: [], previewSceneId: client.preview };
  client.version = version; client.sceneId = sceneId;
  return { version, events, previewSceneId: client.preview, playerViewId: client.playerViewId??null };
}
export async function hostedMessage(env: HostedEnv, request: Request, client: HostedClient, raw: unknown) {
  const message = raw as { type?: string; command?: unknown };
  const actor = await authorizeHosted(env, request, client.campaignId, true), db = requireDb(env);
  if (message.type === 'hello') return pollHosted(env, actor, client, true);
  if (message.type === 'command') {
    const command = roomCommandSchema.parse(message.command); client.generation++;
    const diceResult = command.type === 'dice-roll' ? evaluateDice(command.formula, command.mode) : undefined;
    let youtubeTitle: string | undefined;
    if (command.type === 'music-add') {
      let status;
      try { status = await getYouTubeVideoStatus(env.YOUTUBE_API_KEY, command.videoId); }
      catch (error) { throw new CommandError('unavailable', error instanceof Error ? error.message : 'Не удалось проверить видео YouTube.'); }
      if (!status.embeddable) throw new CommandError('invalid', 'Это видео запрещено встраивать.');
      if (status.madeForKids) throw new CommandError('invalid', 'Видео с отметкой «для детей» пока нельзя добавить в общий плеер.');
      youtubeTitle = status.title;
    }
    const entropy:number[]=[];
    for (let attempt = 0; attempt < 5; attempt++) {
      const room = await readHostedRoom(env, actor);
      if (room.state.receipts.some(value => value.id === command.id && value.userId === actor.actor.userId)) return pollHosted(env, actor, client, true, command.id);
      if ((command.type === 'add' || command.type === 'map') && command.assetId) await hostedImage(env, actor, command.assetId);
      const commandScene = room.state.data.scenes.find(entry => entry.scene.id === command.sceneId)?.scene;
      const touched = commandScene ? affectedMotionTokens(commandScene, command).map(token => token.id) : [];
      if (touched.length) {
        const locked = await db.prepare(`SELECT motion_id FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND token_id IN (SELECT value FROM json_each(?)) AND expires>? AND status IN ('moving','committing')`).bind(client.campaignId, command.sceneId, JSON.stringify(touched), Date.now()).first();
        if (locked) throw new CommandError('busy', 'Эту группу сейчас двигает участник.');
      }
      let cursor=0;const random=(sides:number)=>{const index=cursor++;return entropy[index]??(entropy[index]=randomDie(sides));};
      const result = applyRoomCommand(room.state.data, command, actor.actor, actor.roster, { youtubeTitle, diceResult, random });
      if (command.type === 'scene-view') { client.preview = result.viewSceneId; await db.prepare('DELETE FROM test_table_measurements WHERE campaign_id=? AND client_id=?').bind(client.campaignId, client.id).run(); client.measurementSnapshot = undefined; return pollHosted(env, actor, client, true, command.id); }
      if (command.type === 'scene-view-player') {client.playerViewId=result.playerViewId;client.measurementSnapshot=undefined;return pollHosted(env,actor,client,true,command.id);}
      const state = { data: result.data, receipts: [...room.state.receipts, { id: command.id, userId: actor.actor.userId }].slice(-1000) };
      const idleToken = touched.length ? { sceneId: command.sceneId!, tokenIds: touched } : undefined;
      if (await saveHostedRoom(env, client.campaignId, room.version, state, undefined, idleToken)) {
        if (result.viewSceneId) client.preview = result.viewSceneId;
        if (['scene-activate','scene-archive'].includes(command.type)) await db.prepare('DELETE FROM test_table_measurements WHERE campaign_id=?').bind(client.campaignId).run();
        if (['grid','scene-activate','scene-archive'].includes(command.type)) await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND status IN ('moving','committing')").bind(Date.now() + 3000, client.campaignId).run();
        return pollHosted(env, actor, client, true, command.id);
      }
    }
    throw new CommandError('conflict', 'Сцена изменилась. Повторите действие.');
  }
  if (message.type === 'measurement-frame' || message.type === 'measurement-clear') {
    const parsed = measurementMessageSchema.safeParse(raw); if (!parsed.success) throw new CommandError('invalid', 'Измерение некорректно.');
    const event = parsed.data;
    const room = await readHostedRoom(env, actor);
    if (Date.now() - (client.measureWindow ?? 0) > 10000) { client.measureWindow = Date.now(); client.measureCount = 0; }
    client.measureCount = (client.measureCount ?? 0) + 1;
    if (client.measureCount > 300) return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [] };
    const scene = allowedScene(room.state.data, actor, event.sceneId);
    if (event.type === 'measurement-clear') {
      await db.prepare('DELETE FROM test_table_measurements WHERE campaign_id=? AND user_id=? AND client_id=? AND measurement_id=? AND seq<?').bind(client.campaignId, actor.actor.userId, client.id, event.measurementId, event.seq).run();
    } else {
      if (!event.mode || !event.from || !event.to || event.from.x < 0 || event.from.y < 0 || event.to.x < 0 || event.to.y < 0 || event.from.x > scene.width || event.to.x > scene.width || event.from.y > scene.height || event.to.y > scene.height) throw new CommandError('invalid', 'Координаты измерения вне сцены.');
      const payload = { measurementId: event.measurementId, sceneId: event.sceneId, userId: actor.actor.userId, name: actor.actor.name, mode: event.mode,
        from: snapMeasurePoint(event.from, scene.gridSize), to: snapMeasurePoint(event.to, scene.gridSize), seq: event.seq };
      await db.prepare(`DELETE FROM test_table_measurements WHERE campaign_id=? AND user_id=? AND client_id<>? AND NOT EXISTS(SELECT 1 FROM test_table_peers WHERE client_id=test_table_measurements.client_id AND expires>?)`).bind(client.campaignId, actor.actor.userId, client.id, Date.now()).run();
      await db.prepare(`INSERT INTO test_table_measurements(campaign_id,user_id,client_id,scene_id,measurement_id,payload,seq,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,user_id) DO UPDATE SET scene_id=excluded.scene_id,measurement_id=excluded.measurement_id,payload=excluded.payload,seq=excluded.seq,updated_at=excluded.updated_at WHERE test_table_measurements.client_id=excluded.client_id AND (test_table_measurements.measurement_id=excluded.measurement_id AND test_table_measurements.seq<excluded.seq OR excluded.seq=0)`).bind(client.campaignId, actor.actor.userId, client.id, event.sceneId, event.measurementId, JSON.stringify(payload), event.seq, Date.now()).run();
    }
    const current = await pollHosted(env, actor, client, false);
    return current;
  }
  const motion = motionMessageSchema.parse(raw), room = await readHostedRoom(env, actor), scene = allowedScene(room.state.data, actor, motion.sceneId);
  const token = scene.tokens.find(value => value.id === motion.tokenId); if (!token) throw new CommandError('missing', 'Токен не найден.');
  if(!tokenVisible(scene,actor.actor,token)||actor.actor.role!=='master'&&linkedTokens(scene,token).some(t=>!tokenVisible(scene,actor.actor,t)||scene.fog?.enabled&&t.ownerId!==actor.actor.userId))throw new CommandError('forbidden','Нет доступа к выбранной фигуре.');
  if (motion.type === 'motion-start') {
    if (linkedTokens(scene, token).some(member => member.locked)) throw new CommandError('locked', 'Движение этой фигуры или её группы заблокировано.');
    if (linkedTokens(scene, token)[0].id !== token.id) throw new CommandError('busy', 'Двигайте группу через её основной токен.');
    if (token.version !== motion.expectedVersion) throw new CommandError('conflict', 'Положение токена уже изменилось.');
    const prior = await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND token_id=?').bind(client.campaignId, motion.sceneId, motion.tokenId).first<MotionRow>();
    if (prior?.motion_id === motion.motionId && prior.client_id === client.id && prior.expires > Date.now()) return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [] };
    if (prior && prior.expires > Date.now() && ['moving','committing'].includes(prior.status)) throw new CommandError('busy', 'Этот токен сейчас двигает другой участник.');
    await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND client_id=? AND status='moving'").bind(Date.now() + 3000, client.campaignId, client.id).run();
    const claimed = await db.prepare("INSERT INTO test_table_motions(campaign_id,scene_id,token_id,motion_id,client_id,user_id,name,expected_version,seq,x,y,expires,status) SELECT ?,?,?,?,?,?,?,?,-1,?,?,?,'moving' WHERE EXISTS(SELECT 1 FROM test_table_rooms WHERE campaign_id=? AND version=?) ON CONFLICT(campaign_id,scene_id,token_id) DO UPDATE SET motion_id=excluded.motion_id,client_id=excluded.client_id,user_id=excluded.user_id,name=excluded.name,expected_version=excluded.expected_version,seq=-1,x=excluded.x,y=excluded.y,expires=excluded.expires,status='moving',result=NULL WHERE (test_table_motions.expires<=? OR test_table_motions.status IN ('done','cancelled')) AND EXISTS(SELECT 1 FROM test_table_rooms WHERE campaign_id=? AND version=?)").bind(client.campaignId, motion.sceneId, motion.tokenId, motion.motionId, client.id, actor.actor.userId, actor.actor.name, motion.expectedVersion, token.x, token.y, Date.now() + 3000, client.campaignId, room.version, Date.now(), client.campaignId, room.version).run();
    if (claimed.meta.changes !== 1) throw new CommandError('busy', 'Этот токен сейчас двигает другой участник.');
    return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [{ ...motion, type: 'motion-started', userId: actor.actor.userId, name: actor.actor.name, x: token.x, y: token.y, seq: -1 }] };
  }
  const lease = await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND token_id=?').bind(client.campaignId, motion.sceneId, motion.tokenId).first<MotionRow>();
  if (!lease || lease.motion_id !== motion.motionId || lease.client_id !== client.id || lease.user_id !== actor.actor.userId || lease.expires <= Date.now()) {
    if (motion.type === 'motion-frame') return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [] };
    if (motion.type === 'motion-end' && room.state.receipts.some(value => value.id === motion.motionId && value.userId === actor.actor.userId)) return pollHosted(env, actor, client, true, motion.motionId);
    throw new CommandError('expired', 'Движение прервано. Повторите его.');
  }
  if (motion.type === 'motion-cancel') {
    await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND motion_id=? AND client_id=?").bind(Date.now() + 3000, client.campaignId, motion.motionId, client.id).run();
    return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [{ ...motion, type: 'motion-cancelled' }] };
  }
  if (motion.type === 'motion-frame') {
    if (lease.status !== 'moving' || motion.seq <= lease.seq || token.version !== lease.expected_version) return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [] };
    const point = boundedGroupPoint(scene, token, motion);
    await db.prepare("UPDATE test_table_motions SET seq=?,x=?,y=?,expires=? WHERE campaign_id=? AND motion_id=? AND client_id=? AND seq<? AND status='moving'").bind(motion.seq, point.x, point.y, Date.now() + 3000, client.campaignId, motion.motionId, client.id, motion.seq).run();
    return { version: viewVersion(roomView(room.state.data, actor.actor, client.preview)), events: [] };
  }
  if (lease.status === 'done' && lease.result) {
    const packet=await pollHosted(env,actor,client,true,motion.motionId),visible=roomView(room.state.data,actor.actor,client.preview,client.playerViewId).scene.tokens,event=JSON.parse(lease.result);
    if(!scene.fog?.enabled&&!client.playerViewId)packet.events.unshift({...event,token:visible.find(t=>t.id===token.id),tokens:visible.filter(t=>(event.tokens??[]).some((source:{id:string})=>source.id===t.id))});
    return packet;
  }
  if (motion.seq <= lease.seq) throw new CommandError('expired', 'Кадр движения устарел.');
  const point = boundedGroupPoint(scene, token, motion); client.generation++;
  const secured = await db.prepare("UPDATE test_table_motions SET seq=?,x=?,y=?,expires=?,status='committing' WHERE campaign_id=? AND motion_id=? AND client_id=? AND status='moving' AND seq<?").bind(motion.seq, point.x, point.y, Date.now() + 10000, client.campaignId, motion.motionId, client.id, motion.seq).run();
  if (secured.meta.changes !== 1) throw new CommandError('expired', 'Движение уже завершено.');
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readHostedRoom(env, actor), source = allowedScene(current.state.data, actor, motion.sceneId);
      const command = { type: 'move' as const, id: motion.motionId, sceneId: source.id, tokenId: motion.tokenId, expectedVersion: lease.expected_version, baseRevision: source.revision, ...point };
      const result = applyRoomCommand(current.state.data, command, actor.actor, actor.roster);
      const state = { data: result.data, receipts: [...current.state.receipts, { id: command.id, userId: actor.actor.userId }].slice(-1000) };
      if (await saveHostedRoom(env, client.campaignId, current.version, state, { motionId: motion.motionId, clientId: client.id })) {
        const changed = result.data.scenes.find(value => value.scene.id === source.id)!.scene;
        const event = { type: 'motion-committed', motionId: motion.motionId, sceneId: source.id, tokenId: motion.tokenId, token: changed.tokens.find(value => value.id === token.id), tokens: linkedTokens(changed, changed.tokens.find(value => value.id === token.id)!), sceneRevision: changed.revision, updatedAt: changed.updatedAt };
        await db.prepare("UPDATE test_table_motions SET status='done',result=?,expires=? WHERE campaign_id=? AND motion_id=? AND client_id=?").bind(JSON.stringify(event), Date.now() + 10000, client.campaignId, motion.motionId, client.id).run();
        const packet=await pollHosted(env, actor, client, true, command.id);
        const visible=roomView(state.data,actor.actor,client.preview,client.playerViewId).scene.tokens;
        if(!changed.fog?.enabled&&!client.playerViewId)packet.events.unshift({...event,token:visible.find(t=>t.id===token.id),tokens:visible.filter(t=>event.tokens.some(source=>source.id===t.id))});
        return packet;
      }
    }
    throw new CommandError('conflict', 'Сцена изменилась. Повторите движение.');
  } catch (error) {
    await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND motion_id=? AND client_id=?").bind(Date.now() + 3000, client.campaignId, motion.motionId, client.id).run(); throw error;
  }
}
export function hostedError(error: unknown, raw?: unknown) {
  const message = raw as { type?: string; motionId?: string; sceneId?: string; tokenId?: string; command?: { id?: string } };
  const typed = error instanceof CommandError;
  return { type: message?.motionId ? 'motion-rejected' : 'error', motionId: message?.motionId, sceneId: message?.sceneId, tokenId: message?.tokenId, commandId: message?.command?.id,
    code: typed ? error.code : 'invalid', message: typed ? error.message : 'Не удалось выполнить действие тестового стола.' };
}
