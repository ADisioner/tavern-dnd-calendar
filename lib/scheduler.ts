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
export type SuggestedWindow = Interval & { missingIndices: number[] };
export function findSuggestedWindows(groups: Interval[][], duration: number, now = Date.now(), busy: Interval[] = [], onlyAll = false): SuggestedWindow[] {
  if (!groups.length || !Number.isFinite(duration) || duration <= 0) return [];
  if (onlyAll) return findCommonWindows(groups,duration,now,busy).map(w=>({...w,missingIndices:[]}));
  const step=15*60*1000;
  // Each range describes valid session starts for one member, after bookings.
  const ranges=groups.map(group=>findCommonWindows([group],duration,now,busy).map(w=>({
    start:w.start,last:Math.floor((w.end-duration)/step)*step,
  })));
  const boundaries=[...new Set(ranges.flatMap(group=>group.flatMap(r=>[r.start,r.last+step])))].sort((a,b)=>a-b);
  const result: SuggestedWindow[]=[];
  for (let i=0;i<boundaries.length-1;i++) {
    const start=boundaries[i],missingIndices=ranges.flatMap((group,index)=>group.some(r=>r.start<=start&&start<=r.last)?[]:[index]);
    if (missingIndices.length>2 || missingIndices.length===groups.length) continue;
    const end=boundaries[i+1]-step+duration,last=result.at(-1);
    if (last && last.end-duration+step===start && last.missingIndices.join(',')===missingIndices.join(',')) last.end=end;
    else result.push({start,end,missingIndices});
  }
  return result;
}
export function dateKey(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(time);
  const p=(t:string)=>parts.find(x=>x.type===t)!.value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}
export function timeText(time: number, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time);
}
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function utcOffsetMinutes(time: number, timezone: string) {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {timeZone:timezone,timeZoneName:'shortOffset'});
    offsetFormatters.set(timezone, formatter);
  }
  const value = formatter.formatToParts(time).find(part=>part.type==='timeZoneName')!.value;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/.exec(value);
  if (!match) throw new Error('Unsupported timezone offset: '+value);
  return (match[1]==='-'?-1:1)*(Number(match[2]??0)*60+Number(match[3]??0)+Number(match[4]??0)/60);
}
export function moscowOffsetMinutes(time: number, timezone: string) {
  return utcOffsetMinutes(time,timezone)-utcOffsetMinutes(time,'Europe/Moscow');
}
export function moscowOffsetLabel(time: number, timezone: string) {
  const offset=moscowOffsetMinutes(time,timezone),absolute=Math.abs(Math.round(offset*60));
  const minutes=Math.floor(absolute%3600/60),seconds=absolute%60;
  return `${offset<0?'-':'+'}${Math.floor(absolute/3600)}${minutes||seconds?':'+String(minutes).padStart(2,'0'):''}${seconds?':'+String(seconds).padStart(2,'0'):''} МСК`;
}
const timezoneCities: Record<string,string> = {
  'UTC':'Всемирное время','Europe/Moscow':'Москва','Europe/Kaliningrad':'Калининград',
  'Europe/Samara':'Самара','Europe/Saratov':'Саратов','Europe/Astrakhan':'Астрахань',
  'Europe/Ulyanovsk':'Ульяновск','Europe/Kirov':'Киров','Europe/Volgograd':'Волгоград',
  'Europe/Simferopol':'Симферополь','Asia/Yekaterinburg':'Екатеринбург','Asia/Omsk':'Омск',
  'Asia/Novosibirsk':'Новосибирск','Asia/Krasnoyarsk':'Красноярск','Asia/Barnaul':'Барнаул',
  'Asia/Tomsk':'Томск','Asia/Novokuznetsk':'Новокузнецк','Asia/Irkutsk':'Иркутск',
  'Asia/Chita':'Чита','Asia/Yakutsk':'Якутск','Asia/Vladivostok':'Владивосток',
  'Asia/Khabarovsk':'Хабаровск','Asia/Magadan':'Магадан','Asia/Sakhalin':'Сахалин',
  'Asia/Kamchatka':'Камчатка','Asia/Anadyr':'Анадырь','Europe/Minsk':'Минск',
  'Europe/Kyiv':'Киев','Europe/Kiev':'Киев','Europe/Berlin':'Берлин','Europe/London':'Лондон',
  'Europe/Paris':'Париж','Europe/Warsaw':'Варшава','Europe/Prague':'Прага',
  'Europe/Istanbul':'Стамбул','Asia/Tbilisi':'Тбилиси','Asia/Yerevan':'Ереван',
  'Asia/Almaty':'Алматы','Asia/Tashkent':'Ташкент','Asia/Bishkek':'Бишкек',
  'Asia/Dubai':'Дубай','Asia/Jerusalem':'Иерусалим','Asia/Tokyo':'Токио',
  'Asia/Shanghai':'Шанхай','Asia/Bangkok':'Бангкок','Asia/Seoul':'Сеул',
  'Asia/Kathmandu':'Катманду','Asia/Katmandu':'Катманду','Asia/Kolkata':'Калькутта','Asia/Calcutta':'Калькутта',
  'America/New_York':'Нью-Йорк','America/Chicago':'Чикаго','America/Los_Angeles':'Лос-Анджелес',
  'America/Toronto':'Торонто','Australia/Sydney':'Сидней','Pacific/Auckland':'Окленд',
};
export function timezoneLabel(time: number, timezone: string) {
  return `${moscowOffsetLabel(time,timezone)} · ${timezoneCities[timezone]??timezone.split('/').at(-1)!.replaceAll('_',' ')}`;
}
export function intervalTouchesDay(interval: Interval, day: string, timezone: string) {
  return interval.end > interval.start && dateKey(interval.start, timezone) <= day && dateKey(interval.end - 1, timezone) >= day;
}
// Keep the UTC identity of a suggestion when a DST transition repeats a wall time.
// Edited wall times retain the documented earlier-occurrence policy.
export function resolveLocalStart(value: string, timezone: string, preferredInstant: number | null = null) {
  if (preferredInstant !== null && `${dateKey(preferredInstant, timezone)}T${timeText(preferredInstant, timezone)}` === value) return preferredInstant;
  return zonedToUtc(value, timezone);
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
