import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {eq,and,sql} from 'drizzle-orm';
import {getDb} from '@/db';
import {users,campaigns,members,availability,sessions,logins} from '@/db/schema';
import {currentUser} from '@/lib/auth';
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(){
  try{const user=await currentUser();if(user?.role!=='admin')return reply({error:'Требуются права администратора.'},403);
    const db=getDb();return reply({users:await db.select({id:users.id,login:users.login,name:users.name,role:users.role,disabled:users.disabled,createdAt:users.createdAt}).from(users),campaigns:await db.select().from(campaigns),members:await db.select().from(members),sessionCount:(await db.select({count:sql<number>`count(*)`}).from(sessions).get())?.count??0});
  }catch(e){console.error(e);return reply({error:'Не удалось загрузить панель.'},500);}
}
export async function POST(request:NextRequest){
  try{if(request.headers.get('origin')&&request.headers.get('origin')!==request.nextUrl.origin)return reply({error:'Недопустимый запрос.'},403);
    const user=await currentUser();if(user?.role!=='admin')return reply({error:'Требуются права администратора.'},403);
    const data=z.object({action:z.string(),id:z.string().uuid()}).parse(await request.json()),db=getDb();
    if(typeof data.id!=='string')return reply({error:'Не указан объект.'},400);
    if(['block','unblock','promote','demote'].includes(data.action)){
      if(data.id===user.id)return reply({error:'Нельзя изменить собственные права или заблокировать себя.'},400);
      const target=await db.select().from(users).where(eq(users.id,data.id)).get();if(!target)return reply({error:'Пользователь не найден.'},404);
      const actorStillAdmin=sql`EXISTS (SELECT 1 FROM users AS actor WHERE actor.id=${user.id} AND actor.role='admin' AND actor.disabled=0)`;
      const result=data.action==='block'||data.action==='unblock'
        ?await db.update(users).set({disabled:data.action==='block'?1:0}).where(and(eq(users.id,data.id),actorStillAdmin)).run()
        :await db.update(users).set({role:data.action==='promote'?'admin':'player'}).where(and(eq(users.id,data.id),actorStillAdmin)).run();
      if(!result.meta.changes)return reply({error:'Права изменились. Обновите страницу.'},403);
      if(data.action==='block')await db.delete(logins).where(eq(logins.userId,data.id));
    }else if(data.action==='deleteCampaign'){
      await db.batch([db.delete(availability).where(eq(availability.campaignId,data.id)),db.delete(sessions).where(eq(sessions.campaignId,data.id)),db.delete(members).where(eq(members.campaignId,data.id)),db.delete(campaigns).where(eq(campaigns.id,data.id))]);
    }else return reply({error:'Неизвестное действие.'},400);
    return reply({ok:true});
  }catch(e){console.error(e);return reply({error:'Изменения не сохранены.'},500);}
}

