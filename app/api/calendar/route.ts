import { NextRequest, NextResponse } from 'next/server';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { campaigns, members, availability, sessions } from '@/db/schema';
import { currentUser } from '@/lib/auth';
import { findCommonWindows } from '@/lib/scheduler';
import { hasCampaignRole } from '@/lib/campaign-roles';
export const dynamic = 'force-dynamic';
const zone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Некорректный часовой пояс');
const profile=z.object({name:z.string().trim().min(1).max(50),timezone:zone});
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:NextRequest) {
  try {
    const user=await currentUser();
    if(!user) return json({user:null,campaigns:[],members:[],availability:[],sessions:[]});
    const db=getDb();
    const own=await db.select().from(members).where(eq(members.userId,user.id));
    const all=await db.select().from(campaigns);
    const id=request.nextUrl.searchParams.get('campaign');
    const selected=all.find(c=>c.id===id)??all.find(c=>own.some(m=>m.campaignId===c.id));
    const visible=all.filter(c=>own.some(m=>m.campaignId===c.id)||c.id===id);
    if(!selected) return json({user,campaigns:visible,members:[],availability:[],sessions:[]});
    const roster=await db.select().from(members).where(eq(members.campaignId,selected.id));
    if(!roster.some(m=>m.userId===user.id)) return json({user,campaigns:visible,selected:selected.id,joinRequired:true,members:[],availability:[],sessions:[]});
    const [slots,games]=await Promise.all([db.select().from(availability).where(eq(availability.campaignId,selected.id)),db.select().from(sessions).where(eq(sessions.campaignId,selected.id))]);
    return json({user,campaigns:visible,selected:selected.id,members:roster,availability:slots,sessions:games});
  } catch(error) { console.error('Calendar read failed',error); return json({error:'Не удалось загрузить календарь. Попробуйте ещё раз.'},500); }
}
export async function POST(request:NextRequest) {
  try {
    const origin=request.headers.get('origin');
    if(origin && origin!==request.nextUrl.origin) return json({error:'Недопустимый источник запроса.'},403);
    const user=await currentUser();
    if(!user) return json({error:'Войдите в аккаунт, чтобы участвовать в группе.'},401);
    const data=z.object({action:z.string()}).passthrough().parse(await request.json()); const db=getDb();
    if(data.action==='create') {
      const input=profile.extend({title:z.string().trim().min(1).max(80)}).parse(data);
      const id=crypto.randomUUID();
      await db.batch([db.insert(campaigns).values({id,name:input.title,ownerId:user.id,createdAt:Date.now()}),db.insert(members).values({campaignId:id,userId:user.id,name:input.name,timezone:input.timezone,role:'master'})]);
      return json({campaign:id});
    }
    const campaignId=z.string().uuid().parse(data.campaignId);
    const campaign=await db.select().from(campaigns).where(eq(campaigns.id,campaignId)).get();
    if(!campaign) return json({error:'Кампания не найдена.'},404);
    if(data.action==='join') {
      const input=profile.parse(data);
      await db.insert(members).values({campaignId,userId:user.id,...input,role:'player'}).onConflictDoNothing();
      return json({ok:true});
    }
    const member=await db.select().from(members).where(and(eq(members.campaignId,campaignId),eq(members.userId,user.id))).get();
    if(!member) return json({error:'Сначала присоединитесь к кампании.'},403);
    if(data.action==='setRoles') {
      if(!hasCampaignRole(member,'master'))return json({error:'Менять роли может только ДМ комнаты.'},403);
      const input=z.object({userId:z.string().uuid(),roles:z.array(z.enum(['master','player'])).min(1).max(2).refine(v=>new Set(v).size===v.length)}).parse(data);
      const target=await db.select().from(members).where(and(eq(members.campaignId,campaignId),eq(members.userId,input.userId))).get();
      if(!target)return json({error:'Участник не найден в этой комнате.'},404);
      const role=['master','player'].filter(r=>input.roles.includes(r as 'master'|'player')).join(',');
      // Recheck authorization and the last-DM invariant in the same atomic write.
      const result=await db.run(sql`UPDATE members SET role=${role} WHERE campaign_id=${campaignId} AND user_id=${input.userId}
        AND EXISTS (SELECT 1 FROM members actor WHERE actor.campaign_id=${campaignId} AND actor.user_id=${user.id} AND actor.role IN ('master','master,player'))
        AND (${input.roles.includes('master')?1:0} OR EXISTS (SELECT 1 FROM members other WHERE other.campaign_id=${campaignId} AND other.user_id<>${input.userId} AND other.role IN ('master','master,player')))`);
      if(!result.meta.changes)return json({error:'В комнате должен остаться хотя бы один ДМ. Обновите состав группы.'},409);
    } else if(data.action==='removeMember') {
      const targetId=z.string().uuid().parse(data.userId);
      if(!hasCampaignRole(member,'master') && targetId!==user.id)return json({error:'Убирать других участников может только ДМ.'},403);
      if(targetId===campaign.ownerId)return json({error:'Создатель не может покинуть собственную кампанию.'},400);
      const result=await db.run(sql`DELETE FROM members WHERE campaign_id=${campaignId} AND user_id=${targetId}
        AND EXISTS (SELECT 1 FROM members actor WHERE actor.campaign_id=${campaignId} AND actor.user_id=${user.id} AND (actor.user_id=${targetId} OR actor.role IN ('master','master,player')))
        AND (role='player' OR EXISTS (SELECT 1 FROM members other WHERE other.campaign_id=${campaignId} AND other.user_id<>${targetId} AND other.role IN ('master','master,player')))`);
      if(!result.meta.changes)return json({error:'Участник уже удалён или это последний ДМ комнаты.'},409);
      await db.delete(availability).where(and(eq(availability.campaignId,campaignId),eq(availability.userId,targetId)));
    } else if(data.action==='profile') {
      await db.update(members).set(profile.parse(data)).where(and(eq(members.campaignId,campaignId),eq(members.userId,user.id)));
    } else if(data.action==='availability') {
      const slot=z.object({start:z.number().int(),end:z.number().int()}).parse(data);
      if(slot.start<Date.now()-60000 || slot.end<=slot.start || slot.end-slot.start>7*86400000 || slot.end>Date.now()+180*86400000) return json({error:'Выберите будущий промежуток до 7 дней в ближайшие 6 месяцев.'},400);
      await db.insert(availability).values({id:crypto.randomUUID(),campaignId,userId:user.id,...slot});
    } else if(data.action==='removeAvailability') {
      await db.delete(availability).where(and(eq(availability.id,z.string().uuid().parse(data.id)),eq(availability.campaignId,campaignId),eq(availability.userId,user.id)));
    } else if(data.action==='schedule') {
      if(!hasCampaignRole(member,'master')) return json({error:'Сессию назначает ДМ комнаты.'},403);
      const game=z.object({title:z.string().trim().min(1).max(100),start:z.number().int(),duration:z.number().min(1).max(8),notes:z.string().max(2000).default('')}).parse(data);
      const duration=game.duration*3600000,end=game.start+duration;
      const [roster,slots,games]=await Promise.all([db.select().from(members).where(eq(members.campaignId,campaignId)),db.select().from(availability).where(eq(availability.campaignId,campaignId)),db.select().from(sessions).where(eq(sessions.campaignId,campaignId))]);
      const windows=findCommonWindows(roster.map(m=>slots.filter(s=>s.userId===m.userId)),duration,Date.now(),games);
      if(!windows.some(w=>game.start>=w.start && end<=w.end)) return json({error:'Это время уже недоступно всем участникам. Обновите варианты.'},409);
      const result=await db.run(sql`INSERT INTO sessions (id,campaign_id,title,start,end,notes) SELECT ${crypto.randomUUID()},${campaignId},${game.title},${game.start},${end},${game.notes} WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE campaign_id=${campaignId} AND start<${end} AND end>${game.start})`);
      if(!result.meta.changes) return json({error:'В это время уже назначена сессия.'},409);
    } else if(data.action==='cancel') {
      if(!hasCampaignRole(member,'master')) return json({error:'Отменить сессию может только ДМ.'},403);
      await db.delete(sessions).where(and(eq(sessions.id,z.string().uuid().parse(data.id)),eq(sessions.campaignId,campaignId)));
    } else return json({error:'Неизвестное действие.'},400);
    return json({ok:true});
  } catch(error) {
    if(error instanceof z.ZodError) return json({error:'Проверьте поля: '+error.issues.map(i=>i.path.join('.')).join(', ')},400);
    console.error('Calendar write failed',error); return json({error:'Не удалось сохранить изменения. Попробуйте ещё раз.'},500);
  }
}


