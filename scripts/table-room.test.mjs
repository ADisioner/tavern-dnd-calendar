import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, migrateLegacyRoom, applyRoomCommand, roomCommandSchema, roomView, roomDataSchema } from '../lib/table/room.ts';
const campaign = crypto.randomUUID(), gm = { userId: crypto.randomUUID(), name: 'GM', role: 'master' }, player = { userId: crypto.randomUUID(), name: 'Player', role: 'player' };
const roster = [gm, player];
const command = (data, type, fields = {}) => roomCommandSchema.parse({ id: crypto.randomUUID(), sceneId: data.activeSceneId, baseRevision: data.scenes.find(entry => entry.scene.id === data.activeSceneId).scene.revision,
  type, ...(type.startsWith('scene-') || type.startsWith('music-') ? { expectedRoomRevision: data.revision } : {}), ...fields });
const apply = (data, type, fields = {}, actor = gm) => applyRoomCommand(data, command(data, type, fields), actor, roster);
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

test('legacy migration preserves tokens, map and timestamps, adds stable room and scene identities', () => {
  const source = createRoom(campaign, roster).scenes[0].scene;
  const legacy = { ...source, mapAssetId: crypto.randomUUID() }; delete legacy.id;
  const migrated = migrateLegacyRoom(campaign, legacy);
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.scenes.length, 1);
  assert.deepEqual(migrated.scenes[0].scene.tokens, legacy.tokens);
  assert.equal(migrated.scenes[0].scene.updatedAt, legacy.updatedAt);
  assert.equal(migrated.scenes[0].scene.mapAssetId, legacy.mapAssetId);
  assert.equal(migrated.activeSceneId, migrated.scenes[0].scene.id);
  assert.deepEqual(roomDataSchema.parse(migrated), migrated);
});
test('creating a private preparation scene preserves the active group scene', () => {
  const original = createRoom(campaign, roster), first = original.activeSceneId;
  const result = apply(original, 'scene-create', { name: 'Secret encounter' });
  assert.equal(result.data.activeSceneId, first); assert.notEqual(result.viewSceneId, first);
  assert.equal(result.data.scenes[1].scene.tokens.length, 0);
  assert.equal(original.scenes.length, 1);
  const gmView = roomView(result.data, gm, result.viewSceneId), playerView = roomView(result.data, player, result.viewSceneId);
  assert.equal(gmView.scene.name, 'Secret encounter'); assert.equal(gmView.scenes.length, 2);
  assert.equal(playerView.scene.id, first); assert.equal(playerView.scenes.length, 1);
  assert.equal(JSON.stringify(playerView).includes('Secret encounter'), false);
});
test('players cannot manage or preview scenes even when they know an inactive scene ID', () => {
  const result = apply(createRoom(campaign, roster), 'scene-create', { name: 'Secret' });
  const data = result.data, targetSceneId = result.viewSceneId;
  for (const type of ['scene-view', 'scene-activate', 'scene-archive', 'scene-restore', 'scene-duplicate', 'scene-rename'])
    fails(() => apply(data, type, { targetSceneId, ...(['scene-duplicate', 'scene-rename'].includes(type) ? { name: 'Hacked' } : {}) }, player), 'forbidden');
  fails(() => apply(data, 'scene-create', { name: 'Hacked' }, player), 'forbidden');
  fails(() => apply(data, 'add', { sceneId: targetSceneId, baseRevision: 0, ownerId: player.userId }, player), 'forbidden');
});

test('token removal cannot cross into a master preparation scene', () => {
  const original = createRoom(campaign, roster);
  const result = apply(original, 'scene-duplicate', { targetSceneId: original.activeSceneId, name: 'Private preparation' });
  const secret = result.data.scenes.find(entry => entry.scene.id === result.viewSceneId).scene;
  const token = secret.tokens[0];
  fails(() => apply(result.data, 'remove', { sceneId: secret.id, baseRevision: secret.revision,
    tokenId: token.id, expectedVersion: token.version }, player), 'forbidden');
});
test('duplicate scenes have independent token IDs, while preserving map, grid, owners and positions', () => {
  let original = createRoom(campaign, roster);
  original.scenes[0].scene.mapAssetId = crypto.randomUUID();
  original.scenes[0].scene.tokens[0].assetId = crypto.randomUUID();
  original.scenes[0].scene.tokens[0].version = 4;
  original.scenes[0].scene.gridSize = 60;
  const result = apply(original, 'scene-duplicate', { targetSceneId: original.activeSceneId, name: 'Copy' });
  const source = original.scenes[0].scene, copy = result.data.scenes[1].scene;
  assert.notEqual(copy.id, source.id); assert.equal(result.data.activeSceneId, source.id);
  assert.equal(copy.tokens.length, source.tokens.length); assert.equal(copy.gridSize, source.gridSize);
  assert.equal(copy.mapAssetId, source.mapAssetId);
  for (let i = 0; i < source.tokens.length; i++) {
    assert.notEqual(copy.tokens[i].id, source.tokens[i].id);
    assert.deepEqual({ ...copy.tokens[i], id: source.tokens[i].id, version: source.tokens[i].version }, source.tokens[i]);
  }
});
test('archiving and restoring are reversible; an active scene cannot be archived', () => {
  const made = apply(createRoom(campaign, roster), 'scene-create', { name: 'Second' });
  let data = made.data;
  fails(() => apply(data, 'scene-archive', { targetSceneId: data.activeSceneId }), 'active');
  data = apply(data, 'scene-archive', { targetSceneId: made.viewSceneId }).data;
  assert.equal(data.scenes[1].archived, true);
  assert.equal(roomView(data, gm, made.viewSceneId).scene.id, data.activeSceneId);
  fails(() => apply(data, 'scene-view', { targetSceneId: made.viewSceneId }), 'missing');
  fails(() => apply(data, 'scene-activate', { targetSceneId: made.viewSceneId }), 'archived');
  data = apply(data, 'scene-restore', { targetSceneId: made.viewSceneId }).data;
  assert.equal(data.scenes[1].archived, false);
  data = apply(data, 'scene-activate', { targetSceneId: made.viewSceneId }).data;
  assert.equal(roomView(data, player).scene.id, made.viewSceneId);
});
test('stale room operations conflict; late commands cannot modify a scene after the group has moved', () => {
  const made = apply(createRoom(campaign, roster), 'scene-create', { name: 'Second' });
  const old = made.data, oldToken = old.scenes[0].scene.tokens[0];
  const late = command(old, 'move', { tokenId: oldToken.id, expectedVersion: oldToken.version, x: 300, y: 300 });
  const next = apply(old, 'scene-activate', { targetSceneId: made.viewSceneId }).data;
  fails(() => applyRoomCommand(next, late, player, roster), 'forbidden');
  assert.equal(next.scenes[0].scene.tokens[0].x, oldToken.x);
  fails(() => applyRoomCommand(next, command(old, 'scene-rename', { targetSceneId: old.activeSceneId, name: 'Stale' }), gm, roster), 'conflict');
  const { sceneId: omitted, ...withoutScene } = late;
  fails(() => applyRoomCommand(next, withoutScene, player, roster), 'protocol');
});
test('room schema rejects foreign campaign scenes, duplicate IDs and invalid active references', () => {
  const data = createRoom(campaign, roster);
  assert.equal(roomDataSchema.safeParse({ ...data, activeSceneId: crypto.randomUUID() }).success, false);
  assert.equal(roomDataSchema.safeParse({ ...data, scenes: [data.scenes[0], data.scenes[0]] }).success, false);
  assert.equal(roomDataSchema.safeParse({ ...data, scenes: [{ ...data.scenes[0], archived: true }] }).success, false);
  assert.equal(roomDataSchema.safeParse({ ...data, scenes: [{ ...data.scenes[0], scene: { ...data.scenes[0].scene, campaignId: crypto.randomUUID() } }] }).success, false);
});

test('all table participants share and persist a music playlist and synchronized playback state', () => {
  let data = createRoom(campaign, roster);
  assert.deepEqual(data.music, { tracks: [], currentTrackId: null, playing: false, positionSeconds: 0, startedAt: null });
  const addedByPlayer = command(data, 'music-add', { label: 'Боевая музыка', videoId: 'dQw4w9WgXcQ' });
  data = applyRoomCommand(data, addedByPlayer, player, roster, { youtubeTitle: 'Never Gonna Give You Up' }).data;
  const track = data.music.tracks[0];
  assert.equal(track.id, addedByPlayer.id); assert.equal(track.label, 'Боевая музыка'); assert.equal(track.addedById, player.userId);
  assert.equal(track.title, 'Never Gonna Give You Up');
  const autoTitleCommand = command(data, 'music-add', { videoId: 'FC1pMjDdjng' });
  data = applyRoomCommand(data, autoTitleCommand, player, roster, { youtubeTitle: "maybe I wasn't ready to go home..." }).data;
  assert.equal(data.music.tracks[1].title, "maybe I wasn't ready to go home...");
  assert.equal(data.music.tracks[1].label, undefined);
  assert.equal(roomView(data, gm).music.tracks.length, 2); assert.equal(roomView(data, player).music.tracks.length, 2);
  data = apply(data, 'music-add', { label: 'Спокойная', videoId: 'M7lc1UVf-VE' }).data;
  data = apply(data, 'music-select', { trackId: track.id }).data;
  assert.equal(data.music.currentTrackId, track.id); assert.equal(data.music.playing, false);
  data = apply(data, 'music-play', { trackId: track.id, positionSeconds: 12 }, player).data;
  assert.equal(data.music.playing, true); assert.equal(data.music.positionSeconds, 12); assert.ok(data.music.startedAt);
  data = apply(data, 'music-pause', { trackId: track.id, positionSeconds: 27 }, player).data;
  assert.equal(data.music.playing, false); assert.equal(data.music.positionSeconds, 27); assert.equal(data.music.startedAt, null);
  data = apply(data, 'music-remove', { trackId: track.id }, player).data;
  assert.equal(data.music.tracks.length, 2); assert.equal(data.music.currentTrackId, null);
  assert.equal(roomDataSchema.parse({ ...data, music: undefined }).music.tracks.length, 0);
});
