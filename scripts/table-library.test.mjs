import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startTableServer } from './table-server.mjs';
import { issueTableTicket } from '../lib/table/ticket.ts';
import { WebSocket } from 'ws';

test('library HTTP service enforces private/shared access, scene media access and restart durability', async () => {
  const root = path.resolve('.sites-runtime'); await fs.mkdir(root, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(root, 'library-test-'));
  const campaignId = crypto.randomUUID(), otherCampaign = crypto.randomUUID(), masterId = crypto.randomUUID(), playerId = crypto.randomUUID(), outsiderId = crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID(), origin = 'http://127.0.0.1:5173';
  let allowed = true;
  const roster = [{ userId: masterId, name: 'GM', role: 'master' }, { userId: playerId, name: 'Player', role: 'player' }];
  const verifyAccess = async claims => allowed ? { campaignId: claims.campaignId, roster, actor: { userId: claims.userId, name: claims.userId === masterId ? 'GM' : 'Player', role: claims.userId === masterId ? 'master' : 'player' } } : null;
  const ticket = async (id, campaign = campaignId) => issueTableTicket({ userId: id, campaignId: campaign, sessionHash: 'f'.repeat(64), origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, secret);
  let server = await startTableServer({ secret, stateDirectory, verifyAccess });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const request = async (id, method = 'GET', query = '', body, campaign = campaignId) => fetch(`http://127.0.0.1:${server.port}/library${query ? '?' + query : ''}`, { method, headers: id ? { Authorization: 'Bearer ' + await ticket(id, campaign) } : {}, body });
  let asset, shared, socket;
  try {
    assert.equal((await request(null)).status, 401);
    let result = await request(playerId, 'POST', 'name=Portrait.png&kind=image&scope=personal', image);
    assert.equal(result.status, 200); asset = (await result.json()).asset;
    assert.equal((await (await request(playerId)).json()).assets.length, 1);
    assert.equal((await (await request(masterId)).json()).assets.length, 0);
    assert.equal((await request(masterId, 'GET', 'asset=' + asset.id)).status, 403);
    assert.equal((await request(masterId, 'PATCH', 'asset=' + asset.id + '&scope=shared')).status, 403);
    assert.equal((await request(playerId, 'POST', 'name=evil.svg&kind=image&scope=shared', '<svg onload="alert(1)"/>')).status, 400);
    assert.equal((await request(playerId, 'POST', 'name=big.png&kind=image&scope=shared', Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await request(playerId, 'GET', 'asset=../index.json')).status, 400);
    result = await request(playerId, 'POST', 'name=Shared.png&kind=map&scope=shared', image); shared = (await result.json()).asset;
    assert.equal((await (await request(masterId)).json()).assets.length, 1);
    assert.equal((await request(outsiderId, 'GET', 'asset=' + shared.id, undefined, otherCampaign)).status, 403);
    // Personal uploads can be placed by the owner; other participants can then see the scene image.
    socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin });
    const messages = []; socket.on('message', value => messages.push(JSON.parse(value.toString())));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', ticket: await ticket(playerId) }));
    const wait = predicate => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => { const found = messages.find(predicate); if (found) resolve(found); else if (Date.now() > deadline) reject(new Error('No scene response')); else setTimeout(check, 10); }; check();
    });
    const first = await wait(m => m.type === 'snapshot');
    const command = { type: 'add', sceneId: first.scene.id, id: crypto.randomUUID(), baseRevision: first.scene.revision, ownerId: playerId, assetId: asset.id, name: 'Portrait' };
    socket.send(JSON.stringify({ type: 'command', command }));
    const placed = await wait(m => m.commandId === command.id);
    assert.equal(placed.scene.tokens.at(-1).assetId, asset.id);
    result = await request(masterId, 'GET', 'asset=' + asset.id); assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), image);
    assert.equal((await request(playerId, 'DELETE', 'asset=' + asset.id)).status, 200);
    assert.equal((await request(masterId, 'GET', 'asset=' + asset.id)).status, 200);
    assert.equal((await request(masterId, 'GET', 'asset=' + shared.id)).status, 200);
    assert.equal((await request(playerId, 'PATCH', 'asset=' + shared.id + '&scope=personal')).status, 200);
    assert.equal((await request(masterId, 'GET', 'asset=' + shared.id)).status, 403);
    socket.terminate(); await server.close();
    server = await startTableServer({ secret, stateDirectory, verifyAccess });
    assert.equal((await request(masterId, 'GET', 'asset=' + asset.id)).status, 200);
    assert.equal((await (await request(playerId)).json()).assets[0].id, shared.id);
    allowed = false;
    assert.equal((await request(playerId, 'POST', 'name=revoked.png&kind=image&scope=shared', image)).status, 401);
  } finally { socket?.terminate(); await server.close(); }
});
