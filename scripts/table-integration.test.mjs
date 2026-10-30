import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.env.TABLE_TEST_BASE ?? 'http://127.0.0.1:5173';
const fixturePath = path.resolve('outputs/table-qa.json');
const fresh = () => ({ id: '', cookie: '', login: '', password: '' });
let clients = [fresh(), fresh(), fresh()], campaign = '', sockets = [];
async function api(client, url, data, status = 200) {
  const response = await fetch(BASE + url, { method: data ? 'POST' : 'GET', headers: { Origin: BASE, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(client.cookie ? { Cookie: client.cookie } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  if (response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
  return value;
}
function connect(bootstrap, client) {
  const socket = new WebSocket(bootstrap.socketUrl, { origin: BASE, headers: { Cookie: client.cookie } }); sockets.push(socket);
  const messages = [], waiters = [];
  socket.on('error', () => {});
  socket.on('message', raw => { messages.push(JSON.parse(raw.toString())); for (const check of [...waiters]) check(); });
  socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', ticket: bootstrap.ticket })));
  return { send: command => socket.send(JSON.stringify({ type: 'command', command })), sendMessage: message => socket.send(JSON.stringify(message)), wait: predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); reject(new Error('No matching WebSocket response')); }, 7000);
    function check() { const i = messages.findIndex(predicate); if (i < 0) return; clearTimeout(timer); const j = waiters.indexOf(check); if (j >= 0) waiters.splice(j, 1); resolve(messages.splice(i, 1)[0]); }
    waiters.push(check); check();
  }) };
}
function cleanup() {
  for (const socket of sockets) socket.terminate();
  const ids = clients.map(c => c.id).filter(id => /^[a-f0-9-]{36}$/.test(id));
  let sql = '';
  if (/^[a-f0-9-]{36}$/.test(campaign)) {
    if (process.argv.includes('--hosted')) for (const table of ['test_table_rooms','test_table_motions','test_table_measurements','test_table_peers','test_table_assets']) sql += `DELETE FROM ${table} WHERE campaign_id='${campaign}';\n`;
    sql += `DELETE FROM availability WHERE campaign_id='${campaign}'; DELETE FROM sessions WHERE campaign_id='${campaign}'; DELETE FROM members WHERE campaign_id='${campaign}'; DELETE FROM campaigns WHERE id='${campaign}';\n`;
  }
  for (const id of ids) {
    if (process.argv.includes('--hosted')) sql += `DELETE FROM test_table_assets WHERE owner_id='${id}'; DELETE FROM test_table_peers WHERE user_id='${id}';\n`;
    sql += `DELETE FROM logins WHERE user_id='${id}'; DELETE FROM users WHERE id='${id}';\n`;
  }
  if (sql) {
    fs.mkdirSync('outputs', { recursive: true }); const file = path.resolve('outputs/table-qa-cleanup.sql'); fs.writeFileSync(file, sql);
    const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'dist/server/wrangler.json', '--persist-to', '.wrangler/state', '--file', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('QA cleanup failed: ' + result.stderr);
    for (const suffix of ['.json', '.json.pending', '.room.json', '.room.json.pending']) { const saved = path.resolve('.sites-runtime/table-rooms', campaign + suffix); if (fs.existsSync(saved)) fs.unlinkSync(saved); }
  }
  if (fs.existsSync(fixturePath) && JSON.parse(fs.readFileSync(fixturePath, 'utf8')).campaign === campaign) fs.unlinkSync(fixturePath);
}
if (process.argv.includes('--cleanup')) {
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); clients = saved.clients; campaign = saved.campaign; cleanup(); console.log('Exact local table QA records removed.');
} else {
  if (fs.existsSync(fixturePath)) throw new Error('Previous browser QA fixture exists. Finish it and run --cleanup first.');
  let passed = false;
  try {
    await api(clients[0], '/api/table?campaign=' + crypto.randomUUID(), undefined, 401);
    const suffix = randomBytes(4).toString('hex');
    for (let i = 0; i < clients.length; i++) {
      clients[i].login = `qa_table_${suffix}_${i}`; clients[i].password = randomBytes(9).toString('base64url');
      const value = await api(clients[i], '/api/auth', { action: 'register', login: clients[i].login, password: clients[i].password, name: ['Мастер прототипа', 'Игрок прототипа', 'Посторонний QA'][i] }); clients[i].id = value.user.id;
    }
    campaign = (await api(clients[0], '/api/calendar', { action: 'create', title: 'Локальная таверна · проверка стола', name: 'Мастер прототипа', timezone: 'Europe/Moscow' })).campaign;
    await api(clients[1], '/api/calendar', { action: 'join', campaignId: campaign, name: 'Игрок прототипа', timezone: 'Asia/Yekaterinburg' });
    await api(clients[2], '/api/table?campaign=' + campaign, undefined, 403);
    const masterBootstrap = await api(clients[0], '/api/table?campaign=' + campaign);
    const playerBootstrap = await api(clients[1], '/api/table?campaign=' + campaign);
    const gm = connect(masterBootstrap, clients[0]), player = connect(playerBootstrap, clients[1]);
    const first = await gm.wait(m => m.type === 'snapshot'), other = await player.wait(m => m.type === 'snapshot');
    assert.deepEqual(first.scene, other.scene);
    const own = first.scene.tokens.find(t => t.ownerId === clients[1].id), foreign = first.scene.tokens.find(t => t.ownerId === clients[0].id);
    const command = { type: 'move', sceneId: first.scene.id, id: crypto.randomUUID(), baseRevision: first.scene.revision, tokenId: own.id, expectedVersion: own.version, x: 520, y: 440 };
    player.send(command);
    const [a, b] = await Promise.all([gm.wait(m => m.commandId === command.id), player.wait(m => m.commandId === command.id)]);
    assert.deepEqual(a.scene, b.scene); assert.equal(a.scene.tokens.find(t => t.id === own.id).x, 520);
    player.send({ ...command, id: crypto.randomUUID(), baseRevision: b.scene.revision, tokenId: foreign.id, expectedVersion: foreign.version });
    const foreignMove = await player.wait(m => m.type === 'snapshot' && m.scene.revision === b.scene.revision + 1);
    assert.equal(foreignMove.scene.tokens.find(t => t.id === foreign.id).x, 520);
    await gm.wait(m => m.type === 'snapshot' && m.scene.revision === foreignMove.scene.revision);
    const benchmark = { id: crypto.randomUUID(), type: 'benchmark', sceneId: first.scene.id, baseRevision: foreignMove.scene.revision };
    gm.send(benchmark);
    const benchSnapshot = await gm.wait(m => m.commandId === benchmark.id);
    assert.equal(benchSnapshot.scene.tokens.length, 100);
    assert.equal((await player.wait(m => m.commandId === benchmark.id)).scene.tokens.length, 100);
    const motion = { motionId: crypto.randomUUID(), sceneId: first.scene.id, tokenId: own.id };
    player.sendMessage({ type: 'motion-start', ...motion, expectedVersion: 1 });
    await gm.wait(m => m.type === 'motion-started' && m.motionId === motion.motionId);
    await player.wait(m => m.type === 'motion-started' && m.motionId === motion.motionId);
    const delays = [];
    for (let seq = 1; seq <= 5; seq++) {
      const started = performance.now();
      player.sendMessage({ type: 'motion-frame', ...motion, seq, x: 520 + seq * 20, y: 440 });
      const live = await gm.wait(m => m.type === 'motion-frame' && m.motionId === motion.motionId && m.seq === seq);
      assert.equal(live.x, 520 + seq * 20); delays.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 55));
    }
    player.sendMessage({ type: 'motion-end', ...motion, seq: 6, x: 680, y: 440 });
    const [committedGM, committedPlayer] = await Promise.all([gm.wait(m => m.type === 'motion-committed' && m.motionId === motion.motionId), player.wait(m => m.type === 'motion-committed' && m.motionId === motion.motionId)]);
    assert.deepEqual(committedGM.token, committedPlayer.token); assert.equal(committedGM.token.x, 680);
    console.log(`Motion with real accounts: ${delays.length} previews; max loopback delivery ${Math.max(...delays).toFixed(1)}ms; commit delta ${JSON.stringify(committedGM).length} bytes.`);
    const createScene = { id: crypto.randomUUID(), type: 'scene-create', sceneId: first.scene.id, baseRevision: benchSnapshot.scene.revision,
      expectedRoomRevision: benchSnapshot.roomRevision, name: 'Лесная засада · подготовка' };
    gm.send(createScene);
    const prepared = await gm.wait(m => m.commandId === createScene.id), stillPlaying = await player.wait(m => m.commandId === createScene.id);
    assert.equal(prepared.scene.tokens.length, 0); assert.equal(stillPlaying.scene.id, first.scene.id);
    assert.equal(stillPlaying.scenes.length, 1); assert.equal(JSON.stringify(stillPlaying).includes(createScene.name), false);
    const activate = { id: crypto.randomUUID(), type: 'scene-activate', sceneId: prepared.scene.id, baseRevision: prepared.scene.revision,
      expectedRoomRevision: prepared.roomRevision, targetSceneId: prepared.scene.id };
    gm.send(activate);
    const active = await gm.wait(m => m.commandId === activate.id), publicActive = await player.wait(m => m.commandId === activate.id);
    assert.deepEqual(active.scene, publicActive.scene);
    player.send({ ...command, id: crypto.randomUUID(), expectedVersion: 1 });
    assert.equal((await player.wait(m => m.type === 'error')).code, 'forbidden');
    if (!process.argv.includes('--hosted')) await player.wait(m => m.type === 'snapshot' && !m.commandId);
    const returnScene = { ...activate, id: crypto.randomUUID(), expectedRoomRevision: active.roomRevision, targetSceneId: first.scene.id };
    gm.send(returnScene);
    assert.equal((await gm.wait(m => m.commandId === returnScene.id)).scene.tokens.length, 100);
    assert.equal((await player.wait(m => m.commandId === returnScene.id)).scene.tokens.length, 100);
    if (process.argv.includes('--hosted')) {
      const { hostedChecks } = await import('./hosted-table-checks.mjs');
      await hostedChecks(BASE, clients, campaign);
    }
    // Logging out invalidates an already connected table session on its next command.
    await api(clients[1], '/api/auth', { action: 'logout' });
    player.send({ ...command, id: crypto.randomUUID(), baseRevision: 2, expectedVersion: 1, x: 600 });
    assert.equal((await player.wait(m => m.type === 'error')).code, 'auth');
    await api(clients[1], '/api/auth', { action: 'login', login: clients[1].login, password: clients[1].password });
    passed = true;
    console.log('PASS: real login/campaign tickets, two-client convergence, 100 tokens, all-player movement, private preparation, shared scene switching, stale-scene write denial, outsider denial, open-socket logout revocation.');
  } finally {
    for (const socket of sockets) socket.terminate();
    if (passed && process.env.TABLE_KEEP_QA === '1') { fs.mkdirSync('outputs', { recursive: true }); fs.writeFileSync(fixturePath, JSON.stringify({ clients, campaign })); console.log('Browser QA fixture retained locally in ignored outputs; remove with --cleanup.'); }
    else cleanup();
  }
}
