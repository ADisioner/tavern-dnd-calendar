import {NextRequest,NextResponse} from 'next/server';
import {cookies} from 'next/headers';
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '@/db';
import {users,logins,authLimits} from '@/db/schema';
import {COOKIE,currentUser,digest,passwordHash,randomToken,equalHashes} from '@/lib/auth';
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(){
  try {const db=getDb();const count=await db.select({count:sql<number>`count(*)`}).from(users).get();return reply({user:await currentUser(),setup:count?.count===0});}
  catch(e){console.error('Auth read',e);return reply({error:'Не удалось подключиться к базе данных.'},500);}
}
export async function POST(request:NextRequest){
  try{
    if(request.headers.get('origin') && request.headers.get('origin')!==request.nextUrl.origin)return reply({error:'Недопустимый запрос.'},403);
    const data=z.object({action:z.string()}).passthrough().parse(await request.json()),db=getDb();
    if(data.action==='logout'){
      const jar=await cookies(),token=jar.get(COOKIE)?.value;
      if(token)await db.delete(logins).where(eq(logins.tokenHash,await digest(token)));
      jar.delete(COOKIE);return reply({ok:true});
    }
    if(data.action==='password'){
      const user=await currentUser();if(!user)return reply({error:'Войдите в аккаунт.'},401);
      const now=Date.now(),key=await digest('password-change:'+user.id);
      const limit=await db.insert(authLimits).values({key,count:1,expires:now+900000}).onConflictDoUpdate({target:authLimits.key,set:{count:sql`CASE WHEN expires<${now} THEN 1 ELSE count+1 END`,expires:sql`CASE WHEN expires<${now} THEN ${now+900000} ELSE expires END`}}).returning().get();
      if(limit.count>10)return reply({error:'Слишком много попыток. Попробуйте через 15 минут.'},429);
      const input=z.object({current:z.string().max(128),password:z.string().min(4).max(128)}).parse(data);
      const record=(await db.select().from(users).where(eq(users.id,user.id)).get())!;
      if(!equalHashes(record.passwordHash,await passwordHash(input.current,record.salt)))return reply({error:'Текущий пароль неверен.'},400);
      const salt=randomToken();await db.update(users).set({salt,passwordHash:await passwordHash(input.password,salt)}).where(eq(users.id,user.id));
      await db.delete(logins).where(eq(logins.userId,user.id));(await cookies()).delete(COOKIE);return reply({ok:true});
    }
    if(!['register','login'].includes(data.action))return reply({error:'Неизвестное действие.'},400);
    const input=z.object({login:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),password:z.string().min(4).max(128)}).parse(data);
    const registrationName=data.action==='register'?z.string().trim().max(50).nullish().parse(data.name):undefined;
    const login=input.login.toLocaleLowerCase('ru-RU');
    const now=Date.now(),key=await digest((request.headers.get('cf-connecting-ip')??'local')+':auth');
    const limit=await db.insert(authLimits).values({key,count:1,expires:now+900000}).onConflictDoUpdate({target:authLimits.key,set:{count:sql`CASE WHEN expires<${now} THEN 1 ELSE count+1 END`,expires:sql`CASE WHEN expires<${now} THEN ${now+900000} ELSE expires END`}}).returning().get();
    if(limit.count>30)return reply({error:'Слишком много попыток. Попробуйте через 15 минут.'},429);
    let record=await db.select().from(users).where(eq(users.login,login)).get();
    if(data.action==='register'){
      if(record)return reply({error:'Этот логин уже занят.'},409);
      const salt=randomToken(),hash=await passwordHash(input.password,salt),id=crypto.randomUUID();
      // A single database statement assigns the initial admin without a signup race.
      await db.run(sql`INSERT INTO users (id,login,name,password_hash,salt,role,disabled,created_at) SELECT ${id},${login},${registrationName||input.login},${hash},${salt},CASE WHEN (SELECT COUNT(*) FROM users)=0 THEN 'admin' ELSE 'player' END,0,${now}`);
      record=await db.select().from(users).where(eq(users.id,id)).get();
    }else{
      const hash=await passwordHash(input.password,record?.salt??'no-such-user-salt');
      if(!record||record.disabled||!equalHashes(hash,record.passwordHash))return reply({error:'Неверный логин или пароль.'},401);
    }
    if(!record)return reply({error:'Не удалось создать аккаунт.'},500);
    const token=randomToken(),expires=now+30*86400000;
    await db.insert(logins).values({tokenHash:await digest(token),userId:record.id,expires});
    (await cookies()).set(COOKIE,token,{httpOnly:true,secure:request.nextUrl.protocol==='https:',sameSite:'lax',path:'/',expires:new Date(expires)});
    return reply({user:{id:record.id,name:record.name,login:record.login,role:record.role}});
  }catch(e){if(e instanceof z.ZodError)return reply({error:'Логин: 3–32 буквы, цифры, _ или -. Пароль: 4–128 символов.'},400);console.error('Auth write',e);return reply({error:'Не удалось выполнить действие. Попробуйте ещё раз.'},500);}
}

