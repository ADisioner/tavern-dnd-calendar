'use client';
import { useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { Dice5, X } from 'lucide-react';
import { DICE_SIDES, type RollMode, type RollRecord } from '@/lib/table/dice';
import type { CommandInput } from './use-table-room';

export default function DiceTray({ rolls = [], open, master, disabled, connected, timezone, send, onClose }: { rolls: RollRecord[]; open:boolean; master:boolean; disabled:boolean; connected:boolean; timezone:string; send:(command:CommandInput)=>boolean; onClose:()=>void }) {
  const [formula,setFormula]=useState('d20'),[mode,setMode]=useState<RollMode>('normal'),[visibility,setVisibility]=useState<'public'|'private'|'gm'>('public'),[npc,setNpc]=useState(''),[sound,setSound]=useState(false);
  const [Stage,setStage]=useState<ComponentType<{roll:RollRecord;sound:boolean;overlay?:boolean}>|null>(null);
  const [animation,setAnimation]=useState<RollRecord|null>(null),seen=useRef<Set<string>|null>(null),queue=useRef<RollRecord[]>([]);
  const presetStarted=useRef(false);
  useEffect(()=>{if((open||animation)&&!Stage)void import('./dice-stage').then(module=>setStage(()=>module.default));},[open,animation,Stage]);
  useEffect(()=>{
    if(!connected){seen.current=null;queue.current=[];setAnimation(null);return;}
    if(!seen.current){seen.current=new Set(rolls.map(roll=>roll.id));return;}
    const fresh=rolls.filter(roll=>!seen.current!.has(roll.id));for(const roll of rolls)seen.current.add(roll.id);
    queue.current=queue.current.filter(item=>rolls.some(roll=>roll.id===item.id));
    queue.current.push(...fresh);
    if(!animation||!rolls.some(roll=>roll.id===animation.id))setAnimation(queue.current.shift()??null);
  },[rolls,connected]);
  useEffect(()=>{if(!animation||!Stage)return;const timer=setTimeout(()=>setAnimation(queue.current.shift()??null),5600);return()=>clearTimeout(timer);},[animation,Stage]);
  const submit=(event:FormEvent)=>{event.preventDefault();send({type:'dice-roll',formula,mode,visibility,...(master&&npc.trim()?{npc:npc.trim()}: {})});};
  return <><section className="vtt-panel dice-tray" hidden={!open} aria-label="Лоток кубиков">
    <header><strong><Dice5 size={18}/> Кубики</strong><button className="table-tool" aria-label="Скрыть лоток кубиков" onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={submit}>
      <div className="dice-presets">{DICE_SIDES.map(sides=><button key={sides} type="button" className="small-button" onClick={()=>{setFormula(presetStarted.current&&formula?`${formula}+d${sides}`:`d${sides}`);presetStarted.current=true;}}>d{sides}</button>)}<button type="button" className="text-button" onClick={()=>{setFormula('d20');presetStarted.current=false;}}>Сброс</button></div>
      <label>Формула<input aria-label="Формула броска" value={formula} maxLength={160} onChange={event=>{setFormula(event.target.value);presetStarted.current=true;}} placeholder="2d6+3" required/></label>
      <div className="table-field-row"><label>Режим<select value={mode} onChange={event=>setMode(event.target.value as RollMode)}><option value="normal">Обычный</option><option value="advantage">Преимущество (d20)</option><option value="disadvantage">Помеха (d20)</option></select></label><label>Получатели<select value={visibility} onChange={event=>setVisibility(event.target.value as typeof visibility)}><option value="public">Всем</option><option value="private">Автор и ГМ</option><option value="gm">Только ГМ</option></select></label></div>
      {master&&<label>Бросок за NPC<input value={npc} onChange={event=>setNpc(event.target.value)} maxLength={80} placeholder="Необязательно"/></label>}
      <label className="vtt-check"><input type="checkbox" checked={sound} onChange={event=>setSound(event.target.checked)}/> Звуки столкновений</label>
      <button className="small-button" disabled={disabled}>Бросить {formula}</button>
    </form>

    <div className="dice-history" role="log" aria-label="История бросков">{[...rolls].reverse().map(roll=><article key={roll.id}>
      <div><strong>{roll.npc??roll.authorName}</strong><small>{roll.visibility==='public'?'Всем':roll.visibility==='private'?'Автор и ГМ':'Только ГМ'} · {new Date(roll.createdAt).toLocaleTimeString('ru-RU',{timeZone:timezone})}</small></div>
      <p>{roll.formula} {roll.mode==='advantage'?' · преимущество':roll.mode==='disadvantage'?' · помеха':''} <b aria-label="Итог броска">{roll.total}</b></p>
      <small>{roll.dice.map((die,i)=><span key={i} className={die.kept?'':'dice-discarded'}>d{die.sides}: {die.value}{i<roll.dice.length-1?' · ':''}</span>)}{roll.modifier?` · мод. ${roll.modifier>0?'+':''}${roll.modifier}`:''}</small>
    </article>)}{!rolls.length&&<p>Здесь появятся доступные вам броски. Результат определяет сервер.</p>}</div>
  </section>{animation&&Stage&&<div className="table-dice-overlay" aria-label="Бросок на столе"><Stage roll={animation} sound={sound} overlay/><div className="table-dice-result" role="status">{animation.npc??animation.authorName} · {animation.formula}: <strong>{animation.total}</strong></div></div>}</>;
}
