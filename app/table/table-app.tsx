'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ArrowLeft, MousePointer2, Hand, Grid2X2, Plus, Sun, Moon, RefreshCw, ArrowUp, ArrowDown, ArrowRight, ArrowLeft as MoveLeft, Users, Layers, Swords, FolderOpen, Trash2, Pencil, Eraser, Link2, Unlink2, Ruler, Cone, Circle, Square, Route, PanelRightOpen, PanelRightClose, Music2, X } from 'lucide-react';
import { canMoveToken, linkedTokens, type TableToken } from '@/lib/table/scene';
import { CONDITION_IDS, type ConditionId } from '@/lib/table/conditions';
import type { Point } from '@/lib/table/geometry';
import type { MeasureMode } from '@/lib/table/measurement';
import { useTableRoom } from './use-table-room';
import { useTokenKeyboard } from './use-token-keyboard';
import type { TableCanvasProps } from './table-canvas';
import TableLibrary from './table-library';
import SceneLibrary from './scene-library';
import TableMusicPanel from './table-music-panel';
import DiceTray from './dice-tray';
import { Dice5 } from 'lucide-react';
import { CloudFog } from 'lucide-react';
import FogControls, { type FogEdit } from './fog-controls';
import CombatPanel from './combat-panel';
import { assetUrl } from '@/lib/table/assets';
import './table.css';

export default function TableApp({ campaignId, testMode = false }: { campaignId: string; testMode?: boolean }) {
  const router = useRouter();
  const room = useTableRoom(campaignId);
  const [Canvas, setCanvas] = useState<ComponentType<TableCanvasProps> | null>(null);
  const [tool, setTool] = useState<'select' | 'pan' | 'draw' | 'erase' | 'measure'>('select');
  const [snap, setSnap] = useState(true), [selection, setSelection] = useState<string[]>([]);
  const [brushColor, setBrushColor] = useState('#d0ae72'), [brushWidth, setBrushWidth] = useState(4);
  function expandedSelection(ids: string[]) {
    const current = room.scene; if (!current) return [];
    const valid = ids.filter(id => current.tokens.some(token => token.id === id));
    const expanded = new Set(valid.flatMap(id => linkedTokens(current, current.tokens.find(token => token.id === id)!).map(token => token.id)));
    return [...expanded].filter(id => !valid.includes(id)).concat(valid);
  }
  const selectedIds = expandedSelection(selection);
  const selectedId = selectedIds.at(-1) ?? null;
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [measureMode, setMeasureMode] = useState<MeasureMode>('line');
  const [rulerMenuOpen, setRulerMenuOpen] = useState(false);
  const [rulerMenuTop, setRulerMenuTop] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [diceOpen, setDiceOpen] = useState(false);
  const [fogOpen,setFogOpen]=useState(false),[fogEdit,setFogEdit]=useState<FogEdit|null>(null);
  const [combatOpen,setCombatOpen]=useState(false);
  const [gmFogOpacity,setGmFogOpacity]=useState(.1);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  useEffect(()=>{try{const opacity=localStorage.getItem('tavern-gm-fog-opacity');if(opacity!==null&&Number.isFinite(Number(opacity)))setGmFogOpacity(Math.max(0,Math.min(1,Number(opacity))));setCombatOpen(localStorage.getItem('tavern-combat-open:'+campaignId)==='true');}finally{setPreferencesLoaded(true);}},[campaignId]);
  useEffect(()=>{if(preferencesLoaded)localStorage.setItem('tavern-combat-open:'+campaignId,String(combatOpen));},[combatOpen,campaignId,preferencesLoaded]);
  const [timezone, setTimezone] = useState('UTC');
  useTokenKeyboard({ scene: room.scene, actor: room.bootstrap?.actor, selectedId, connection: room.connection, pending: room.pending,
    motionStore: room.motionStore, startMotion: room.startMotion, previewMotion: room.previewMotion, endMotion: room.endMotion, removeToken, duplicateToken });
  useEffect(() => {
    let active = true;
    void import('./table-canvas').then(module => { if (active) setCanvas(() => module.default); });
    const frame = requestAnimationFrame(() => {
      const saved = localStorage.getItem('tavern-theme') === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = saved; setTheme(saved);
      const zone = localStorage.getItem('tavern-timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try { new Intl.DateTimeFormat('ru-RU', { timeZone: zone }).format(); setTimezone(zone); } catch { setTimezone('UTC'); }
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, []);
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    document.documentElement.dataset.theme = next; localStorage.setItem('tavern-theme', next);
  }
  const back = () => router.push('/' + (campaignId ? '?campaign=' + encodeURIComponent(campaignId) : ''));
  if (room.entryError || (!room.bootstrap && room.connection === 'offline')) return <div className="table-app"><div className="table-empty"><Layers size={40}/><h1>Ваш игровой стол</h1><p>{room.entryError || 'Не удалось подключиться.'}</p><div><button className="primary" onClick={back}>Открыть календарь</button> <button className="small-button" onClick={room.reconnect}>Повторить</button></div></div></div>;
  const { scene, bootstrap } = room;
  const actor = bootstrap?.actor, master = actor?.role === 'master';
  const selected = scene?.tokens.find(token => token.id === selectedId);
  const canMove = !!(actor && selected && scene && linkedTokens(scene, selected).every(token => canMoveToken(token, actor)));
  const disabled = room.connection !== 'connected' || room.pending;
  const previewing = master && scene?.id !== room.activeSceneId;
  const activeSceneName = room.scenes.find(value => value.id === room.activeSceneId)?.name;
  const shownScene = scene;
  function move(token: TableToken, point: Point) {
    if (!room.startMotion(token)) return false;
    room.previewMotion(token, point, 85); room.endMotion(token.id); return true;
  }
  function chooseMeasureMode(mode: MeasureMode) {
    setMeasureMode(mode); setTool(mode === 'move' ? 'select' : 'measure'); setRulerMenuOpen(false);
  }
  function toggleRulerMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const main = event.currentTarget.closest('.table-main')?.getBoundingClientRect();
    if (main) {
      const halfMenu = Math.min(123, Math.max(0, main.height / 2 - 12));
      const center = bounds.top + bounds.height / 2 - main.top;
      setRulerMenuTop(Math.max(halfMenu + 12, Math.min(center, main.height - halfMenu - 12)));
    }
    if (tool !== 'measure') setTool('measure');
    if (measureMode === 'move') setMeasureMode('line');
    setRulerMenuOpen(open => !open);
  }
  function removeToken(token: TableToken) {
    const tokens = scene?.tokens.filter(value => selectedIds.includes(value.id)) ?? [];
    return tokens.length > 1
      ? room.send({ type: 'remove-many', tokens: tokens.map(value => ({ tokenId: value.id, expectedVersion: value.version })) })
      : room.send({ type: 'remove', tokenId: token.id, expectedVersion: token.version });
  }
  function duplicateToken(token: TableToken) {
    return room.send({ type: 'duplicate', tokenId: token.id, expectedVersion: token.version });
  }
  function selectToken(id: string | null, additive = false) {
    if (!id || !scene) { if (!additive) setSelection([]); return; }
    const token = scene.tokens.find(value => value.id === id); if (!token) return;
    const ids = linkedTokens(scene, token).map(value => value.id);
    // Keep the clicked token primary in the inspector, even if its group anchor differs.
    const ordered = [...ids.filter(value => value !== id), id];
    setSelection(current => {
      const expanded = expandedSelection(current);
      return additive ? (ids.every(value => expanded.includes(value)) ? expanded.filter(value => !ids.includes(value)) : [...expanded.filter(value => !ids.includes(value)), ...ordered]) : ordered;
    });
  }
  function selectMany(ids: string[], additive = false) {
    if (!scene) return;
    const expanded = new Set<string>();
    for (const id of ids) {
      const token = scene.tokens.find(value => value.id === id);
      if (token) for (const member of linkedTokens(scene, token)) expanded.add(member.id);
    }
    setSelection(current => [...new Set([...(additive ? current : []), ...expanded])]);
  }
  function updateToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    room.send({ type: 'update', tokenId: selected.id, expectedVersion: selected.version,
      name: String(form.get('name')), size: Number(form.get('size')), ownerId: String(form.get('ownerId')) || null });
  }
  function tokenAction(token: TableToken, action: string, value?: string | boolean | number) {
    if (disabled || !scene) return;
    if (action === 'visibility') {
      if (actor?.role !== 'master') return;
      return room.send({ type: 'vision', tokenId: token.id, expectedVersion: token.version,
        visionFeet: token.visionFeet ?? 60, hidden: !token.hidden });
    }
    if (action === 'duplicate' || action === 'delete') {
      return room.send({ type: action === 'delete' ? 'remove' : 'duplicate', tokenId: token.id, expectedVersion: token.version });
    }
    const patch: Partial<TableToken> = {};
    if (action === 'resize' && typeof value === 'number' && Number.isFinite(value)) patch.size = Math.max(0.5, Math.min(3, value));
    else if (action === 'smaller' || action === 'larger') patch.size = Math.max(0.5, Math.min(3, token.size + (action === 'larger' ? 0.5 : -0.5)));
    else if (action === 'rotate') patch.rotation = ((token.rotation ?? 0) + 45) % 360;
    else if (action === 'lock') patch.locked = !token.locked;
    else if (action === 'front') patch.layer = Math.min(10000, Math.max(0, ...scene.tokens.map(value => value.layer ?? 0)) + 1);
    else if (action === 'back') patch.layer = Math.max(-10000, Math.min(0, ...scene.tokens.map(value => value.layer ?? 0)) - 1);
    else if (action === 'label' && typeof value === 'boolean') patch.showLabel = value;
    else if (action === 'label' && typeof value === 'string') { const name = value.trim(); if (!name || name.length > 40) return; patch.name = name; }
    else if (action === 'status' && typeof value === 'string') {
      const statuses = token.statuses ?? [];
      if (value === 'clear') patch.statuses = [];
      else if (/^exhaustion:[1-6]$/.test(value)) {
        patch.statuses = statuses.includes('exhaustion') ? [...statuses] : [...statuses, 'exhaustion'];
        patch.exhaustionLevel = Number(value.split(':')[1]);
      } else if (CONDITION_IDS.includes(value as ConditionId)) {
        const id = value as ConditionId;
        patch.statuses = statuses.includes(id) ? statuses.filter(status => status !== id) : [...statuses, id];
        if (id === 'exhaustion' && !statuses.includes(id)) patch.exhaustionLevel = 1;
      } else return;
    }
    else return;
    return room.send({ type: 'update', tokenId: token.id, expectedVersion: token.version,
      name: token.name, size: token.size, ownerId: token.ownerId, ...patch });
  }
  return <div className="table-app">
    <header className="table-header"><button className="table-back" onClick={back} aria-label="Вернуться к календарю"><ArrowLeft size={18}/><span>Календарь</span></button><div className="table-title"><h1>{bootstrap?.campaign.name || 'Игровой стол'}</h1><small>{testMode ? 'Тест · Виртуальный стол' : 'Виртуальный стол'} · {master ? 'За ширмой мастера' : 'Место игрока'}</small></div><span className="table-connection" data-state={room.connection} role="status">{room.connection === 'connected' ? 'В сети' : room.connection === 'connecting' ? 'Подключаемся…' : 'Нет соединения'}</span><button className="table-theme-button" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button></header>
    {testMode && <div className="table-test-notice"><strong>Тест</strong><span>Экспериментальный виртуальный стол. Сцены и материалы сохраняются отдельно от календаря.</span></div>}
    {room.error && <div className="table-error" role="alert">{room.error} <button className="text-button" onClick={room.clearError}>Закрыть</button></div>}
    {room.connection === 'offline' && scene && <div className="table-notice">Соединение потеряно. На карте — последнее подтверждённое состояние. <button className="text-button" onClick={room.reconnect}><RefreshCw size={14}/>Подключиться</button></div>}
    {previewing && scene && <div className="scene-preview-notice" role="status"><span>За ширмой: <strong>{scene.name}</strong>. Группа остаётся на сцене «{activeSceneName}».</span><button className="small-button" disabled={disabled} onClick={() => room.send({ type: 'scene-activate', targetSceneId: scene.id })}>Показать группе</button><button className="text-button" disabled={disabled} onClick={() => room.send({ type: 'scene-view', targetSceneId: room.activeSceneId })}>Вернуться к группе</button></div>}
    <div className="table-main">
      {Canvas && shownScene && actor ? <Canvas key={shownScene.id} scene={shownScene} actor={actor} selectedId={selectedId} tool={tool} measureMode={measureMode} snap={snap} pending={disabled || !!room.playerViewId} selectedIds={selectedIds} onSelect={selectToken} onSelectMany={selectMany} brushColor={brushColor} brushWidth={brushWidth} onDraw={drawing => room.send({ type: 'draw', drawing })} onErase={drawingId => room.send({ type: 'erase', drawingId })} onMove={move} onTokenAction={tokenAction} measurements={room.measurements} onMeasurement={room.sendMeasurement} gmFogOpacity={gmFogOpacity} fogEdit={fogEdit} onFogGesture={(mode,from,to)=>{if(mode==="wall"||mode==="door")room.send({type:"wall-set",wall:{id:crypto.randomUUID(),a:from,b:to,door:mode==="door",open:false}});else room.send({type:"fog-area",area:{id:crypto.randomUUID(),x:Math.min(from.x,to.x),y:Math.min(from.y,to.y),width:Math.abs(to.x-from.x)||1,height:Math.abs(to.y-from.y)||1,reveal:mode==="reveal"}});}} motionStore={room.motionStore} onMotionStart={room.startMotion} onMotionPreview={room.previewMotion} onMotionEnd={room.endMotion}/> : <div className="table-stage-wrap"><div className="table-stage-loading">Готовим карту и фигурки…</div></div>}
      <aside className="table-tools" aria-label="Инструменты карты" role="toolbar">
        <button className="table-tool" title="Перемещение карты" aria-label="Перемещение карты" aria-pressed={tool === 'pan'} onClick={() => { setTool(tool === 'pan' ? 'select' : 'pan'); setRulerMenuOpen(false); }}><Hand size={21}/></button>
        <button className="table-tool" title="Выбор токенов" aria-label="Выбор токенов" aria-pressed={tool === 'select' && measureMode !== 'move'} onClick={() => { setTool('select'); setMeasureMode('line'); setRulerMenuOpen(false); }}><MousePointer2 size={20}/></button>
        <button className="table-tool" title="Кисть" aria-label="Кисть" aria-pressed={tool === 'draw'} onClick={() => { setTool('draw'); setRulerMenuOpen(false); }}><Pencil size={20}/></button>
        <button className="table-tool" title="Линейка и AoE" aria-label="Линейка и AoE" aria-pressed={tool === 'measure' || measureMode === 'move'} aria-expanded={rulerMenuOpen} aria-controls="table-ruler-menu" onClick={toggleRulerMenu}><Ruler size={20}/></button>
        <button className="table-tool" title="Ластик" aria-label="Ластик" aria-pressed={tool === 'erase'} onClick={() => { setTool('erase'); setRulerMenuOpen(false); }}><Eraser size={20}/></button>
        <span className="table-tool-separator" aria-hidden="true"/>
        <button className="table-tool" title="Привязка к клеткам" aria-label="Привязка к клеткам" aria-pressed={snap} onClick={() => setSnap(value => !value)}><Grid2X2 size={20}/></button>
        <button className="table-tool" title="Добавить токен" aria-label="Добавить токен" disabled={disabled} onClick={() => room.send({ type: 'add', ownerId: actor?.userId ?? null })}><Plus size={22}/></button>
        <button className="table-tool" title="Библиотека материалов" aria-label="Библиотека материалов" onClick={() => setLibraryOpen(true)}><FolderOpen size={21}/></button>
        <button className="table-tool" title={room.music?.playing ? 'Общая музыка — играет' : 'Общая музыка'} aria-label="Общая музыка" aria-pressed={musicOpen} aria-expanded={musicOpen} aria-controls="table-music-panel" onClick={() => setMusicOpen(value => !value)}><Music2 size={20}/></button>
        <button className="table-tool" title={panelOpen ? 'Закрыть панель стола' : 'Открыть панель стола'} aria-label={panelOpen ? 'Закрыть панель стола' : 'Открыть панель стола'} aria-pressed={panelOpen} onClick={() => setPanelOpen(value => !value)}>{panelOpen ? <PanelRightClose size={20}/> : <PanelRightOpen size={20}/>}</button>
      </aside>
      <div className="vtt-quick-tools"><button className="table-tool" aria-label="Инициатива и бой" title="Инициатива и бой" aria-expanded={combatOpen} onClick={()=>{setCombatOpen(value=>!value);setFogOpen(false);setFogEdit(null);setDiceOpen(false);setMusicOpen(false);}}><Swords size={20}/>{!combatOpen&&scene?.combat?.running&&<span className="combat-mini">Р{scene.combat.round} · {scene.tokens.find(t=>t.id===scene.combat.entries.find(e=>e.id===scene.combat.currentId)?.tokenId)?.name??"Скрытый ход"}</span>}</button>{master&&<button className="table-tool" title="Туман войны" aria-label="Туман войны" onClick={()=>{setFogOpen(value=>!value);setDiceOpen(false);setCombatOpen(false);setMusicOpen(false);}}><CloudFog size={20}/></button>}<button className="table-tool" title="Кубики" aria-label="Кубики" aria-expanded={diceOpen} onClick={()=>{setDiceOpen(value=>!value);setFogOpen(false);setFogEdit(null);setCombatOpen(false);setMusicOpen(false);}}><Dice5 size={20}/></button></div>
      {master&&fogOpen&&scene&&<FogControls gmOpacity={gmFogOpacity} onGmOpacity={value=>{setGmFogOpacity(value);localStorage.setItem("tavern-gm-fog-opacity",String(value));}} scene={scene} roster={bootstrap?.roster??[]} selectedId={selectedId} preview={room.playerViewId??null} edit={fogEdit} setEdit={mode=>{setFogEdit(mode);setTool("select");}} disabled={disabled} send={room.send} onClose={()=>{setFogOpen(false);setFogEdit(null);}}/>}{scene&&actor&&<CombatPanel open={combatOpen} scene={scene} actor={actor} selectedId={selectedId} disabled={disabled||!!room.playerViewId} send={room.send} onSelect={id=>selectToken(id)} onClose={()=>setCombatOpen(false)}/>}<DiceTray timezone={timezone} rolls={room.rolls} connected={room.connection==="connected"} open={diceOpen} master={master} disabled={disabled} send={room.send} onClose={()=>setDiceOpen(false)}/>
      <TableMusicPanel music={room.music} disabled={disabled} hidden={!musicOpen} send={room.send} onClose={() => setMusicOpen(false)}/>
      {rulerMenuOpen && <div id="table-ruler-menu" className="table-ruler-menu" style={{ top: rulerMenuTop }} role="group" aria-label="Режим линейки">
        {([['line', 'Линейка', Ruler], ['cone', 'Конус', Cone], ['sphere', 'Сфера', Circle], ['square', 'Квадрат', Square], ['move', 'Линейка движения токена', Route]] as const).map(([mode, label, Icon]) => <button key={mode} type="button" className="table-tool" aria-label={label} title={label} aria-pressed={measureMode === mode} onClick={() => chooseMeasureMode(mode)}><Icon size={19}/></button>)}
      </div>}
      {panelOpen && <><button className="table-inspector-backdrop" aria-label="Закрыть панель стола" onClick={() => setPanelOpen(false)}/><aside className="table-inspector" aria-label="Настройки игрового стола">
        <div className="table-inspector-heading"><strong>Настройки стола</strong><button className="table-tool" aria-label="Закрыть панель стола" onClick={() => setPanelOpen(false)}><X size={19}/></button></div>
        {master && scene && <SceneLibrary scenes={room.scenes} activeSceneId={room.activeSceneId} viewedSceneId={scene.id} disabled={disabled} send={room.send}/>}
        <section className="table-card"><div className="table-section-heading"><Layers size={17}/> Сцена</div><h2>{scene?.name || 'Готовим таверну…'}</h2><p>Поле 1600 × 1120 px · {scene?.mapAssetId ? 'ваша карта' : 'карта таверны'}. Карта, сетка и токены сохраняются для этой кампании.</p><button className="small-button library-open-button" onClick={() => setLibraryOpen(true)}><FolderOpen size={16}/> Открыть библиотеку</button>{master && scene?.mapAssetId && <button className="text-button" disabled={disabled} onClick={() => room.send({ type: 'map', assetId: null })}>Вернуть карту таверны</button>}<span className="table-chip">{scene?.tokens.length ?? 0} токенов · ревизия {scene?.revision ?? 0}</span>
          {scene && <form key={`${scene.gridSize}:${scene.gridVisible}:${scene.gridColor}:${scene.gridOpacity}`} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); room.send({ type: 'grid', gridSize: Number(form.get('gridSize')), gridVisible: form.get('gridVisible') === 'yes', gridColor: String(form.get('gridColor')), gridOpacity: Number(form.get('gridOpacity')) / 100 }); }}><div className="table-field-row"><label>Размер клетки<select name="gridSize" defaultValue={scene.gridSize} disabled={!master || disabled}>{[40, 60, 80, 100, 120].map(value => <option key={value} value={value}>{value} px</option>)}</select></label><label>Сетка<select name="gridVisible" defaultValue={scene.gridVisible ? 'yes' : 'no'} disabled={!master || disabled}><option value="yes">Включена</option><option value="no">Скрыта</option></select></label></div><div className="table-field-row table-grid-style"><label>Цвет линий<input type="color" name="gridColor" defaultValue={scene.gridColor} disabled={!master || disabled}/></label><label>Прозрачность<input type="range" name="gridOpacity" min="0" max="100" step="1" defaultValue={Math.round(scene.gridOpacity * 100)} disabled={!master || disabled}/></label></div>{master && <button className="small-button" disabled={disabled}>Применить сетку</button>}</form>}
        </section>
        <section className="table-card"><div className="table-section-heading"><Users size={17}/> За столом · {room.peers.length}</div><div className="table-participants">{room.peers.map(peer => <span className="table-chip" key={peer.userId}>{peer.name}{peer.role === 'master' ? ' · мастер' : ''}</span>)}</div><p>{'Все участники могут добавлять, двигать, редактировать и удалять любые токены. Настройки сцены меняет мастер.'}</p></section>
        {(tool === 'draw' || tool === 'erase') && <section className="table-card table-brush-card"><h2>{tool === 'draw' ? 'Кисть' : 'Ластик'}</h2>
          {tool === 'draw' ? <div className="table-field-row"><label>Цвет<input type="color" value={brushColor} onChange={event => setBrushColor(event.target.value)}/></label><label>Толщина<select value={brushWidth} onChange={event => setBrushWidth(Number(event.target.value))}>{[2, 4, 8, 12].map(width => <option value={width} key={width}>{width} px</option>)}</select></label></div> : <p>Нажмите на линию, чтобы стереть весь штрих.</p>}
          <p>Рисунки видны всем участникам и сохраняются на сцене.</p>
        </section>}
        <section className="table-card"><h2>{selectedIds.length > 1 ? `Выбрано токенов: ${selectedIds.length}` : selected ? 'Выбранный токен' : 'Токены сцены'}</h2>
          {selected && <div className="table-selection-actions">
            <button className="small-button" disabled={disabled || selectedIds.length < 2} onClick={() => room.send({ type: 'group', tokenIds: selectedIds })}><Link2 size={16}/> Склеить</button>
            <button className="small-button" disabled={disabled || !scene?.tokens.some(token => selectedIds.includes(token.id) && token.groupId)} onClick={() => room.send({ type: 'ungroup', tokenIds: selectedIds })}><Unlink2 size={16}/> Разъединить</button>
            {selectedIds.length > 1 && <button className="text-button" onClick={() => setSelection([])}>Снять выделение</button>}
          </div>}
          {selected && <><div className="table-token-heading"><span className="table-token-avatar" style={{ borderColor: selected.color }}>{selected.assetId ? <img src={assetUrl(campaignId, selected.assetId)} alt=""/> : selected.name.slice(0, 2)}</span><strong>{selected.name}</strong></div><p>X {Math.round(selected.x)} · Y {Math.round(selected.y)} · {selected.size} клетки</p>
            <div className="table-nudge" aria-label="Переместить выбранный токен">{[{ x: -1, y: 0, icon: MoveLeft, label: 'Влево' }, { x: 0, y: -1, icon: ArrowUp, label: 'Вверх' }, { x: 0, y: 1, icon: ArrowDown, label: 'Вниз' }, { x: 1, y: 0, icon: ArrowRight, label: 'Вправо' }].map(({ x, y, icon: Icon, label }) => <button className="small-button" key={label} aria-label={label} disabled={!canMove || disabled} onClick={() => move(selected, { x: selected.x + x * scene!.gridSize, y: selected.y + y * scene!.gridSize })}><Icon size={16}/></button>)}</div><p className="table-keyboard-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — шаг на клетку · удерживайте для движения</p>
            <form key={selected.id + ':' + selected.name + ':' + selected.size + ':' + selected.ownerId} onSubmit={updateToken}><label>Имя токена<input name="name" defaultValue={selected.name} maxLength={40} required disabled={disabled}/></label><div className="table-field-row"><label>Размер<input name="size" type="number" defaultValue={selected.size} min={0.5} max={3} step={0.01} inputMode="decimal" required disabled={disabled}/></label><label>Владелец<select name="ownerId" defaultValue={selected.ownerId ?? ''} disabled={disabled}><option value="">Мастер</option>{bootstrap?.roster.map(member => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select></label></div><button className="small-button" disabled={disabled}>Сохранить токен</button></form>
            <button className="table-action table-delete-token" disabled={disabled} onClick={() => removeToken(selected)}><Trash2 size={16}/> {selectedIds.length > 1 ? 'Удалить выбранные' : 'Удалить с карты'} <kbd>Del</kbd></button>
          </>}
          <div className="table-token-list" aria-label="Список токенов">{scene?.tokens.map(token => <button key={token.id} aria-pressed={selectedIds.includes(token.id)} onClick={event => selectToken(token.id, event.shiftKey)}><span style={{ color: token.color }}>●</span><span>{token.name}</span><small>{token.groupId ? 'В группе' : 'Выбрать'}</small></button>)}</div>
        </section>
        {master && <section className="table-card"><div className="table-section-heading"><Swords size={17}/> Проверка большой сцены</div><p>Добавляет фигуры до 100, сохраняя существующие токены.</p><button className="small-button" disabled={disabled || (scene?.tokens.length ?? 0) >= 100} onClick={() => room.send({ type: 'benchmark' })}>Добавить до 100 токенов</button></section>}
        <div className="table-shortcuts"><kbd>W A S D</kbd> — двигать выбранный токен (Ц Ф Ы В)<br/><kbd>СКМ</kbd> или <kbd>Пробел</kbd> + перетаскивание — камера<br/><kbd>Ctrl</kbd> / <kbd>Alt</kbd> — двигать без привязки<br/><kbd>Del</kbd> — удалить выбранные токены<br/><kbd>Shift</kbd> + клик — добавить к выбору<br/>Рамка на пустом месте — выбрать несколько<br/>Колесо или жест — масштаб</div>
      </aside></>}
    </div>{libraryOpen && actor && <TableLibrary campaignId={campaignId} actor={actor} version={room.libraryVersion} disabled={disabled} actionError={room.error} onClose={() => setLibraryOpen(false)} onAdd={asset => room.send({ type: 'add', ownerId: actor.userId, assetId: asset.id, name: asset.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Токен' })} onMap={asset => room.send({ type: 'map', assetId: asset.id })}/>}<footer className="table-status-bar"><span>Таверна · игровой стол</span><span>{scene ? `Сохранено в ${new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(scene.updatedAt)}` : 'Подключение к кампании…'}</span><span>Карта · токены · общая сцена</span></footer>
  </div>;
}
