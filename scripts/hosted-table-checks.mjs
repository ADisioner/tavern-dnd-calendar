import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export async function hostedChecks(base, clients, campaign) {
  const clientId = crypto.randomUUID(), viewerId = crypto.randomUUID(), assets = [];
  async function request(who, path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Origin: base, Cookie: clients[who].cookie,
      ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}) },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  const poll = (who, id, extra = '') => request(who, `/api/test/table?campaign=${campaign}&client=${id}${extra}`);
  const send = (who, id, message, preview) => request(who, '/api/test/table', 'POST', { campaignId: campaign, clientId: id, message, preview });
  const library = `/api/table/library?campaign=${campaign}`;
  try {
    assert.equal((await poll(2, viewerId)).status, 403);
    let packet = await poll(1, clientId), scene = packet.body.events.find(e => e.type === 'snapshot').scene;
    const token = scene.tokens[0], motionId = crypto.randomUUID(), identity = { motionId, sceneId: scene.id, tokenId: token.id };
    const start = await send(1, clientId, { type: 'motion-start', ...identity, expectedVersion: token.version });
    assert.equal(start.body.events[0].type, 'motion-started');
    const denied = await send(0, viewerId, { type: 'motion-start', ...identity, motionId: crypto.randomUUID(), expectedVersion: token.version });
    assert.equal(denied.body.events[0].code, 'busy');
    await send(1, clientId, { type: 'motion-frame', ...identity, seq: 1, x: 701, y: 400 });
    const live = await poll(0, viewerId);
    assert.equal(live.body.events.find(e => e.type === 'motion-frame' && e.motionId === motionId).x, 701);
    assert.equal(live.body.events.find(e => e.type === 'snapshot').scene.tokens[0].x, token.x);
    const ended = await send(1, clientId, { type: 'motion-end', ...identity, seq: 2, x: 723, y: 400 });
    assert.equal(ended.body.events[0].token.x, 723);
    const repeated = await send(1, clientId, { type: 'motion-end', ...identity, seq: 2, x: 723, y: 400 });
    assert.equal(repeated.body.events[0].token.version, token.version + 1);
    packet = await poll(0, viewerId);
    const snapshot = packet.body.events.find(e => e.type === 'snapshot');
    assert.equal(snapshot.scene.tokens[0].x, 723);
    const prepare = await send(0, viewerId, { type: 'command', command: { type: 'scene-create', id: crypto.randomUUID(),
      sceneId: snapshot.scene.id, baseRevision: snapshot.scene.revision, expectedRoomRevision: snapshot.roomRevision, name: 'HTTP private preparation' } });
    const hidden = prepare.body.events.find(e => e.type === 'snapshot').scene;
    const malicious = await poll(1, clientId, `&preview=${hidden.id}&scene=${hidden.id}&version=${prepare.body.version}`);
    assert.equal(JSON.stringify(malicious.body).includes('HTTP private preparation'), false);
    assert.notEqual(malicious.body.events.find(e => e.type === 'snapshot').scene.id, hidden.id);

    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    const uploaded = await request(1, library + '&name=QA.png&kind=token&scope=personal', 'POST', png);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const asset = uploaded.body.asset; assets.push(asset.id);
    assert.equal((await request(0, library)).body.assets.some(a => a.id === asset.id), false);
    assert.equal((await request(0, library + '&asset=' + asset.id)).status, 403);
    const current = (await poll(1, clientId)).body.events.find(e => e.type === 'snapshot');
    const added = await send(1, clientId, { type: 'command', command: { type: 'add', id: crypto.randomUUID(), sceneId: current.scene.id,
      baseRevision: current.scene.revision, ownerId: clients[1].id, assetId: asset.id, name: 'Private placed token' } });
    assert.equal(added.body.events[0].type, 'snapshot');
    const file = await fetch(base + library + '&asset=' + asset.id, { headers: { Cookie: clients[0].cookie } });
    assert.equal(file.status, 200); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
    assert.equal((await request(2, library + '&asset=' + asset.id)).status, 403);
    assert.equal((await request(0, library + '&asset=' + asset.id, 'DELETE')).status, 403);
    await request(1, library + '&asset=' + asset.id + '&scope=shared', 'PATCH');
    assert.equal((await request(0, library)).body.assets.some(a => a.id === asset.id), true);
    await request(0, library + '&asset=' + asset.id, 'DELETE');
    assert.equal((await request(1, library)).body.assets.some(a => a.id === asset.id), false);
    console.log('PASS: hosted HTTP fallback, motion lease contention and idempotent commits, forged private-scene cursor denial, R2 upload/download, personal/shared/placed asset authorization and archive.');
  } finally {
    for (const id of assets) {
      const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'delete', 'site-creator-r2/test-vtt/' + id, '--local', '--persist-to', '.wrangler/state'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('QA R2 cleanup failed: ' + result.stderr);
    }
  }
}

if (process.argv.includes('--fixture')) {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync('outputs/table-qa.json', 'utf8'));
  await hostedChecks('http://127.0.0.1:5173', fixture.clients, fixture.campaign);
}
