import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, applyRoomCommand, roomView, roomDataSchema, roomCommandSchema, viewVersion } from '../lib/table/room.ts';
import { diceHull } from '../lib/table/dice-geometry.ts';
const dice = await import('../lib/table/dice.ts').catch(() => ({}));
test('dice formula groups, signed modifiers and advantage keep server rolls', () => {
  const values = [2, 5, 6];
  assert.equal(dice.evaluateDice?.('2d6+3', 'normal', () => values.shift()).total, 10);
  const pair = [4, 19];
  const adv = dice.evaluateDice?.('d20-2', 'advantage', () => pair.shift());
  assert.equal(adv.total, 17); assert.deepEqual(adv.dice.map(d => d.kept), [false, true]);
  const low = [4, 19];
  assert.equal(dice.evaluateDice?.('d20+5', 'disadvantage', () => low.shift()).total, 9);
});
test('invalid formulas, unbounded work and unsupported advantage are rejected', () => {
  for (const formula of ['alert(1)', '2d7', '9999d6', '1d6/0', '2d6+', '1e99', '']) assert.throws(() => dice.evaluateDice(formula));
  assert.throws(() => dice.evaluateDice('40d100'));
  assert.throws(() => dice.evaluateDice('2d6', 'advantage'));
});
test('percentile convention maps 00 and zero to100 and all outcomes bijectively', () => {
  const seen = new Set();
  for (let tens=0;tens<10;tens++) for(let units=0;units<10;units++) seen.add(dice.percentileValue(tens,units));
  assert.equal(dice.percentileValue?.(0,0),100); assert.equal(seen.size,100);
  assert.equal(Math.min(...seen),1); assert.equal(Math.max(...seen),100);
});
test('private and GM-only roll records are projected only to authorized recipients', () => {
  const roll = { authorId:'author', visibility:'private' };
  assert.equal(dice.canSeeRoll?.(roll,{userId:'other',role:'player'}),false);
  assert.equal(dice.canSeeRoll?.(roll,{userId:'author',role:'player'}),true);
  assert.equal(dice.canSeeRoll?.({...roll,visibility:'gm'},{userId:'author',role:'player'}),false);
  assert.equal(dice.canSeeRoll?.({...roll,visibility:'gm'},{userId:'gm',role:'master'}),true);
});
test('every physical die has the right number of outward convex faces', () => {
  for(const sides of [4,6,8,10,12,20]) {const hull=diceHull(sides);assert.equal(hull.faces.length,sides); for(const face of hull.faces) assert.ok(face.normal.dot(face.center)>0);}
});
test('room commands reject forged outcomes and retain private history across restoration', () => {
  const actor={userId:crypto.randomUUID(),name:'Player',role:'player'},other={userId:crypto.randomUUID(),name:'Other',role:'player'},gm={userId:crypto.randomUUID(),name:'GM',role:'master'};
  let room=createRoom(crypto.randomUUID(),[actor,other,gm]);
  const previous=viewVersion(roomView(room,other));
  const command={type:'dice-roll',id:crypto.randomUUID(),sceneId:room.activeSceneId,baseRevision:0,expectedRoomRevision:0,formula:'2d6+3',mode:'normal',visibility:'private'};
  assert.equal(roomCommandSchema.safeParse({...command,total:99}).success,false);
  room=applyRoomCommand(room,roomCommandSchema.parse(command),actor,[]).data;
  assert.equal(room.rolls.length,1);assert.ok(room.rolls[0].total>=5&&room.rolls[0].total<=15);
  assert.equal(viewVersion(roomView(room,other)),previous);
  assert.equal(roomView(room,other).rolls.length,0);assert.equal(roomView(room,gm).rolls.length,1);
  const restored=roomDataSchema.parse(JSON.parse(JSON.stringify(room)));
  assert.deepEqual(roomView(restored,actor).rolls,roomView(room,actor).rolls);
  assert.equal(applyRoomCommand(restored,command,actor,[]).data.rolls.length,1);
  assert.throws(()=>applyRoomCommand(room,{...command,id:crypto.randomUUID(),npc:'Dragon'},actor,[]));
});

test('private roll retention cannot evict public history or change another player projection',()=>{
  const actor={userId:crypto.randomUUID(),name:'P',role:'player'},other={userId:crypto.randomUUID(),name:'O',role:'player'};let room=createRoom(crypto.randomUUID(),[actor,other]);
  const command=(visibility)=>({type:'dice-roll',id:crypto.randomUUID(),sceneId:room.activeSceneId,baseRevision:0,expectedRoomRevision:0,formula:'d6',mode:'normal',visibility});
  room=applyRoomCommand(room,command('public'),actor,[]).data;const before=JSON.stringify(roomView(room,other));
  for(let i=0;i<205;i++)room=applyRoomCommand(room,command('private'),actor,[]).data;
  assert.equal(JSON.stringify(roomView(room,other)),before);assert.equal(room.rolls.filter(r=>r.visibility==='private').length,50);
});
