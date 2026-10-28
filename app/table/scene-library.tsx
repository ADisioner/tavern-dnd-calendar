'use client';
import { useState, type FormEvent } from 'react';
import { Layers, Plus, Eye, Radio, Copy, Archive, ArchiveRestore, Pencil, Check, X } from 'lucide-react';
import type { SceneSummary } from '@/lib/table/room';
import type { CommandInput } from './use-table-room';

export default function SceneLibrary({ scenes, activeSceneId, viewedSceneId, disabled, send }: {
  scenes: SceneSummary[]; activeSceneId: string; viewedSceneId: string; disabled: boolean; send: (command: CommandInput) => boolean;
}) {
  const [showArchive, setShowArchive] = useState(false), [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null), [name, setName] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault(); if (!name.trim()) return;
    if (send(editing ? { type: 'scene-rename', targetSceneId: editing, name: name.trim() } : { type: 'scene-create', name: name.trim() })) {
      setCreating(false); setEditing(null); setName('');
    }
  }
  const visible = scenes.filter(scene => scene.archived === showArchive);
  return <section className="table-card scene-library" aria-label="Сцены кампании">
    <div className="table-section-heading"><span><Layers size={16}/> Сцены кампании</span><span className="table-chip">{scenes.filter(scene => !scene.archived).length}</span></div>
    <p>Готовьте сцену за ширмой. Игроки перейдут на неё после «Показать группе».</p>
    <div className="scene-library-tabs" role="group" aria-label="Список или архив сцен"><button className="small-button" aria-pressed={!showArchive} onClick={() => setShowArchive(false)}>Сцены</button><button className="small-button" aria-pressed={showArchive} onClick={() => setShowArchive(true)}><Archive size={13}/> Архив · {scenes.filter(scene => scene.archived).length}</button></div>
    <div className="scene-list">{visible.map(scene => <article key={scene.id} className="scene-list-item" data-selected={scene.id === viewedSceneId}>
      {editing === scene.id ? <form onSubmit={submit}><label>Новое название<input aria-label="Новое название сцены" value={name} onChange={event => setName(event.target.value)} required maxLength={100} autoFocus disabled={disabled}/></label><div className="scene-item-actions"><button className="small-button" disabled={disabled || !name.trim()} aria-label="Сохранить название сцены"><Check size={14}/></button><button type="button" className="small-button" aria-label="Отменить переименование" onClick={() => setEditing(null)}><X size={14}/></button></div></form> : <>
        <button className="scene-preview-button" disabled={disabled || scene.archived} aria-pressed={viewedSceneId === scene.id} onClick={() => send({ type: 'scene-view', targetSceneId: scene.id })} title="Открыть только у мастера"><span className="scene-marker"><Layers size={17}/></span><span><strong>{scene.name}</strong><small>{scene.id === activeSceneId ? '● Группа здесь' : scene.id === viewedSceneId ? 'За ширмой мастера' : scene.archived ? 'В архиве' : 'Подготовлена'} · токенов: {scene.tokenCount}</small></span></button>
        <div className="scene-item-actions">{scene.archived ? <button className="small-button" disabled={disabled} onClick={() => send({ type: 'scene-restore', targetSceneId: scene.id })}><ArchiveRestore size={14}/> Восстановить</button> : <>
          {scene.id !== activeSceneId && <button className="small-button scene-show-button" disabled={disabled} onClick={() => send({ type: 'scene-activate', targetSceneId: scene.id })}><Radio size={13}/> Показать группе</button>}
          <button className="small-button" disabled={disabled} title="Переименовать сцену" aria-label={'Переименовать ' + scene.name} onClick={() => { setEditing(scene.id); setCreating(false); setName(scene.name); }}><Pencil size={13}/></button>
          <button className="small-button" disabled={disabled || scenes.length >= 50} title="Дублировать сцену" aria-label={'Дублировать ' + scene.name} onClick={() => { setShowArchive(false); send({ type: 'scene-duplicate', targetSceneId: scene.id, name: (scene.name + ' · копия').slice(0, 100) }); }}><Copy size={13}/></button>
          <button className="small-button" disabled={disabled || scene.id === activeSceneId} title={scene.id === activeSceneId ? 'Сначала покажите группе другую сцену' : 'Убрать сцену в архив'} aria-label={'Архивировать ' + scene.name} onClick={() => send({ type: 'scene-archive', targetSceneId: scene.id })}><Archive size={13}/></button>
        </>}</div>
      </>}
    </article>)}</div>
    {!visible.length && <p className="scene-library-empty">{showArchive ? 'Архив пуст. Здесь можно будет восстановить убранные сцены.' : 'Нет сцен.'}</p>}
    {creating ? <form className="scene-create-form" onSubmit={submit}><label>Название новой сцены<input aria-label="Название новой сцены" value={name} onChange={event => setName(event.target.value)} required maxLength={100} placeholder="Например, Лесная засада" autoFocus disabled={disabled}/></label><div className="scene-item-actions"><button className="small-button" disabled={disabled || !name.trim()}><Plus size={14}/> Создать</button><button type="button" className="text-button" onClick={() => setCreating(false)}>Отмена</button></div></form> : <button className="small-button scene-create-button" disabled={disabled || scenes.length >= 50} onClick={() => { setCreating(true); setEditing(null); setShowArchive(false); setName(''); }}><Plus size={14}/> Новая сцена</button>}
    {viewedSceneId !== activeSceneId && <button className="text-button scene-return-button" disabled={disabled} onClick={() => send({ type: 'scene-view', targetSceneId: activeSceneId })}><Eye size={14}/> Вернуться к группе</button>}
  </section>;
}
