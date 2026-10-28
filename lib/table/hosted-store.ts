import { tableRole } from '../campaign-roles.ts';
import { z } from 'zod';
import { roomDataSchema, createRoom, type TableRoomData } from './room.ts';
import { CommandError, type TableActor, type TableMember } from './scene.ts';
export type HostedEnv = { DB?: D1Database; BUCKET?: R2Bucket };
export type HostedActor = { actor: TableActor; roster: TableMember[]; campaignId: string; sessionHash: string; user: { id: string; name: string; login: string; role: string }; campaign: { id: string; name: string } };
export type StoredRoom = { data: TableRoomData; receipts: { id: string; userId: string }[] };
const authorizationCache = new Map<string, { at: number; value: HostedActor }>();
export function requireDb(env: HostedEnv) { if (!env.DB) throw new CommandError('unavailable', 'Хранилище тестового стола недоступно.'); return env.DB; }
export async function authorizeHosted(env: HostedEnv, request: Request, campaignId: string, fresh = true): Promise<HostedActor> {
  z.string().uuid().parse(campaignId);
  const raw = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('tavern_session='))?.slice('tavern_session='.length);
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) throw new CommandError('auth', 'Войдите в аккаунт в календаре.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), value => value.toString(16).padStart(2,'0')).join('');
  const key = hash + ':' + campaignId, cached = authorizationCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < 1000) return cached.value;
  const db = requireDb(env);
  const row = await db.prepare(`SELECT u.id,u.name,u.login,u.role,c.name AS campaign_name,m.role AS member_role,m.name AS member_name FROM logins l JOIN users u ON u.id=l.user_id JOIN members m ON m.user_id=u.id JOIN campaigns c ON c.id=m.campaign_id WHERE l.token_hash=? AND l.expires>? AND u.disabled=0 AND c.id=?`).bind(hash, Date.now(), campaignId).first<{ id: string; name: string; login: string; role: string; campaign_name: string; member_role: string; member_name: string }>();
  if (!row) {
    authorizationCache.delete(key);
    const valid = await db.prepare('SELECT u.id FROM logins l JOIN users u ON u.id=l.user_id WHERE l.token_hash=? AND l.expires>? AND u.disabled=0').bind(hash, Date.now()).first();
    throw new CommandError(valid ? 'forbidden' : 'auth', 'Нет доступа к этой кампании. Вернитесь в календарь.');
  }
  const roster = (await db.prepare('SELECT user_id AS userId,name,role FROM members WHERE campaign_id=?').bind(campaignId).all<TableMember>()).results;
  const value: HostedActor = { actor: { userId: row.id, name: row.member_name, role: tableRole({ role: row.member_role }) }, roster: roster.map(member => ({ ...member, role: tableRole(member) })), campaignId, sessionHash: hash,
    user: { id: row.id, name: row.name, login: row.login, role: row.role }, campaign: { id: campaignId, name: row.campaign_name } };
  if (authorizationCache.size > 1000) authorizationCache.clear(); authorizationCache.set(key, { at: Date.now(), value }); return value;
}
export async function readHostedRoom(env: HostedEnv, actor: HostedActor) {
  const db = requireDb(env);
  let row = await db.prepare('SELECT payload,version FROM test_table_rooms WHERE campaign_id=?').bind(actor.campaignId).first<{ payload: string; version: number }>();
  if (!row) {
    const payload = JSON.stringify({ data: createRoom(actor.campaignId, actor.roster), receipts: [] });
    await db.prepare('INSERT INTO test_table_rooms(campaign_id,payload,version) VALUES(?,?,0) ON CONFLICT(campaign_id) DO NOTHING').bind(actor.campaignId, payload).run();
    row = await db.prepare('SELECT payload,version FROM test_table_rooms WHERE campaign_id=?').bind(actor.campaignId).first<{ payload: string; version: number }>();
  }
  if (!row) throw new CommandError('unavailable', 'Не удалось открыть тестовый стол.');
  const parsed = JSON.parse(row.payload) as StoredRoom;
  const state: StoredRoom = { data: roomDataSchema.parse(parsed.data), receipts: parsed.receipts ?? [] };
  if (state.data.campaignId !== actor.campaignId) throw new CommandError('forbidden', 'Нет доступа к сцене.');
  return { state, version: row.version };
}
export async function saveHostedRoom(env: HostedEnv, campaignId: string, version: number, state: StoredRoom, lease?: { motionId: string; clientId: string }) {
  const query = lease ? "UPDATE test_table_rooms SET payload=?,version=version+1 WHERE campaign_id=? AND version=? AND EXISTS(SELECT 1 FROM test_table_motions WHERE campaign_id=? AND motion_id=? AND client_id=? AND status='committing' AND expires>?)" : 'UPDATE test_table_rooms SET payload=?,version=version+1 WHERE campaign_id=? AND version=?';
  const values = lease ? [JSON.stringify(state), campaignId, version, campaignId, lease.motionId, lease.clientId, Date.now()] : [JSON.stringify(state), campaignId, version];
  const result = await requireDb(env).prepare(query).bind(...values).run();
  return result.meta.changes === 1;
}
