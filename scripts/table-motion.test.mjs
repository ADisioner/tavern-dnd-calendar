import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startTableServer } from './table-server.mjs';
import { issueTableTicket } from '../lib/table/ticket.ts';
import { MotionStore, motionMessageSchema, MAX_TABLE_MESSAGE_BYTES } from '../lib/table/motion.ts';

const origin = 'http://127.0.0.1:5173';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin }), messages = [], waiting = [];
  socket.on('error', () => {});
  socket.on('message', raw => { messages.push(JSON.parse(raw.toString())); for (const check of [...waiting]) check(); });
  return { socket, messages, send: value => socket.send(JSON.stringify(value)), opened: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    wait: predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(check), 1); reject(new Error('Motion event timeout')); }, 5000);
      function check() { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); waiting.splice(waiting.indexOf(check), 1); resolve(messages.splice(index, 1)[0]); }
      waiting.push(check); check();
    }) };
}
async function setup(count = 2) {
  const root = path.resolve('.sites-runtime'); await fs.mkdir(root, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(root, 'motion-test-')), campaignId = crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID(), roster = Array.from({ length: count }, (_, i) => ({ userId: crypto.randomUUID(), name: 'User ' + i, role: i ? 'player' : 'master' }));
  let calls = 0, allowed = true;
  const verifyAccess = async claims => { calls++; return allowed ? { campaignId, roster, actor: roster.find(actor => actor.userId === claims.userId) } : null; };
  const server = await startTableServer({ secret, stateDirectory, verifyAccess });
  const clients = roster.map(() => connect(server.port));
  await Promise.all(clients.map(async (client, i) => { await client.opened; client.send({ type: 'hello', ticket: await issueTableTicket({ userId: roster[i].userId, campaignId, sessionHash: 'f'.repeat(64), origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, secret) }); client.initial = await client.wait(value => value.type === 'snapshot'); }));
  return { server, clients, roster, campaignId, stateDirectory, calls: () => calls, revoke: () => { allowed = false; },
    async close() { for (const client of clients) client.socket.terminate(); await server.close(); } };
}
function motion(client, token = client.initial.scene.tokens[0]) {
  return { motionId: crypto.randomUUID(), sceneId: client.initial.scene.id, tokenId: token.id, expectedVersion: token.version };
}
const frame = (identity, seq, x, y) => { const { expectedVersion, ...ids } = identity; return { type: 'motion-frame', ...ids, seq, x, y }; };

test('motion interpolation is continuous, finishes at canonical position and respects newer local gestures', () => {
  const store = new MotionStore();
  store.update('token', 'first', { x: 100, y: 80 }, { x: 0, y: 0 }, { duration: 100, now: 0 });
  assert.deepEqual(store.position('token', { x: 0, y: 0 }, 50), { x: 50, y: 40 });
  store.update('token', 'first', { x: 200, y: 100 }, { x: 0, y: 0 }, { duration: 100, now: 50 });
  assert.deepEqual(store.position('token', { x: 0, y: 0 }, 50), { x: 50, y: 40 });
  assert.deepEqual(store.position('token', { x: 0, y: 0 }, 150), { x: 200, y: 100 });
  store.update('token', 'next', { x: 300, y: 200 }, { x: 200, y: 100 }, { local: true, now: 150 });
  store.cancel('token', 'first');
  store.finish('token', 'first', { x: 200, y: 100 }, { x: 100, y: 80 });
  assert.deepEqual(store.target({ id: 'token' }), { x: 300, y: 200 });
  assert.deepEqual(store.position('token', { x: 200, y: 100 }, 10000), { x: 200, y: 100 });
});
test('motion protocol rejects non-finite, out-of-map and malformed frames', () => {
  const ids = { motionId: crypto.randomUUID(), sceneId: crypto.randomUUID(), tokenId: crypto.randomUUID(), expectedVersion: 0 };
  assert.equal(motionMessageSchema.safeParse(frame(ids, 1, NaN, 50)).success, false);
  assert.equal(motionMessageSchema.safeParse(frame(ids, 1, -2, 50)).success, false);
  assert.equal(motionMessageSchema.safeParse({ ...frame(ids, 1, 20, 20), tokenId: '../file' }).success, false);
});
test('six peers receive 20Hz motion previews with no disk revisions, full snapshots or per-frame auth; one final delta persists', async () => {
  const run = await setup(6), [gm, player] = run.clients;
  try {
    const identity = motion(player), file = path.join(run.stateDirectory, run.campaignId + '.room.json');
    const original = await fs.readFile(file, 'utf8'), calls = run.calls(), latencies = [];
    player.send({ type: 'motion-start', ...identity });
    await Promise.all(run.clients.map(client => client.wait(value => value.type === 'motion-started')));
    for (let seq = 1; seq <= 8; seq++) {
      const started = performance.now(); player.send(frame(identity, seq, 240 + seq * 20, 320));
      const values = await Promise.all(run.clients.map(client => client.wait(value => value.type === 'motion-frame' && value.seq === seq)));
      assert.ok(values.every(value => value.x === 240 + seq * 20)); latencies.push(performance.now() - started);
      if (seq < 8) await pause(51);
    }
    assert.equal(run.calls(), calls);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.ok(run.clients.every(client => !client.messages.some(value => value.type === 'snapshot')));
    player.send({ ...frame(identity, 9, 440, 360), type: 'motion-end' });
    const commits = await Promise.all(run.clients.map(client => client.wait(value => value.type === 'motion-committed')));
    assert.ok(commits.every(value => JSON.stringify(value.token) === JSON.stringify(commits[0].token)));
    assert.equal(commits[0].token.x, 440); assert.equal(commits[0].token.version, 1);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).data.scenes[0].scene.revision, 1);
    assert.ok(JSON.stringify(commits[0]).length < 1000);
    const stale = frame(identity, 10, 800, 800); player.send(stale);
    await pause(60);
    assert.ok(!gm.messages.some(value => value.type === 'motion-frame' && value.seq === 10));
    console.log(`Motion QA: 6 peers, 8 streamed frames, max loopback fanout ${Math.max(...latencies).toFixed(1)}ms; final delta ${JSON.stringify(commits[0]).length} bytes.`);
  } finally { await run.close(); }
});
test('leases reject competing grabs, stale sequences and legacy writes while allowing other tokens to move', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const first = motion(player); player.send({ type: 'motion-start', ...first }); await gm.wait(value => value.type === 'motion-started');
    const removeId = crypto.randomUUID();
    gm.send({ type: 'command', command: { id: removeId, type: 'remove', sceneId: first.sceneId, tokenId: first.tokenId,
      expectedVersion: first.expectedVersion, baseRevision: gm.initial.scene.revision } });
    assert.equal((await gm.wait(value => value.type === 'error' && value.commandId === removeId)).code, 'busy');
    const rival = motion(gm); gm.send({ type: 'motion-start', ...rival });
    assert.equal((await gm.wait(value => value.type === 'motion-rejected')).code, 'busy'); await gm.wait(value => value.type === 'snapshot');
    const second = motion(gm, gm.initial.scene.tokens[1]); gm.send({ type: 'motion-start', ...second }); await gm.wait(value => value.type === 'motion-started' && value.motionId === second.motionId);
    player.send(frame(first, 5, 520, 360)); await gm.wait(value => value.type === 'motion-frame' && value.seq === 5);
    player.send(frame(first, 4, 700, 700)); await pause(55);
    assert.ok(!gm.messages.some(value => value.type === 'motion-frame' && value.seq === 4));
    gm.send({ ...frame(second, 1, 600, 600), type: 'motion-end' });
    assert.equal((await gm.wait(value => value.type === 'motion-committed')).token.x, 600);
    player.send({ ...frame(first, 6, 520, 360), type: 'motion-end' });
    assert.equal((await player.wait(value => value.type === 'motion-committed' && value.motionId === first.motionId)).token.x, 520);
  } finally { await run.close(); }
});

test('player edits and removes another participant token; peers converge and deletion persists', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const token = gm.initial.scene.tokens[0], scene = gm.initial.scene;
    const editId = crypto.randomUUID();
    player.send({ type: 'command', command: { id: editId, type: 'update', sceneId: scene.id, baseRevision: scene.revision,
      tokenId: token.id, expectedVersion: token.version, name: 'Edited by player', size: 2, ownerId: token.ownerId } });
    const edited = await player.wait(value => value.type === 'snapshot' && value.commandId === editId);
    assert.equal(edited.scene.tokens.find(value => value.id === token.id).name, 'Edited by player');
    const id = crypto.randomUUID(), command = { id, type: 'remove', sceneId: scene.id, baseRevision: edited.scene.revision,
      tokenId: token.id, expectedVersion: token.version + 1 };
    player.send({ type: 'command', command });
    const removed = await gm.wait(value => value.type === 'snapshot' && value.commandId === id);
    assert.equal(removed.scene.tokens.some(value => value.id === token.id), false);
    await player.wait(value => value.type === 'snapshot' && value.commandId === id);
    player.send({ type: 'command', command });
    const repeated = await player.wait(value => value.type === 'snapshot' && value.commandId === id);
    assert.equal(repeated.scene.revision, removed.scene.revision);
    const saved = JSON.parse(await fs.readFile(path.join(run.stateDirectory, run.campaignId + '.room.json'), 'utf8'));
    assert.equal(saved.data.scenes[0].scene.tokens.some(value => value.id === token.id), false);
  } finally { await run.close(); }
});
test('disconnect cancels unsaved motion and releases the token; permission revocation prevents final writes', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const first = motion(player); player.send({ type: 'motion-start', ...first }); await gm.wait(value => value.type === 'motion-started');
    player.send(frame(first, 1, 800, 800)); await gm.wait(value => value.type === 'motion-frame');
    player.socket.terminate(); await gm.wait(value => value.type === 'motion-cancelled');
    const next = motion(gm); gm.send({ type: 'motion-start', ...next }); await gm.wait(value => value.type === 'motion-started' && value.motionId === next.motionId);
    run.revoke(); gm.send({ ...frame(next, 1, 900, 900), type: 'motion-end' });
    assert.equal((await gm.wait(value => value.type === 'error')).code, 'auth');
    const saved = JSON.parse(await fs.readFile(path.join(run.stateDirectory, run.campaignId + '.room.json'), 'utf8'));
    assert.equal(saved.data.scenes[0].scene.revision, 0);
  } finally { await run.close(); }
});
test('failed persistence rolls movement back and releases the lease for a retry', async () => {
  const run = await setup(), [gm, player] = run.clients;
  const file = path.join(run.stateDirectory, run.campaignId + '.room.json'), pending = file + '.pending';
  try {
    const original = await fs.readFile(file, 'utf8'), identity = motion(player);
    player.send({ type: 'motion-start', ...identity }); await gm.wait(value => value.type === 'motion-started');
    await fs.mkdir(pending);
    player.send({ ...frame(identity, 1, 640, 640), type: 'motion-end' });
    assert.equal((await player.wait(value => value.type === 'motion-rejected')).code, 'save');
    await gm.wait(value => value.type === 'motion-cancelled');
    const restored = await player.wait(value => value.type === 'snapshot'); assert.equal(restored.scene.revision, 0);
    assert.equal(await fs.readFile(file, 'utf8'), original); await fs.rmdir(pending);
    const retry = motion(player); player.send({ type: 'motion-start', ...retry }); await gm.wait(value => value.type === 'motion-started' && value.motionId === retry.motionId);
    player.send({ ...frame(retry, 1, 640, 640), type: 'motion-end' });
    assert.equal((await player.wait(value => value.type === 'motion-committed')).token.x, 640);
  } finally { await fs.rmdir(pending).catch(() => {}); await run.close(); }
});
test('private preparation motions never appear in player messages', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const create = { type: 'scene-create', id: crypto.randomUUID(), sceneId: gm.initial.scene.id, baseRevision: 0, expectedRoomRevision: 0, name: 'Secret room' };
    gm.send({ type: 'command', command: create });
    const prepared = await gm.wait(value => value.commandId === create.id); await player.wait(value => value.commandId === create.id);
    const add = { type: 'add', id: crypto.randomUUID(), sceneId: prepared.scene.id, baseRevision: 0, ownerId: run.roster[0].userId };
    gm.send({ type: 'command', command: add });
    const scene = (await gm.wait(value => value.commandId === add.id)).scene; await player.wait(value => value.commandId === add.id);
    const identity = { motionId: crypto.randomUUID(), sceneId: scene.id, tokenId: scene.tokens[0].id, expectedVersion: 0 };
    gm.send({ type: 'motion-start', ...identity }); await gm.wait(value => value.type === 'motion-started');
    gm.send(frame(identity, 1, 640, 640)); await gm.wait(value => value.type === 'motion-frame');
    gm.send({ ...frame(identity, 2, 640, 640), type: 'motion-end' }); await gm.wait(value => value.type === 'motion-committed');
    assert.ok(!player.messages.some(value => value.type.startsWith('motion-')));
    assert.ok(!JSON.stringify(player.messages).includes('Secret room'));
  } finally { await run.close(); }
});

test('group lease rejects a second member and commits every member with stable offsets', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const scene = gm.initial.scene, ids = scene.tokens.slice(0, 2).map(token => token.id);
    const groupId = crypto.randomUUID();
    gm.send({ type: 'command', command: { type: 'group', id: groupId, sceneId: scene.id, baseRevision: scene.revision, tokenIds: ids } });
    const grouped = (await gm.wait(value => value.type === 'snapshot' && value.commandId === groupId)).scene;
    await player.wait(value => value.type === 'snapshot' && value.commandId === groupId);
    const members = grouped.tokens.filter(token => ids.includes(token.id)).sort((a, b) => a.id.localeCompare(b.id));
    const identity = motion(player, members[0]);
    player.send({ type: 'motion-start', ...identity }); await gm.wait(value => value.type === 'motion-started');
    gm.send({ type: 'motion-start', ...motion(gm, members[1]) });
    assert.equal((await gm.wait(value => value.type === 'motion-rejected')).code, 'busy');
    for (const command of [
      { type: 'ungroup', tokenIds: [members[1].id] },
      { type: 'group', tokenIds: [members[1].id, grouped.tokens[2].id].filter(Boolean) },
      { type: 'remove-many', tokens: [{ tokenId: members[1].id, expectedVersion: members[1].version }] },
      { type: 'update', tokenId: members[1].id, expectedVersion: members[1].version, name: 'Blocked', size: members[1].size, ownerId: members[1].ownerId },
      { type: 'remove', tokenId: members[1].id, expectedVersion: members[1].version },
    ]) {
      const id = crypto.randomUUID(); gm.send({ type: 'command', command: { ...command, id, sceneId: scene.id, baseRevision: grouped.revision } });
      assert.equal((await gm.wait(value => value.type === 'error' && value.commandId === id)).code, 'busy');
    }
    player.send(frame(identity, 1, members[0].x + 100, members[0].y + 80));
    await gm.wait(value => value.type === 'motion-frame' && value.motionId === identity.motionId);
    player.send({ ...frame(identity, 2, members[0].x + 100, members[0].y + 80), type: 'motion-end' });
    const commits = await Promise.all(run.clients.map(client => client.wait(value => value.type === 'motion-committed' && value.motionId === identity.motionId)));
    assert.deepEqual(commits[0].tokens, commits[1].tokens); assert.equal(commits[0].tokens.length, 2);
    for (const before of members) {
      const after = commits[0].tokens.find(token => token.id === before.id);
      assert.equal(after.x - before.x, 100); assert.equal(after.y - before.y, 80); assert.equal(after.version, before.version + 1);
    }
    const saved = JSON.parse(await fs.readFile(path.join(run.stateDirectory, run.campaignId + '.room.json'), 'utf8')).data.scenes[0].scene;
    for (const token of commits[0].tokens) assert.deepEqual(saved.tokens.find(value => value.id === token.id), token);
  } finally { await run.close(); }
});


test('group preview tracks preserve offsets and cancel together without clearing a newer gesture', async () => {
  const { createPrototypeScene } = await import('../lib/table/scene.ts');
  const scene = createPrototypeScene(crypto.randomUUID(), []), [a, b] = scene.tokens;
  a.groupId = b.groupId = crypto.randomUUID();
  const store = new MotionStore();
  store.updateGroup(scene, a, 'first', { x: a.x + 200, y: a.y + 100 }, { duration: 100, now: 0 });
  assert.deepEqual(store.position(b.id, b, 50), { x: b.x + 100, y: b.y + 50 });
  store.updateGroup(scene, a, 'next', { x: a.x + 300, y: a.y + 150 }, { local: true, now: 50 });
  store.cancelMotion('first');
  assert.deepEqual(store.target(b), { x: b.x + 300, y: b.y + 150 });
  store.cancelMotion('next'); assert.equal(store.tracks.size, 0);
});

test('maximum valid floating-point brush stroke crosses the WebSocket transport and persists', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const drawing = { id: crypto.randomUUID(), color: '#a8bc8a', width: 5,
      points: Array.from({ length: 2048 }, (_, i) => i % 2 ? 234.12345678901235 : 456.9876543210987) };
    const command = { type: 'draw', id: crypto.randomUUID(), sceneId: gm.initial.scene.id, baseRevision: 0, drawing };
    const message = { type: 'command', command };
    assert.ok(Buffer.byteLength(JSON.stringify(message)) > 24000);
    player.send(message);
    const snapshots = await Promise.all(run.clients.map(client => client.wait(value => value.type === 'snapshot' && value.commandId === command.id)));
    assert.deepEqual(snapshots[0].scene.drawings, [drawing]); assert.deepEqual(snapshots[1].scene.drawings, [drawing]);
    const saved = JSON.parse(await fs.readFile(path.join(run.stateDirectory, run.campaignId + '.room.json'), 'utf8'));
    assert.deepEqual(saved.data.scenes[0].scene.drawings, [drawing]);
  } finally { await run.close(); }
});


test('WebSocket closes oversized UTF-8 messages with 1009 instead of hanging a pending command', async () => {
  const run = await setup(), [, player] = run.clients;
  try {
    const closed = new Promise(resolve => player.socket.once('close', code => resolve(code)));
    player.send({ type: 'command', padding: 'я'.repeat(MAX_TABLE_MESSAGE_BYTES / 2) });
    assert.equal(await closed, 1009);
  } finally { await run.close(); }
});

test('server refuses locked token motion and permits an unlocked independent copy', async () => {
  const run = await setup(), [gm, player] = run.clients;
  try {
    const scene = gm.initial.scene, token = scene.tokens[0], updateId = crypto.randomUUID();
    gm.send({ type: 'command', command: { type: 'update', id: updateId, sceneId: scene.id, baseRevision: scene.revision,
      tokenId: token.id, expectedVersion: token.version, name: token.name, size: token.size, ownerId: token.ownerId, locked: true } });
    const locked = (await player.wait(value => value.type === 'snapshot' && value.commandId === updateId)).scene;
    const identity = motion(player, locked.tokens.find(value => value.id === token.id));
    player.send({ type: 'motion-start', ...identity });
    assert.equal((await player.wait(value => value.type === 'motion-rejected' && value.motionId === identity.motionId)).code, 'locked');
    const id = crypto.randomUUID();
    player.send({ type: 'command', command: { type: 'duplicate', id, sceneId: scene.id, baseRevision: locked.revision,
      tokenId: token.id, expectedVersion: token.version + 1 } });
    const copied = (await player.wait(value => value.type === 'snapshot' && value.commandId === id)).scene.tokens.find(value => value.id === id);
    assert.equal(copied.locked, false); assert.equal(copied.version, 0);
  } finally { await run.close(); }
});
