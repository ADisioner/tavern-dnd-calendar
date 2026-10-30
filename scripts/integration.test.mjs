import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {zonedToUtc} from '../lib/scheduler.ts';
const BASE='http://127.0.0.1:5173';
const suffix=crypto.randomBytes(5).toString('hex'),password=crypto.randomBytes(3).toString('base64url');
const newPassword=password.slice(0,3)+(password[3]==='x'?'y':'x');
const clients=[{cookie:'',id:''},{cookie:'',id:''},{cookie:'',id:''}];let campaign='';
async function call(client,url,data,expected=200){
  const r=await fetch(BASE+url,{method:data?'POST':'GET',headers:{...(data?{'Content-Type':'application/json','Origin':BASE}:{}),...(client.cookie?{Cookie:client.cookie}:{})},body:data?JSON.stringify(data):undefined});
  const result=await r.json();assert.equal(r.status,expected,JSON.stringify(result));
  const cookie=r.headers.get('set-cookie');if(cookie)client.cookie=cookie.split(';')[0];return result;
}
try{
  assert.equal((await call(clients[0],'/api/auth')).setup,true,'Use only a fresh local preview database.');
  await call(clients[0],'/api/calendar',{action:'create',title:'No auth'},401);
  await call(clients[0],'/api/auth',{action:'register',login:`qa_${suffix}_short`,password:'abc'},400);
  for(let i=0;i<3;i++){
    const result=await call(clients[i],'/api/auth',{action:'register',login:`qa_${suffix}_${i}`,password,name:`QA ${i}`});clients[i].id=result.user.id;
    assert.equal(result.user.role,i===0?'admin':'player');
  }
  // The browser login form previously sent name:null even though it has no name field.
  await call(clients[0],'/api/auth',{action:'login',login:`qa_${suffix}_0`,password,name:null});
  assert.equal((await call(clients[0],'/api/auth')).user.id,clients[0].id);
  await call(clients[1],'/api/admin',undefined,403);
  await call(clients[1],'/api/auth',{action:'login',login:`qa_${suffix}_1`,password:'wrong-password'},401);
  const created=await call(clients[0],'/api/calendar',{action:'create',title:'QA private campaign',name:'QA master',timezone:'Europe/Moscow'});campaign=created.campaign;
  assert.equal((await call(clients[1],`/api/calendar?campaign=${campaign}`)).joinRequired,true);
  await call(clients[1],'/api/calendar',{action:'join',campaignId:campaign,name:'QA player',timezone:'Asia/Yekaterinburg'});
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const start=zonedToUtc(`${day}T10:00`,'Europe/Moscow'),end=zonedToUtc(`${day}T14:00`,'Europe/Moscow');
  assert.equal(start,zonedToUtc(`${day}T12:00`,'Asia/Yekaterinburg'));
  await call(clients[0],'/api/calendar',{action:'availability',campaignId:campaign,start,end});
  await call(clients[0],'/api/calendar',{action:'schedule',campaignId:campaign,title:'Too early',start,duration:3},409);
  await call(clients[1],'/api/calendar',{action:'availability',campaignId:campaign,start:zonedToUtc(`${day}T12:00`,'Asia/Yekaterinburg'),end:zonedToUtc(`${day}T16:00`,'Asia/Yekaterinburg')});
  await call(clients[1],'/api/calendar',{action:'schedule',campaignId:campaign,title:'Forbidden',start,duration:3},403);
  await call(clients[2],'/api/calendar',{action:'availability',campaignId:campaign,start,end},403);
  await call(clients[0],'/api/calendar',{action:'schedule',campaignId:campaign,title:'Timezone QA',start,duration:3});
  await call(clients[0],'/api/calendar',{action:'schedule',campaignId:campaign,title:'Duplicate',start,duration:3},409);
  const result=await call(clients[1],`/api/calendar?campaign=${campaign}`);
  assert.equal(result.sessions[0].start,start);assert.equal(result.members.length,2);assert.equal(result.availability.length,2);
  const own=result.availability.find(a=>a.userId===clients[0].id);
  await call(clients[1],'/api/calendar',{action:'removeAvailability',campaignId:campaign,id:own.id});
  assert.equal((await call(clients[0],`/api/calendar?campaign=${campaign}`)).availability.length,2,'Players must not remove another member availability');
  await call(clients[0],'/api/admin',{action:'block',id:clients[1].id});
  assert.equal((await call(clients[1],'/api/calendar')).user,null);
  await call(clients[1],'/api/auth',{action:'login',login:`qa_${suffix}_1`,password},401);
  await call(clients[0],'/api/admin',{action:'unblock',id:clients[1].id});
  await call(clients[1],'/api/auth',{action:'login',login:`qa_${suffix}_1`,password});
  await call(clients[0],'/api/admin',{action:'demote',id:clients[0].id},400);
  await call(clients[0],'/api/admin',{action:'promote',id:clients[2].id});
  await call(clients[2],'/api/admin');
  await call(clients[2],'/api/auth',{action:'password',current:password,password:newPassword});
  await call(clients[2],'/api/admin',undefined,403);
  await call(clients[2],'/api/auth',{action:'login',login:`qa_${suffix}_2`,password},401);
  await call(clients[2],'/api/auth',{action:'login',login:`qa_${suffix}_2`,password:newPassword});
  const response=await fetch(BASE+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({action:'logout'})});assert.equal(response.status,403);
  console.log('PASS: registration, admin bootstrap, authentication, group invitation, timezone conversion, availability intersection, master permissions, persistence, booking conflicts, ownership, blocking, roles, password change, CSRF.');
}finally{
  // Remove only the exact generated QA records, from the local development DB.
  const ids=clients.map(c=>c.id).filter(id=>/^[a-f0-9-]{36}$/.test(id));
  let cleanup='';
  if(/^[a-f0-9-]{36}$/.test(campaign))cleanup+=`DELETE FROM availability WHERE campaign_id='${campaign}'; DELETE FROM sessions WHERE campaign_id='${campaign}'; DELETE FROM members WHERE campaign_id='${campaign}'; DELETE FROM campaigns WHERE id='${campaign}';\n`;
  for(const id of ids)cleanup+=`DELETE FROM logins WHERE user_id='${id}'; DELETE FROM users WHERE id='${id}';\n`;
  if(cleanup){fs.mkdirSync('outputs',{recursive:true});const file=path.resolve('outputs/qa-cleanup.sql');fs.writeFileSync(file,cleanup);const result=spawnSync(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config','dist/server/wrangler.json','--persist-to','.wrangler/state','--file',file],{encoding:'utf8'});if(result.status!==0)throw new Error('Local QA cleanup failed: '+result.stderr);console.log('Local QA records removed; first-user admin setup remains available.');}
}
