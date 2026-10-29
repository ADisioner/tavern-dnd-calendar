// Runs only against a disposable campaign from table-integration.test.mjs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const base=process.env.TABLE_TEST_BASE??'http://127.0.0.1:5178';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw new Error('Local QA only.');
const fixture=JSON.parse(fs.readFileSync('outputs/table-qa.json','utf8')),{clients,campaign}=fixture;
async function api(index,path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,Cookie:clients[index].cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
function wsClient(socketUrl,ticket){const socket=new WebSocket(socketUrl,{origin:base}),messages=[],waiters=[];socket.on('error',()=>{});socket.on('message',data=>{messages.push(JSON.parse(data));for(const fn of [...waiters])fn();});socket.on('open',()=>socket.send(JSON.stringify({type:'hello',ticket})));return{socket,send:input=>socket.send(JSON.stringify(input)),wait(predicate){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{waiters.splice(waiters.indexOf(check),1);reject(new Error('VTT event timeout'));},5000);function check(){const index=messages.findIndex(predicate);if(index<0)return;clearTimeout(timeout);waiters.splice(waiters.indexOf(check),1);resolve(messages.splice(index,1)[0]);}waiters.push(check);check();});}};}
let local;
const clientIds=[crypto.randomUUID(),crypto.randomUUID()];
try{
  if(!clients[3]){
    const login=`qa_vtt_ui_${Date.now()}`,password='Local-test-only-2026!';
    const response=await fetch(base+'/api/auth',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({action:'register',login,password,name:'VTT UI QA'})});const value=await response.json();assert.equal(response.status,200);
    clients.push({id:value.user.id,login,password,cookie:response.headers.get('set-cookie').split(';')[0]});fs.writeFileSync('outputs/table-qa.json',JSON.stringify(fixture));
    await api(3,'/api/calendar',{action:'join',campaignId:campaign,name:'VTT UI QA',timezone:'Asia/Yekaterinburg'});
  }
  await api(0,'/api/calendar',{action:'setRoles',campaignId:campaign,userId:clients[3].id,roles:['master']});
  for(const transport of ['local','hosted']){
    let state;
    const poll=async index=>{const data=await api(index,`/api/test/table?campaign=${campaign}&client=${clientIds[index]}`);return data.events.find(e=>e.type==='snapshot');};
    if(transport==='local'){const bootstrap=await api(0,'/api/table?campaign='+campaign);local=wsClient(bootstrap.socketUrl,bootstrap.ticket);state=await local.wait(e=>e.type==='snapshot');}else state=await poll(0);
    async function command(input,index=0){const id=crypto.randomUUID(),command={id,sceneId:state.scene.id,baseRevision:state.scene.revision,...(input.type.startsWith('scene-')||input.type==='dice-roll'?{expectedRoomRevision:state.roomRevision}:{}),...input};
      let result;if(transport==='local'){assert.equal(index,0);local.send({type:'command',command});result=await local.wait(e=>e.commandId===id);assert.equal(result.type,'snapshot',JSON.stringify(result));}
      else {const packet=await api(index,'/api/test/table',{campaignId:campaign,clientId:clientIds[index],message:{type:'command',command}});result=packet.events.find(e=>e.type==='snapshot');assert.ok(result,JSON.stringify(packet));}
      if(index===0)state=result;return result;
    }
    await command({type:'scene-create',name:'VTT 2014 QA'});await command({type:'scene-activate',targetSceneId:state.scene.id});
    await command({type:'add',ownerId:clients[1].id,name:'Герой QA'});await command({type:'add',ownerId:null,name:'Гоблин QA'});await command({type:'add',ownerId:null,name:'Секретный NPC QA'});
    const ids=state.scene.tokens.map(t=>t.id);
    for(let i=0;i<ids.length;i++){
      let t=state.scene.tokens.find(t=>t.id===ids[i]);await command({type:'move',tokenId:t.id,expectedVersion:t.version,x:200+i*250,y:200});t=state.scene.tokens.find(t=>t.id===ids[i]);
      await command({type:'vitals',tokenId:t.id,expectedVersion:t.version,hp:12,maxHp:20,ac:13,initiativeMod:i,hidden:i===2,shareStats:false,initiativeGroup:''});await command({type:'combat-add',tokenId:t.id});
    }
    await command({type:'combat-roll'});await command({type:'combat-start'});const first=state.scene.combat.currentId;
    for(let i=0;i<3;i++)await command({type:'combat-next'});assert.equal(state.scene.combat.round,2);assert.equal(state.scene.combat.currentId,first);
    const owned=state.scene.tokens.find(t=>t.id===ids[0]);await command({type:'effect-add',tokenId:owned.id,expectedVersion:owned.version,effect:{id:crypto.randomUUID(),name:'Bless QA',rounds:2,condition:'concentration'}});
    const dice=await command({type:'dice-roll',formula:'2d6+3',mode:'normal',visibility:'public'});assert.ok(dice.rolls.at(-1).total>=5&&dice.rolls.at(-1).total<=15);
    const blind=await command({type:'dice-roll',formula:'d20',mode:'normal',visibility:'gm',npc:'Hidden roll QA'});const blindId=blind.rolls.at(-1).id;
    const wallId=crypto.randomUUID();await command({type:'wall-set',wall:{id:wallId,a:{x:400,y:0},b:{x:400,y:1120},door:true,open:false}});await command({type:'fog-config',enabled:true});
    if(transport==='hosted'){
      const player=await poll(1);assert.equal(JSON.stringify(player).includes(ids[1]),false);assert.equal(JSON.stringify(player).includes(ids[2]),false);assert.equal(JSON.stringify(player).includes(blindId),false);
      const wall=state.scene.fog.walls.find(w=>w.id===wallId);await command({type:'wall-set',wall:{...wall,open:true}});const open=await poll(1);assert.ok(open.scene.tokens.some(t=>t.id===ids[1]));assert.equal(open.scene.tokens.find(t=>t.id===ids[1]).hp,undefined);
      assert.equal(open.scene.combat.entries.some(e=>e.tokenId===ids[2]),false);
      const pc=open.scene.tokens.find(t=>t.id===ids[0]);await command({type:'vitals',tokenId:pc.id,expectedVersion:pc.version,hp:7,maxHp:20,ac:13,initiativeMod:0,hidden:false,shareStats:false,initiativeGroup:''},1);
      state=await poll(0);assert.equal(state.scene.tokens.find(t=>t.id===ids[0]).hp,7);const reconnect=await api(1,`/api/test/table?campaign=${campaign}&client=${crypto.randomUUID()}`);assert.equal(reconnect.events.find(e=>e.type==='snapshot').scene.tokens.find(t=>t.id===ids[0]).hp,7);
    }
    // Leave a clear scene for visual QA in the disposable campaign.
    await command({type:'fog-config',enabled:false});await command({type:'combat-end'});
    console.log(`PASS: ${transport} server dice, combat round wrap, token vitals/effect persistence${transport==='hosted'?', closed/open door projections, private NPC/roll filtering and reconnect':''}.`);
    local?.socket.terminate();local=undefined;
  }
  console.log(JSON.stringify({uiLogin:clients[3].login,campaign}));
}finally{local?.socket.terminate();}
