import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const base = 'http://127.0.0.1:5173', fixturePath = 'outputs/invite-qa.json';
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
  const client = { login: 'qa_invite_' + randomBytes(6).toString('hex'), password: randomBytes(12).toString('base64url'), cookie: '', id: '' };
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
    fs.mkdirSync('outputs', { recursive: true }); const filename = path.resolve('outputs/invite-qa-cleanup.sql'); fs.writeFileSync(filename, sql);
    const result = spawnSync(process.execPath, ['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config','dist/server/wrangler.json','--persist-to','.wrangler/state','--file',filename], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
}
if (process.argv.includes('--cleanup')) {
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); clients.push(...saved.clients); campaignIds.push(...saved.campaignIds); cleanup();
  console.log('Exact invitation QA records removed.');
} else {
  assert.equal(fs.existsSync(fixturePath), false, 'Finish the previous invitation QA fixture first.');
  let passed = false;
  try {
    const master = fresh(), invited = fresh(), ordinary = fresh(), invalid = fresh();
    await api(master, '/api/auth', { action: 'register', login: master.login, password: master.password, name: 'Invite QA master' });
    const campaign = (await api(master, '/api/calendar', { action: 'create', title: 'Invite QA room', name: 'Existing master name', timezone: 'Europe/Moscow' })).campaign;
    campaignIds.push(campaign);
    const registered = await api(invited, '/api/auth', { action: 'register', login: invited.login, password: invited.password, name: 'Invited player', campaignId: campaign, timezone: 'Asia/Yekaterinburg' });
    assert.equal(registered.campaignId, campaign);
    const calendar = await api(invited, '/api/calendar?campaign=' + campaign);
    assert.equal(calendar.selected, campaign); assert.equal(calendar.joinRequired, undefined);
    assert.deepEqual(calendar.members.find(member => member.userId === invited.id), { campaignId: campaign, userId: invited.id, name: 'Invited player', timezone: 'Asia/Yekaterinburg', role: 'player' });
    assert.equal((await api(invited, '/api/table?campaign=' + campaign)).actor.role, 'player');
    await api(master, '/api/auth', { action: 'login', login: master.login, password: master.password, campaignId: campaign, timezone: 'UTC' });
    const roster = (await api(master, '/api/calendar?campaign=' + campaign)).members;
    assert.equal(roster.find(member => member.userId === master.id).role, 'master');
    assert.equal(roster.find(member => member.userId === master.id).name, 'Existing master name');
    assert.equal(roster.find(member => member.userId === master.id).timezone, 'Europe/Moscow');
    await api(ordinary, '/api/auth', { action: 'register', login: ordinary.login, password: ordinary.password });
    assert.equal((await api(ordinary, '/api/calendar?campaign=' + campaign)).joinRequired, true);
    await api(ordinary, '/api/auth', { action: 'login', login: ordinary.login, password: ordinary.password, campaignId: campaign, timezone: 'Europe/Berlin' });
    assert.equal((await api(ordinary, '/api/calendar?campaign=' + campaign)).joinRequired, undefined);
    const missing = crypto.randomUUID();
    await api(invalid, '/api/auth', { action: 'register', login: invalid.login, password: invalid.password, campaignId: missing }, 404);
    assert.equal(invalid.cookie, '');
    await api(invalid, '/api/auth', { action: 'register', login: invalid.login, password: invalid.password, campaignId: campaign, timezone: 'invalid/zone' }, 400);
    await api(invalid, '/api/auth', { action: 'register', login: invalid.login, password: invalid.password });
    const before = await api(invalid, '/api/calendar?campaign=' + campaign); assert.equal(before.joinRequired, true);
    await api(invalid, '/api/auth', { action: 'login', login: invalid.login, password: 'incorrect-password', campaignId: campaign }, 401);
    assert.equal((await api(invalid, '/api/calendar?campaign=' + campaign)).joinRequired, true);
    passed = true;
    console.log('PASS: invite registration immediately grants calendar/table access, stores player name/timezone, login joins existing accounts, repeated owner login preserves role/profile; absent/missing/invalid invitations and wrong passwords grant no membership.');
  } finally {
    if (passed && process.env.INVITE_KEEP_QA === '1') {
      fs.mkdirSync('outputs', { recursive: true }); fs.writeFileSync(fixturePath, JSON.stringify({ clients, campaignIds }));
      console.log('Ignored local browser QA fixture retained; run --cleanup when finished.');
    } else cleanup();
  }
}
