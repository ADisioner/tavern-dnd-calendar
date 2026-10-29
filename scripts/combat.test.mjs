import test from 'node:test';
import assert from 'node:assert/strict';
const combat=await import('../lib/table/combat.ts').catch(()=>({}));
test('initiative sorts descending and resolves ties stably by explicit GM order',()=>{
  const entries=[{id:'a',total:12,tieOrder:2},{id:'b',total:18,tieOrder:1},{id:'c',total:12,tieOrder:0}];
  assert.deepEqual(combat.sortInitiative?.(entries,'manual').map(e=>e.id),['b','c','a']);
});
test('turns wrap rounds, expire round effects and remove current participant safely',()=>{
  const scene={tokens:[{id:'ta',ownerId:'p',initiativeMod:2,effects:[{id:'e',name:'Bless',rounds:1}],statuses:[]},{id:'tb',ownerId:null,initiativeMod:0}],combat:{running:true,round:1,currentId:'a',tiePolicy:'manual',entries:[{id:'a',tokenId:'ta',roll:10,total:12,tieOrder:0,tieRoll:null},{id:'b',tokenId:'tb',roll:5,total:5,tieOrder:1,tieRoll:null}]}};
  const gm={userId:'gm',role:'master'};
  let next=combat.applyCombat(scene,{type:'combat-next'},gm);assert.equal(next.combat.currentId,'b');assert.equal(next.combat.round,1);
  next=combat.applyCombat(next,{type:'combat-next'},gm);assert.equal(next.combat.currentId,'a');assert.equal(next.combat.round,2);assert.equal(next.tokens[0].effects.length,0);
  next=combat.applyCombat(next,{type:'combat-remove',participantId:'a'},gm);assert.equal(next.combat.currentId,'b');
  assert.throws(()=>combat.applyCombat(scene,{type:'combat-next'},{userId:'p',role:'player'}));
});

test('auto initiative uses server RNG, ownership and NPC statistics are enforced and restorable',async()=>{
  const {createRoom,applyRoomCommand,roomView,roomDataSchema,roomCommandSchema}=await import('../lib/table/room.ts');
  const gm={userId:crypto.randomUUID(),name:'GM',role:'master'},player={userId:crypto.randomUUID(),name:'P',role:'player'},roster=[gm,player];
  let room=createRoom(crypto.randomUUID(),roster);
  const dispatch=(input,actor=gm)=>{const scene=room.scenes[0].scene,command={id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,...input};room=applyRoomCommand(room,roomCommandSchema.parse(command),actor,roster,{random:()=>12}).data;return command;};
  let scene=room.scenes[0].scene;const pc=scene.tokens.find(t=>t.ownerId===player.userId),npc=scene.tokens.find(t=>!t.ownerId),hidden=scene.tokens.filter(t=>!t.ownerId)[1];
  const set=(token,extra)=>dispatch({type:'vitals',tokenId:token.id,expectedVersion:token.version,hp:25,maxHp:30,ac:17,initiativeMod:3,hidden:false,shareStats:false,initiativeGroup:'',...extra});
  set(pc,{});set(npc,{});set(hidden,{hidden:true});
  dispatch({type:'combat-add',tokenId:pc.id});dispatch({type:'combat-add',tokenId:npc.id});dispatch({type:'combat-add',tokenId:hidden.id});dispatch({type:'combat-roll'});dispatch({type:'combat-start'});
  scene=room.scenes[0].scene;assert.ok(scene.combat.entries.every(e=>e.roll===12&&e.total===15));
  const view=roomView(room,player).scene;assert.equal(view.tokens.some(t=>t.id===hidden.id),false);assert.equal(view.combat.entries.some(e=>e.tokenId===hidden.id),false);
  assert.equal(view.tokens.find(t=>t.id===npc.id).hp,undefined);assert.equal(view.tokens.find(t=>t.id===pc.id).hp,25);assert.equal(view.combat.entries.find(e=>e.tokenId===npc.id).roll,null);
  assert.throws(()=>dispatch({type:'vitals',tokenId:npc.id,expectedVersion:1,hp:1,maxHp:30,ac:17,initiativeMod:3,hidden:false,shareStats:false,initiativeGroup:''},player));
  assert.throws(()=>dispatch({type:'combat-next'},player));
  const currentPc=room.scenes[0].scene.tokens.find(t=>t.id===pc.id);dispatch({type:'vitals',tokenId:pc.id,expectedVersion:currentPc.version,hp:8,maxHp:30,ac:17,initiativeMod:3,hidden:false,shareStats:false,initiativeGroup:''},player);
  const restored=roomDataSchema.parse(JSON.parse(JSON.stringify(room)));assert.equal(roomView(restored,player).scene.tokens.find(t=>t.id===pc.id).hp,8);assert.equal(restored.scenes[0].scene.combat.round,1);
});

test('optional tie rerolls are server generated and explicit NPC groups share one initiative roll',()=>{
  const entries=[{id:'a',tokenId:'ta',roll:null,total:null,tieOrder:0,tieRoll:null},{id:'b',tokenId:'tb',roll:null,total:null,tieOrder:1,tieRoll:null}],tokens=[{id:'ta',ownerId:null,initiativeMod:0},{id:'tb',ownerId:null,initiativeMod:0}],gm={userId:'g',role:'master'};
  let scene={tokens,combat:{running:false,round:0,currentId:null,tiePolicy:'reroll',entries}},numbers=[10,10,4,17];
  const result=combat.applyCombat(scene,{type:'combat-roll'},gm,()=>numbers.shift());assert.deepEqual(combat.sortInitiative(result.combat.entries,'reroll').map(e=>e.id),['b','a']);
  let calls=0;scene={...scene,tokens:tokens.map(t=>({...t,initiativeGroup:'goblins'})),combat:{...scene.combat,tiePolicy:'manual'}};
  const grouped=combat.applyCombat(scene,{type:'combat-roll'},gm,()=>{calls++;return 8;});assert.equal(calls,1);assert.deepEqual(grouped.combat.entries.map(e=>e.total),[8,8]);
});
