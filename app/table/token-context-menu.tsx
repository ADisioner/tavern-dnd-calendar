'use client';
import { useEffect, useRef, useState, type CSSProperties, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { MoveHorizontal, RotateCw, Lock, LockOpen, Layers, Copy, Tag, Trash2, Ellipsis } from 'lucide-react';
import type { TableToken } from '@/lib/table/scene';
import type { Point } from '@/lib/table/geometry';
import { CONDITION_IDS, CONDITIONS } from '@/lib/table/conditions';

export type TokenAction = 'smaller' | 'larger' | 'resize' | 'rotate' | 'lock' | 'front' | 'back' | 'duplicate' | 'label' | 'delete' | 'status';
export type TokenActionHandler = (token: TableToken, action: TokenAction, value?: string | boolean | number) => void;
export function tokenMenuPlacement(point: Point, radius: number, viewport: { width: number; height: number }) {
  const r = Math.max(24, Math.min(radius, viewport.width / 2 - 54, viewport.height / 2 - 70));
  const side = Math.max(142, r + 52);
  const maxScale = Math.max(0.35, (viewport.width - 24) / 141);
  return { x: Math.max(Math.min(side, viewport.width / 2), Math.min(viewport.width - side, point.x)),
    y: Math.max(Math.max(88, r + 52), Math.min(viewport.height - r - 68, point.y)), radius: r,
    scale: Math.max(0.35, Math.min(0.675, r / 64, maxScale)) };
}
export default function TokenContextMenu({ token, pending, radius, position, viewport, onAction, menuRef, resizePixelsPerCell = 80, onResizePreview }: {
  token: TableToken; pending: boolean; radius: number; position: Point; viewport: { width: number; height: number };
  onAction: TokenActionHandler; menuRef?: RefObject<HTMLDivElement | null>;
  resizePixelsPerCell?: number; onResizePreview?: (size: number | null) => void;
}) {
  const ownRef = useRef<HTMLDivElement>(null), rootRef = menuRef ?? ownRef;
  const [popup, setPopup] = useState<'layer' | 'label' | 'more' | null>(null), [name, setName] = useState(token.name);
  const [statusTab, setStatusTab] = useState(false);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const resize = useRef<{ pointerId: number; x: number; size: number; value: number; pixels: number; token: TableToken; target: HTMLButtonElement } | null>(null);
  const cancelResize = () => {
    const current = resize.current; if (!current) return;
    resize.current = null; onResizePreview?.(null);
    if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  useEffect(() => { cancelResize(); }, [token.id, token.version, pending]);
  useEffect(() => {
    window.addEventListener('blur', cancelResize);
    return () => { window.removeEventListener('blur', cancelResize); cancelResize(); };
  }, []);
  useEffect(() => { setPopup(null); setName(token.name); setStatusTab(false); }, [token.id, token.name]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPopup(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { cancelResize(); setPopup(null); buttonRefs.current.get(popup ?? '')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [popup, rootRef]);
  const point = tokenMenuPlacement(position, radius, viewport);
  const action = (kind: TokenAction, value?: string | boolean | number) => { if (!pending) onAction(token, kind, value); };
  const toggle = (kind: 'layer' | 'label' | 'more') => setPopup(current => current === kind ? null : kind);
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const sizeAt = (x: number, current: NonNullable<typeof resize.current>) => x === current.x ? current.size : Math.max(0.5, Math.min(3, Math.round((current.size + (x - current.x) / current.pixels) * 100) / 100));
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pending || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); setPopup(null);
    resize.current = { pointerId: event.pointerId, x: event.clientX, size: token.size, value: token.size, pixels: Math.max(24, resizePixelsPerCell), token, target: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId); onResizePreview?.(token.size);
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = resize.current; if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); current.value = sizeAt(event.clientX, current); onResizePreview?.(current.value);
  };
  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = resize.current; if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); const size = sizeAt(event.clientX, current); resize.current = null;
    if (current.target.hasPointerCapture?.(event.pointerId)) current.target.releasePointerCapture(event.pointerId);
    if (size !== current.size && !pending) { onResizePreview?.(size); onAction(current.token, 'resize', size); }
    else onResizePreview?.(null);
  };
  const resizeHandle = (side: 'слева' | 'справа', className: string) => <button type="button" role="slider" className={`token-menu-size ${className}`} aria-label={`Изменить размер ${side}`}
    aria-valuemin={0.5} aria-valuemax={3} aria-valuenow={token.size} aria-valuetext={`${token.size} клетки`} title="Зажмите и тяните: вправо — больше, влево — меньше" disabled={pending}
    onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={cancelResize} onLostPointerCapture={cancelResize}
    onKeyDown={event => { if (pending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation();
      action('resize', event.key === 'Home' ? 0.5 : event.key === 'End' ? 3 : Math.max(0.5, Math.min(3, Math.round((token.size + (event.key === 'ArrowRight' ? 0.1 : -0.1)) * 100) / 100))); }}><MoveHorizontal size={19}/></button>;
  return <div ref={rootRef} data-token-menu className="token-context-menu" role="group" aria-label={`Действия: ${token.name}`}
    style={{ left: point.x, top: point.y, '--token-menu-radius': `${point.radius}px`, '--token-menu-scale': point.scale } as CSSProperties}
    onMouseDown={stop} onPointerDown={stop} onTouchStart={stop} onClick={stop} onDoubleClick={stop} onWheel={stop} onContextMenu={event => { stop(event); event.preventDefault(); }}
    onKeyDown={event => { if (event.key !== 'Escape' && !((event.ctrlKey || event.metaKey) && ['c', 'v'].includes(event.key.toLowerCase()))) event.stopPropagation(); }}>
    {resizeHandle('слева', 'token-menu-smaller')}
    {resizeHandle('справа', 'token-menu-larger')}
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
          {CONDITION_IDS.map(id => <label className="token-condition-option" key={id}><input aria-label={CONDITIONS[id].label} type="checkbox" value={id} checked={token.statuses?.includes(id) ?? false} disabled={pending} onChange={() => action('status', id)}/><svg aria-hidden="true" viewBox="0 0 24 24" className="token-condition-icon" style={{ color: CONDITIONS[id].color }}><path d={CONDITIONS[id].icon}/></svg>{CONDITIONS[id].label}</label>)}
          <label className="token-condition-level">Уровень истощения<select aria-label="Уровень истощения" value={token.exhaustionLevel ?? 1} disabled={pending} onChange={event => action('status', `exhaustion:${event.target.value}`)}>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          <button className="token-condition-clear" aria-label="Снять все состояния" disabled={pending || !token.statuses?.length} onClick={() => action('status', 'clear')}>Снять все состояния</button>
        </div>}
      </>}
    </div>}
  </div>;
}
