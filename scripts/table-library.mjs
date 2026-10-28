import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MAX_ASSET_BYTES } from '../lib/table/assets.ts';
import { CommandError } from '../lib/table/scene.ts';

const metadata = z.object({ name: z.string().trim().min(1).max(100),
  kind: z.enum(['image', 'token', 'map', 'document', 'audio']), scope: z.enum(['personal', 'shared']) }).strict();
const uuid = z.string().uuid();
function detectMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  throw new CommandError('invalid', 'Поддерживаются PNG, JPEG, WebP, GIF, PDF, MP3, OGG и WAV.');
}
export async function createTableLibrary(directory) {
  await fs.mkdir(directory, { recursive: true });
  const indexFile = path.join(directory, 'index.json');
  let assets = [];
  try { assets = JSON.parse(await fs.readFile(indexFile, 'utf8')); if (!Array.isArray(assets)) throw new Error(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Библиотека повреждена. Исходные файлы сохранены.'); }
  let queue = Promise.resolve();
  const serialize = operation => { const task = queue.then(operation); queue = task.catch(() => {}); return task; };
  async function save(next) {
    await fs.writeFile(indexFile + '.pending', JSON.stringify(next));
    await fs.rename(indexFile + '.pending', indexFile); assets = next;
  }
  const visible = (asset, peer) => !asset.archived && (asset.ownerId === peer.actor.userId || asset.campaignId === peer.campaignId);
  function find(id) { const key = uuid.parse(id); return assets.find(asset => asset.id === key); }
  return {
    list: peer => assets.filter(asset => visible(asset, peer)).map(asset => ({ ...asset })),
    async image(id, peer) {
      const asset = find(id);
      if (!asset || !visible(asset, peer) || !asset.mime.startsWith('image/')) throw new CommandError('forbidden', 'Изображение недоступно в вашей библиотеке.');
      return asset;
    },
    async read(id, peer, scene) {
      const asset = find(id);
      const placed = (Array.isArray(scene) ? scene : [scene]).some(value => value.mapAssetId === id || value.tokens.some(token => token.assetId === id));
      if (!asset || (!visible(asset, peer) && !placed)) throw new CommandError('forbidden', 'Файл недоступен.');
      return { asset, bytes: await fs.readFile(path.join(directory, asset.id + '.bin')) };
    },
    upload: (peer, rawMetadata, bytes) => serialize(async () => {
      const input = metadata.parse(rawMetadata);
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new CommandError('limit', 'Размер файла — до 8 МБ.');
      const mime = detectMime(bytes);
      if (['image', 'token', 'map'].includes(input.kind) && !mime.startsWith('image/')) throw new CommandError('invalid', 'Для карты или токена выберите изображение.');
      if (input.kind === 'document' && mime !== 'application/pdf') throw new CommandError('invalid', 'Для документа выберите PDF.');
      if (input.kind === 'audio' && !mime.startsWith('audio/')) throw new CommandError('invalid', 'Выберите аудиофайл.');
      const owned = assets.filter(a => a.ownerId === peer.actor.userId);
      if (owned.length >= 500 || owned.reduce((sum, a) => sum + a.size, 0) + bytes.length > 256 * 1024 * 1024) throw new CommandError('limit', 'Лимит библиотеки: 500 файлов и 256 МБ, включая используемые на сценах.');
      const asset = { id: crypto.randomUUID(), ownerId: peer.actor.userId, ownerName: peer.actor.name,
        campaignId: input.scope === 'shared' ? peer.campaignId : null, name: input.name,
        kind: input.kind, mime, size: bytes.length, createdAt: Date.now() };
      const file = path.join(directory, asset.id + '.bin');
      await fs.writeFile(file, bytes, { flag: 'wx' });
      try { await save([...assets, asset]); } catch (error) { await fs.unlink(file); throw error; }
      return asset;
    }),
    change: (peer, id, scope) => serialize(async () => {
      const asset = find(id);
      if (!asset || !visible(asset, peer) || (asset.ownerId !== peer.actor.userId && !(scope === 'archive' && asset.campaignId === peer.campaignId && peer.actor.role === 'master')))
        throw new CommandError('forbidden', 'Изменять файл может его владелец.');
      if (!['personal', 'shared', 'archive'].includes(scope)) throw new CommandError('invalid', 'Неизвестная библиотека.');
      const changed = { ...asset, ...(scope === 'archive' ? { archived: true } : { campaignId: scope === 'shared' ? peer.campaignId : null }) };
      await save(assets.map(a => a.id === id ? changed : a));
      return changed;
    }),
    close: () => queue,
  };
}
