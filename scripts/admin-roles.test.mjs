import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
import {and,eq,getTableColumns,sql} from 'drizzle-orm';
import {sqliteTable,text,SQLiteSyncDialect} from 'drizzle-orm/sqlite-core';
import {z} from 'zod';
import {campaignRoleValue,parseCampaignRoles} from '../lib/admin-roles.ts';

const campaignId='00000000-0000-4000-8000-000000000001';
const adminId='00000000-0000-4000-8000-000000000002';
const memberId='00000000-0000-4000-8000-000000000003';
const otherMasterId='00000000-0000-4000-8000-000000000004';
const users=sqliteTable('users',{id:text('id').primaryKey(),role:text('role').notNull(),disabled:text('disabled').notNull()});
const campaigns=sqliteTable('campaigns',{id:text('id').primaryKey()});
const members=sqliteTable('members',{campaignId:text('campaign_id').notNull(),userId:text('user_id').notNull(),role:text('role').notNull()});
const dialect=new SQLiteSyncDialect();
const routeSource=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../app/api/admin/route.ts',import.meta.url),'utf8'));

function harness({actorRole='admin',actorDisabled=0,masters=[memberId]}={}){
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, disabled INTEGER NOT NULL); CREATE TABLE campaigns (id TEXT PRIMARY KEY); CREATE TABLE members (campaign_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(campaign_id,user_id));');
  database.prepare('INSERT INTO users (id,role,disabled) VALUES (?,?,?)').run(adminId,actorRole,actorDisabled);
  database.prepare('INSERT INTO campaigns (id) VALUES (?)').run(campaignId);
  const insert=database.prepare('INSERT INTO members (campaign_id,user_id,role) VALUES (?,?,?)');
  insert.run(campaignId,memberId,'master');
  for(const userId of masters.filter(id=>id!==memberId))insert.run(campaignId,userId,'master');

  const db={
    select(selection){
      return {from(table){
        return {where(condition){
          return {get(){
            const columns=getTableColumns(table);
            const keys=selection?Object.keys(selection):Object.keys(columns);
            const projection=sql.join(keys.map(key=>sql`${columns[key]} AS ${sql.raw('"'+key+'"')}`),sql`, `);
            const query=dialect.sqlToQuery(sql`SELECT ${projection} FROM ${table} WHERE ${condition}`);
            return database.prepare(query.sql).get(...query.params);
          }};
        }};
      }};
    },
    run(statement){const query=dialect.sqlToQuery(statement);const result=database.prepare(query.sql).run(...query.params);return {meta:{changes:Number(result.changes)}};},
  };
  let currentActor={id:adminId,role:actorRole};
  const routeExports={};
  const compiled=ts.transpileModule(routeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const roleHelpers={campaignRoleValue,parseCampaignRoles};
  vm.runInNewContext(compiled,{exports:routeExports,require(name){
    if(name==='next/server')return {NextResponse:{json(body,options={}){return {status:options.status??200,body,headers:options.headers};}}};
    if(name==='zod')return {z};
    if(name==='drizzle-orm')return {and,eq,sql};
    if(name==='@/db')return {getDb:()=>db};
    if(name==='@/db/schema')return {users,campaigns,members,availability:{campaignId:'unused'},sessions:{campaignId:'unused'},logins:{userId:'unused'}};
    if(name==='@/lib/auth')return {currentUser:async()=>currentActor};
    if(name==='@/lib/admin-roles')return roleHelpers;
    throw new Error('Unexpected route import: '+name);
  },console:{error(){}}},{filename:'admin-route.cjs'});
  const handler=routeExports.POST;
  return {
    database,
    setActor(value){currentActor=value;},
    roleFor(userId){return database.prepare('SELECT role FROM members WHERE campaign_id=? AND user_id=?').get(campaignId,userId)?.role;},
    async post({userId=memberId,roles,campaign=campaignId}={}){
      return handler({headers:{get:()=>null},nextUrl:{origin:'https://tavern.test'},json:async()=>({action:'setMemberRoles',id:userId,campaignId:campaign,roles})});
    },
  };
}

test('admin role changes accept one or both campaign roles and encode the stored role',()=>{
  assert.deepEqual(parseCampaignRoles(['master']),['master']);
  assert.deepEqual(parseCampaignRoles(['player','master']),['master','player']);
  assert.equal(campaignRoleValue(['master','player']),'master,player');
  assert.equal(campaignRoleValue(['player']),'player');
});

test('admin role changes reject empty, duplicate, or unknown roles',()=>{
  for(const roles of [[],['master','master'],['admin'],['player','guest']])assert.throws(()=>parseCampaignRoles(roles));
});

test('non-admin requests cannot change campaign member roles',async()=>{
  const app=harness({actorRole:'player'});
  const response=await app.post({roles:['player']});
  assert.equal(response.status,403);
  assert.equal(app.roleFor(memberId),'master');
  app.database.close();
});

test('an administrator can assign both roles and the SQLite row stores both',async()=>{
  const app=harness();
  const response=await app.post({roles:['master','player']});
  assert.equal(response.status,200);
  assert.equal(app.roleFor(memberId),'master,player');
  app.database.close();
});

test('the last master cannot be demoted',async()=>{
  const app=harness();
  const response=await app.post({roles:['player']});
  assert.equal(response.status,409);
  assert.equal(app.roleFor(memberId),'master');
  app.database.close();
});

test('a master can be demoted when another master remains',async()=>{
  const app=harness({masters:[memberId,otherMasterId]});
  const response=await app.post({roles:['player']});
  assert.equal(response.status,200);
  assert.equal(app.roleFor(memberId),'player');
  assert.equal(app.roleFor(otherMasterId),'master');
  app.database.close();
});

test('the atomic update rejects an administrator disabled after authentication',async()=>{
  const app=harness({actorDisabled:1,masters:[memberId,otherMasterId]});
  const response=await app.post({roles:['player']});
  assert.equal(response.status,409);
  assert.equal(app.roleFor(memberId),'master');
  app.database.close();
});
