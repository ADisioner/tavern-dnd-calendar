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

test('players cannot change the grid, run the benchmark, or update token properties', () => {
  const scene = createPrototypeScene(crypto.randomUUID(), roster);
  const token = scene.tokens[0];
  const commands = [
    { id: commandId(), baseRevision: 0, type: 'grid', gridSize: 40, gridVisible: false },
    { id: commandId(), baseRevision: 0, type: 'benchmark' },
    { id: commandId(), baseRevision: 0, type: 'map', assetId: null },
    { id: commandId(), baseRevision: 0, type: 'update', tokenId: token.id, expectedVersion: token.version,
      name: 'Updated', size: token.size, ownerId: playerAId },
  ];

  for (const rawCommand of commands) {
    const command = commandSchema.parse(rawCommand);
    expectCommandError(() => applyTableCommand(scene, command, playerA, roster), 'forbidden');
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
