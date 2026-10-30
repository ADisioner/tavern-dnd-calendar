import test from 'node:test';
import assert from 'node:assert/strict';
import {findCommonWindows,resolveLocalStart,intervalTouchesDay,dateKey,timeText} from '../lib/scheduler.ts';
const H=3600000;
test('Selecting a suggested window retains the second occurrence of a repeated DST time',()=>{
  const zone='America/New_York',now=Date.parse('2026-10-28T00:00:00Z'),start=Date.parse('2026-11-01T06:00:00Z');
  const [window]=findCommonWindows([[{start,end:start+3*H}]],H,now);
  const value=`${dateKey(window.start,zone)}T${timeText(window.start,zone)}`;
  const submitted=resolveLocalStart(value,zone,window.start);
  assert.equal(submitted,start);
  assert.ok(submitted>=window.start&&submitted+H<=window.end);
  assert.equal(resolveLocalStart('2026-11-01T02:00',zone,window.start),Date.parse('2026-11-01T07:00:00Z'));
  assert.equal(resolveLocalStart(value,zone),Date.parse('2026-11-01T05:00:00Z'));
});
test('A session appears on every local date it occupies, excluding its end boundary',()=>{
  const game={start:Date.parse('2026-11-01T18:00:00Z'),end:Date.parse('2026-11-01T22:00:00Z')};
  assert.equal(intervalTouchesDay(game,'2026-11-01','Asia/Yekaterinburg'),true);
  assert.equal(intervalTouchesDay(game,'2026-11-02','Asia/Yekaterinburg'),true);
  assert.equal(intervalTouchesDay(game,'2026-11-03','Asia/Yekaterinburg'),false);
  assert.equal(intervalTouchesDay({...game,end:Date.parse('2026-11-01T19:00:00Z')},'2026-11-02','Asia/Yekaterinburg'),false);
  assert.equal(intervalTouchesDay(game,'2026-11-02','America/New_York'),false);
});

test('Timezone labels use Moscow as their zero and follow the event date',async()=>{
  const {moscowOffsetLabel,timezoneLabel}=await import('../lib/scheduler.ts');
  const winter=Date.parse('2026-11-01T12:00:00Z'),summer=Date.parse('2026-07-01T12:00:00Z');
  assert.equal(moscowOffsetLabel(winter,'Europe/Moscow'),'+0 МСК');
  assert.equal(timezoneLabel(winter,'Asia/Yekaterinburg'),'+2 МСК · Екатеринбург');
  assert.equal(moscowOffsetLabel(winter,'Europe/Berlin'),'-2 МСК');
  assert.equal(moscowOffsetLabel(summer,'Europe/Berlin'),'-1 МСК');
  assert.equal(moscowOffsetLabel(winter,'Asia/Kathmandu'),'+2:45 МСК');
  assert.equal(moscowOffsetLabel(Date.parse('2026-11-01T05:00:00Z'),'America/New_York'),'-7 МСК');
  assert.equal(moscowOffsetLabel(Date.parse('2026-11-01T06:00:00Z'),'America/New_York'),'-8 МСК');
});

test('Initial SSR timestamps and historical second offsets never crash timezone labels',async()=>{
  const {timezoneLabel,moscowOffsetLabel}=await import('../lib/scheduler.ts');
  for(const zone of Intl.supportedValuesOf('timeZone'))assert.ok(timezoneLabel(0,zone).includes('МСК'));
  assert.equal(moscowOffsetLabel(0,'Africa/Monrovia'),'-3:44:30 МСК');
});
