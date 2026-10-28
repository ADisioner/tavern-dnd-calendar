'use client';
import { useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { assetUrl, type LibraryAsset } from '@/lib/table/assets';

export default function Tokenizer({ asset, campaignId, onClose, onSave }: {
  asset: LibraryAsset; campaignId: string; onClose: () => void;
  onSave: (blob: Blob, name: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [name, setName] = useState(asset.name.replace(/\.[^.]+$/, '').slice(0, 80) + ' · токен');
  const [color, setColor] = useState('#d0ae72'), [border, setBorder] = useState(16);
  const [style, setStyle] = useState('solid'), [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const img = new Image(); let active = true;
    img.onload = () => { if (active) { image.current = img; setLoaded(true); } };
    img.onerror = () => { if (active) setError('Изображение не удалось открыть.'); };
    img.src = assetUrl(campaignId, asset.id);
    return () => { active = false; };
  }, [asset.id, campaignId]);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d'), img = image.current;
    if (!ctx || !img || !loaded) return;
    const size = 512, r = size / 2 - border / 2 - 4;
    const scale = Math.max(size / img.width, size / img.height) * zoom;
    const w = img.width * scale, h = img.height * scale;
    const x = Math.max(-(w - size) / 2, Math.min((w - size) / 2, offset.x));
    const y = Math.max(-(h - size) / 2, Math.min((h - size) / 2, offset.y));
    ctx.clearRect(0, 0, size, size); ctx.save();
    ctx.beginPath(); ctx.arc(256, 256, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, (size - w) / 2 + x, (size - h) / 2 + y, w, h); ctx.restore();
    if (border > 0) {
      ctx.strokeStyle = color; ctx.lineWidth = border;
      ctx.setLineDash(style === 'dashed' ? [24, 12] : []);
      ctx.beginPath(); ctx.arc(256, 256, r, 0, Math.PI * 2); ctx.stroke();
      if (style === 'double') {
        ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(256, 256, r - border / 2 - 7, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }, [loaded, zoom, offset, color, border, style]);
  async function save() {
    if (!loaded || !canvas.current || !name.trim()) return;
    setSaving(true); setError('');
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.current!.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось создать PNG.')), 'image/png'));
      await onSave(blob, name.trim() + '.png'); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить токен.'); }
    finally { setSaving(false); }
  }
  const img = image.current;
  const scale = img ? Math.max(512 / img.width, 512 / img.height) * zoom : 1;
  const maxX = img ? Math.floor((img.width * scale - 512) / 2) : 0;
  const maxY = img ? Math.floor((img.height * scale - 512) / 2) : 0;
  return <dialog ref={dialog} className="table-dialog tokenizer-dialog" aria-labelledby="tokenizer-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><div><small>МАСТЕРСКАЯ ОБРАЗОВ</small><h2 id="tokenizer-title">Создать круглый токен</h2></div><button className="small-button" aria-label="Закрыть токенизатор" disabled={saving} onClick={onClose}><X size={20}/></button></header>
    <div className="tokenizer-body"><div><div className="tokenizer-preview"><canvas ref={canvas} width={512} height={512} aria-label="Предпросмотр токена. Перетащите картинку для кадрирования" style={{ touchAction: 'none' }}
      onPointerDown={event => { if (!loaded || saving) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; }}
      onPointerMove={event => { const start = drag.current, img = image.current; if (!start || !img) return;
        const factor = 512 / event.currentTarget.getBoundingClientRect().width;
        const scale = Math.max(512 / img.width, 512 / img.height) * zoom;
        const maxX = (img.width * scale - 512) / 2, maxY = (img.height * scale - 512) / 2;
        setOffset({ x: Math.max(-maxX, Math.min(maxX, start.ox + (event.clientX - start.x) * factor)), y: Math.max(-maxY, Math.min(maxY, start.oy + (event.clientY - start.y) * factor)) }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}/></div><p>Перетащите изображение внутри круга.<br/>PNG 512 × 512 · прозрачные углы</p></div>
      <fieldset disabled={saving} className="tokenizer-controls"><label>Название<input value={name} onChange={event => setName(event.target.value)} maxLength={96}/></label>
        <label>Масштаб · {zoom.toFixed(1)}×<input type="range" min="1" max="4" step="0.05" value={zoom} onChange={event => { setZoom(Number(event.target.value)); setOffset({ x: 0, y: 0 }); }}/></label>
        <label>По горизонтали<input type="range" min={-maxX} max={maxX} step="1" disabled={!maxX} value={offset.x} onChange={event => setOffset(value => ({ ...value, x: Number(event.target.value) }))}/></label>
        <label>По вертикали<input type="range" min={-maxY} max={maxY} step="1" disabled={!maxY} value={offset.y} onChange={event => setOffset(value => ({ ...value, y: Number(event.target.value) }))}/></label>
        <label>Цвет обводки<input type="color" value={color} onChange={event => setColor(event.target.value)}/></label><div className="tokenizer-swatches">{['#d0ae72', '#a8bc8a', '#87b2c2', '#b49bc9', '#c9939b', '#ffffff', '#242628'].map(value => <button type="button" key={value} aria-label={'Обводка ' + value} aria-pressed={color === value} style={{ background: value }} onClick={() => setColor(value)}/>)}</div>
        <label>Толщина обводки · {border} px<input type="range" min="0" max="36" value={border} onChange={event => setBorder(Number(event.target.value))}/></label>
        <label>Оформление<select value={style} onChange={event => setStyle(event.target.value)}><option value="solid">Сплошная обводка</option><option value="double">Двойная обводка</option><option value="dashed">Пунктирная обводка</option></select></label>
        <button type="button" className="small-button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}><RotateCcw size={14}/> Сбросить кадр</button>
      </fieldset></div>
    {error && <p role="alert" className="table-error">{error}</p>}
    <footer><p>Оригинал останется в библиотеке. Новый токен сохранится в выбранную библиотеку.</p><button className="table-action" disabled={!loaded || saving || !name.trim()} onClick={() => void save()}>{saving ? 'Сохраняем…' : 'Сохранить токен'}</button></footer>
  </dialog>;
}
