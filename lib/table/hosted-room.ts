import { z } from 'zod';
import { authorizeHosted, readHostedRoom, requireDb, saveHostedRoom, type HostedActor, type HostedEnv } from './hosted-store.ts';
import { applyRoomCommand, roomCommandSchema, roomView, type TableRoomData } from './room.ts';
import { affectedMotionTokens, motionMessageSchema } from './motion.ts';
import { CommandError, linkedTokens, boundedGroupPoint } from './scene.ts';
import { hostedImage } from './hosted-library.ts';

export type HostedClient = { id: string; campaignId: string; preview?: string; version: number; sceneId: string; generation: number; touched: number; seen: Map<string,string>; permissions?: string };
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
export async function pollHosted(env: HostedEnv, actor: HostedActor, client: HostedClient, force = false, commandId?: string) {
  const db = requireDb(env), generation = client.generation, events: Record<string, unknown>[] = [];
  const touched = Date.now() - client.touched > 3000;
  if (touched) { await db.prepare('INSERT INTO test_table_peers(client_id,campaign_id,user_id,expires) VALUES(?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET expires=excluded.expires WHERE campaign_id=excluded.campaign_id AND user_id=excluded.user_id AND expires<?').bind(client.id, actor.campaignId, actor.actor.userId, Date.now() + 12000, Date.now() + 8000).run(); client.touched = Date.now(); }
  const room = await readHostedRoom(env, actor), version = room.version;
  const view = roomView(room.state.data, actor.actor, client.preview), sceneId = view.scene.id;
  const permissions = JSON.stringify([actor.actor, actor.roster]);
  if (force || version !== client.version || client.sceneId !== sceneId || client.permissions !== permissions) {
    client.permissions = permissions;
    events.push({ type: 'snapshot', ...view, actor: actor.actor, roster: actor.roster, peers: await presence(env, actor), commandId: commandId ?? room.state.receipts.at(-1)?.id });
    if (client.version >= 0) events.push({ type: 'library-changed' });
  } else if (touched) events.push({ type: 'presence', peers: await presence(env, actor) });
  if (sceneId) {
    const rows = (await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND expires>?').bind(actor.campaignId, sceneId, Date.now()).all<MotionRow>()).results;
    for (const row of rows) {
      const key = row.motion_id + ':' + row.seq + ':' + row.status;
      if (client.seen.get(row.motion_id) === key) continue;
      if (row.status === 'done' && row.result) events.push(JSON.parse(row.result));
      else if (row.status === 'cancelled') events.push({ type: 'motion-cancelled', motionId: row.motion_id, sceneId, tokenId: row.token_id });
      else events.push({ type: row.seq < 0 ? 'motion-started' : 'motion-frame', motionId: row.motion_id, sceneId, tokenId: row.token_id, seq: row.seq, userId: row.user_id, name: row.name, x: row.x, y: row.y });
    }
    if (generation !== client.generation) return { version: client.version, events: [], previewSceneId: client.preview };
    for (const row of rows) client.seen.set(row.motion_id, row.motion_id + ':' + row.seq + ':' + row.status);
    if (client.seen.size > 500) client.seen.clear();
  }
  if (generation !== client.generation) return { version: client.version, events: [], previewSceneId: client.preview };
  client.version = version; client.sceneId = sceneId;
  return { version, events, previewSceneId: client.preview };
}
export async function hostedMessage(env: HostedEnv, request: Request, client: HostedClient, raw: unknown) {
  const message = raw as { type?: string; command?: unknown };
  const ephemeral = ['motion-start','motion-frame','motion-cancel'].includes(message?.type ?? '');
  const actor = await authorizeHosted(env, request, client.campaignId, !ephemeral), db = requireDb(env);
  if (message.type === 'hello') return pollHosted(env, actor, client, true);
  if (message.type === 'command') {
    const command = roomCommandSchema.parse(message.command); client.generation++;
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
      const result = applyRoomCommand(room.state.data, command, actor.actor, actor.roster);
      if (command.type === 'scene-view') { client.preview = result.viewSceneId; return pollHosted(env, actor, client, true, command.id); }
      const state = { data: result.data, receipts: [...room.state.receipts, { id: command.id, userId: actor.actor.userId }].slice(-1000) };
      const idleToken = touched.length ? { sceneId: command.sceneId!, tokenIds: touched } : undefined;
      if (await saveHostedRoom(env, client.campaignId, room.version, state, undefined, idleToken)) {
        if (result.viewSceneId) client.preview = result.viewSceneId;
        if (['grid','scene-activate','scene-archive'].includes(command.type)) await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND status IN ('moving','committing')").bind(Date.now() + 3000, client.campaignId).run();
        return pollHosted(env, actor, client, true, command.id);
      }
    }
    throw new CommandError('conflict', 'Сцена изменилась. Повторите действие.');
  }
  const motion = motionMessageSchema.parse(raw), room = await readHostedRoom(env, actor), scene = allowedScene(room.state.data, actor, motion.sceneId);
  const token = scene.tokens.find(value => value.id === motion.tokenId); if (!token) throw new CommandError('missing', 'Токен не найден.');
  if (motion.type === 'motion-start') {
    if (linkedTokens(scene, token).some(member => member.locked)) throw new CommandError('locked', 'Движение этой фигуры или её группы заблокировано.');
    if (linkedTokens(scene, token)[0].id !== token.id) throw new CommandError('busy', 'Двигайте группу через её основной токен.');
    if (token.version !== motion.expectedVersion) throw new CommandError('conflict', 'Положение токена уже изменилось.');
    const prior = await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND token_id=?').bind(client.campaignId, motion.sceneId, motion.tokenId).first<MotionRow>();
    if (prior?.motion_id === motion.motionId && prior.client_id === client.id && prior.expires > Date.now()) return { version: room.version, events: [] };
    if (prior && prior.expires > Date.now() && ['moving','committing'].includes(prior.status)) throw new CommandError('busy', 'Этот токен сейчас двигает другой участник.');
    await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND client_id=? AND status='moving'").bind(Date.now() + 3000, client.campaignId, client.id).run();
    const claimed = await db.prepare("INSERT INTO test_table_motions(campaign_id,scene_id,token_id,motion_id,client_id,user_id,name,expected_version,seq,x,y,expires,status) SELECT ?,?,?,?,?,?,?,?,-1,?,?,?,'moving' WHERE EXISTS(SELECT 1 FROM test_table_rooms WHERE campaign_id=? AND version=?) ON CONFLICT(campaign_id,scene_id,token_id) DO UPDATE SET motion_id=excluded.motion_id,client_id=excluded.client_id,user_id=excluded.user_id,name=excluded.name,expected_version=excluded.expected_version,seq=-1,x=excluded.x,y=excluded.y,expires=excluded.expires,status='moving',result=NULL WHERE (test_table_motions.expires<=? OR test_table_motions.status IN ('done','cancelled')) AND EXISTS(SELECT 1 FROM test_table_rooms WHERE campaign_id=? AND version=?)").bind(client.campaignId, motion.sceneId, motion.tokenId, motion.motionId, client.id, actor.actor.userId, actor.actor.name, motion.expectedVersion, token.x, token.y, Date.now() + 3000, client.campaignId, room.version, Date.now(), client.campaignId, room.version).run();
    if (claimed.meta.changes !== 1) throw new CommandError('busy', 'Этот токен сейчас двигает другой участник.');
    return { version: room.version, events: [{ ...motion, type: 'motion-started', userId: actor.actor.userId, name: actor.actor.name, x: token.x, y: token.y, seq: -1 }] };
  }
  const lease = await db.prepare('SELECT * FROM test_table_motions WHERE campaign_id=? AND scene_id=? AND token_id=?').bind(client.campaignId, motion.sceneId, motion.tokenId).first<MotionRow>();
  if (!lease || lease.motion_id !== motion.motionId || lease.client_id !== client.id || lease.user_id !== actor.actor.userId || lease.expires <= Date.now()) {
    if (motion.type === 'motion-frame') return { version: room.version, events: [] };
    if (motion.type === 'motion-end' && room.state.receipts.some(value => value.id === motion.motionId && value.userId === actor.actor.userId)) return pollHosted(env, actor, client, true, motion.motionId);
    throw new CommandError('expired', 'Движение прервано. Повторите его.');
  }
  if (motion.type === 'motion-cancel') {
    await db.prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE campaign_id=? AND motion_id=? AND client_id=?").bind(Date.now() + 3000, client.campaignId, motion.motionId, client.id).run();
    return { version: room.version, events: [{ ...motion, type: 'motion-cancelled' }] };
  }
  if (motion.type === 'motion-frame') {
    if (lease.status !== 'moving' || motion.seq <= lease.seq || token.version !== lease.expected_version) return { version: room.version, events: [] };
    const point = boundedGroupPoint(scene, token, motion);
    await db.prepare("UPDATE test_table_motions SET seq=?,x=?,y=?,expires=? WHERE campaign_id=? AND motion_id=? AND client_id=? AND seq<? AND status='moving'").bind(motion.seq, point.x, point.y, Date.now() + 3000, client.campaignId, motion.motionId, client.id, motion.seq).run();
    return { version: room.version, events: [] };
  }
  if (lease.status === 'done' && lease.result) return { version: room.version, events: [JSON.parse(lease.result)] };
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
        return { version: current.version + 1, events: [event] };
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
