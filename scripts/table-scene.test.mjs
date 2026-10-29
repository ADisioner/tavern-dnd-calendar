import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTableCommand,
  canMoveToken,
  commandSchema,
  CommandError,
  createPrototypeScene,
  sceneSchema,
} from '../lib/table/scene.ts';
import { CONDITION_IDS, CONDITIONS } from '../lib/table/conditions.ts';

const masterId = '11111111-1111-4111-8111-111111111111';
const playerAId = '22222222-2222-4222-8222-222222222222';
const playerBId = '33333333-3333-4333-8333-333333333333';
const outsiderId = '44444444-4444-4444-8444-444444444444';
const roster = [
  { userId: playerAId, name: 'Aria', role: 'player' },
  { userId: playerBId, name: 'Bram', role: 'player' },
];
const master = { userId: masterId, name: 'Master', role: 'master' };
const playerA = { userId: playerAId, name: 'Aria', role: 'player' };
const playerB = { userId: playerBId, name: 'Bram', role: 'player' };
const commandId = () => crypto.randomUUID();
const moveCommand = (scene, token, changes = {}) => commandSchema.parse({
  id: commandId(),
  baseRevision: scene.revision,
  type: 'move',
  tokenId: token.id,
  expectedVersion: token.version,
  x: token.x + 80,
  y: token.y + 40,
  ...changes,
});
const expectCommandError = (fn, code) => {
  assert.throws(fn, error => error instanceof CommandError && error.code === code);
};

test('owner can move their token; token and scene revisions advance without mutating source', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const ownedToken = scene.tokens[0];
  const originalX = ownedToken.x;
  const originalY = ownedToken.y;
  const command = moveCommand(scene, ownedToken);

  const updated = applyTableCommand(scene, command, playerA, roster);

  assert.equal(updated.revision, scene.revision + 1);
  assert.equal(updated.tokens[0].version, ownedToken.version + 1);
  assert.equal(updated.tokens[0].x, command.x);
  assert.equal(updated.tokens[0].y, command.y);
  assert.equal(ownedToken.version, 0);
  assert.equal(ownedToken.x, originalX);
  assert.equal(ownedToken.y, originalY);
  assert.equal(scene.revision, 0);
  assert.equal(sceneSchema.parse(updated).revision, 1);
});

test('every player can move other players and unassigned tokens', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  assert.equal(canMoveToken(scene.tokens[0], playerA), true);
  assert.equal(canMoveToken(scene.tokens[0], playerB), true);
  assert.equal(applyTableCommand(scene, moveCommand(scene, scene.tokens[0]), playerB, roster).tokens[0].version, 1);
  assert.equal(applyTableCommand(scene, moveCommand(scene, scene.tokens[3]), playerB, roster).tokens[3].version, 1);
});

test('moving the same token with a stale expectedVersion conflicts', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const token = scene.tokens[0];
  const first = applyTableCommand(scene, moveCommand(scene, token), playerA, roster);
  const stale = moveCommand(first, first.tokens[0], { expectedVersion: token.version });

  expectCommandError(() => applyTableCommand(first, stale, playerA, roster), 'conflict');
});

test('a different token can move from an older global baseRevision when its version matches', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const first = applyTableCommand(scene, moveCommand(scene, scene.tokens[0]), playerA, roster);
  const untouchedToken = first.tokens[1];
  const staleGlobalMove = moveCommand(first, untouchedToken, { baseRevision: scene.revision });

  const updated = applyTableCommand(first, staleGlobalMove, playerB, roster);

  assert.equal(updated.revision, first.revision + 1);
  assert.equal(updated.tokens[1].version, untouchedToken.version + 1);
});

test('players cannot change the grid, map or run the benchmark', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const token = scene.tokens[0];
  const commands = [
    { id: commandId(), baseRevision: 0, type: 'grid', gridSize: 40, gridVisible: false },
    { id: commandId(), baseRevision: 0, type: 'benchmark' },
    { id: commandId(), baseRevision: 0, type: 'map', assetId: null },
  ];

  for (const rawCommand of commands) {
    const command = commandSchema.parse(rawCommand);
    expectCommandError(() => applyTableCommand(scene, command, playerA, roster), 'forbidden');
  }
});

test('players can edit any token while owner validation remains enforced', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  for (const token of scene.tokens) {
    const command = commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type: 'update',
      tokenId: token.id, expectedVersion: token.version, name: 'Renamed', size: 2, ownerId: playerBId });
    const updated = applyTableCommand(scene, command, playerA, roster);
    assert.equal(updated.tokens.find(value => value.id === token.id).name, 'Renamed');
    assert.equal(updated.tokens.find(value => value.id === token.id).size, 2);
    expectCommandError(() => applyTableCommand(scene, { ...command, ownerId: outsiderId }, playerA, roster), 'owner');
    expectCommandError(() => applyTableCommand(updated, { ...command, baseRevision: updated.revision }, playerA, roster), 'conflict');
  }
});

test('all participants can remove any token without mutating the source scene', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  for (const actor of [master, playerA, playerB]) for (const token of scene.tokens) {
    const command = commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type: 'remove',
      tokenId: token.id, expectedVersion: token.version });
    const updated = applyTableCommand(scene, command, actor, roster);
    assert.deepEqual(updated.tokens, scene.tokens.filter(value => value.id !== token.id));
    assert.equal(updated.revision, scene.revision + 1);
    assert.equal(scene.tokens.length, 8);
    expectCommandError(() => applyTableCommand(updated, { ...command, baseRevision: updated.revision }, actor, roster), 'missing');
    expectCommandError(() => applyTableCommand(scene, { ...command, expectedVersion: token.version + 1 }, actor, roster), 'conflict');
  }
});

test('master cannot assign a token to an owner outside the campaign roster', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const token = scene.tokens[0];
  const update = commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type: 'update',
    tokenId: token.id, expectedVersion: token.version, name: token.name, size: token.size, ownerId: outsiderId });

  expectCommandError(() => applyTableCommand(scene, update, master, roster), 'owner');
  const add = commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type: 'add', ownerId: outsiderId });
  expectCommandError(() => applyTableCommand(scene, add, master, roster), 'owner');
});

test('move coordinates clamp to map bounds while preserving a valid token', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const token = scene.tokens[0];
  const move = moveCommand(scene, token, { x: -500, y: 5000 });

  const updated = applyTableCommand(scene, move, playerA, roster);

  assert.equal(updated.tokens[0].x, token.size * scene.gridSize / 2);
  assert.equal(updated.tokens[0].y, scene.height - token.size * scene.gridSize / 2);
  assert.equal(sceneSchema.parse(updated).tokens[0].y, 1120 - 40);
});

test('master benchmark creates 100 tokens and preserves existing token records', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const priorTokens = scene.tokens.map(token => ({ ...token }));
  const benchmark = commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type: 'benchmark' });

  const updated = applyTableCommand(scene, benchmark, master, roster);

  assert.equal(updated.tokens.length, 100);
  assert.equal(updated.revision, scene.revision + 1);
  assert.deepEqual(updated.tokens.slice(0, priorTokens.length), priorTokens);
  assert.equal(scene.tokens.length, priorTokens.length);
  assert.equal(sceneSchema.parse(updated).tokens.length, 100);
});

test('benchmark preserves a moved player token and places new tokens without overlapping it', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const playerToken = scene.tokens[0];
  const moved = applyTableCommand(scene, moveCommand(scene, playerToken, { x: 600, y: 520 }), playerA, roster);
  const movedToken = moved.tokens.find(token => token.id === playerToken.id);
  const benchmark = commandSchema.parse({ id: commandId(), baseRevision: moved.revision, type: 'benchmark' });

  const updated = applyTableCommand(moved, benchmark, master, roster);
  const preservedToken = updated.tokens.find(token => token.id === playerToken.id);
  const newTokens = updated.tokens.slice(moved.tokens.length);

  assert.deepEqual(preservedToken, movedToken);
  assert.equal(preservedToken.x, 600);
  assert.equal(preservedToken.y, 520);
  assert.ok(newTokens.length > 0);
  for (const added of newTokens) {
    const distance = Math.hypot(added.x - preservedToken.x, added.y - preservedToken.y);
    const minimumDistance = (added.size + preservedToken.size) * moved.gridSize / 2;
    assert.ok(distance >= minimumDistance,
      `new token at (${added.x}, ${added.y}) overlaps moved token at (${preservedToken.x}, ${preservedToken.y})`);
  }
});

 test('players can add image tokens but cannot assign ownership to another player', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const assetId = crypto.randomUUID();
  const command = commandSchema.parse({ type: 'add', id: commandId(), baseRevision: 0, ownerId: playerBId, name: 'Portrait', assetId });
  const updated = applyTableCommand(scene, command, playerA, roster);
  assert.equal(updated.tokens.at(-1).ownerId, playerAId);
  assert.equal(updated.tokens.at(-1).assetId, assetId);
});
test('existing scene saves remain compatible; map changes preserve existing tokens', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  assert.equal(sceneSchema.parse(scene).mapAssetId, undefined);
  const assetId = crypto.randomUUID();
  const updated = applyTableCommand(scene, commandSchema.parse({ type: 'map', id: commandId(), baseRevision: 0, assetId }), master, roster);
  assert.equal(updated.mapAssetId, assetId);
  assert.deepEqual(updated.tokens, scene.tokens);
});

const sceneCommand = (scene, type, fields = {}) => commandSchema.parse({ id: commandId(), baseRevision: scene.revision, type, ...fields });
const stroke = () => ({ id: commandId(), color: '#a8bc8a', width: 4, points: [10, 20, 40, 60] });

test('token menu properties persist and normal update preserves them', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster), token = scene.tokens[0];
  const command = sceneCommand(scene, 'update', { tokenId: token.id, expectedVersion: 0, name: token.name, size: token.size, ownerId: token.ownerId,
    locked: true, rotation: 315, layer: -5, showLabel: false });
  const updated = applyTableCommand(scene, command, playerB, roster);
  const normal = applyTableCommand(updated, sceneCommand(updated, 'update', { tokenId: token.id, expectedVersion: 1, name: 'Renamed', size: 2, ownerId: token.ownerId }), playerA, roster);
  assert.deepEqual([normal.tokens[0].locked, normal.tokens[0].rotation, normal.tokens[0].layer, normal.tokens[0].showLabel], [true, 315, -5, false]);
  assert.equal(sceneSchema.parse(JSON.parse(JSON.stringify(normal))).tokens[0].rotation, 315);
  for (const invalid of [{ rotation: 360 }, { rotation: -1 }, { layer: 10001 }, { layer: 0.5 }, { locked: 'yes' }, { showLabel: 0 }]) {
    assert.equal(commandSchema.safeParse({ ...command, ...invalid }).success, false);
  }
});

test('multiple D&D statuses and exhaustion persist through edits and copying, invalid statuses fail', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster), token = scene.tokens[0];
  const command = sceneCommand(scene, 'update', { tokenId: token.id, expectedVersion: token.version,
    name: token.name, size: token.size, ownerId: token.ownerId, statuses: ['poisoned', 'exhaustion'], exhaustionLevel: 3 });
  const styled = applyTableCommand(scene, command, playerA, roster);
  assert.deepEqual(styled.tokens[0].statuses, ['poisoned', 'exhaustion']);
  assert.equal(styled.tokens[0].exhaustionLevel, 3);
  const normal = applyTableCommand(styled, sceneCommand(styled, 'update', { tokenId: token.id, expectedVersion: 1,
    name: 'Renamed', size: 2, ownerId: token.ownerId }), playerB, roster);
  const copy = applyTableCommand(normal, sceneCommand(normal, 'duplicate', { tokenId: token.id, expectedVersion: 2 }), playerA, roster).tokens.at(-1);
  assert.deepEqual(copy.statuses, ['poisoned', 'exhaustion']); assert.equal(copy.exhaustionLevel, 3);
  assert.deepEqual(sceneSchema.parse(JSON.parse(JSON.stringify(normal))).tokens[0].statuses, ['poisoned', 'exhaustion']);
  for (const invalid of [{ statuses: ['unknown'] }, { statuses: ['poisoned', 'poisoned'] }, { exhaustionLevel: 0 }, { exhaustionLevel: 7 }, { exhaustionLevel: 1.5 }]) {
    assert.equal(commandSchema.safeParse({ ...command, ...invalid }).success, false);
  }
  const cleared = applyTableCommand(normal, sceneCommand(normal, 'update', { tokenId: token.id, expectedVersion: 2,
    name: token.name, size: token.size, ownerId: token.ownerId, statuses: [] }), playerA, roster);
  assert.deepEqual(cleared.tokens[0].statuses, []);
});

test('every standard and custom status has a unique vector sigil, including concentration and death', () => {
  assert.equal(CONDITION_IDS.length, 17);
  assert.ok(CONDITION_IDS.includes('concentration'));
  assert.ok(CONDITION_IDS.includes('dead'));
  const sigils = CONDITION_IDS.map(id => CONDITIONS[id].icon);
  assert.ok(sigils.every(icon => typeof icon === 'string' && icon.trim().length > 0));
  assert.equal(new Set(sigils).size, CONDITION_IDS.length);
});

test('locked group member blocks movement but participants can unlock, edit and remove', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  scene.tokens[0].groupId = scene.tokens[1].groupId = commandId();
  scene.tokens[1].locked = true;
  assert.equal(canMoveToken(scene.tokens[1], master), false);
  expectCommandError(() => applyTableCommand(scene, moveCommand(scene, scene.tokens[0]), master, roster), 'locked');
  expectCommandError(() => applyTableCommand(scene, moveCommand(scene, scene.tokens[1]), playerA, roster), 'locked');
  const locked = scene.tokens[1];
  const unlocked = applyTableCommand(scene, sceneCommand(scene, 'update', { tokenId: locked.id, expectedVersion: 0, name: locked.name, size: locked.size, ownerId: locked.ownerId, locked: false }), playerB, roster);
  assert.equal(applyTableCommand(unlocked, moveCommand(unlocked, unlocked.tokens[0]), playerA, roster).tokens[0].version, 1);
  assert.equal(applyTableCommand(scene, sceneCommand(scene, 'remove', { tokenId: locked.id, expectedVersion: 0 }), playerA, roster).tokens.length, 7);
});

test('duplicate copies placed private image reference and style, detaches group and validates versions, scene, role and cap', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster), source = scene.tokens[0];
  Object.assign(source, { assetId: commandId(), groupId: commandId(), locked: true, rotation: 135, layer: 7, showLabel: false, x: 1550, y: 1070 });
  const command = sceneCommand(scene, 'duplicate', { tokenId: source.id, expectedVersion: 0 });
  const copyScene = applyTableCommand(scene, command, playerB, roster), copy = copyScene.tokens.at(-1);
  const { groupId, ...ungroupedSource } = source;
  assert.deepEqual(copy, { ...ungroupedSource, id: command.id, locked: false, version: 0, x: 1560, y: 1080 });
  assert.equal(scene.tokens.length, 8);
  expectCommandError(() => applyTableCommand(scene, { ...command, expectedVersion: 1 }, playerA, roster), 'conflict');
  expectCommandError(() => applyTableCommand(copyScene, command, playerA, roster), 'conflict');
  expectCommandError(() => applyTableCommand(scene, { ...command, sceneId: commandId() }, playerA, roster), 'forbidden');
  expectCommandError(() => applyTableCommand(scene, command, { ...playerA, role: 'spectator' }, roster), 'forbidden');
  scene.tokens = Array.from({ length: 150 }, (_, i) => ({ ...source, id: i ? commandId() : source.id }));
  expectCommandError(() => applyTableCommand(scene, command, master, roster), 'limit');
});

test('old scene saves acquire empty drawings and retain optional group ids', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  delete scene.drawings;
  assert.deepEqual(sceneSchema.parse(scene).drawings, []);
  scene.tokens[0].groupId = commandId();
  assert.equal(sceneSchema.parse(scene).tokens[0].groupId, scene.tokens[0].groupId);
});

test('shared drawing and erasing persist without changing the source or other scenes', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const secret = createPrototypeScene(scene.campaignId, roster);
  const drawing = stroke();
  const drawn = applyTableCommand(scene, sceneCommand(scene, 'draw', { drawing }), playerB, roster);
  assert.deepEqual(drawn.drawings, [drawing]);
  assert.deepEqual(scene.drawings, []);
  assert.deepEqual(secret.drawings, []);
  const erased = applyTableCommand(drawn, sceneCommand(drawn, 'erase', { drawingId: drawing.id }), playerA, roster);
  assert.deepEqual(erased.drawings, []);
  assert.deepEqual(drawn.drawings, [drawing]);
  expectCommandError(() => applyTableCommand(erased, sceneCommand(erased, 'erase', { drawingId: drawing.id }), master, roster), 'missing');
  expectCommandError(() => applyTableCommand(scene, sceneCommand(scene, 'draw', { sceneId: secret.id, drawing }), playerA, roster), 'forbidden');
});

test('drawing validation bounds finite paired points, brush width, stroke count and duplicate ids', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  for (const changes of [{ points: [0, 0, 1601, 0] }, { points: [0, 0, 1, 1121] }, { points: [0, NaN, 1, 1] },
    { points: [0, 0, 1] }, { points: [0, 0] }, { points: Array(2050).fill(1) }, { width: 0 }, { width: 41 }]) {
    assert.equal(commandSchema.safeParse({ id: commandId(), baseRevision: 0, type: 'draw', drawing: { ...stroke(), ...changes } }).success, false);
  }
  const drawing = stroke();
  scene.drawings = [drawing];
  expectCommandError(() => applyTableCommand(scene, sceneCommand(scene, 'draw', { drawing }), playerA, roster), 'conflict');
  scene.drawings = Array.from({ length: 300 }, stroke);
  expectCommandError(() => applyTableCommand(scene, sceneCommand(scene, 'draw', { drawing: stroke() }), master, roster), 'limit');
});

test('scene-wide drawing budget accepts 40000 coordinates and rejects an extra stroke without mutation', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const longStroke = count => ({ ...stroke(), points: Array(count).fill(1.2345678901234567) });
  scene.drawings = [...Array.from({ length: 19 }, () => longStroke(2048)), longStroke(1088)];
  assert.equal(sceneSchema.safeParse(scene).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(scene), 'utf8') < 1_000_000);
  const original = structuredClone(scene);
  const drawing = stroke();
  assert.equal(sceneSchema.safeParse({ ...scene, drawings: [...scene.drawings, drawing] }).success, false);
  expectCommandError(() => applyTableCommand(scene, sceneCommand(scene, 'draw', { drawing }), playerA, roster), 'limit');
  assert.deepEqual(scene, original);
});

test('independent stale draw and erase commands merge without structural revision conflicts', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const first = stroke(), second = stroke();
  const firstCommand = sceneCommand(scene, 'draw', { drawing: first });
  const secondCommand = sceneCommand(scene, 'draw', { drawing: second });
  const eraseFirst = sceneCommand(scene, 'erase', { drawingId: first.id });
  const drawn = applyTableCommand(scene, firstCommand, playerA, roster);
  const both = applyTableCommand(drawn, secondCommand, playerB, roster);
  assert.deepEqual(both.drawings, [first, second]);
  assert.deepEqual(drawn.drawings, [first]);
  expectCommandError(() => applyTableCommand(both, secondCommand, playerA, roster), 'conflict');
  const erased = applyTableCommand(both, eraseFirst, playerB, roster);
  assert.deepEqual(erased.drawings, [second]);
  expectCommandError(() => applyTableCommand(erased, eraseFirst, playerA, roster), 'missing');
  const staleGroup = sceneCommand(scene, 'group', { tokenIds: scene.tokens.slice(0, 2).map(token => token.id) });
  const staleUngroup = sceneCommand(scene, 'ungroup', { tokenIds: [scene.tokens[0].id] });
  expectCommandError(() => applyTableCommand(erased, staleGroup, playerA, roster), 'conflict');
  expectCommandError(() => applyTableCommand(erased, staleUngroup, playerA, roster), 'conflict');
});

test('group merges whole intersecting groups and ungroup clears every linked member atomically', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const first = applyTableCommand(scene, sceneCommand(scene, 'group', { tokenIds: scene.tokens.slice(0, 2).map(t => t.id) }), playerA, roster);
  const second = applyTableCommand(first, sceneCommand(first, 'group', { tokenIds: first.tokens.slice(2, 4).map(t => t.id) }), playerB, roster);
  const merge = sceneCommand(second, 'group', { tokenIds: [second.tokens[0].id, second.tokens[2].id] });
  const merged = applyTableCommand(second, merge, playerB, roster);
  assert.deepEqual(merged.tokens.slice(0, 4).map(t => t.groupId), Array(4).fill(merge.id));
  assert.deepEqual(merged.tokens.slice(0, 4).map(t => t.version), [2, 2, 2, 2]);
  const ungrouped = applyTableCommand(merged, sceneCommand(merged, 'ungroup', { tokenIds: [merged.tokens[1].id] }), playerA, roster);
  assert.ok(ungrouped.tokens.slice(0, 4).every(t => t.groupId === undefined && t.version === 3));
  assert.ok(merged.tokens.slice(0, 4).every(t => t.groupId === merge.id));
  expectCommandError(() => applyTableCommand(merged, { ...merge, baseRevision: merged.revision - 1 }, master, roster), 'conflict');
  expectCommandError(() => applyTableCommand(merged, sceneCommand(merged, 'ungroup', { tokenIds: [commandId()] }), master, roster), 'missing');
});

test('group movement uses one rigid clamped delta and invalidates every linked version', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const grouped = applyTableCommand(scene, sceneCommand(scene, 'group', { tokenIds: scene.tokens.slice(0, 2).map(t => t.id) }), playerA, roster);
  const moved = applyTableCommand(grouped, moveCommand(grouped, grouped.tokens[1], { x: -500, y: 5000 }), playerB, roster);
  assert.deepEqual(moved.tokens.slice(0, 2).map(t => [t.x, t.y, t.version]), [[40, 1080, 2], [120, 1080, 2]]);
  assert.deepEqual(grouped.tokens.slice(0, 2).map(t => [t.x, t.y, t.version]), [[120, 120, 1], [200, 120, 1]]);
  expectCommandError(() => applyTableCommand(moved, moveCommand(moved, moved.tokens[0], { expectedVersion: 1 }), playerA, roster), 'conflict');
});

test('remove-many validates every expected version before atomically deleting a selection', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const tokens = scene.tokens.slice(0, 3).map(t => ({ tokenId: t.id, expectedVersion: t.version }));
  const command = sceneCommand(scene, 'remove-many', { tokens });
  expectCommandError(() => applyTableCommand(scene, { ...command, tokens: [tokens[0], { ...tokens[1], expectedVersion: 1 }] }, playerA, roster), 'conflict');
  expectCommandError(() => applyTableCommand(scene, { ...command, tokens: [tokens[0], { tokenId: commandId(), expectedVersion: 0 }] }, playerA, roster), 'missing');
  const removed = applyTableCommand(scene, command, playerB, roster);
  assert.deepEqual(removed.tokens, scene.tokens.slice(3));
  assert.equal(scene.tokens.length, 8);
  expectCommandError(() => applyTableCommand(removed, { ...command, baseRevision: removed.revision }, playerA, roster), 'missing');
  assert.equal(commandSchema.safeParse({ ...command, tokens: [tokens[0], tokens[0]] }).success, false);
});

test('drawing, grouping and batch removal reject an unauthorized role', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const outsider = { userId: outsiderId, name: 'Outsider', role: 'spectator' };
  for (const command of [sceneCommand(scene, 'draw', { drawing: stroke() }), sceneCommand(scene, 'erase', { drawingId: commandId() }),
    sceneCommand(scene, 'group', { tokenIds: scene.tokens.slice(0, 2).map(t => t.id) }),
    sceneCommand(scene, 'ungroup', { tokenIds: [scene.tokens[0].id] }),
    sceneCommand(scene, 'remove-many', { tokens: [{ tokenId: scene.tokens[0].id, expectedVersion: 0 }] })]) {
    expectCommandError(() => applyTableCommand(scene, command, outsider, roster), 'forbidden');
  }
});
