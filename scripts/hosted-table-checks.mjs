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
  const library = `/api/table/library?campaign=${campaign}&storage=hosted`;
  try {
    assert.equal((await poll(2, viewerId)).status, 403);
    let packet = await poll(1, clientId), scene = packet.body.events.find(e => e.type === 'snapshot').scene;
    const longDrawing = { id: crypto.randomUUID(), color: '#a8bc8a', width: 5,
      points: Array.from({ length: 2048 }, (_, i) => i % 2 ? 234.12345678901235 : 456.9876543210987) };
    const longStroke = { type: 'command', command: { type: 'draw', id: crypto.randomUUID(), sceneId: scene.id, baseRevision: scene.revision, drawing: longDrawing } };
    assert.ok(Buffer.byteLength(JSON.stringify(longStroke)) > 24000);
    const drawn = await send(1, clientId, longStroke);
    assert.equal(drawn.status, 200);
    scene = drawn.body.events.find(e => e.type === 'snapshot').scene;
    assert.deepEqual(scene.drawings.find(value => value.id === longDrawing.id), longDrawing);
    const measurementId = crypto.randomUUID(), measurement = { type: 'measurement-frame', measurementId, sceneId: scene.id, seq: 0, mode: 'sphere', from: { x: 200, y: 200 }, to: { x: 360, y: 200 } };
    const measured = await send(1, clientId, measurement);
    assert.equal(measured.status, 200);
    assert.ok(measured.body.events.some(event => event.type === 'measurement-state' && event.measurements?.some(value => value.measurementId === measurementId)));
    const shared = await poll(0, viewerId);
    assert.ok(shared.body.events.some(event => event.type === 'measurement-state' && event.measurements?.some(value => value.measurementId === measurementId && value.mode === 'sphere')));
    const cleared = await send(1, clientId, { type: 'measurement-clear', measurementId, sceneId: scene.id, seq: 1 });
    assert.ok(cleared.body.events.some(event => event.type === 'measurement-state' && !event.measurements?.some(value => value.measurementId === measurementId)));
    console.log('PASS: hosted measurement insert, same-scene query, and clear.');
    const oversized = await send(1, clientId, { type: 'command', padding: 'я'.repeat(33000) });
    assert.equal(oversized.status, 413);
    const token = scene.tokens[0], motionId = crypto.randomUUID(), identity = { motionId, sceneId: scene.id, tokenId: token.id };
    const start = await send(1, clientId, { type: 'motion-start', ...identity, expectedVersion: token.version });
    assert.equal(start.body.events[0].type, 'motion-started');
    const denied = await send(0, viewerId, { type: 'motion-start', ...identity, motionId: crypto.randomUUID(), expectedVersion: token.version });
    assert.equal(denied.body.events[0].code, 'busy');
    const lockedRemoval = await send(0, viewerId, { type: 'command', command: { type: 'remove', id: crypto.randomUUID(),
      sceneId: scene.id, baseRevision: scene.revision, tokenId: token.id, expectedVersion: token.version } });
    assert.equal(lockedRemoval.body.events[0].code, 'busy');
    await send(1, clientId, { type: 'motion-frame', ...identity, seq: 1, x: 701, y: 400 });
    const live = await poll(0, viewerId);
    assert.equal(live.body.events.find(e => e.type === 'motion-frame' && e.motionId === motionId).x, 701);
    assert.equal(live.body.events.find(e => e.type === 'snapshot').scene.tokens[0].x, token.x);
    const ended = await send(1, clientId, { type: 'motion-end', ...identity, seq: 2, x: 723, y: 400 });
    assert.equal(ended.body.events[0].token.x, 723);
    const repeated = await send(1, clientId, { type: 'motion-end', ...identity, seq: 2, x: 723, y: 400 });
    assert.equal(repeated.body.events[0].token.version, token.version + 1);
    packet = await poll(0, viewerId);
    let snapshot = packet.body.events.find(e => e.type === 'snapshot');
    assert.equal(snapshot.scene.tokens[0].x, 723);
    const movedToken = snapshot.scene.tokens[0];
    const edited = await send(1, clientId, { type: 'command', command: { type: 'update', id: crypto.randomUUID(),
      sceneId: snapshot.scene.id, baseRevision: snapshot.scene.revision, tokenId: movedToken.id, expectedVersion: movedToken.version,
      name: 'Player edited foreign token', size: 2, ownerId: movedToken.ownerId } });
    assert.equal(edited.body.events[0].scene.tokens[0].name, 'Player edited foreign token');
    const removed = await send(1, clientId, { type: 'command', command: { type: 'remove', id: crypto.randomUUID(),
      sceneId: snapshot.scene.id, baseRevision: edited.body.events[0].scene.revision, tokenId: movedToken.id, expectedVersion: movedToken.version + 1 } });
    assert.equal(removed.body.events[0].scene.tokens.some(value => value.id === movedToken.id), false);
    snapshot = (await poll(0, viewerId)).body.events.find(e => e.type === 'snapshot');
    assert.equal(snapshot.scene.tokens.some(value => value.id === movedToken.id), false);
    // A grouped member cannot acquire an independent lease or mutate while its anchor moves.
    const groupIds = snapshot.scene.tokens.slice(0, 2).map(value => value.id);
    const groupedPacket = await send(1, clientId, { type: 'command', command: { type: 'group', id: crypto.randomUUID(),
      sceneId: snapshot.scene.id, baseRevision: snapshot.scene.revision, tokenIds: groupIds } });
    const groupedScene = groupedPacket.body.events.find(e => e.type === 'snapshot').scene;
    const members = groupedScene.tokens.filter(value => groupIds.includes(value.id)).sort((a, b) => a.id.localeCompare(b.id));
    const groupMotion = { motionId: crypto.randomUUID(), sceneId: groupedScene.id, tokenId: members[0].id };
    assert.equal((await send(1, clientId, { type: 'motion-start', ...groupMotion, expectedVersion: members[0].version })).body.events[0].type, 'motion-started');
    assert.equal((await send(0, viewerId, { type: 'motion-start', ...groupMotion, motionId: crypto.randomUUID(), tokenId: members[1].id, expectedVersion: members[1].version })).body.events[0].code, 'busy');
    for (const mutation of [
      { type: 'ungroup', tokenIds: [members[1].id] },
      { type: 'remove-many', tokens: [{ tokenId: members[1].id, expectedVersion: members[1].version }] },
    ]) {
      const blocked = await send(0, viewerId, { type: 'command', command: { ...mutation, id: crypto.randomUUID(), sceneId: groupedScene.id, baseRevision: groupedScene.revision } });
      assert.equal(blocked.body.events[0].code, 'busy');
    }
    await send(1, clientId, { type: 'motion-frame', ...groupMotion, seq: 1, x: members[0].x + 60, y: members[0].y + 40 });
    const groupLive = await poll(0, viewerId);
    assert.equal(groupLive.body.events.find(e => e.type === 'motion-frame' && e.motionId === groupMotion.motionId).x, members[0].x + 60);
    const groupEnd = await send(1, clientId, { type: 'motion-end', ...groupMotion, seq: 2, x: members[0].x + 60, y: members[0].y + 40 });
    const groupCommit = groupEnd.body.events.find(e => e.type === 'motion-committed');
    assert.equal(groupCommit.tokens.length, 2);
    for (const before of members) {
      const after = groupCommit.tokens.find(value => value.id === before.id);
      assert.equal(after.x, before.x + 60); assert.equal(after.y, before.y + 40); assert.equal(after.version, before.version + 1);
    }
    snapshot = (await poll(0, viewerId)).body.events.find(e => e.type === 'snapshot');
    for (const token of groupCommit.tokens) assert.deepEqual(snapshot.scene.tokens.find(value => value.id === token.id), token);
    const racedMotion = { motionId: crypto.randomUUID(), sceneId: snapshot.scene.id, tokenId: groupCommit.token.id };
    const [raceStart, raceMutation] = await Promise.all([
      send(1, clientId, { type: 'motion-start', ...racedMotion, expectedVersion: groupCommit.token.version }),
      send(0, viewerId, { type: 'command', command: { type: 'ungroup', id: crypto.randomUUID(), sceneId: snapshot.scene.id,
        baseRevision: snapshot.scene.revision, tokenIds: [members[1].id] } }),
    ]);
    const startedRace = raceStart.body.events.some(e => e.type === 'motion-started');
    const changedRace = raceMutation.body.events.some(e => e.type === 'snapshot');
    assert.equal(Number(startedRace) + Number(changedRace), 1, 'concurrent group mutation and lease claim must not both succeed');
    if (startedRace) await send(1, clientId, { type: 'motion-cancel', ...racedMotion });
    snapshot = (await poll(0, viewerId)).body.events.find(e => e.type === 'snapshot');
    const prepare = await send(0, viewerId, { type: 'command', command: { type: 'scene-create', id: crypto.randomUUID(),
      sceneId: snapshot.scene.id, baseRevision: snapshot.scene.revision, expectedRoomRevision: snapshot.roomRevision, name: 'HTTP private preparation' } });
    const hidden = prepare.body.events.find(e => e.type === 'snapshot').scene;
    const malicious = await poll(1, clientId, `&preview=${hidden.id}&scene=${hidden.id}&version=${prepare.body.version}`);
    assert.equal(JSON.stringify(malicious.body).includes('HTTP private preparation'), false);
    assert.notEqual(malicious.body.events.find(e => e.type === 'snapshot').scene.id, hidden.id);
    const privateMeasurementId = crypto.randomUUID();
    const privateMeasurement = await send(0, viewerId, { type: 'measurement-frame', measurementId: privateMeasurementId, sceneId: hidden.id, seq: 0, mode: 'cone', from: { x: 200, y: 200 }, to: { x: 360, y: 200 } }, hidden.id);
    assert.ok(privateMeasurement.body.events.some(event => event.type === 'measurement-state' && event.measurements?.some(value => value.measurementId === privateMeasurementId)));
    const publicMeasurements = await poll(1, clientId);
    assert.equal(publicMeasurements.body.events.some(event => event.type === 'measurement-state' && event.measurements?.some(value => value.measurementId === privateMeasurementId)), false);
    console.log('PASS: hosted preparation measurement stays private.');
    if (process.argv.includes('--measurements-only')) return;

    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    const uploaded = await request(1, library + '&name=QA.png&kind=token&scope=personal', 'POST', png);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const asset = uploaded.body.asset; assets.push(asset.id);
    assert.equal((await request(0, library)).body.assets.some(a => a.id === asset.id), false);
    assert.equal((await request(0, library + '&asset=' + asset.id)).status, 403);
    const current = (await poll(1, clientId)).body.events.find(e => e.type === 'snapshot');
    const added = await send(1, clientId, { type: 'command', command: { type: 'add', id: crypto.randomUUID(), sceneId: current.scene.id,
      baseRevision: current.scene.revision, ownerId: clients[1].id, assetId: asset.id, name: 'Private placed token' } });
    assert.equal(added.body.events[0].type, 'snapshot', JSON.stringify(added.body));
    const placedScene = added.body.events[0].scene, placedToken = placedScene.tokens.at(-1);
    const copied = await send(0, viewerId, { type: 'command', command: { type: 'duplicate', id: crypto.randomUUID(),
      sceneId: placedScene.id, baseRevision: placedScene.revision, tokenId: placedToken.id, expectedVersion: placedToken.version } });
    assert.equal(copied.body.events[0].type, 'snapshot', JSON.stringify(copied.body));
    const copiedScene = copied.body.events[0].scene, copy = copiedScene.tokens.at(-1);
    assert.notEqual(copy.id, placedToken.id); assert.equal(copy.assetId, placedToken.assetId);
    const styled = await send(1, clientId, { type: 'command', command: { type: 'update', id: crypto.randomUUID(),
      sceneId: copiedScene.id, baseRevision: copiedScene.revision, tokenId: copy.id, expectedVersion: copy.version,
      name: 'Menu label', size: 1.5, ownerId: copy.ownerId, rotation: 45, layer: 3, locked: true, showLabel: false,
      statuses: ['poisoned', 'exhaustion'], exhaustionLevel: 3 } });
    const styledToken = styled.body.events[0].scene.tokens.find(value => value.id === copy.id);
    assert.equal(styledToken.rotation, 45); assert.equal(styledToken.layer, 3); assert.equal(styledToken.showLabel, false);
    assert.deepEqual(styledToken.statuses, ['poisoned', 'exhaustion']); assert.equal(styledToken.exhaustionLevel, 3);
    const sharedStatus = (await poll(0, viewerId)).body.events.find(event => event.type === 'snapshot').scene.tokens.find(value => value.id === copy.id);
    assert.deepEqual(sharedStatus.statuses, ['poisoned', 'exhaustion']); assert.equal(sharedStatus.exhaustionLevel, 3);
    const locked = await send(0, viewerId, { type: 'motion-start', motionId: crypto.randomUUID(), sceneId: copiedScene.id,
      tokenId: copy.id, expectedVersion: styledToken.version });
    assert.equal(locked.body.events[0].type, 'motion-rejected'); assert.equal(locked.body.events[0].code, 'locked');
    const file = await fetch(base + library + '&asset=' + asset.id, { headers: { Cookie: clients[0].cookie } });
    assert.equal(file.status, 200); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
    assert.equal((await request(2, library + '&asset=' + asset.id)).status, 403);
    assert.equal((await request(0, library + '&asset=' + asset.id, 'DELETE')).status, 403);
    await request(1, library + '&asset=' + asset.id + '&scope=shared', 'PATCH');
    assert.equal((await request(0, library)).body.assets.some(a => a.id === asset.id), true);
    await request(0, library + '&asset=' + asset.id, 'DELETE');
    assert.equal((await request(1, library)).body.assets.some(a => a.id === asset.id), false);
    console.log('PASS: hosted HTTP fallback, shared token edit/remove, deletion motion lock, motion lease contention and idempotent commits, forged private-scene cursor denial, R2 upload/download, personal/shared/placed asset authorization and archive.');
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
