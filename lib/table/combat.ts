import { z } from 'zod';
import { CONDITION_IDS } from './conditions.ts';
import { randomDie } from './dice.ts';
export const effectSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(80),rounds:z.number().int().min(1).max(100).nullable(),condition:z.enum(CONDITION_IDS).optional()}).strict();
export const participantSchema=z.object({id:z.string().uuid(),tokenId:z.string().uuid(),roll:z.number().int().min(1).max(20).nullable(),total:z.number().int().nullable(),tieOrder:z.number().int().nonnegative(),tieRoll:z.number().int().min(1).max(20).nullable()}).strict();
export const combatSchema=z.object({entries:z.array(participantSchema).max(150),running:z.boolean(),round:z.number().int().min(0).max(100000),currentId:z.string().uuid().nullable(),tiePolicy:z.enum(['manual','reroll']),lastAttack:z.object({attackerName:z.string().max(80),targetName:z.string().max(80),attackFormula:z.string().max(160),attackTotal:z.number().int(),hit:z.boolean(),damageFormula:z.string().max(160).optional(),damageTotal:z.number().int().optional()}).nullable().optional()}).strict();
export const emptyCombat=()=>({entries:[],running:false,round:0,currentId:null,tiePolicy:'manual' as const,lastAttack:null});
export const combatTokenFields={hp:z.number().int().min(0).max(1000000).optional(),tempHp:z.number().int().min(0).max(1000000).optional(),maxHp:z.number().int().min(1).max(1000000).optional(),ac:z.number().int().min(0).max(60).optional(),initiativeMod:z.number().int().min(-20).max(40).optional(),shareStats:z.boolean().optional(),hideStats:z.boolean().optional(),initiativeGroup:z.string().trim().max(40).optional(),effects:z.array(effectSchema).max(20).optional()};
const envelope=z.object({id:z.string().uuid(),sceneId:z.string().uuid().optional(),baseRevision:z.number().int().nonnegative()});
export const combatCommandSchema=z.discriminatedUnion('type',[
  envelope.extend({type:z.literal('combat-add'),tokenId:z.string().uuid()}).strict(),
  envelope.extend({type:z.literal('combat-remove'),participantId:z.string().uuid()}).strict(),
  envelope.extend({type:z.literal('combat-roll'),participantId:z.string().uuid().optional()}).strict(),
  envelope.extend({type:z.literal('combat-start')}).strict(),envelope.extend({type:z.literal('combat-next')}).strict(),envelope.extend({type:z.literal('combat-end')}).strict(),
  envelope.extend({type:z.literal('combat-policy'),policy:z.literal('manual')}).strict(),
  envelope.extend({type:z.literal('combat-order'),participantIds:z.array(z.string().uuid()).max(150)}).strict(),
  envelope.extend({type:z.literal('combat-adjust'),tokenId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),operation:z.enum(['damage','heal']),amount:z.number().int().min(1).max(1000000)}).strict(),
  envelope.extend({type:z.literal('vitals'),tokenId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),hp:z.number().int().min(0).max(1000000),tempHp:z.number().int().min(0).max(1000000).optional(),maxHp:z.number().int().min(1).max(1000000),ac:z.number().int().min(0).max(60),initiativeMod:z.number().int().min(-20).max(40),hidden:z.boolean(),shareStats:z.boolean(),hideStats:z.boolean().optional(),initiativeGroup:z.string().trim().max(40)}).strict(),
  envelope.extend({type:z.literal('effect-add'),tokenId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),effect:effectSchema}).strict(),
  envelope.extend({type:z.literal('effect-remove'),tokenId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),effectId:z.string().uuid()}).strict(),
]);
export type CombatState=z.infer<typeof combatSchema>;
export type CombatCommand=z.infer<typeof combatCommandSchema>;
type CombatToken={id:string;name?:string;ownerId:string|null;version?:number;hp?:number;tempHp?:number;maxHp?:number;ac?:number;initiativeMod?:number;hidden?:boolean;shareStats?:boolean;hideStats?:boolean;initiativeGroup?:string;statuses?:string[];effects?:z.infer<typeof effectSchema>[]};
type Scene={tokens:CombatToken[];combat:CombatState};
export function excludeAtZeroHp(token:CombatToken,roster?:{userId:string;role:string}[]){return token.hp===0&&(!token.ownerId||!!roster?.some(member=>member.userId===token.ownerId&&member.role==='master'));}
class CombatError extends Error {code:string;constructor(code:string,message:string){super(message);this.code=code;}}
export function sortInitiative<T extends {id:string;total:number|null;tieOrder:number;tieRoll?:number|null}>(entries:T[],policy:string='manual'):T[]{return [...entries].sort((a,b)=>(b.total??-Infinity)-(a.total??-Infinity)||a.tieOrder-b.tieOrder||a.id.localeCompare(b.id));}
export function reconcileCombat<T extends Scene>(previous:T,next:T,roster?:{userId:string;role:string}[]):T{
  const state=next.combat??emptyCombat(),entries=state.entries.filter(e=>next.tokens.some(t=>t.id===e.tokenId&&!excludeAtZeroHp(t,roster)));
  let currentId=state.currentId,round=state.round;
  if(currentId&&!entries.some(e=>e.id===currentId)){
    const old=sortInitiative(previous.combat.entries,previous.combat.tiePolicy),index=old.findIndex(e=>e.id===currentId),following=old.slice(index+1).find(e=>entries.some(value=>value.id===e.id));
    currentId=following?.id??sortInitiative(entries,state.tiePolicy)[0]?.id??null;if(!following&&currentId&&state.running){round++;}
  }
  return{...next,combat:entries.length?{...state,entries,currentId,round}:{...emptyCombat(),tiePolicy:state.tiePolicy}};
}
export function applyCombat<T extends Scene>(scene:T,command:CombatCommand,actor:{userId:string;role:string},random=randomDie,roster?:{userId:string;role:string}[]):T{
  const next={...scene,tokens:scene.tokens.map(t=>({...t,statuses:[...(t.statuses??[])],effects:(t.effects??[]).map(e=>({...e}))})),combat:{...(scene.combat??emptyCombat()),entries:(scene.combat?.entries??[]).map(e=>({...e}))}};
  const state=next.combat,gm=actor.role==='master';
  if(['vitals','effect-add','effect-remove','combat-adjust'].includes(command.type)){
    const input=command as Extract<CombatCommand,{tokenId:string;expectedVersion:number}>,token=next.tokens.find(t=>t.id===input.tokenId);
    if(!token||!gm&&(token.ownerId!==actor.userId||token.hideStats))throw new CombatError('forbidden','Нет доступа к характеристикам.');
    if((token.version??0)!==input.expectedVersion)throw new CombatError('conflict','Характеристики изменились.');
    token.effects??=[];token.statuses??=[];
    if(input.type==='vitals'){
      if(input.hp>input.maxHp)throw new CombatError('invalid','HP не могут превышать максимум.');
      if(!gm&&(input.hidden!==!!token.hidden||input.shareStats!==!!token.shareStats||!!input.hideStats!==!!token.hideStats||input.initiativeGroup!==(token.initiativeGroup??'')))throw new CombatError('forbidden','Видимостью NPC и группами управляет ГМ.');
      Object.assign(token,{hp:input.hp,...(input.tempHp!==undefined?{tempHp:input.tempHp}:{}),maxHp:input.maxHp,ac:input.ac,initiativeMod:input.initiativeMod,...(gm?{hidden:input.hidden,shareStats:input.shareStats,hideStats:!!input.hideStats,initiativeGroup:input.initiativeGroup}:{})});
    }else if(input.type==='combat-adjust'){
      const maxHp=token.maxHp??10;let hp=Math.min(maxHp,token.hp??maxHp),tempHp=token.tempHp??0;
      if(input.operation==='heal')hp=Math.min(maxHp,hp+input.amount);
      else{const absorbed=Math.min(tempHp,input.amount);tempHp-=absorbed;hp=Math.max(0,hp-(input.amount-absorbed));}
      Object.assign(token,{hp,tempHp,maxHp});
    }else if(input.type==='effect-add'){
      if(token.effects.length>=20||token.effects.some(e=>e.id===input.effect.id))throw new CombatError('limit','До 20 уникальных эффектов на токене.');token.effects.push(input.effect);
    }else if(input.type==='effect-remove'){
      token.effects=token.effects.filter(e=>e.id!==input.effectId);
    }
    token.version=(token.version??0)+1;
    return reconcileCombat(scene,next as T,roster);
  }
  if(!gm&&command.type!=='combat-roll')throw new CombatError('forbidden','Боем управляет мастер.');
  if(command.type==='combat-add'){
    if(!next.tokens.some(t=>t.id===command.tokenId&&!excludeAtZeroHp(t,roster)))throw new CombatError('missing','Токен не найден.');
    if(state.entries.some(e=>e.tokenId===command.tokenId))throw new CombatError('conflict','Токен уже участвует в бою.');
    state.entries.push({id:command.id,tokenId:command.tokenId,roll:null,total:null,tieOrder:Math.max(-1,...state.entries.map(e=>e.tieOrder))+1,tieRoll:null});
  }else if(command.type==='combat-remove'){
    state.entries=state.entries.filter(e=>e.id!==command.participantId);
  }else if(command.type==='combat-roll'){
    if(!gm&&!command.participantId)throw new CombatError('forbidden','Выберите своего участника.');
    const selected=command.participantId?state.entries.filter(e=>e.id===command.participantId):state.entries;
    if(!selected.length)throw new CombatError(gm?'missing':'forbidden','Нет доступа к участнику.');
    const groups=new Map<string,number>();
    for(const entry of selected){const token=next.tokens.find(t=>t.id===entry.tokenId)!;
      if(!gm&&(token.ownerId!==actor.userId||token.hideStats||entry.roll!==null))throw new CombatError('forbidden','За своего участника можно бросить один раз.');
      const group=gm&&token.initiativeGroup?token.initiativeGroup:entry.id;let roll=groups.get(group);if(roll===undefined){roll=random(20);groups.set(group,roll);}entry.roll=roll;entry.total=roll+(token.initiativeMod??0);
    }
  }else if(command.type==='combat-policy')state.tiePolicy=command.policy;
  else if(command.type==='combat-order'){
    if(command.participantIds.length!==state.entries.length||new Set(command.participantIds).size!==state.entries.length||state.entries.some(e=>!command.participantIds.includes(e.id)))throw new CombatError('invalid','Укажите порядок всех участников.');
    state.entries=state.entries.map(e=>({...e,tieOrder:command.participantIds.indexOf(e.id)}));
  }else if(command.type==='combat-start'){
    if(!state.entries.length||state.entries.some(e=>e.total===null))throw new CombatError('invalid','Сначала бросьте инициативу всех участников.');
    state.running=true;state.round=1;state.currentId=sortInitiative(state.entries,state.tiePolicy)[0].id;
  }else if(command.type==='combat-next'){
    if(!state.running||!state.entries.length)throw new CombatError('invalid','Бой ещё не начат.');
    const order=sortInitiative(state.entries,state.tiePolicy),index=order.findIndex(e=>e.id===state.currentId),nextIndex=(index+1)%order.length;
    state.currentId=order[nextIndex].id;if(nextIndex===0){state.round++;}
  }else if(command.type==='combat-end'){state.running=false;state.round=0;state.currentId=null;}
  return reconcileCombat(scene,next as T,roster);
}
export function redactCombat<T extends Scene>(scene:T,actor:{role:string;userId:string},visibleIds:Set<string>):T{
  if(actor.role==='master')return scene;
  const tokens=scene.tokens.map(t=>{if(!t.hideStats&&(t.ownerId===actor.userId||t.shareStats))return t;const{hp:_hp,tempHp:_tempHp,maxHp:_max,ac:_ac,initiativeMod:_mod,effects:_effects,initiativeGroup:_group,...publicToken}=t;return publicToken;});
  const order=sortInitiative(scene.combat?.entries??[],scene.combat?.tiePolicy).filter(e=>visibleIds.has(e.tokenId));
  const entries=order.map((entry,i)=>{const t=scene.tokens.find(t=>t.id===entry.tokenId)!;return{...entry,tieOrder:i,...(!t.hideStats&&(t.ownerId===actor.userId||t.shareStats)?{}:{roll:null,total:null,tieRoll:null})};});
  return{...scene,tokens,combat:{...(scene.combat??emptyCombat()),entries,currentId:entries.some(e=>e.id===scene.combat?.currentId)?scene.combat.currentId:null}} as T;
}
