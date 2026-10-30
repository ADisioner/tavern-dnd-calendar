import test from 'node:test';
import assert from 'node:assert/strict';
const fog=await import('../lib/table/fog.ts').catch(()=>({}));
const wall={id:crypto.randomUUID(),a:{x:80,y:0},b:{x:80,y:160},door:false,open:false};
test('walls block line of sight; opening a door restores it, including range limits',()=>{
  assert.equal(fog.lineOfSight?.({x:40,y:40},{x:120,y:40},[wall]),false);
  assert.equal(fog.lineOfSight?.({x:40,y:40},{x:120,y:40},[{...wall,door:true,open:true}]),true);
  assert.equal(fog.lineOfSight?.({x:40,y:40},{x:40,y:120},[wall]),true);
});
test('ownership, explored memory and projection remove hidden tokens and GM geometry',()=>{
  const scene={width:1600,height:1120,gridSize:80,tokens:[{id:'own',ownerId:'p',x:40,y:40,visionFeet:30},{id:'secret',ownerId:null,x:120,y:40},{id:'far',ownerId:null,x:40,y:900}],drawings:[],fog:{enabled:true,walls:[wall],manual:[],explored:{}}};
  const explored=fog.exploreScene(scene,[{userId:'p',role:'player'}]);
  assert.ok(explored.fog.explored.p.length>0);
  const view=fog.projectScene(explored,{userId:'p',role:'player'});
  assert.deepEqual(view.tokens.map(t=>t.id),['own']);assert.deepEqual(view.fog.walls,[]);assert.deepEqual(view.fog.explored,{});
  assert.ok(view.fog.view.polygons.length);
  const moved=fog.exploreScene({...explored,tokens:[{...scene.tokens[0],x:300,y:300}]},[{userId:'p',role:'player'}]);
  assert.ok(moved.fog.explored.p.length>=explored.fog.explored.p.length);
});

test('hideStats leaves tokens visible while the separate GM visibility command hides them from players only',async()=>{
  const {createPrototypeScene,commandSchema,applyTableCommand}=await import('../lib/table/scene.ts');
  const gm={userId:crypto.randomUUID(),name:'GM',role:'master'},player={userId:crypto.randomUUID(),name:'P',role:'player'},roster=[gm,player];
  const source=createPrototypeScene(crypto.randomUUID(),roster),token=source.tokens.find(value=>!value.ownerId);
  const scene={...source,tokens:source.tokens.map(value=>value.id===token.id?{...value,hp:7,tempHp:5,maxHp:10,hideStats:true,hidden:false}:value)};
  const visible=fog.projectScene(scene,player);assert.ok(visible.tokens.some(value=>value.id===token.id));
  assert.equal(visible.tokens.find(value=>value.id===token.id).hp,undefined);assert.equal(fog.projectScene(scene,gm).tokens.find(value=>value.id===token.id).hp,7);
  const hidden=applyTableCommand(scene,commandSchema.parse({id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,type:'vision',tokenId:token.id,expectedVersion:token.version,visionFeet:token.visionFeet??60,hidden:true}),gm,roster);
  assert.equal(fog.projectScene(hidden,player).tokens.some(value=>value.id===token.id),false);
  assert.equal(fog.projectScene(hidden,gm).tokens.some(value=>value.id===token.id),true);
  assert.throws(()=>applyTableCommand(scene,{id:crypto.randomUUID(),sceneId:scene.id,baseRevision:scene.revision,type:'vision',tokenId:token.id,expectedVersion:token.version,visionFeet:60,hidden:true},player,roster));
});

test('the map endpoint masks unexplored artwork before bytes reach the client', async()=>{
  const {PNG}=await import('pngjs'),{maskedMap}=await import('../lib/table/fog-map.ts');
  const image=new PNG({width:40,height:28});for(let i=0;i<image.data.length;i+=4){image.data[i]=255;image.data[i+3]=255;}
  const scene={width:1600,height:1120,gridSize:80,tokens:[{id:'own',ownerId:'p',x:40,y:40,visionFeet:10}],fog:{enabled:true,walls:[wall],manual:[],explored:{}},drawings:[]};
  const result=PNG.sync.read(Buffer.from(maskedMap(PNG.sync.write(image),'image/png',scene,{userId:'p',role:'player'},'test-map')));
  assert.equal(result.data[(40*1600+40)*4],255);
  assert.notEqual(result.data[(40*1600+120)*4],255);
  const square=new PNG({width:4,height:4});for(let i=0;i<square.data.length;i+=4){square.data[i]=255;square.data[i+3]=255;}
  const revealed={...scene,fog:{...scene.fog,manual:[{id:crypto.randomUUID(),x:0,y:0,width:1600,height:1120,reveal:true}]}};
  const letterbox=PNG.sync.read(Buffer.from(maskedMap(PNG.sync.write(square),'image/png',revealed,{userId:'p',role:'player'},'square-map')));
  assert.equal(letterbox.data[(40*1600+40)*4],21);assert.equal(letterbox.data[(40*1600+800)*4],255);
});


test('GM fog overview combines player vision and memory without changing player projection',async()=>{
 const {gmFogView,emptyFog}=await import('../lib/table/fog.ts');
 const scene={width:400,height:400,gridSize:50,drawings:[],tokens:[{id:'p',ownerId:'a',x:100,y:100,visionFeet:5},{id:'npc',ownerId:null,x:300,y:300,visionFeet:60}],fog:{...emptyFog(),enabled:true,explored:{a:['0:0'],b:['20:0']}}};
 const view=gmFogView(scene);assert.equal(view.polygons.length,1);assert.deepEqual(view.exploredCells.sort(),['0:0','20:0']);assert.equal(scene.fog.view,undefined);
});
