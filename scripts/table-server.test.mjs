import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startTableServer } from './table-server.mjs';
import { issueTableTicket, verifyTableTicket } from '../lib/table/ticket.ts';
import { createPrototypeScene } from '../lib/table/scene.ts';

const origin = 'http://127.0.0.1:5173';
function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const messages = [], waiting = [];
  socket.on('message', data => { const value = JSON.parse(data.toString()); messages.push(value); for (const check of [...waiting]) check(); });
  socket.on('error', () => {});
  return { socket, send: value => socket.send(JSON.stringify(value)), async wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const i = waiting.indexOf(check); if (i >= 0) waiting.splice(i, 1); reject(new Error('Timed out waiting for table event')); }, 5000);
      function check() { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); const i = waiting.indexOf(check); if (i >= 0) waiting.splice(i, 1); resolve(messages.splice(index, 1)[0]); }
      waiting.push(check); check();
    });
  }, opened: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }) };
}
test('signed table tickets reject tampering and expiration', async () => {
  const secret = 'a'.repeat(64), claims = { userId: crypto.randomUUID(), campaignId: crypto.randomUUID(), sessionHash: 'b'.repeat(64), origin, expires: Date.now() + 60000, nonce: crypto.randomUUID() };
  const signed = await issueTableTicket(claims, secret);
  assert.deepEqual(await verifyTableTicket(signed, secret), claims);
  assert.equal(await verifyTableTicket(signed, 'c'.repeat(64)), null);
  assert.equal(await verifyTableTicket('x' + signed, secret), null);
  assert.equal(await verifyTableTicket(await issueTableTicket({ ...claims, expires: Date.now() - 1 }, secret), secret), null);
});

test('multi-scene rooms keep preparation private, scope writes, preserve legacy files and recover after restart', async () => {
  const directory = path.resolve('.sites-runtime'); await fs.mkdir(directory, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(directory, 'multi-scene-test-'));
  const campaignId = crypto.randomUUID(), masterId = crypto.randomUUID(), playerId = crypto.randomUUID();
  const roster = [{ userId: masterId, name: 'GM', role: 'master' }, { userId: playerId, name: 'Player', role: 'player' }];
  const legacyScene = createPrototypeScene(campaignId, roster); delete legacyScene.id;
  const legacy = JSON.stringify({ scene: legacyScene, receipts: [] });
  const legacyFile = path.join(stateDirectory, campaignId + '.json'); await fs.writeFile(legacyFile, legacy);
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const verifyAccess = async claims => ({ campaignId, roster, actor: { userId: claims.userId, name: claims.userId === masterId ? 'GM' : 'Player', role: claims.userId === masterId ? 'master' : 'player' } });
  const ticket = userId => issueTableTicket({ userId, campaignId, sessionHash: 'f'.repeat(64), origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, secret);
  let server = await startTableServer({ secret, stateDirectory, verifyAccess });
  let gm = client(server.port), player = client(server.port), expected;
  const cmd = (snapshot, type, extra = {}) => ({ id: crypto.randomUUID(), type, sceneId: snapshot.scene.id, baseRevision: snapshot.scene.revision,
    ...(type.startsWith('scene-') ? { expectedRoomRevision: snapshot.roomRevision } : {}), ...extra });
  const submit = async (peer, command) => { peer.send({ type: 'command', command }); return peer.wait(value => value.type === 'snapshot' && value.commandId === command.id); };
  try {
    await Promise.all([gm.opened, player.opened]); gm.send({ type: 'hello', ticket: await ticket(masterId) }); player.send({ type: 'hello', ticket: await ticket(playerId) });
    const first = await gm.wait(m => m.type === 'snapshot'); await player.wait(m => m.type === 'snapshot');
    assert.deepEqual(first.scene.tokens, legacyScene.tokens);
    let command = cmd(first, 'scene-create', { name: 'Secret ambush' });
    let prepared = await submit(gm, command);
    const uninformed = await player.wait(m => m.commandId === command.id);
    assert.equal(uninformed.scene.id, first.scene.id); assert.equal(uninformed.scenes.length, 1);
    assert.equal(JSON.stringify(uninformed).includes('Secret ambush'), false);
    const preparedId = prepared.scene.id;
    player.send({ type: 'command', command: cmd(uninformed, 'scene-view', { targetSceneId: preparedId }) });
    assert.equal((await player.wait(m => m.type === 'error')).code, 'forbidden'); await player.wait(m => m.type === 'snapshot');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const result = await fetch(`http://127.0.0.1:${server.port}/library?name=secret.png&kind=map&scope=personal`, { method: 'POST', headers: { Authorization: 'Bearer ' + await ticket(masterId) }, body: png });
    assert.equal(result.status, 200); const assetId = (await result.json()).asset.id;
    const media = async who => fetch(`http://127.0.0.1:${server.port}/library?asset=${assetId}`, { headers: { Authorization: 'Bearer ' + await ticket(who) } });
    prepared = await submit(gm, cmd(prepared, 'add', { ownerId: masterId }));
    prepared = await submit(gm, cmd(prepared, 'map', { assetId }));
    assert.equal((await media(playerId)).status, 403); assert.equal((await media(masterId)).status, 200);
    // Ticket refresh keeps the master's personal preview instead of returning to the group.
    gm.send({ type: 'hello', ticket: await ticket(masterId) });
    assert.equal((await gm.wait(m => m.type === 'snapshot' && !m.commandId)).scene.id, preparedId);
    command = cmd(prepared, 'scene-activate', { targetSceneId: preparedId });
    let current = await submit(gm, command); const shown = await player.wait(m => m.commandId === command.id);
    assert.deepEqual(shown.scene, current.scene); assert.equal((await media(playerId)).status, 200);
    const oldToken = first.scene.tokens[0];
    player.send({ type: 'command', command: cmd(first, 'move', { tokenId: oldToken.id, expectedVersion: oldToken.version, x: 400, y: 400 }) });
    assert.equal((await player.wait(m => m.type === 'error')).code, 'forbidden'); await player.wait(m => m.type === 'snapshot' && !m.commandId);
    current = await submit(gm, cmd(current, 'scene-archive', { targetSceneId: first.scene.id }));
    assert.equal(current.scenes.find(scene => scene.id === first.scene.id).archived, true);
    current = await submit(gm, cmd(current, 'scene-restore', { targetSceneId: first.scene.id }));
    command = cmd(current, 'scene-duplicate', { targetSceneId: current.scene.id, name: 'Copy of ambush' });
    const copy = await submit(gm, command);
    assert.notEqual(copy.scene.tokens[0].id, current.scene.tokens[0].id);
    assert.equal(copy.scene.mapAssetId, assetId);
    assert.equal((await submit(gm, command)).scenes.length, 3);
    command = cmd(copy, 'scene-activate', { targetSceneId: first.scene.id });
    current = await submit(gm, command);
    assert.equal((await player.wait(m => m.commandId === command.id)).scene.id, first.scene.id);
    assert.deepEqual(current.scene.tokens, first.scene.tokens);
    assert.equal((await media(playerId)).status, 403);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
    expected = current;
  } finally { gm.socket.terminate(); player.socket.terminate(); await server.close(); }
  server = await startTableServer({ secret, stateDirectory, verifyAccess }); gm = client(server.port); player = client(server.port);
  try {
    await Promise.all([gm.opened, player.opened]); gm.send({ type: 'hello', ticket: await ticket(masterId) }); player.send({ type: 'hello', ticket: await ticket(playerId) });
    const restored = await gm.wait(m => m.type === 'snapshot'), publicView = await player.wait(m => m.type === 'snapshot');
    assert.deepEqual(restored.scene, expected.scene); assert.deepEqual(restored.scenes, expected.scenes);
    assert.equal(restored.roomRevision, expected.roomRevision); assert.equal(publicView.scenes.length, 1);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
  } finally { gm.socket.terminate(); player.socket.terminate(); await server.close(); }
});
test('two authenticated peers converge, allow all token moves, deduplicate and recover after restart', async () => {
  const directory = path.resolve('.sites-runtime'); await fs.mkdir(directory, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(directory, 'table-test-'));
  const campaignId = crypto.randomUUID(), masterId = crypto.randomUUID(), playerId = crypto.randomUUID();
  const roster = [{ userId: masterId, name: 'Мастер', role: 'master' }, { userId: playerId, name: 'Игрок', role: 'player' }];
  let allowed = true, secret = crypto.randomUUID() + crypto.randomUUID();
  const verifyAccess = async claims => allowed ? { campaignId, roster, actor: { userId: claims.userId, name: claims.userId === masterId ? 'Мастер' : 'Игрок', role: claims.userId === masterId ? 'master' : 'player' } } : null;
  const ticket = userId => issueTableTicket({ userId, campaignId, sessionHash: 'f'.repeat(64), origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, secret);
  let server = await startTableServer({ secret, stateDirectory, verifyAccess });
  const first = client(server.port), second = client(server.port);
  let expected;
  try {
    await Promise.all([first.opened, second.opened]);
    first.send({ type: 'hello', ticket: await ticket(masterId) });
    second.send({ type: 'hello', ticket: await ticket(playerId) });
    const a = await first.wait(m => m.type === 'snapshot'), b = await second.wait(m => m.type === 'snapshot');
    assert.deepEqual(a.scene, b.scene);
    const playerToken = a.scene.tokens.find(t => t.ownerId === playerId), foreign = a.scene.tokens.find(t => t.ownerId === masterId);
    const command = { type: 'move', sceneId: a.scene.id, id: crypto.randomUUID(), baseRevision: 0, tokenId: playerToken.id, expectedVersion: 0, x: 440, y: 360 };
    second.send({ type: 'command', command });
    const [one, two] = await Promise.all([first.wait(m => m.type === 'snapshot' && m.commandId === command.id), second.wait(m => m.type === 'snapshot' && m.commandId === command.id)]);
    assert.deepEqual(one.scene, two.scene); assert.equal(one.scene.revision, 1);
    assert.equal(one.scene.tokens.find(t => t.id === playerToken.id).x, 440);
    second.send({ type: 'command', command });
    assert.equal((await second.wait(m => m.commandId === command.id)).scene.revision, 1);
    second.send({ type: 'command', command: { ...command, id: crypto.randomUUID(), baseRevision: 1, tokenId: foreign.id } });
    const snapshot = await second.wait(m => m.type === 'snapshot' && m.scene.revision === 2);
    assert.equal(snapshot.scene.tokens.find(t => t.id === foreign.id).x, 440);
    await first.wait(m => m.type === 'snapshot' && m.scene.revision === 2);
    expected = snapshot.scene;
    // Revocation is checked on the next command, even on an already open socket.
    allowed = false;
    second.send({ type: 'command', command: { ...command, id: crypto.randomUUID(), baseRevision: 1, expectedVersion: 1 } });
    assert.equal((await second.wait(m => m.type === 'error')).code, 'auth');
  } finally { first.socket.terminate(); second.socket.terminate(); await server.close(); }
  secret = crypto.randomUUID() + crypto.randomUUID(); allowed = true;
  server = await startTableServer({ secret, stateDirectory, verifyAccess });
  const restored = client(server.port);
  try {
    await restored.opened; restored.send({ type: 'hello', ticket: await ticket(masterId) });
    assert.deepEqual((await restored.wait(m => m.type === 'snapshot')).scene, expected);
  } finally { restored.socket.terminate(); await server.close(); }
});
