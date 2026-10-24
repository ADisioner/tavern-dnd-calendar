import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdout.write('Ready for private setup JSON on stdin (input is hidden).\n');
let raw='';
process.stdin.on('data',async chunk=>{
  raw+=chunk.toString();if(!raw.includes('\n')&&!raw.includes('\r'))return;if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();
  try{
    const input=JSON.parse(raw.trim()),origin=new URL(input.url).origin;
    if(origin!=='https://tavern-dnd-calendar.auroraroot21.chatgpt.site')throw new Error('Unexpected destination.');
    const headers={'OAI-Sites-Authorization':`Bearer ${input.bearer}`,'Content-Type':'application/json',Origin:origin};
    const status=await fetch(origin+'/api/auth',{headers,redirect:'error'});
    if(!status.ok)throw new Error(`Auth check failed: ${status.status}`);
    const current=await status.json();
    if(!current.setup){console.log(JSON.stringify({existing_admin:true}));process.exit(0);}
    const password=crypto.randomBytes(24).toString('base64url');
    const r=await fetch(origin+'/api/auth',{method:'POST',headers,redirect:'error',body:JSON.stringify({action:'register',login:'admin',password,name:'Администратор'})});
    if(!r.ok)throw new Error(`Admin setup failed: ${r.status}`);
    const result=await r.json();if(result.user?.role!=='admin')throw new Error('Admin role not established.');
    const dir=path.join(process.env.USERPROFILE,'.codex','private');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'tavern-admin.txt');
    fs.writeFileSync(file,`Таверна — первоначальный аккаунт администратора\n\nСайт: ${origin}\nЛогин: admin\nПароль: ${password}\n\nПосле входа: Ваш аккаунт → Изменить пароль.\nНе отправляйте этот файл игрокам.\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
    console.log(JSON.stringify({created:true,login:'admin',password_file:file}));process.exit(0);
  }catch(e){console.error(e.message);process.exit(1);}
});
