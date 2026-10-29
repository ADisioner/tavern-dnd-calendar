import test from 'node:test';
import assert from 'node:assert/strict';
import {findCommonWindows,mergeIntervals,zonedToUtc,timeText,dateKey} from '../lib/scheduler.ts';
const H=3600000;
test('Near matches are chronological, include missing master, and strict mode excludes them',async()=>{
  const scheduler=await import('../lib/scheduler.ts');
  assert.equal(typeof scheduler.findSuggestedWindows,'function');
  const groups=[[{start:10*H,end:20*H}],[{start:12*H,end:20*H}],[],[{start:14*H,end:20*H}]];
  const windows=scheduler.findSuggestedWindows(groups,2*H,0);
  assert.equal(windows[0].start,12*H);
  assert.deepEqual(windows[0].missingIndices,[2,3]);
  assert.equal(windows.find(w=>w.start===14*H).missingIndices.length,1);
  assert.deepEqual(scheduler.findSuggestedWindows(groups,2*H,0,[],true),[]);
});
test('Near matches require full-duration attendance, merge touching slots and exclude bookings',async()=>{
  const {findSuggestedWindows}=await import('../lib/scheduler.ts');
  assert.equal(typeof findSuggestedWindows,'function');
  const groups=[[{start:0,end:2*H},{start:2*H,end:8*H}],[{start:2*H,end:4*H}],[],[]];
  const windows=findSuggestedWindows(groups,2*H,H+1,[{start:4*H,end:6*H}]);
  assert.deepEqual(windows,[{start:2*H,end:4*H,missingIndices:[2,3]}]);
  assert.deepEqual(findSuggestedWindows([[],[]],H,0),[]);
  assert.deepEqual(findSuggestedWindows([],H,0),[]);
  assert.deepEqual(findSuggestedWindows(groups,0,0),[]);
});
test('Strict suggestions retain all members and quarter-hour rounding',async()=>{
  const {findSuggestedWindows}=await import('../lib/scheduler.ts');
  assert.equal(typeof findSuggestedWindows,'function');
  assert.deepEqual(findSuggestedWindows([[{start:0,end:4*H}],[{start:0,end:4*H}]],2*H,H+1,[],true),[{start:1.25*H,end:4*H,missingIndices:[]}]);
});
test('Same instant is 10:00 in Moscow and 12:00 in Yekaterinburg',()=>{
  const a=zonedToUtc('2026-11-01T10:00','Europe/Moscow');
  const b=zonedToUtc('2026-11-01T12:00','Asia/Yekaterinburg');
  assert.equal(a,b);assert.equal(new Date(a).toISOString(),'2026-11-01T07:00:00.000Z');
  assert.equal(timeText(a,'Europe/Moscow'),'10:00');assert.equal(timeText(a,'Asia/Yekaterinburg'),'12:00');
});
test('Master participates and missing member blocks suggestions',()=>{
  assert.deepEqual(findCommonWindows([[{start:10*H,end:18*H}],[{start:12*H,end:17*H}],[{start:14*H,end:16*H}]],3*H,0),[]);
  assert.deepEqual(findCommonWindows([[{start:10*H,end:18*H}],[]],H,0),[]);
});
test('Combines touching and overlapping slots before intersection',()=>{
  assert.deepEqual(mergeIntervals([{start:0,end:2*H},{start:H,end:3*H},{start:3*H,end:4*H}]),[{start:0,end:4*H}]);
  assert.deepEqual(findCommonWindows([[{start:0,end:2*H},{start:2*H,end:4*H}],[{start:H,end:5*H}]],3*H,0),[{start:H,end:4*H}]);
});
test('Excludes booked sessions, rounds to next quarter hour and clips past',()=>{
  assert.deepEqual(findCommonWindows([[{start:0,end:12*H}]],2*H,H+1,[{start:5*H,end:8*H}]),[{start:1.25*H,end:5*H},{start:8*H,end:12*H}]);
});
test('Exact-length overlap works, too short does not',()=>{
  assert.equal(findCommonWindows([[{start:0,end:3*H}],[{start:0,end:3*H}]],3*H,0).length,1);
  assert.equal(findCommonWindows([[{start:0,end:3*H-1}]],3*H,0).length,0);
});
test('DST nonexistent and repeated times, fractional offsets, invalid dates',()=>{
  assert.equal(zonedToUtc('2026-03-29T02:30','Europe/Berlin'),null);
  assert.equal(new Date(zonedToUtc('2026-10-25T02:30','Europe/Berlin')).toISOString(),'2026-10-25T00:30:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-01T10:00','Asia/Kathmandu')).toISOString(),'2026-11-01T04:15:00.000Z');
  assert.equal(zonedToUtc('2026-02-30T12:00','UTC'),null);
});
test('Local dates cross midnight without changing the instant',()=>{
  const t=Date.parse('2026-11-01T22:00:00Z');assert.equal(dateKey(t,'Europe/Moscow'),'2026-11-02');assert.equal(dateKey(t,'America/New_York'),'2026-11-01');
});
