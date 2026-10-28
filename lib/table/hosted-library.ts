import { z } from 'zod';
import { MAX_ASSET_BYTES, type LibraryAsset } from './assets.ts';
import { validateAssetUpload } from './asset-validation.ts';
import { CommandError } from './scene.ts';
import { authorizeHosted, readHostedRoom, requireDb, type HostedActor, type HostedEnv } from './hosted-store.ts';
type AssetRow = { metadata: string; archived: number; owner_id: string; campaign_id: string | null };
const visible = (row: AssetRow, actor: HostedActor) => !row.archived && (row.owner_id === actor.actor.userId || row.campaign_id === actor.campaignId);
export async function hostedImage(env: HostedEnv, actor: HostedActor, id: string) {
  z.string().uuid().parse(id);
  const row = await requireDb(env).prepare('SELECT metadata,archived,owner_id,campaign_id FROM test_table_assets WHERE id=?').bind(id).first<AssetRow>();
  if (!row || !visible(row, actor)) throw new CommandError('forbidden', 'Файл недоступен в вашей библиотеке.');
  const asset = JSON.parse(row.metadata) as LibraryAsset;
  if (!asset.mime.startsWith('image/')) throw new CommandError('invalid', 'Выберите изображение.');
  return asset;
}
export async function hostedLibrary(request: Request, env: HostedEnv) {
  const url = new URL(request.url), actor = await authorizeHosted(env, request, url.searchParams.get('campaign') ?? '');
  const db = requireDb(env), id = url.searchParams.get('asset');
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!env.BUCKET) throw new CommandError('unavailable', 'Хранилище файлов тестового стола недоступно.');
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) throw new CommandError('forbidden', 'Недопустимый источник запроса.');
  if (request.method === 'GET' && !id) {
    const rows = (await db.prepare('SELECT metadata FROM test_table_assets WHERE archived=0 AND (owner_id=? OR campaign_id=?) ORDER BY updated_at DESC LIMIT 1000').bind(actor.actor.userId, actor.campaignId).all<{ metadata: string }>()).results;
    return Response.json({ assets: rows.map(row => JSON.parse(row.metadata)) }, { headers });
  }
  if (request.method === 'GET' && id) {
    z.string().uuid().parse(id);
    const row = await db.prepare('SELECT metadata,archived,owner_id,campaign_id FROM test_table_assets WHERE id=?').bind(id).first<AssetRow>();
    if (!row) throw new CommandError('forbidden', 'Файл недоступен.');
    if (!visible(row, actor)) {
      const { state } = await readHostedRoom(env, actor);
      const readable = state.data.scenes.filter(entry => actor.actor.role === 'master' || entry.scene.id === state.data.activeSceneId);
      if (!readable.some(({ scene }) => scene.mapAssetId === id || scene.tokens.some(token => token.assetId === id))) throw new CommandError('forbidden', 'Файл недоступен.');
    }
    const asset = JSON.parse(row.metadata) as LibraryAsset, object = await env.BUCKET.get('test-vtt/' + id);
    if (!object) throw new CommandError('missing', 'Файл не найден.');
    return new Response(object.body, { headers: { ...headers, 'Content-Type': asset.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}` } });
  }
  let asset: LibraryAsset;
  if (request.method === 'POST') {
    const reader = request.body?.getReader(); if (!reader) throw new CommandError('invalid', 'Выберите файл.');
    let size = 0; const parts: Uint8Array[] = [];
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_ASSET_BYTES) { await reader.cancel(); throw new CommandError('limit', 'Размер файла — до 8 МБ.'); } parts.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const { input, mime } = validateAssetUpload({ name: url.searchParams.get('name'), kind: url.searchParams.get('kind'), scope: url.searchParams.get('scope') }, bytes);
    await authorizeHosted(env, request, actor.campaignId, true);
    asset = { id: crypto.randomUUID(), ownerId: actor.actor.userId, ownerName: actor.actor.name, campaignId: input.scope === 'shared' ? actor.campaignId : null,
      name: input.name, kind: input.kind, mime, size, createdAt: Date.now() };
    await env.BUCKET.put('test-vtt/' + asset.id, bytes, { httpMetadata: { contentType: mime } });
    try {
      const inserted = await db.prepare('INSERT INTO test_table_assets(id,owner_id,campaign_id,metadata,size,archived,updated_at) SELECT ?,?,?,?,?,0,? WHERE (SELECT COUNT(*) FROM test_table_assets WHERE owner_id=?)<500 AND (SELECT COALESCE(SUM(size),0) FROM test_table_assets WHERE owner_id=?)+?<=268435456').bind(asset.id, asset.ownerId, asset.campaignId, JSON.stringify(asset), size, Date.now(), asset.ownerId, asset.ownerId, size).run();
      if (inserted.meta.changes !== 1) throw new CommandError('limit', 'Лимит библиотеки: 500 файлов и 256 МБ.');
    } catch (error) { await env.BUCKET.delete('test-vtt/' + asset.id); throw error; }
  } else if (request.method === 'PATCH' || request.method === 'DELETE') {
    z.string().uuid().parse(id);
    const row = await db.prepare('SELECT metadata,archived,owner_id,campaign_id FROM test_table_assets WHERE id=?').bind(id).first<AssetRow>();
    const scope = request.method === 'DELETE' ? 'archive' : z.enum(['personal','shared']).parse(url.searchParams.get('scope'));
    if (!row || !visible(row, actor) || row.owner_id !== actor.actor.userId && !(scope === 'archive' && row.campaign_id === actor.campaignId && actor.actor.role === 'master')) throw new CommandError('forbidden', 'Изменять файл может владелец.');
    asset = { ...JSON.parse(row.metadata), ...(scope === 'archive' ? { archived: true } : { campaignId: scope === 'shared' ? actor.campaignId : null }) } as LibraryAsset;
    const result = await db.prepare('UPDATE test_table_assets SET metadata=?,campaign_id=?,archived=?,updated_at=? WHERE id=? AND (owner_id=? OR campaign_id=?)').bind(JSON.stringify(asset), asset.campaignId, asset.archived ? 1 : 0, Date.now(), id, actor.actor.userId, actor.campaignId).run();
    if (result.meta.changes !== 1) throw new CommandError('conflict', 'Файл уже изменён. Обновите библиотеку.');
  } else return new Response(null, { status: 405, headers });
  await db.prepare('UPDATE test_table_rooms SET version=version+1 WHERE campaign_id=?').bind(actor.campaignId).run();
  return Response.json({ asset }, { headers });
}
