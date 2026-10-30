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
  return { socket, messages, send: value => socket.send(JSON.stringify(value)), async wait(predicate) {
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

test('shared rulers reach only viewers of the same scene and clear on finish or disconnect', async () => {
  const directory = path.resolve('.sites-runtime'); await fs.mkdir(directory, { recursive: true });
  const stateDirectory = await fs.mkdtemp(path.join(directory, 'table-measurement-test-'));
  const campaignId = crypto.randomUUID(), masterId = crypto.randomUUID(), playerId = crypto.randomUUID(), visitorId = crypto.randomUUID();
  const roster = [{ userId: masterId, name: 'GM', role: 'master' }, { userId: playerId, name: 'Player', role: 'player' }, { userId: visitorId, name: 'Visitor', role: 'player' }];
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const verifyAccess = async claims => ({ campaignId, roster, actor: { userId: claims.userId, name: claims.userId === masterId ? 'GM' : claims.userId === visitorId ? 'Visitor' : 'Player', role: claims.userId === masterId ? 'master' : 'player' } });
  const ticket = userId => issueTableTicket({ userId, campaignId, sessionHash: 'f'.repeat(64), origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, secret);
  const server = await startTableServer({ secret, stateDirectory, verifyAccess });
  const gm = client(server.port), player = client(server.port), outsider = client(server.port);
  const quiet = async peer => { await new Promise(resolve => setTimeout(resolve, 150)); return peer.messages.filter(value => value.type === 'measurement-state'); };
  try {
    await Promise.all([gm.opened, player.opened, outsider.opened]);
    gm.send({ type: 'hello', ticket: await ticket(masterId) }); player.send({ type: 'hello', ticket: await ticket(playerId) }); outsider.send({ type: 'hello', ticket: await ticket(visitorId) });
    const [master, playerScene, outsiderScene] = await Promise.all([gm.wait(m => m.type === 'snapshot').catch(error => { throw new Error('initial GM snapshot: ' + error.message); }), player.wait(m => m.type === 'snapshot').catch(error => { throw new Error('initial player snapshot: ' + error.message); }), outsider.wait(m => m.type === 'snapshot').catch(error => { throw new Error('initial visitor snapshot: ' + error.message); })]);
    const sceneId = playerScene.scene.id, measurementId = crypto.randomUUID();
    outsider.send({ type: 'measurement-frame', measurementId, sceneId: outsiderScene.scene.id, seq: 0, mode: 'sphere', from: { x: 200, y: 200 }, to: { x: 360, y: 200 } });
    const received = await player.wait(m => m.type === 'measurement-state' && m.measurements?.some(value => value.measurementId === measurementId)).catch(error => { throw new Error('player ruler broadcast: ' + error.message); });
    assert.equal(received.measurements.find(value => value.measurementId === measurementId).name, 'Visitor');
    assert.equal((await gm.wait(m => m.type === 'measurement-state' && m.measurements?.some(value => value.measurementId === measurementId)).catch(error => { throw new Error('GM ruler broadcast: ' + error.message); })).measurements.length, 1);
    const nextMeasurementId = crypto.randomUUID();
    outsider.send({ type: 'measurement-frame', measurementId: nextMeasurementId, sceneId, seq: 0, mode: 'line', from: { x: 100, y: 100 }, to: { x: 300, y: 300 } });
    assert.deepEqual((await player.wait(m => m.type === 'measurement-state' && m.measurements?.some(value => value.measurementId === nextMeasurementId))).measurements.map(value => value.measurementId), [nextMeasurementId]);
    outsider.send({ type: 'measurement-clear', measurementId: nextMeasurementId, sceneId, seq: 1 });
    const cleared = await Promise.all([player.wait(m => m.type === 'measurement-state' && m.measurements?.length === 0).catch(error => { throw new Error('player ruler clear: ' + error.message); }), gm.wait(m => m.type === 'measurement-state' && m.measurements?.length === 0).catch(error => { throw new Error('GM ruler clear: ' + error.message); })]);
    assert.deepEqual(cleared.map(value => value.measurements), [[], []]);
    const cursorId=crypto.randomUUID();outsider.send({type:'measurement-frame',measurementId:cursorId,sceneId,seq:0,mode:'cursor',from:{x:213.25,y:187.5},to:{x:213.25,y:187.5}});
    const cursor=await player.wait(m=>m.type==='measurement-state'&&m.measurements?.some(value=>value.measurementId===cursorId));
    assert.equal(cursor.measurements.find(value=>value.measurementId===cursorId).name,'Visitor');assert.equal(cursor.measurements.find(value=>value.measurementId===cursorId).from.x,213.25);
    outsider.send({type:'measurement-clear',measurementId:cursorId,sceneId,seq:1});await player.wait(m=>m.type==='measurement-state'&&m.measurements?.length===0);
    const create = { id: crypto.randomUUID(), type: 'scene-create', sceneId: master.scene.id, baseRevision: master.scene.revision, expectedRoomRevision: master.roomRevision, name: 'Preparation' };
    gm.send({ type: 'command', command: create });
    const preparation = await gm.wait(m => m.type === 'snapshot' && m.commandId === create.id).catch(error => { throw new Error('create preparation: ' + error.message); });
    await player.wait(m => m.type === 'snapshot' && m.commandId === create.id).catch(error => { throw new Error('player create snapshot: ' + error.message); });
    const view = { id: crypto.randomUUID(), type: 'scene-view', sceneId: preparation.scene.id, targetSceneId: preparation.scene.id, baseRevision: preparation.scene.revision, expectedRoomRevision: preparation.roomRevision };
    gm.send({ type: 'command', command: view });
    await gm.wait(m => m.type === 'snapshot' && m.commandId === view.id).catch(error => { throw new Error('preview preparation: ' + error.message); });
    const privateId = crypto.randomUUID();
    gm.send({ type: 'measurement-frame', measurementId: privateId, sceneId: preparation.scene.id, seq: 0, mode: 'cone', from: { x: 200, y: 200 }, to: { x: 360, y: 200 } });
    assert.deepEqual(await quiet(player), []);
    const returnToMap = { id: crypto.randomUUID(), type: 'scene-view', sceneId: preparation.scene.id, targetSceneId: master.scene.id, baseRevision: preparation.scene.revision, expectedRoomRevision: preparation.roomRevision };
    gm.send({ type: 'command', command: returnToMap }); await gm.wait(m => m.type === 'snapshot' && m.commandId === returnToMap.id);
    const disconnectId = crypto.randomUUID();
    outsider.send({ type: 'measurement-frame', measurementId: disconnectId, sceneId, seq: 0, mode: 'line', from: { x: 100, y: 100 }, to: { x: 300, y: 300 } });
    await player.wait(m => m.type === 'measurement-state' && m.measurements?.some(value => value.measurementId === disconnectId));
    outsider.socket.terminate();
    assert.deepEqual((await player.wait(m => m.type === 'measurement-state' && !m.measurements?.some(value => value.measurementId === disconnectId))).measurements, []);
  } finally { gm.socket.terminate(); player.socket.terminate(); outsider.socket.terminate(); await server.close(); }
});

test('private dice emit no result or event to other players; public and blind rolls reconnect safely', async () => {
  const directory=path.resolve('.sites-runtime');await fs.mkdir(directory,{recursive:true});const stateDirectory=await fs.mkdtemp(path.join(directory,'dice-security-'));
  const campaignId=crypto.randomUUID(),roster=['master','player','player'].map((role,i)=>({userId:crypto.randomUUID(),name:`Actor ${i}`,role})),secret=crypto.randomUUID()+crypto.randomUUID();
  const verifyAccess=async claims=>({campaignId,roster,actor:{...roster.find(a=>a.userId===claims.userId)}});
  const ticket=userId=>issueTableTicket({userId,campaignId,sessionHash:'f'.repeat(64),origin,expires:Date.now()+90000,nonce:crypto.randomUUID()},secret);
  const server=await startTableServer({secret,stateDirectory,verifyAccess}),peers=roster.map(()=>client(server.port));let reconnected;
  try{
    await Promise.all(peers.map(p=>p.opened));for(let i=0;i<3;i++)peers[i].send({type:'hello',ticket:await ticket(roster[i].userId)});
    const views=await Promise.all(peers.map(p=>p.wait(e=>e.type==='snapshot'))),sceneId=views[0].scene.id;
    const send=(visibility)=>{const command={type:'dice-roll',id:crypto.randomUUID(),sceneId,baseRevision:0,expectedRoomRevision:0,formula:'2d6+3',mode:'normal',visibility};peers[1].send({type:'command',command});return command;};
    const privateRoll=send('private');
    await peers[1].wait(e=>e.type==='snapshot'&&e.commandId===privateRoll.id);const gm=await peers[0].wait(e=>e.type==='snapshot'&&e.rolls?.some(r=>r.id===privateRoll.id));assert.ok(gm.rolls[0].total>=5);
    await new Promise(r=>setTimeout(r,80));assert.equal(JSON.stringify(peers[2].messages).includes(privateRoll.id),false);
    const blind=send('gm');const ack=await peers[1].wait(e=>e.type==='snapshot'&&e.commandId===blind.id);assert.equal(JSON.stringify(ack.rolls).includes(blind.id),false);
    await peers[0].wait(e=>e.type==='snapshot'&&e.rolls?.some(r=>r.id===blind.id));
    const publicRoll=send('public');await Promise.all(peers.map(p=>p.wait(e=>e.type==='snapshot'&&e.rolls?.some(r=>r.id===publicRoll.id))));
    reconnected=client(server.port);await reconnected.opened;reconnected.send({type:'hello',ticket:await ticket(roster[2].userId)});const restored=await reconnected.wait(e=>e.type==='snapshot');assert.deepEqual(restored.rolls.map(r=>r.id),[publicRoll.id]);
    roster[0].role='player';
    const revoked=send('private');await peers[1].wait(e=>e.type==='snapshot'&&e.commandId===revoked.id);
    const downgraded=await peers[0].wait(e=>e.type==='snapshot'&&e.actor.role==='player');assert.equal(JSON.stringify(downgraded).includes(revoked.id),false);assert.deepEqual(downgraded.rolls.map(r=>r.id),[publicRoll.id]);
  }finally{for(const peer of peers)peer.socket.terminate();reconnected?.socket.terminate();await server.close();await fs.rm(stateDirectory,{recursive:true,force:true});}
});

test('fog filters snapshots, hidden motion and private token images at the server boundary', async()=>{
  const directory=path.resolve('.sites-runtime');await fs.mkdir(directory,{recursive:true});const stateDirectory=await fs.mkdtemp(path.join(directory,'fog-security-'));
  const campaignId=crypto.randomUUID(),gmActor={userId:crypto.randomUUID(),name:'GM',role:'master'},playerActor={userId:crypto.randomUUID(),name:'Player',role:'player'},roster=[gmActor,playerActor],secret=crypto.randomUUID()+crypto.randomUUID();
  const verifyAccess=async claims=>({campaignId,roster,actor:roster.find(a=>a.userId===claims.userId)});
  const ticket=userId=>issueTableTicket({userId,campaignId,sessionHash:'f'.repeat(64),origin,expires:Date.now()+90000,nonce:crypto.randomUUID()},secret);
  const server=await startTableServer({secret,stateDirectory,verifyAccess}),gm=client(server.port);let player;
  try{
    await gm.opened;gm.send({type:'hello',ticket:await ticket(gmActor.userId)});let state=await gm.wait(e=>e.type==='snapshot');
    async function command(input){const id=crypto.randomUUID();gm.send({type:'command',command:{id,sceneId:state.scene.id,baseRevision:state.scene.revision,...input}});state=await gm.wait(e=>e.type==='snapshot'&&e.commandId===id);return state;}
    const own=state.scene.tokens.find(t=>t.ownerId===playerActor.userId),enemy=state.scene.tokens.find(t=>!t.ownerId);
    await command({type:'move',tokenId:own.id,expectedVersion:own.version,x:40,y:40});
    await command({type:'move',tokenId:enemy.id,expectedVersion:enemy.version,x:120,y:40});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    const uploaded=await fetch(`http://127.0.0.1:${server.port}/library?name=secret.png&kind=token&scope=personal`,{method:'POST',headers:{Authorization:`Bearer ${await ticket(gmActor.userId)}`},body:png});assert.equal(uploaded.status,200);const {asset}=await uploaded.json();
    await command({type:'add',ownerId:null,assetId:asset.id,name:'Secret image'});
    await command({type:'wall-set',wall:{id:crypto.randomUUID(),a:{x:80,y:0},b:{x:80,y:1120},door:false,open:false}});
    await command({type:'fog-config',enabled:true});
    player=client(server.port);await player.opened;player.send({type:'hello',ticket:await ticket(playerActor.userId)});const projected=await player.wait(e=>e.type==='snapshot');
    assert.equal(JSON.stringify(projected).includes(enemy.id),false);assert.equal(JSON.stringify(projected).includes(asset.id),false);assert.equal(projected.scene.fog.walls.length,0);
    const image=await fetch(`http://127.0.0.1:${server.port}/library?asset=${asset.id}`,{headers:{Authorization:`Bearer ${await ticket(playerActor.userId)}`}});assert.equal(image.status,403);
    const raw=state.scene.tokens.find(t=>t.id===enemy.id),motionId=crypto.randomUUID();gm.send({type:'motion-start',motionId,sceneId:state.scene.id,tokenId:enemy.id,expectedVersion:raw.version});await gm.wait(e=>e.type==='motion-started'&&e.motionId===motionId);
    gm.send({type:'motion-frame',motionId,sceneId:state.scene.id,tokenId:enemy.id,seq:0,x:160,y:40});await new Promise(r=>setTimeout(r,80));assert.equal(JSON.stringify(player.messages).includes(enemy.id),false);
    gm.send({type:'motion-cancel',motionId,sceneId:state.scene.id,tokenId:enemy.id});
  }finally{gm.socket.terminate();player?.socket.terminate();await server.close();await fs.rm(stateDirectory,{recursive:true,force:true});}
});
