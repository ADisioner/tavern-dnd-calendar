import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createTableLibrary } from './table-library.mjs';
import { MAX_ASSET_BYTES } from '../lib/table/assets.ts';
import { verifyTableTicket } from '../lib/table/ticket.ts';
import { CommandError, linkedTokens, boundedGroupPoint } from '../lib/table/scene.ts';
import { roomCommandSchema, roomDataSchema, createRoom, migrateLegacyRoom, roomView, applyRoomCommand } from '../lib/table/room.ts';
import { motionMessageSchema, affectedMotionTokens, MOTION_LEASE_MS, MAX_TABLE_MESSAGE_BYTES } from '../lib/table/motion.ts';
import { getYouTubeVideoStatus } from '../lib/table/youtube.ts';
import { measurementMessageSchema, snapMeasurePoint } from '../lib/table/measurement.ts';
import { canSeeRoll } from '../lib/table/dice.ts';
import { projectScene, tokenVisible, pointVisible } from '../lib/table/fog.ts';
import { maskedMap } from '../lib/table/fog-map.ts';

const isLoopbackOrigin = value => {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.origin === value; }
  catch { return false; }
};
export async function startTableServer({ secret, stateDirectory = path.resolve('.sites-runtime/table-rooms'), verifyAccess }) {
  if (!secret || secret.length < 32) throw new Error('A fresh local service secret is required.');
  await fs.mkdir(stateDirectory, { recursive: true });
  const rooms = new Map(), peers = new Map();
  const library = await createTableLibrary(path.join(stateDirectory, 'library'));
  const http = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/library') { response.writeHead(404); response.end(); return; }
      const peer = await access(request.headers.authorization?.replace(/^Bearer /, ''));
      const room = await roomFor(peer.campaignId, peer.roster);
      const id = url.searchParams.get('asset');
      let value;
      if (request.method === 'GET' && id) {
        const readable = room.data.scenes.filter(entry => peer.actor.role === 'master' || entry.scene.id === room.data.activeSceneId).map(entry => projectScene(entry.scene, peer.actor));
        const { asset, bytes } = await library.read(id, peer, readable);
        if(peer.actor.role!=='master'){
          const map=room.data.scenes.find(entry=>entry.scene.id===room.data.activeSceneId&&entry.scene.mapAssetId===id&&entry.scene.fog?.enabled)?.scene;
          if(map){response.setHeader('Content-Type','image/png');response.end(maskedMap(bytes,asset.mime,map,peer.actor,id));return;}
        }
        response.setHeader('Content-Type', asset.mime);
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
        response.end(bytes); return;
      } else if (request.method === 'GET') value = { assets: library.list(peer) };
      else if (request.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > MAX_ASSET_BYTES) throw new CommandError('limit', 'Размер файла — до 8 МБ.');
          chunks.push(chunk);
        }
        // Recheck after the upload, in case membership or login was revoked.
        const current = await access(request.headers.authorization?.replace(/^Bearer /, ''));
        value = { asset: await library.upload(current, { name: url.searchParams.get('name'), kind: url.searchParams.get('kind'), scope: url.searchParams.get('scope') }, Buffer.concat(chunks)) };
      } else if (request.method === 'PATCH' || request.method === 'DELETE') {
        value = { asset: await library.change(peer, id, request.method === 'DELETE' ? 'archive' : url.searchParams.get('scope')) };
      } else { response.writeHead(405); response.end(); return; }
      if (request.method !== 'GET') for (const [socket, connected] of peers) {
        if (connected.campaignId === peer.campaignId || connected.actor.userId === peer.actor.userId) send(socket, { type: 'library-changed' });
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(error.code === 'auth' ? 401 : error.code === 'forbidden' ? 403 : error.code === 'limit' ? 413 : error instanceof CommandError || error.name === 'ZodError' ? 400 : 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof CommandError ? error.message : 'Не удалось выполнить действие с библиотекой.' }));
    }
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_TABLE_MESSAGE_BYTES,
    verifyClient: info => isLoopbackOrigin(info.origin) && wss.clients.size < 64 });
  const send = (socket, value) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  async function access(ticket) {
    const claims = await verifyTableTicket(ticket, secret);
    if (!claims || !isLoopbackOrigin(claims.origin)) throw new CommandError('auth', 'Сессия стола истекла. Подключитесь заново.');
    let result;
    if (verifyAccess) result = await verifyAccess(claims);
    else {
      const response = await fetch(claims.origin + '/api/table/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new CommandError(response.status === 503 ? 'unavailable' : 'auth', 'Нет доступа к игровому столу. Вернитесь в календарь.');
      result = await response.json();
    }
    if (!result || result.campaignId !== claims.campaignId || result.actor.userId !== claims.userId) throw new CommandError('auth', 'Нет доступа к кампании.');
    return { ...result, claims };
  }
  async function roomFor(campaignId, roster) {
    if (!/^[a-f0-9-]{36}$/.test(campaignId)) throw new Error('Invalid campaign identifier');
    if (!rooms.has(campaignId)) rooms.set(campaignId, (async () => {
      const file = path.join(stateDirectory, campaignId + '.room.json');
      let data, receipts = [];
      try { const saved = JSON.parse(await fs.readFile(file, 'utf8')); data = roomDataSchema.parse(saved.data); receipts = saved.receipts ?? []; }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Сохранение стола повреждено. Исходный файл сохранён.');
        try {
          // Never overwrite the previous single-scene source during migration.
          const saved = JSON.parse(await fs.readFile(path.join(stateDirectory, campaignId + '.json'), 'utf8'));
          data = migrateLegacyRoom(campaignId, saved.scene); receipts = saved.receipts ?? [];
        } catch (legacyError) {
          if (legacyError.code !== 'ENOENT') throw new Error('Сохранение сцены повреждено. Исходный файл сохранён.');
          data = createRoom(campaignId, roster);
        }
      }
      if (data.campaignId !== campaignId) throw new Error('Scene ownership mismatch');
      const room = { data, receipts, file, queue: Promise.resolve(), motions: new Map(), measurements: new Map(), measurementTimers: new Map() };
      // Initial IDs and any migrated room are durable before the first snapshot.
      await save(room);
      return room;
    })());
    return rooms.get(campaignId);
  }
  async function save(room) {
    const temporary = room.file + '.pending';
    await fs.writeFile(temporary, JSON.stringify({ data: room.data, receipts: room.receipts }), 'utf8');
    await fs.rename(temporary, room.file);
  }
  const enqueue = (room, operation) => {
    const task = room.queue.then(operation);
    room.queue = task.catch(() => {});
    return task;
  };
  function presence(campaignId) {
    return Array.from(new Map([...peers.values()].filter(p => p.campaignId === campaignId).map(p => [p.actor.userId, p.actor])).values());
  }
  function announce(campaignId) {
    for (const [socket, peer] of peers) if (peer.campaignId === campaignId) send(socket, { type: 'presence', peers: presence(campaignId) });
  }
  async function refresh(socket, force = true) {
    const peer = peers.get(socket);
    if (!peer) return null;
    if (!force && peer.checkedAt > Date.now() - 2500 && peer.claims.expires > Date.now()) return peer;
    try {
      const current = await access(peer.ticket);
      Object.assign(peer, current, { checkedAt: Date.now() });
      return peer;
    } catch (error) {
      send(socket, { type: 'error', code: error.code ?? 'unavailable', message: error.message });
      socket.close(error.code === 'auth' ? 4003 : 1011, 'Access recheck');
      return null;
    }
  }
  async function snapshot(socket, room, commandId) {
    const peer = await refresh(socket, true);
    if (peer) {
      const sceneId = viewedScene(room, peer), measurements = [...room.measurements.values()].filter(value => value.sceneId === sceneId && value.socket !== socket).map(({ socket: _socket, ...value }) => value);
      const view=roomView(room.data, peer.actor, peer.previewSceneId, peer.playerViewId);
      const viewer=peer.playerViewId?{...peer.actor,userId:peer.playerViewId,role:'player'}:peer.actor;
      const raw=room.data.scenes.find(entry=>entry.scene.id===sceneId)?.scene;
      send(socket, { type: 'snapshot', ...view, actor: peer.actor, roster: peer.roster, peers: presence(peer.campaignId), measurements:measurements.filter(m=>!raw||pointVisible(raw,viewer,m.from)&&pointVisible(raw,viewer,m.to)), commandId });
    }
  }
  async function broadcast(room, commandId) {
    await Promise.all([...peers].filter(([, p]) => p.campaignId === room.data.campaignId).map(([s]) => snapshot(s, room, commandId)));
  }
  const motionKey = value => value.sceneId + ':' + value.tokenId;
  function viewedScene(room, peer) {
    return peer.actor.role === 'master' && room.data.scenes.some(entry => entry.scene.id === peer.previewSceneId && !entry.archived) ? peer.previewSceneId : room.data.activeSceneId;
  }
  async function motionBroadcast(room, motion, message) {
    const sourceScene=room.data.scenes.find(entry=>entry.scene.id===motion.sceneId)?.scene;
    const sensitive=motion.sceneId!==room.data.activeSceneId||!!sourceScene?.fog?.enabled||sourceScene?.tokens.some(t=>t.hidden||t.hp!==undefined||t.ac!==undefined||t.effects?.length);
    for (const [socket, cached] of peers) {
      if(cached.campaignId!==room.data.campaignId)continue;
      const peer=await refresh(socket,sensitive);if(!peer||viewedScene(room,peer)!==motion.sceneId)continue;
      const scene=room.data.scenes.find(entry=>entry.scene.id===motion.sceneId)?.scene;
      const viewer=peer.playerViewId?{...peer.actor,userId:peer.playerViewId,role:'player'}:peer.actor;
      const token=scene?.tokens.find(token=>token.id===motion.tokenId);
      if(!scene||!token||!tokenVisible(scene,viewer,token)||scene.fog?.enabled&&viewer.role!=='master'&&token.ownerId!==viewer.userId)continue;
      let delivered=message;
      if(message.type==='motion-committed') { const visible=projectScene(scene,viewer).tokens; delivered={...message,token:visible.find(t=>t.id===motion.tokenId),tokens:visible.filter(t=>(message.tokens??[]).some(source=>source.id===t.id))}; }
      if (peer.checkedAt > Date.now() - 2500 && peer.claims.expires > Date.now()) send(socket, delivered);
      else if (message.type === 'motion-committed') void snapshot(socket, room, message.motionId).catch(() => {});
    }
  }
  async function measurementBroadcast(room, sceneId) {
    for (const [socket, cached] of peers) {
      if(cached.campaignId!==room.data.campaignId)continue;
      const peer=await refresh(socket,true);if(!peer||viewedScene(room,peer)!==sceneId)continue;
      const measurements = [...room.measurements.values()].filter(value => value.sceneId === sceneId && value.socket !== socket).map(({ socket: _socket, ...value }) => value);
      const scene=room.data.scenes.find(entry=>entry.scene.id===sceneId)?.scene,viewer=peer.playerViewId?{...peer.actor,userId:peer.playerViewId,role:'player'}:peer.actor;
      send(socket, { type: 'measurement-state', sceneId, measurements:measurements.filter(m=>!scene||pointVisible(scene,viewer,m.from)&&pointVisible(scene,viewer,m.to)) });
    }
  }
  async function measurement(socket, raw) {
    const parsed = measurementMessageSchema.safeParse(raw); if (!parsed.success) return;
    const peer = await refresh(socket,true); if (!peer || peer.claims.expires <= Date.now()) return;
    const room = await rooms.get(peer.campaignId); if (!room) return;
    const message = parsed.data, key = peer.actor.userId;
    if (Date.now() - (peer.measureWindow ?? 0) > 10000) { peer.measureWindow = Date.now(); peer.measureCount = 0; }
    if (++peer.measureCount > 300) return;
    if (viewedScene(room, peer) !== message.sceneId) return;
    if (message.type === 'measurement-clear') {
      const current = room.measurements.get(key);
      if (!current || current.socket !== socket || current.measurementId !== message.measurementId || message.seq <= current.seq) return;
      room.measurements.delete(key); measurementBroadcast(room, message.sceneId); return;
    }
    const scene = room.data.scenes.find(entry => entry.scene.id === message.sceneId)?.scene;
    if (!scene || !message.from || !message.to || !message.mode) return;
    const current = room.measurements.get(key);
    if (current && (current.socket !== socket || current.measurementId !== message.measurementId && message.seq !== 0 || current.measurementId === message.measurementId && message.seq <= current.seq)) return;
    const point = value => snapMeasurePoint({ x: Math.max(0, Math.min(scene.width, value.x)), y: Math.max(0, Math.min(scene.height, value.y)) }, scene.gridSize);
    const next = { measurementId: message.measurementId, sceneId: message.sceneId, userId: peer.actor.userId, name: peer.actor.name, mode: message.mode, from: point(message.from), to: point(message.to), seq: message.seq, socket };
    room.measurements.set(key, next);
    const elapsed = Date.now() - (peer.measureSentAt ?? 0);
    if (elapsed >= 50) { peer.measureSentAt = Date.now(); measurementBroadcast(room, message.sceneId); }
    else if (!room.measurementTimers.has(message.sceneId)) {
      const timer = setTimeout(() => { room.measurementTimers.delete(message.sceneId); measurementBroadcast(room, message.sceneId); }, 50 - elapsed);
      room.measurementTimers.set(message.sceneId, timer);
    }
  }
  function pruneMeasurements(room) {
    const affected = new Set();
    for (const [userId, value] of room.measurements) {
      const owner = peers.get(value.socket);
      if (!owner || viewedScene(room, owner) !== value.sceneId) { affected.add(value.sceneId); room.measurements.delete(userId); }
    }
    for (const sceneId of affected) measurementBroadcast(room, sceneId);
  }
  function cancelMotion(room, motion, reason = 'cancelled') {
    if (room.motions.get(motionKey(motion)) !== motion) return;
    room.motions.delete(motionKey(motion));
    motionBroadcast(room, motion, { type: 'motion-cancelled', motionId: motion.motionId, sceneId: motion.sceneId, tokenId: motion.tokenId, reason });
  }
  function invalidateMotions(room, changedGridScene) {
    for (const motion of room.motions.values()) {
      const owner = peers.get(motion.socket), entry = room.data.scenes.find(entry => entry.scene.id === motion.sceneId && !entry.archived);
      const token = entry?.scene.tokens.find(token => token.id === motion.tokenId);
      if (!owner || viewedScene(room, owner) !== motion.sceneId || !token || token.version !== motion.expectedVersion || changedGridScene === motion.sceneId || !motion.ending && motion.expires < Date.now()) cancelMotion(room, motion);
    }
  }
  function authorizedMotionScene(room, peer, sceneId) {
    const entry = room.data.scenes.find(entry => entry.scene.id === sceneId && !entry.archived);
    if (!entry || (peer.actor.role !== 'master' && sceneId !== room.data.activeSceneId)) throw new CommandError('forbidden', 'Эта сцена недоступна для движения.');
    return entry.scene;
  }
  // Ephemeral frames bypass the durable-command queue and never perform file/DB work.
  // Permissions are bounded by the short cache and refreshed in the background.
  async function frame(socket, raw) {
    const parsed = motionMessageSchema.safeParse(raw); if (!parsed.success || parsed.data.type !== 'motion-frame') return;
    const message = parsed.data, peer = peers.get(socket);
    if (!peer || peer.checkedAt < Date.now() - 2500 || peer.claims.expires <= Date.now()) return;
    const room = await rooms.get(peer.campaignId); if (!room) return;
    const motion = room.motions.get(motionKey(message));
    if (!motion || motion.socket !== socket || motion.motionId !== message.motionId || motion.ending || motion.expires < Date.now() || message.seq <= motion.seq) return;
    if (Date.now() - (peer.frameWindow ?? 0) > 10000) { peer.frameWindow = Date.now(); peer.frameCount = 0; }
    if (++peer.frameCount > 300) return;
    let scene;
    try { scene = authorizedMotionScene(room, peer, message.sceneId); } catch { cancelMotion(room, motion); return; }
    const token = scene.tokens.find(token => token.id === message.tokenId);
    if (!token || token.version !== motion.expectedVersion) { cancelMotion(room, motion); return; }
    motion.seq = message.seq; motion.expires = Date.now() + MOTION_LEASE_MS;
    const point = boundedGroupPoint(scene, token, message);
    if (Date.now() - motion.sentAt < 40) return;
    motion.sentAt = Date.now();
    motionBroadcast(room, motion, { type: 'motion-frame', motionId: motion.motionId, sceneId: motion.sceneId, tokenId: motion.tokenId, seq: motion.seq, userId: peer.actor.userId, name: peer.actor.name, ...point });
  }
  async function motionCommand(socket, room, message, peer) {
    const key = motionKey(message), existing = room.motions.get(key);
    if (message.type === 'motion-start') {
      const scene = authorizedMotionScene(room, peer, message.sceneId), token = scene.tokens.find(token => token.id === message.tokenId);
      if(!token||!tokenVisible(scene,peer.actor,token)||peer.actor.role!=='master'&&linkedTokens(scene,token).some(t=>!tokenVisible(scene,peer.actor,t)||scene.fog?.enabled&&t.ownerId!==peer.actor.userId))throw new CommandError('forbidden','Нет доступа к выбранной фигуре.');
      if (!token) throw new CommandError('missing', 'Токен больше не существует.');
      if (linkedTokens(scene, token).some(member => member.locked)) throw new CommandError('locked', 'Движение этой фигуры или её группы заблокировано.');
      if (linkedTokens(scene, token)[0].id !== token.id) throw new CommandError('busy', 'Двигайте группу через её основной токен.');
      if (existing && existing.expires > Date.now() && (existing.socket !== socket || existing.motionId !== message.motionId)) throw new CommandError('busy', 'Этот токен сейчас двигает другой участник.');
      if (token.version !== message.expectedVersion) throw new CommandError('conflict', 'Положение токена изменилось. Повторите движение.');
      if (existing?.socket === socket && existing.motionId === message.motionId) return;
      for (const motion of room.motions.values()) if (motion.socket === socket && motion.motionId !== message.motionId) cancelMotion(room, motion);
      const motion = { ...message, socket, seq: -1, sentAt: 0, expires: Date.now() + MOTION_LEASE_MS };
      room.motions.set(key, motion);
      motionBroadcast(room, motion, { ...message, type: 'motion-started', userId: peer.actor.userId, name: peer.actor.name, x: token.x, y: token.y });
      return;
    }
    if (!existing || existing.socket !== socket || existing.motionId !== message.motionId) {
      if (message.type === 'motion-end' && room.receipts.some(receipt => receipt.id === message.motionId && receipt.userId === peer.actor.userId)) { await snapshot(socket, room, message.motionId); return; }
      throw new CommandError('expired', 'Движение завершено или прервано.');
    }
    if (message.type === 'motion-cancel') { cancelMotion(room, existing); return; }
    if (message.type !== 'motion-end' || existing.expires < Date.now() || message.seq <= existing.seq) throw new CommandError('expired', 'Движение устарело.');
    const scene = authorizedMotionScene(room, peer, message.sceneId);
    existing.ending = true;
    const command = { id: message.motionId, sceneId: message.sceneId, baseRevision: scene.revision, type: 'move', tokenId: message.tokenId, expectedVersion: existing.expectedVersion, x: message.x, y: message.y };
    const result = applyRoomCommand(room.data, command, peer.actor, peer.roster);
    const receipts = [...room.receipts, { id: command.id, userId: peer.actor.userId }].slice(-1000);
    try { await save({ ...room, data: result.data, receipts }); }
    catch { throw new CommandError('save', 'Не удалось сохранить движение. Позиция восстановлена.'); }
    room.data = result.data; room.receipts = receipts; room.motions.delete(key);
    const savedScene = room.data.scenes.find(entry => entry.scene.id === scene.id).scene;
    motionBroadcast(room, existing, { type: 'motion-committed', motionId: message.motionId, sceneId: scene.id, tokenId: message.tokenId,
      token: savedScene.tokens.find(token => token.id === message.tokenId), tokens: linkedTokens(savedScene, savedScene.tokens.find(token => token.id === message.tokenId)), sceneRevision: savedScene.revision, updatedAt: savedScene.updatedAt });
    if(savedScene.fog?.enabled) await Promise.all([...peers].filter(([,p])=>p.campaignId===room.data.campaignId).map(([s,p])=>snapshot(s,room,p.actor.userId===peer.actor.userId?message.motionId:undefined)));
  }
  wss.on('connection', (socket, request) => {
    const origin = request.headers.origin;
    let chain = Promise.resolve(), count = 0, windowStarted = Date.now();
    const helloTimeout = setTimeout(() => { if (!peers.has(socket)) socket.close(4003, 'Authentication required'); }, 8000);
    socket.on('message', raw => {
      let rejectedCommandId;
      let motionMessage;
      try { const message = JSON.parse(raw.toString()); if (message.type === 'motion-frame') { void frame(socket, message).catch(() => {}); return; } if (message.type === 'measurement-frame' || message.type === 'measurement-clear') { void measurement(socket, message).catch(() => {}); return; } } catch { /* durable path returns a structured error */ }
      chain = chain.then(async () => {
        if (Date.now() - windowStarted > 10000) { count = 0; windowStarted = Date.now(); }
        if (++count > 80) throw new CommandError('rate', 'Слишком много команд. Подождите несколько секунд.');
        const message = JSON.parse(raw.toString());
        if (typeof message.command?.id === 'string' && message.command.id.length === 36) rejectedCommandId = message.command.id;
        if (message.type === 'hello' && typeof message.ticket === 'string') {
          const current = await access(message.ticket);
          if (current.claims.origin !== origin) throw new CommandError('auth', 'Источник соединения не совпадает.');
          const previous = peers.get(socket);
          if (previous && previous.campaignId !== current.campaignId) throw new CommandError('auth', 'Откройте другую кампанию в отдельном соединении.');
          peers.set(socket, { ...current, ticket: message.ticket, previewSceneId: previous?.previewSceneId, checkedAt: Date.now() }); clearTimeout(helloTimeout);
          const room = await roomFor(current.campaignId, current.roster);
          await enqueue(room, () => snapshot(socket, room)); announce(current.campaignId);
          return;
        }
        const isMotion = typeof message.type === 'string' && message.type.startsWith('motion-');
        const peer = await refresh(socket, !isMotion);
        if (!peer) { socket.close(4003, 'Authentication required'); return; }
        if (typeof message.type === 'string' && message.type.startsWith('motion-')) {
          motionMessage = motionMessageSchema.parse(message);
          const room = await roomFor(peer.campaignId, peer.roster);
          if (motionMessage.type === 'motion-end') {
            const existing = room.motions.get(motionKey(motionMessage));
            if (existing?.socket === socket && existing.motionId === motionMessage.motionId && motionMessage.seq > existing.seq && existing.expires > Date.now()) {
              const scene = authorizedMotionScene(room, peer, motionMessage.sceneId), token = scene.tokens.find(value => value.id === motionMessage.tokenId);
              if (token && token.version === existing.expectedVersion) {
                // Show the exact drop/keyboard destination immediately, while its durable write waits.
                existing.ending = true; existing.expires = Date.now() + 10000;
                motionBroadcast(room, existing, { type: 'motion-frame', motionId: existing.motionId, sceneId: existing.sceneId, tokenId: existing.tokenId,
                  seq: motionMessage.seq, userId: peer.actor.userId, name: peer.actor.name, ...boundedGroupPoint(scene, token, motionMessage) });
              }
            }
          }
          await enqueue(room, async () => { const current = await refresh(socket, motionMessage.type === 'motion-end'); if (current) await motionCommand(socket, room, motionMessage, current); });
          return;
        }
        if (message.type !== 'command') throw new CommandError('invalid', 'Неизвестная команда.');
        const command = roomCommandSchema.parse(message.command);
        const room = await roomFor(peer.campaignId, peer.roster);
        await enqueue(room, async () => {
          // Recheck after waiting for other commands: logout/removal must revoke writes.
          const actor = await refresh(socket); if (!actor) return;
          if (room.receipts.some(r => r.id === command.id && r.userId === actor.actor.userId)) { await snapshot(socket, room, command.id); return; }
          let youtubeTitle;
          const commandScene = room.data.scenes.find(entry => entry.scene.id === command.sceneId)?.scene;
          if (commandScene && affectedMotionTokens(commandScene, command).some(token => {
            const lease = room.motions.get(command.sceneId + ':' + token.id);
            return lease && (lease.ending || lease.expires > Date.now());
          })) throw new CommandError('busy', 'Дождитесь окончания движения этой группы.');
          if ((command.type === 'add' || command.type === 'map') && command.assetId) await library.image(command.assetId, actor);
          if (command.type === 'music-add') {
            let status;
            try { status = await getYouTubeVideoStatus(process.env.YOUTUBE_API_KEY, command.videoId); }
            catch (error) { throw new CommandError('unavailable', error instanceof Error ? error.message : 'Не удалось проверить видео YouTube.'); }
            if (!status.embeddable) throw new CommandError('invalid', 'Это видео запрещено встраивать.');
            if (status.madeForKids) throw new CommandError('invalid', 'Видео с отметкой «для детей» пока нельзя добавить в общий плеер.');
            youtubeTitle = status.title;
          }
          const result = applyRoomCommand(room.data, command, actor.actor, actor.roster, { youtubeTitle });
          if (command.type === 'scene-view' || command.type === 'scene-view-player') { if(command.type==='scene-view')actor.previewSceneId = result.viewSceneId;else actor.playerViewId=result.playerViewId; invalidateMotions(room); pruneMeasurements(room); await snapshot(socket, room, command.id); return; }
          const receipts = [...room.receipts, { id: command.id, userId: actor.actor.userId }].slice(-1000);
          try { await save({ ...room, data: result.data, receipts }); }
          catch { throw new CommandError('save', 'Сохранение не удалось. Изменение не подтверждено.'); }
          room.data = result.data; room.receipts = receipts;
          if (result.viewSceneId) actor.previewSceneId = result.viewSceneId;
          invalidateMotions(room, command.type === 'grid' ? command.sceneId : undefined);
          pruneMeasurements(room);
          if (command.type === 'dice-roll') {
            const roll = room.data.rolls.find(value => value.id === command.id);
            await Promise.all([...peers].filter(([,p]) => p.campaignId === room.data.campaignId && (p.actor.userId === actor.actor.userId || canSeeRoll(roll, p.actor))).map(([s,p]) => snapshot(s, room, p.actor.userId === actor.actor.userId ? command.id : undefined)));
          } else await broadcast(room, command.id);
        });
      }).catch(async error => {
        if (motionMessage) {
          send(socket, { type: 'motion-rejected', motionId: motionMessage.motionId, sceneId: motionMessage.sceneId, tokenId: motionMessage.tokenId, code: error.code ?? 'invalid', message: error instanceof CommandError ? error.message : 'Движение не подтверждено.' });
          const peer = peers.get(socket), room = peer && await rooms.get(peer.campaignId);
          const existing = room?.motions.get(motionKey(motionMessage));
          if (existing?.motionId === motionMessage.motionId && existing.socket === socket) cancelMotion(room, existing);
          if (room) await snapshot(socket, room);
          return;
        }
        send(socket, { type: 'error', code: error.code ?? 'invalid', message: error instanceof CommandError ? error.message : 'Некорректная команда.', commandId: rejectedCommandId });
        const peer = peers.get(socket);
        if (peer) { const room = await roomFor(peer.campaignId, peer.roster).catch(() => null); if (room) await snapshot(socket, room); }
      });
    });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(helloTimeout); const peer = peers.get(socket); peers.delete(socket); if (peer) { void rooms.get(peer.campaignId)?.then(room => { invalidateMotions(room); const current = room.measurements.get(peer.actor.userId); if (current?.socket === socket) { room.measurements.delete(peer.actor.userId); measurementBroadcast(room, current.sceneId); } }); announce(peer.campaignId); } });
  });
  const heartbeat = setInterval(() => {
    for (const [socket, peer] of peers) if (!peer.backgroundCheck) peer.backgroundCheck = refresh(socket).finally(() => { peer.backgroundCheck = null; });
    for (const promise of rooms.values()) void promise.then(room => invalidateMotions(room)).catch(() => {});
  }, 1000);
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  return { port: http.address().port, async close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([...rooms.values()].map(async promise => { const room = await promise.catch(() => null); if (room) { for (const timer of room.measurementTimers.values()) clearTimeout(timer); room.measurementTimers.clear(); await room.queue; } }));
    await new Promise(resolve => wss.close(resolve));
    await library.close();
    await new Promise(resolve => http.close(resolve));
  } };
}
