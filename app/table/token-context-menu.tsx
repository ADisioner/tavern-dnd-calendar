'use client';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Minus, Plus, RotateCw, Lock, LockOpen, Layers, Copy, Tag, Trash2, Ellipsis } from 'lucide-react';
import type { TableToken } from '@/lib/table/scene';
import type { Point } from '@/lib/table/geometry';
import { CONDITION_IDS, CONDITIONS } from '@/lib/table/conditions';

export type TokenAction = 'smaller' | 'larger' | 'rotate' | 'lock' | 'front' | 'back' | 'duplicate' | 'label' | 'delete' | 'status';
export type TokenActionHandler = (token: TableToken, action: TokenAction, value?: string | boolean) => void;
export function tokenMenuPlacement(point: Point, radius: number, viewport: { width: number; height: number }) {
  const r = Math.max(24, Math.min(radius, viewport.width / 2 - 54, viewport.height / 2 - 70));
  const side = Math.max(142, r + 52);
  return { x: Math.max(Math.min(side, viewport.width / 2), Math.min(viewport.width - side, point.x)),
    y: Math.max(Math.max(88, r + 52), Math.min(viewport.height - r - 68, point.y)), radius: r };
}
export default function TokenContextMenu({ token, pending, radius, position, viewport, onAction, menuRef }: {
  token: TableToken; pending: boolean; radius: number; position: Point; viewport: { width: number; height: number };
  onAction: TokenActionHandler; menuRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement>(null), rootRef = menuRef ?? ownRef;
  const [popup, setPopup] = useState<'layer' | 'label' | 'more' | null>(null), [name, setName] = useState(token.name);
  const [statusTab, setStatusTab] = useState(false);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { setPopup(null); setName(token.name); setStatusTab(false); }, [token.id, token.name]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPopup(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopup(null); buttonRefs.current.get(popup ?? '')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [popup, rootRef]);
  const point = tokenMenuPlacement(position, radius, viewport);
  const action = (kind: TokenAction, value?: string | boolean) => { if (!pending) onAction(token, kind, value); };
  const toggle = (kind: 'layer' | 'label' | 'more') => setPopup(current => current === kind ? null : kind);
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return <div ref={rootRef} data-token-menu className="token-context-menu" role="group" aria-label={`Действия: ${token.name}`}
    style={{ left: point.x, top: point.y, '--token-menu-radius': `${point.radius}px` } as CSSProperties}
    onMouseDown={stop} onPointerDown={stop} onTouchStart={stop} onClick={stop} onDoubleClick={stop} onWheel={stop} onContextMenu={event => { stop(event); event.preventDefault(); }}
    onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <button className="token-menu-size token-menu-smaller" aria-label="Уменьшить фигуру" title="Уменьшить фигуру" disabled={pending || token.size <= 0.5} onClick={() => action('smaller')}><Minus size={19}/></button>
    <button className="token-menu-size token-menu-larger" aria-label="Увеличить фигуру" title="Увеличить фигуру" disabled={pending || token.size >= 3} onClick={() => action('larger')}><Plus size={19}/></button>
    <button className="token-menu-rotate" aria-label="Повернуть фигуру" title="Повернуть на 45°" disabled={pending} onClick={() => action('rotate')}><RotateCw size={19}/></button>
    <div className="token-menu-toolbar" role="toolbar" aria-label="Действия с фигурой">
      <button aria-label={token.locked ? 'Разблокировать фигуру' : 'Заблокировать фигуру'} title={token.locked ? 'Разблокировать' : 'Заблокировать'} aria-pressed={!!token.locked} disabled={pending} onClick={() => action('lock')}>{token.locked ? <Lock size={18}/> : <LockOpen size={18}/>}</button>
      <button ref={node => { if (node) buttonRefs.current.set('layer', node); }} aria-label="Порядок слоёв" title="Порядок слоёв" aria-expanded={popup === 'layer'} disabled={pending} onClick={() => toggle('layer')}><Layers size={18}/></button>
      <button aria-label="Создать копию" title="Создать копию" disabled={pending} onClick={() => action('duplicate')}><Copy size={18}/></button>
      <button ref={node => { if (node) buttonRefs.current.set('label', node); }} aria-label="Подпись фигуры" title="Подпись фигуры" aria-expanded={popup === 'label'} disabled={pending} onClick={() => toggle('label')}><Tag size={18}/></button>
      <button className="token-menu-delete" aria-label="Удалить фигуру" title="Удалить фигуру" disabled={pending} onClick={() => action('delete')}><Trash2 size={18}/></button>
      <button ref={node => { if (node) buttonRefs.current.set('more', node); }} aria-label="Дополнительно" title="Дополнительно" aria-expanded={popup === 'more'} disabled={pending} onClick={() => toggle('more')}><Ellipsis size={18}/></button>
    </div>
    {popup && <div className="token-menu-popup" role="group" aria-label={popup === 'layer' ? 'Порядок фигуры' : popup === 'label' ? 'Настройки подписи' : 'Дополнительные действия'}>
      {popup === 'layer' && <><button aria-label="На передний план" disabled={pending} onClick={() => { action('front'); setPopup(null); }}>На передний план</button><button aria-label="На задний план" disabled={pending} onClick={() => { action('back'); setPopup(null); }}>На задний план</button></>}
      {popup === 'label' && <><form onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (trimmed) action('label', trimmed); }}>
        <label>Имя<input aria-label="Имя фигуры" value={name} maxLength={40} disabled={pending} onChange={event => setName(event.target.value)}/></label><button disabled={pending || !name.trim()} type="submit">Сохранить</button>
      </form><label className="token-menu-label-toggle"><input aria-label="Показывать подпись" type="checkbox" checked={token.showLabel !== false} disabled={pending} onChange={event => action('label', event.target.checked)}/>Показывать подпись</label></>}
      {popup === 'more' && <><div role="tablist" aria-label="Дополнительные настройки"><button className="token-status-tab" id={`status-tab-${token.id}`} role="tab" aria-label="Статус" aria-controls={`status-panel-${token.id}`} aria-selected={statusTab} disabled={pending} onClick={() => setStatusTab(true)}>Статус</button></div>
        {statusTab && <div id={`status-panel-${token.id}`} role="tabpanel" aria-labelledby={`status-tab-${token.id}`} aria-label="Состояния D&D 5e" className="token-condition-panel">
          {CONDITION_IDS.map(id => <label className="token-condition-option" key={id}><input aria-label={CONDITIONS[id].label} type="checkbox" value={id} checked={token.statuses?.includes(id) ?? false} disabled={pending} onChange={() => action('status', id)}/><span aria-hidden="true" style={{ background: CONDITIONS[id].color }}/>{CONDITIONS[id].label}</label>)}
          <label className="token-condition-level">Уровень истощения<select aria-label="Уровень истощения" value={token.exhaustionLevel ?? 1} disabled={pending} onChange={event => action('status', `exhaustion:${event.target.value}`)}>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          <button className="token-condition-clear" aria-label="Снять все состояния" disabled={pending || !token.statuses?.length} onClick={() => action('status', 'clear')}>Снять все состояния</button>
        </div>}
      </>}
    </div>}
  </div>;
}
