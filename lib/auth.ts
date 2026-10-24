import { cookies } from 'next/headers';
import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { users,logins } from '@/db/schema';
export const COOKIE='tavern_session';
export const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export async function digest(value:string){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
export async function passwordHash(password:string,salt:string){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256));
}
export function randomToken(){return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);}
export function equalHashes(a:string,b:string){let result=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++) result|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return result===0;}
export async function currentUser(){
  const token=(await cookies()).get(COOKIE)?.value;
  if(!token) return null;
  const db=getDb();
  const session=await db.select().from(logins).where(and(eq(logins.tokenHash,await digest(token)),gt(logins.expires,Date.now()))).get();
  if(!session) return null;
  const user=await db.select().from(users).where(eq(users.id,session.userId)).get();
  return user&&!user.disabled?{id:user.id,name:user.name,login:user.login,role:user.role}:null;
}
