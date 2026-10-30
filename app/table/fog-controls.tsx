'use client';
import { CloudFog, X } from 'lucide-react';
import { useState } from 'react';
import { assetUrl } from '@/lib/table/assets';
import type { TableScene, TableMember } from '@/lib/table/scene';
import type { CommandInput } from './use-table-room';
export type FogEdit = 'wall'|'door'|'reveal'|'hide';
export default function FogControls({scene,roster,selectedId,preview,edit,setEdit,disabled,send,onClose,gmOpacity,onGmOpacity}:{scene:TableScene;roster:TableMember[];selectedId:string|null;preview:string|null;edit:FogEdit|null;setEdit:(edit:FogEdit|null)=>void;disabled:boolean;send:(input:CommandInput)=>boolean;onClose:()=>void;gmOpacity:number;onGmOpacity:(opacity:number)=>void}) {
  const token=scene.tokens.find(t=>t.id===selectedId),fog=scene.fog;
  const [preparing,setPreparing]=useState(false),[mapError,setMapError]=useState('');
  async function normalizeMap(){
    if(!scene.mapAssetId)return;setPreparing(true);setMapError('');
    try{
      const response=await fetch(assetUrl(scene.campaignId,scene.mapAssetId));if(!response.ok)throw new Error('Не удалось прочитать карту.');
      const bitmap=await createImageBitmap(await response.blob()),canvas=document.createElement('canvas');canvas.width=scene.width;canvas.height=scene.height;const ctx=canvas.getContext('2d')!,scale=Math.min(scene.width/bitmap.width,scene.height/bitmap.height);ctx.fillStyle='#15191a';ctx.fillRect(0,0,scene.width,scene.height);ctx.drawImage(bitmap,(scene.width-bitmap.width*scale)/2,(scene.height-bitmap.height*scale)/2,bitmap.width*scale,bitmap.height*scale);bitmap.close();
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Не удалось подготовить PNG.')),'image/png'));
      const upload=await fetch(`/api/table/library?campaign=${scene.campaignId}&kind=map&scope=personal&name=Fog-map.png`,{method:'POST',body:blob});const data=await upload.json() as {error?:string;asset:{id:string}};if(!upload.ok)throw new Error(data.error??'Не удалось сохранить карту.');
      send({type:'map',assetId:data.asset.id});
    }catch(error){setMapError((error as Error).message);}finally{setPreparing(false);}
  }
  return <section className="vtt-panel" aria-label="Туман войны"><header><strong><CloudFog size={18}/> Обзор и туман</strong><button className="table-tool" aria-label="Скрыть настройки тумана" onClick={onClose}><X size={18}/></button></header>
    <label>Предпросмотр глазами игрока<select disabled={disabled} value={preview??''} onChange={event=>send({type:'scene-view-player',viewerId:event.target.value||null})}><option value="">Полный обзор ГМа</option>{roster.map(member=><option key={member.userId} value={member.userId}>{member.name}</option>)}</select></label>
    <label>Затемнение тумана для ГМа: {Math.round(gmOpacity*100)}%<input aria-label="Затемнение тумана для ГМа" type="range" min="0" max="100" step="1" value={Math.round(gmOpacity*100)} onChange={event=>onGmOpacity(Number(event.target.value)/100)}/></label>{preview?<p>Показано серверное представление выбранного игрока. Для редактирования вернитесь к полному обзору.</p>:<>
      <label className="vtt-check"><input type="checkbox" checked={!!fog?.enabled} disabled={disabled} onChange={event=>send({type:'fog-config',enabled:event.target.checked})}/> Автоматическое зрение и память карты</label>
      {scene.mapAssetId&&<><button className="small-button" disabled={disabled||preparing} onClick={()=>void normalizeMap()}>{preparing?'Подготовка карты…':'Подготовить карту для тумана'}</button><p>PNG, JPEG и GIF маскируются сервером. Для WebP или карты больше 4 Мп сначала нажмите «Подготовить карту»: создастся PNG-копия. Оригинал останется в библиотеке.</p>{mapError&&<p role="alert">{mapError}</p>}</>}
      <div className="fog-tools">{([['wall','Стена'],['door','Дверь'],['reveal','Открыть область'],['hide','Скрыть область']] as const).map(([mode,label])=><button key={mode} className="small-button" aria-pressed={edit===mode} disabled={disabled} onClick={()=>setEdit(edit===mode?null:mode)}>{label}</button>)}</div>
      {edit&&<p>Протяните на карте от начала до конца {edit==='wall'||edit==='door'?'отрезка':'прямоугольника'}. <button className="text-button" onClick={()=>setEdit(null)}>Завершить</button></p>}
      {token&&<form key={`${token.id}:${token.version}`} onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);send({type:'vision',tokenId:token.id,expectedVersion:token.version,visionFeet:Number(data.get('visionFeet')),hidden:data.get('hidden')==='on'});}}>
        <strong>{token.name}</strong><label>Зрение, ft<input name="visionFeet" type="number" min="0" max="300" step="5" defaultValue={token.visionFeet??60}/></label>
        <label className="vtt-check"><input name="hidden" type="checkbox" defaultChecked={token.hidden}/> Скрыть токен от игроков</label><button className="small-button" disabled={disabled}>Сохранить зрение</button>
      </form>}
      <p>Зрение игрока исходит из принадлежащих ему токенов. Владельца можно назначить в настройках фигуры. 0 ft отключает зрение.</p>
      <div className="fog-wall-list">{(fog?.walls??[]).map((wall,i)=><div key={wall.id}><span>{wall.door?'Дверь':'Стена'} {i+1}</span>{wall.door&&<button className="small-button" disabled={disabled} onClick={()=>send({type:'wall-set',wall:{...wall,open:!wall.open}})}>{wall.open?'Закрыть':'Открыть'}</button>}<button className="text-button" disabled={disabled} onClick={()=>send({type:'wall-remove',wallId:wall.id})}>Удалить</button></div>)}</div>
      <button className="small-button" disabled={disabled} onClick={()=>send({type:'fog-reset'})}>Сбросить память и ручные области</button>
    </>}
  </section>;
}
