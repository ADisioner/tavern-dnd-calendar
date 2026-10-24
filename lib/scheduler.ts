export type Interval = { start: number; end: number };
export function mergeIntervals(values: Interval[]): Interval[] {
  const sorted = values.filter(v => v.end > v.start).map(v => ({...v})).sort((a,b) => a.start-b.start);
  const result: Interval[] = [];
  for (const item of sorted) {
    const last = result[result.length-1];
    if (last && item.start <= last.end) last.end = Math.max(last.end,item.end);
    else result.push(item);
  }
  return result;
}
export function findCommonWindows(groups: Interval[][], duration: number, now = Date.now(), busy: Interval[] = []): Interval[] {
  if (!groups.length || groups.some(g => !g.length) || duration <= 0) return [];
  let common = mergeIntervals(groups[0]);
  for (const group of groups.slice(1)) {
    const next: Interval[] = [];
    for (const a of common) for (const b of mergeIntervals(group)) {
      const start=Math.max(a.start,b.start,now), end=Math.min(a.end,b.end);
      if (end>start) next.push({start,end});
    }
    common=mergeIntervals(next);
  }
  for (const blocked of mergeIntervals(busy)) {
    common=common.flatMap(v => {
      if (blocked.end<=v.start || blocked.start>=v.end) return [v];
      return [{start:v.start,end:Math.min(v.end,blocked.start)},{start:Math.max(v.start,blocked.end),end:v.end}].filter(x=>x.end>x.start);
    });
  }
  const step=15*60*1000;
  return common.map(v=>({start:Math.ceil(Math.max(now,v.start)/step)*step,end:v.end})).filter(v=>v.end-v.start>=duration);
}
export function dateKey(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(time);
  const p=(t:string)=>parts.find(x=>x.type===t)!.value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}
export function timeText(time: number, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time);
}
// Check offsets on both sides of timezone transitions, including fractional offsets.
// For a repeated DST clock time choose the earlier instant; reject nonexistent times.
export function zonedToUtc(value: string, timezone: string): number | null {
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if(!match) return null;
  const [,y,m,d,h,min]=match.map(Number), wall=Date.UTC(y,m-1,d,h,min);
  const offsets=new Set<number>();
  for(const delta of [-36,-12,0,12,36]) {
    const probe=wall+delta*3600000;
    const key=dateKey(probe,timezone), clock=timeText(probe,timezone);
    offsets.add(Date.parse(`${key}T${clock}:00Z`)-probe);
  }
  const candidates=[...offsets].map(offset=>wall-offset).filter(utc=>`${dateKey(utc,timezone)}T${timeText(utc,timezone)}`===value).sort((a,b)=>a-b);
  return candidates[0]??null;
}
