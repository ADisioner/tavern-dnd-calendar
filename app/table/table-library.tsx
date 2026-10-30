'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Upload, ImagePlus, FolderOpen, Search, FileText, Music, CircleUserRound, Map, Share2, Lock, Trash2, Download } from 'lucide-react';
import { assetUrl, MAX_ASSET_BYTES, type LibraryAsset } from '@/lib/table/assets';
import type { TableActor } from '@/lib/table/scene';
import Tokenizer from './tokenizer';

const kinds: Record<LibraryAsset['kind'], string> = { image: 'Изображение', token: 'Токен', map: 'Карта', document: 'Документ', audio: 'Аудио' };
export default function TableLibrary({ campaignId, actor, version, disabled, actionError, onClose, onAdd, onMap }: {
  campaignId: string; actor: TableActor; version: number; disabled: boolean; actionError: string; onClose: () => void;
  onAdd: (asset: LibraryAsset) => boolean; onMap: (asset: LibraryAsset) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<LibraryAsset[]>([]), [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [kind, setKind] = useState<LibraryAsset['kind']>('image'), [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false), [tokenize, setTokenize] = useState<LibraryAsset | null>(null);
  const busyRef = useRef(false), loadNumber = useRef(0);
  const endpoint = '/api/table/library?campaign=' + encodeURIComponent(campaignId);
  const load = useCallback(async () => {
    const number = ++loadNumber.current;
    try {
      const response = await fetch('/api/table/library?campaign=' + encodeURIComponent(campaignId), { cache: 'no-store' });
      const value = await response.json() as { error?: string; assets: LibraryAsset[]; asset: LibraryAsset }; if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие.');
      if (number === loadNumber.current) setAssets(value.assets);
    } catch (failure) { if (number === loadNumber.current) setError(failure instanceof Error ? failure.message : 'Не удалось открыть библиотеку.'); }
    finally { if (number === loadNumber.current) setLoading(false); }
  }, [campaignId]);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { element.close(); loadNumber.current++; }; }, []);
  useEffect(() => { void load(); }, [load, version]);
  async function upload(blob: Blob, name: string, assetKind: LibraryAsset['kind'], targetScope = scope) {
    if (!blob.size || blob.size > MAX_ASSET_BYTES) throw new Error('Размер каждого файла — от 1 байта до 8 МБ.');
    const response = await fetch(endpoint + '&' + new URLSearchParams({ name: name.slice(0, 100), kind: assetKind, scope: targetScope }), { method: 'POST', body: blob });
    const value = await response.json() as { error?: string; assets: LibraryAsset[]; asset: LibraryAsset }; if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие.');
    return value.asset as LibraryAsset;
  }
  async function files(list: File[]) {
    if (busyRef.current || !list.length) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice(''); let count = 0;
    const failures: string[] = [];
    try {
      for (const file of list) {
        try {
          const detectedKind = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'document' : file.type.startsWith('audio/') || /\.(mp3|ogg|wav)$/i.test(file.name) ? 'audio' : kind;
          await upload(file, file.name, detectedKind); count++;
        } catch (failure) { failures.push(file.name + ': ' + (failure instanceof Error ? failure.message : 'Ошибка загрузки')); }
      }
      setNotice(count ? `Загружено файлов: ${count}.` : ''); setError(failures.join('\n')); await load();
    } finally { busyRef.current = false; setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function change(asset: LibraryAsset, action: 'archive' | 'personal' | 'shared') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(endpoint + '&asset=' + asset.id + '&scope=' + action, { method: action === 'archive' ? 'DELETE' : 'PATCH' });
      const value = await response.json() as { error?: string; assets: LibraryAsset[]; asset: LibraryAsset }; if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие.');
      setNotice(action === 'archive' ? 'Файл убран из библиотеки. Размещённые на сценах копии доступны участникам.' : action === 'shared' ? 'Файл доступен группе в общей библиотеке.' : 'Файл возвращён в личную библиотеку. Уже размещённые на сценах изображения видны группе.');
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось изменить файл.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const shown = assets.filter(asset => (scope === 'personal' ? asset.ownerId === actor.userId && !asset.campaignId : asset.campaignId === campaignId) && (filter === 'all' || asset.kind === filter) && asset.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <><dialog ref={dialog} className="table-dialog library-dialog" aria-labelledby="library-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><small>СУНДУК ПРИКЛЮЧЕНЦА</small><h2 id="library-title">Библиотека материалов</h2></div><button className="small-button" disabled={busy} aria-label="Закрыть библиотеку" onClick={onClose}><X size={20}/></button></header>
    <div className="library-body"><div className="library-tabs" role="group" aria-label="Выбор библиотеки"><button aria-pressed={scope === 'personal'} disabled={busy} onClick={() => setScope('personal')}><Lock size={16}/> Моя библиотека</button><button aria-pressed={scope === 'shared'} disabled={busy} onClick={() => setScope('shared')}><Share2 size={16}/> Общая библиотека</button></div>
      <p className="library-description">{scope === 'personal' ? 'Ваши файлы во всех кампаниях. На столе выбранные изображения будут видны участникам.' : 'Материалы этой кампании. Загружать и использовать файлы может каждый участник.'}</p>
      <div className="library-drop" data-dragging={dragging} aria-busy={busy} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); void files(Array.from(event.dataTransfer.files)); }}>
        <Upload size={26}/><strong>{busy ? 'Сохраняем материалы…' : 'Перетащите файлы сюда'}</strong><span>PNG, JPG, WebP, GIF, PDF и аудио · до 8 МБ на файл</span><div className="library-upload-controls"><label>Тип изображения<select value={kind} disabled={busy} onChange={event => setKind(event.target.value as LibraryAsset['kind'])}><option value="image">Изображение</option><option value="token">Токен</option><option value="map">Карта</option></select></label><button className="small-button" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus size={16}/> Выбрать файлы</button></div>
        <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" aria-label="Загрузить файлы в библиотеку" onChange={event => void files(Array.from(event.target.files ?? []))}/>
      </div>
      <div className="library-search"><label><Search size={16}/><input placeholder="Найти материал…" aria-label="Поиск материалов" value={search} onChange={event => setSearch(event.target.value)}/></label><select aria-label="Тип материала" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все материалы</option>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      {(error || actionError) && <div className="table-error" role="alert">{error || actionError}<button className="text-button" onClick={() => void load()}>Обновить</button></div>}{notice && !actionError && <p className="library-notice" role="status">{disabled && notice.includes('на стол') ? 'Сохраняем изменения сцены…' : notice}</p>}
      {loading ? <p role="status">Открываем сундук…</p> : shown.length === 0 ? <div className="library-empty"><FolderOpen size={36}/><h3>{search || filter !== 'all' ? 'Ничего не найдено' : 'Здесь будут ваши материалы'}</h3><p>Загрузите портрет героя, карту приключения или раздаточный материал.</p></div> : <div className="library-grid">{shown.map(asset => <article className="library-asset" key={asset.id}>
        <div className="library-thumbnail">{asset.mime.startsWith('image/') ? <img src={assetUrl(campaignId, asset.id)} alt={asset.name} loading="lazy"/> : asset.kind === 'audio' ? <Music size={42}/> : <FileText size={42}/>}<span>{kinds[asset.kind]}</span></div>
        <div className="library-asset-details"><h3 title={asset.name}>{asset.name}</h3><p>{asset.ownerName} · {(asset.size / 1024).toFixed(0)} КБ</p>
          <div className="library-actions">{asset.mime.startsWith('image/') && <><button className="small-button" disabled={disabled || busy} onClick={() => { if (onAdd(asset)) setNotice('Токен добавлен на стол.'); }}><CircleUserRound size={14}/> На стол</button><button className="small-button" disabled={busy} onClick={() => setTokenize(asset)}>Токенизатор</button>{actor.role === 'master' && <button className="small-button" disabled={disabled || busy} onClick={() => { if (onMap(asset)) setNotice('Карта сцены изменена.'); }}><Map size={14}/> На карту</button>}</>}
            <a className="small-button" href={assetUrl(campaignId, asset.id)} download={asset.name} aria-label={'Скачать ' + asset.name}><Download size={14}/></a>
            {asset.ownerId === actor.userId && <button className="small-button" disabled={busy} title={scope === 'personal' ? 'Поделиться с группой' : 'Вернуть в личную библиотеку'} aria-label={scope === 'personal' ? 'Поделиться ' + asset.name : 'Сделать личным ' + asset.name} onClick={() => void change(asset, scope === 'personal' ? 'shared' : 'personal')}>{scope === 'personal' ? <Share2 size={14}/> : <Lock size={14}/>}</button>}
            {(asset.ownerId === actor.userId || actor.role === 'master' && asset.campaignId === campaignId) && <button className="small-button" disabled={busy} title="Убрать из библиотеки" aria-label={'Убрать ' + asset.name} onClick={() => void change(asset, 'archive')}><Trash2 size={14}/></button>}
          </div></div>
      </article>)}</div>}
    </div><footer><p>{shown.length} материалов · {scope === 'personal' ? 'Личная библиотека аккаунта' : 'Общая библиотека кампании'}<br/>Файлы и сцены сохраняются для этой кампании.</p></footer>
  </dialog>{tokenize && <Tokenizer asset={tokenize} campaignId={campaignId} onClose={() => setTokenize(null)} onSave={async (blob, name) => { await upload(blob, name, 'token'); setFilter('all'); setSearch(''); await load(); setNotice('Круглый токен сохранён. Его можно добавить на стол.'); }}/>}</>;
}
