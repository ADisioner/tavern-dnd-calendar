import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const base = 'http://127.0.0.1:5173', fixturePath = 'outputs/roles-qa.json';
const clients = [], campaignIds = [];
async function api(client, endpoint, body, status = 200) {
  const response = await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { Origin: base,
    ...(client.cookie ? { Cookie: client.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  const cookie = response.headers.get('set-cookie'); if (cookie) client.cookie = cookie.split(';')[0];
  if (value.user) client.id = value.user.id;
  return value;
}
function fresh() {
  const client = { login: 'qa_roles_' + randomBytes(6).toString('hex'), password: randomBytes(12).toString('base64url'), cookie: '', id: '' };
  clients.push(client); return client;
}
function cleanup() {
  let sql = '';
  for (const id of campaignIds) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    for (const table of ['test_table_assets','test_table_rooms','test_table_motions','test_table_peers','availability','sessions','members']) sql += `DELETE FROM ${table} WHERE campaign_id='${id}';\n`;
    sql += `DELETE FROM campaigns WHERE id='${id}';\n`;
  }
  for (const client of clients) if (client.id) {
    assert.match(client.id, /^[a-f0-9-]{36}$/);
    sql += `DELETE FROM logins WHERE user_id='${client.id}'; DELETE FROM users WHERE id='${client.id}';\n`;
  }
  if (sql) {
    fs.mkdirSync('outputs', { recursive: true }); const filename = path.resolve('outputs/roles-qa-cleanup.sql'); fs.writeFileSync(filename, sql);
    const result = spawnSync(process.execPath, ['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config','dist/server/wrangler.json','--persist-to','.wrangler/state','--file',filename], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const id of campaignIds) for (const suffix of ['.room.json','.room.json.pending']) { const saved=path.resolve('.sites-runtime/table-rooms',id+suffix); if(fs.existsSync(saved))fs.unlinkSync(saved); }
  if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
}

if (process.argv.includes('--cleanup')) {
  const saved=JSON.parse(fs.readFileSync(fixturePath,'utf8'));clients.push(...saved.clients);campaignIds.push(...saved.campaignIds);cleanup();console.log('Exact local roles QA records removed.');
} else {
  assert.equal(fs.existsSync(fixturePath),false,'Clean up the previous roles fixture first.');
  let passed=false;
  try {
    const [owner,dual,player,outsider]=[fresh(),fresh(),fresh(),fresh()];
    for(const [i,client] of clients.entries())await api(client,'/api/auth',{action:'register',login:client.login,password:client.password,name:['Создатель комнаты','ДМ и игрок','Обычный игрок','Другая комната'][i]});
    const create=async(client,title)=>{const id=(await api(client,'/api/calendar',{action:'create',title,name:title,timezone:'Asia/Yekaterinburg'})).campaign;campaignIds.push(id);return id;};
    const campaign=await create(owner,'Проверка ролей'),other=await create(dual,'Другая партия');
    const hosted=async(client)=>{const response=await api(client,'/api/test/table',{campaignId:campaign,clientId:crypto.randomUUID(),message:{type:'hello'}});return response.events.find(event=>event.type==='snapshot');};
    const post=(client,action,payload={},status=200)=>api(client,'/api/calendar',{action,campaignId:campaign,...payload},status);
    const roles=(client,target,values,status=200)=>post(client,'setRoles',{userId:target.id,roles:values},status);
    const roster=async()=>(await api(owner,'/api/calendar?campaign='+campaign)).members;
    for(const client of [dual,player])await post(client,'join',{name:client===dual?'ДМ и игрок':'Обычный игрок',timezone:'Europe/Moscow'});
    await roles(outsider,outsider,['master'],403);
    await roles(player,player,['master','player'],403);
    await roles(owner,owner,['player'],409);
    await roles(owner,dual,[],400);await roles(owner,dual,['admin'],400);await roles(owner,dual,['player','player'],400);
    await roles(owner,outsider,['master'],404);
    await roles(owner,dual,['player','master']);
    assert.equal((await roster()).find(m=>m.userId===dual.id).role,'master,player');
    assert.equal((await roster()).length,3,'Combining roles must not duplicate membership');
    let bootstrap=await api(dual,'/api/table?campaign='+campaign);assert.equal(bootstrap.actor.role,'master');
    assert.equal(bootstrap.roster.find(m=>m.userId===dual.id).role,'master');
    assert.equal((await hosted(dual)).actor.role,'master');
    const start=Math.ceil((Date.now()+86400000)/900000)*900000,end=start+4*3600000;
    for(const client of [dual,player])await post(client,'availability',{start,end});
    await post(dual,'schedule',{title:'Без времени создателя',start,duration:2},409);
    await post(owner,'availability',{start,end});
    await post(player,'schedule',{title:'Нет прав',start,duration:2},403);
    await post(dual,'schedule',{title:'Сессия второго ДМа',start,duration:2});
    const games=(await api(dual,'/api/calendar?campaign='+campaign)).sessions;assert.equal(games.length,1);
    await post(player,'cancel',{id:games[0].id},403);await post(dual,'cancel',{id:games[0].id});
    await roles(dual,player,['master','player']);await roles(player,player,['player']);
    await roles(owner,dual,['player']);
    bootstrap=await api(dual,'/api/table?campaign='+campaign);assert.equal(bootstrap.actor.role,'player');
    assert.equal((await hosted(dual)).actor.role,'player');
    await roles(dual,player,['master'],403);await post(dual,'schedule',{title:'Права сняты',start,duration:2},403);
    assert.equal((await api(dual,'/api/table?campaign='+other)).actor.role,'master','Roles stay scoped to one room');
    await api(dual,'/api/auth',{action:'login',login:dual.login,password:dual.password,campaignId:campaign,timezone:'UTC'});
    assert.equal((await roster()).find(m=>m.userId===dual.id).role,'player','Repeat invite must not restore roles');
    await roles(owner,dual,['master','player']);
    const race=await Promise.all([
      fetch(base+'/api/calendar',{method:'POST',headers:{Origin:base,Cookie:owner.cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'setRoles',campaignId:campaign,userId:owner.id,roles:['player']})}),
      fetch(base+'/api/calendar',{method:'POST',headers:{Origin:base,Cookie:dual.cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'setRoles',campaignId:campaign,userId:dual.id,roles:['player']})})
    ]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    let current=await roster();const remaining=current.find(m=>m.role.includes('master'));const dm=clients.find(c=>c.id===remaining.userId);
    await roles(dm,owner,['master']);await roles(owner,dual,['master','player']);
    await roles(owner,owner,['player']);
    await post(dual,'removeMember',{userId:dual.id},409);
    await roles(dual,owner,['master','player']);
    await post(player,'removeMember',{userId:owner.id},403);
    await post(dual,'removeMember',{userId:player.id});
    assert.equal((await roster()).some(m=>m.userId===player.id),false);
    await api(outsider,'/api/calendar',{action:'join',campaignId:other,name:'Другая комната',timezone:'UTC'});
    await roles(owner,outsider,['master'],404);
    await roles(dual,dual,['master']);assert.equal((await roster()).find(m=>m.userId===dual.id).role,'master');
    await roles(dual,dual,['master','player']);
    passed=true;console.log('PASS: combined roles, server authorization, cross-room isolation, validation, delegated scheduling/cancellation, all-member matching, repeat invites, role revocation, atomic last-DM protection, member removal and table bootstrap.');
  } finally {
    if(passed&&process.env.ROLES_KEEP_QA==='1'){fs.mkdirSync('outputs',{recursive:true});fs.writeFileSync(fixturePath,JSON.stringify({clients,campaignIds}));console.log('Disposable local browser fixture retained; run --cleanup afterward.');}
    else cleanup();
  }
}
