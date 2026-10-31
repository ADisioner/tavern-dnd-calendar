import test from 'node:test';
import assert from 'node:assert/strict';
const combat=await import('../lib/table/combat.ts').catch(()=>({}));
test('initiative sorts descending and resolves ties stably by explicit GM order',()=>{
  const entries=[{id:'a',total:12,tieOrder:2},{id:'b',total:18,tieOrder:1},{id:'c',total:12,tieOrder:0}];
  assert.deepEqual(combat.sortInitiative?.(entries,'manual').map(e=>e.id),['b','c','a']);
});
test('combat automation is removed while initiative and manual tracker operations remain',()=>{
  assert.equal(combat.combatCommandSchema.options.map(option=>option.shape.type.value).includes('combat-attack'),false);
  const scene={tokens:[{id:'pc',ownerId:'player',hp:0,initiativeMod:2,effects:[{id:'e',name:'Bless',rounds:1}],statuses:[]},{id:'npc',ownerId:null,hp:0,initiativeMod:1,effects:[],statuses:[]}],combat:{running:true,round:1,currentId:'pc-entry',tiePolicy:'manual',entries:[{id:'pc-entry',tokenId:'pc',roll:10,total:12,tieOrder:0,tieRoll:null},{id:'npc-entry',tokenId:'npc',roll:8,total:9,tieOrder:1,tieRoll:null}]}};
  const reconciled=combat.reconcileCombat(scene,scene);
  assert.deepEqual(reconciled.combat.entries.map(entry=>entry.tokenId),['pc']);
  assert.equal(reconciled.combat.currentId,'pc-entry');
  let next=combat.applyCombat(reconciled,{type:'combat-next'},{userId:'gm',role:'master'});
  assert.equal(next.combat.round,2);assert.equal(next.tokens[0].effects[0].rounds,1);
});
test('turns wrap rounds without expiring effects and remove current participant safely',()=>{
  const scene={tokens:[{id:'ta',ownerId:'p',initiativeMod:2,effects:[{id:'e',name:'Bless',rounds:1}],statuses:[]},{id:'tb',ownerId:null,initiativeMod:0}],combat:{running:true,round:1,currentId:'a',tiePolicy:'manual',entries:[{id:'a',tokenId:'ta',roll:10,total:12,tieOrder:0,tieRoll:null},{id:'b',tokenId:'tb',roll:5,total:5,tieOrder:1,tieRoll:null}]}};
  const gm={userId:'gm',role:'master'};
  let next=combat.applyCombat(scene,{type:'combat-next'},gm);assert.equal(next.combat.currentId,'b');assert.equal(next.combat.round,1);
  next=combat.applyCombat(next,{type:'combat-next'},gm);assert.equal(next.combat.currentId,'a');assert.equal(next.combat.round,2);assert.equal(next.tokens[0].effects[0].rounds,1);
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

test('temporary HP can be set, displayed and survive initiative removal and re-addition',async()=>{
  const {createRoom,applyRoomCommand,roomCommandSchema,roomDataSchema,roomView}=await import('../lib/table/room.ts');
  const gm={userId:crypto.randomUUID(),name:'GM',role:'master'},roster=[gm];let room=createRoom(crypto.randomUUID(),roster);
  const token=room.scenes[0].scene.tokens[0];
  const dispatch=input=>{const scene=room.scenes[0].scene;room=applyRoomCommand(room,roomCommandSchema.parse({id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,...input}),gm,roster).data;};
  let scene=room.scenes[0].scene;
  dispatch({type:'vitals',tokenId:token.id,expectedVersion:token.version,hp:8,maxHp:10,tempHp:6,ac:12,initiativeMod:1,hidden:false,shareStats:false,initiativeGroup:''});
  dispatch({type:'combat-add',tokenId:token.id});
  assert.equal(roomView(room,gm).scene.tokens.find(t=>t.id===token.id).tempHp,6);
  const entryId=room.scenes[0].scene.combat.entries[0].id;
  dispatch({type:'combat-remove',participantId:entryId});
  assert.equal(roomView(room,gm).scene.tokens.find(t=>t.id===token.id).tempHp,6);
  dispatch({type:'combat-add',tokenId:token.id});
  const restored=roomDataSchema.parse(JSON.parse(JSON.stringify(room)));
  assert.equal(roomView(restored,gm).scene.tokens.find(t=>t.id===token.id).tempHp,6);
  assert.equal(restored.scenes[0].scene.combat.entries.length,1);
});

test('numeric damage spends temporary HP first and numeric healing caps at maximum HP',()=>{
  const gm={userId:'gm',role:'master'},scene={tokens:[{id:'t',ownerId:'p',hp:10,tempHp:5,maxHp:12,version:0}],combat:{...combat.emptyCombat(),entries:[{id:'e',tokenId:'t',roll:10,total:10,tieOrder:0,tieRoll:null}]}};
  const damaged=combat.applyCombat(scene,{type:'combat-adjust',tokenId:'t',expectedVersion:0,operation:'damage',amount:8},gm);
  assert.equal(damaged.tokens[0].tempHp,0);assert.equal(damaged.tokens[0].hp,7);
  const healed=combat.applyCombat(damaged,{type:'combat-adjust',tokenId:'t',expectedVersion:damaged.tokens[0].version,operation:'heal',amount:9},gm);
  assert.equal(healed.tokens[0].hp,12);assert.equal(healed.tokens[0].tempHp,0);
  assert.throws(()=>combat.combatCommandSchema.parse({id:crypto.randomUUID(),baseRevision:0,type:'combat-adjust',tokenId:'t',expectedVersion:0,operation:'damage',amount:0}));
  const fatal=combat.applyCombat(healed,{type:'combat-adjust',tokenId:'t',expectedVersion:healed.tokens[0].version,operation:'damage',amount:99},gm);
  assert.equal(fatal.tokens[0].hp,0);assert.equal(fatal.combat.entries.length,1);
});

test('ties remain manual and explicit NPC groups share one initiative roll',()=>{
  const entries=[{id:'a',tokenId:'ta',roll:null,total:null,tieOrder:0,tieRoll:null},{id:'b',tokenId:'tb',roll:null,total:null,tieOrder:1,tieRoll:null}],tokens=[{id:'ta',ownerId:null,initiativeMod:0},{id:'tb',ownerId:null,initiativeMod:0}],gm={userId:'g',role:'master'};
  let scene={tokens,combat:{running:false,round:0,currentId:null,tiePolicy:'reroll',entries}},numbers=[10,10,4,17];
  const result=combat.applyCombat(scene,{type:'combat-roll'},gm,()=>numbers.shift());assert.deepEqual(combat.sortInitiative(result.combat.entries,'reroll').map(e=>e.id),['a','b']);
  let calls=0;scene={...scene,tokens:tokens.map(t=>({...t,initiativeGroup:'goblins'})),combat:{...scene.combat,tiePolicy:'manual'}};
  const grouped=combat.applyCombat(scene,{type:'combat-roll'},gm,()=>{calls++;return 8;});assert.equal(calls,1);assert.deepEqual(grouped.combat.entries.map(e=>e.total),[8,8]);
});


test('zero HP removes current participant, advances round and ends empty combat',()=>{
  const entries=['a','b'].map((id,i)=>({id,tokenId:'t'+id,roll:20-i,total:20-i,tieOrder:i,tieRoll:null}));
  const previous={tokens:[{id:'ta',ownerId:null,hp:1},{id:'tb',ownerId:null,hp:1}],combat:{running:true,round:2,currentId:'b',tiePolicy:'manual',entries}};
  const next=combat.reconcileCombat(previous,{...previous,tokens:[previous.tokens[0],{...previous.tokens[1],hp:0}]});
  assert.deepEqual(next.combat.entries.map(e=>e.id),['a']);assert.equal(next.combat.currentId,'a');assert.equal(next.combat.round,3);
  const ended=combat.reconcileCombat(next,{...next,tokens:next.tokens.map(t=>({...t,hp:0}))});assert.equal(ended.combat.running,false);assert.equal(ended.combat.currentId,null);
});
test('hideStats hides only statistics from players while GM keeps them and token stays visible',()=>{
  const scene={tokens:[{id:'t',name:'Goblin',ownerId:'p',hidden:false,hp:7,tempHp:5,maxHp:10,ac:17,initiativeMod:3,shareStats:true,hideStats:true,effects:[]}],combat:{...combat.emptyCombat(),entries:[{id:'e',tokenId:'t',roll:12,total:15,tieOrder:0,tieRoll:null}]}};
  const view=combat.redactCombat(scene,{role:'player',userId:'p'},new Set(['t']));assert.equal(view.tokens[0].id,'t');assert.equal(view.tokens[0].name,'Goblin');assert.equal(view.tokens[0].hidden,false);assert.equal(view.tokens[0].hp,undefined);assert.equal(view.tokens[0].tempHp,undefined);assert.equal(view.combat.entries[0].total,null);
  const gmView=combat.redactCombat(scene,{role:'master',userId:'g'},new Set(['t']));assert.equal(gmView.tokens[0].hp,7);assert.equal(gmView.tokens[0].tempHp,5);
});


test('hidden stats persist through room schema and cannot be read or changed by owner',async()=>{
 const {createRoom,roomCommandSchema,applyRoomCommand,roomDataSchema,roomView}=await import('../lib/table/room.ts');
 const gm={userId:crypto.randomUUID(),name:'GM',role:'master'},player={userId:crypto.randomUUID(),name:'P',role:'player'},roster=[gm,player];let room=createRoom(crypto.randomUUID(),roster);
 const token=room.scenes[0].scene.tokens.find(t=>t.ownerId===player.userId);
 const command=(actor,extra)=>{const scene=room.scenes[0].scene;return applyRoomCommand(room,roomCommandSchema.parse({id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,type:'vitals',tokenId:token.id,expectedVersion:scene.tokens.find(t=>t.id===token.id).version,hp:7,maxHp:10,ac:17,initiativeMod:2,hidden:false,shareStats:true,hideStats:true,initiativeGroup:'',...extra}),actor,roster);};
 room=command(gm,{}).data;room=roomDataSchema.parse(JSON.parse(JSON.stringify(room)));
 const playerToken=roomView(room,player).scene.tokens.find(t=>t.id===token.id);assert.equal(playerToken.id,token.id);assert.notEqual(playerToken.hidden,true);assert.equal(playerToken.hp,undefined);assert.equal(playerToken.tempHp,undefined);
 assert.throws(()=>command(player,{hideStats:false,hp:8}));assert.throws(()=>command(player,{hp:8}));
 assert.equal(roomView(room,gm).scene.tokens.find(t=>t.id===token.id).hp,7);
});


test('owner cannot roll initiative for a token whose statistics GM has hidden',()=>{
 const scene={tokens:[{id:'t',ownerId:'p',hideStats:true,initiativeMod:7}],combat:{...combat.emptyCombat(),entries:[{id:'e',tokenId:'t',roll:null,total:null,tieOrder:0,tieRoll:null}]}};
 assert.throws(()=>combat.applyCombat(scene,{type:'combat-roll',participantId:'e'},{role:'player',userId:'p'},()=>12));
 assert.equal(combat.applyCombat(scene,{type:'combat-roll',participantId:'e'},{role:'master',userId:'g'},()=>12).combat.entries[0].total,19);
});

test('zero HP removes master-owned tokens but retains player-owned tokens through room commands',async()=>{
 const {createRoom,applyRoomCommand,roomCommandSchema}=await import('../lib/table/room.ts');
 const gm={userId:crypto.randomUUID(),name:'GM',role:'master'},player={userId:crypto.randomUUID(),name:'P',role:'player'},roster=[gm,player];let room=createRoom(crypto.randomUUID(),roster);
 const dispatch=input=>{const scene=room.scenes[0].scene;room=applyRoomCommand(room,roomCommandSchema.parse({id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,...input}),gm,roster).data;};
 const tokens=room.scenes[0].scene.tokens.filter(t=>t.ownerId);
 for(const token of tokens)dispatch({type:'combat-add',tokenId:token.id});
 dispatch({type:'combat-roll'});dispatch({type:'combat-start'});
 for(const token of tokens){const current=room.scenes[0].scene.tokens.find(t=>t.id===token.id);dispatch({type:'combat-adjust',tokenId:token.id,expectedVersion:current.version,operation:'damage',amount:10000});}
 const entries=room.scenes[0].scene.combat.entries;
 assert.equal(entries.some(e=>room.scenes[0].scene.tokens.find(t=>t.id===e.tokenId).ownerId===gm.userId),false);
 assert.equal(entries.some(e=>room.scenes[0].scene.tokens.find(t=>t.id===e.tokenId).ownerId===player.userId),true);
});
test('manual effects do not change statuses and changing a modifier does not rewrite rolled initiative',()=>{
 const scene={tokens:[{id:'t',ownerId:'p',hp:10,maxHp:10,version:0,initiativeMod:2,statuses:[],effects:[]}],combat:{...combat.emptyCombat(),entries:[{id:'e',tokenId:'t',roll:10,total:12,tieOrder:0,tieRoll:null}]}};
 const gm={userId:'gm',role:'master'};
 const added=combat.applyCombat(scene,{type:'effect-add',tokenId:'t',expectedVersion:0,effect:{id:'fx',name:'Effect',rounds:1,condition:'prone'}},gm);
 assert.deepEqual(added.tokens[0].statuses,[]);
 const updated=combat.applyCombat(added,{type:'vitals',tokenId:'t',expectedVersion:1,hp:10,maxHp:10,ac:10,initiativeMod:5,hidden:false,shareStats:false,initiativeGroup:''},gm);
 assert.equal(updated.combat.entries[0].total,12);
 const removed=combat.applyCombat(updated,{type:'effect-remove',tokenId:'t',expectedVersion:2,effectId:'fx'},gm);
 assert.equal(removed.tokens[0].effects.length,0);
});
