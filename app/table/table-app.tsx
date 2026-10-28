'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { ArrowLeft, MousePointer2, Hand, Grid2X2, Plus, Sun, Moon, RefreshCw, ArrowUp, ArrowDown, ArrowRight, ArrowLeft as MoveLeft, Users, Layers, Swords, FolderOpen } from 'lucide-react';
import { canMoveToken, type TableToken } from '@/lib/table/scene';
import type { Point } from '@/lib/table/geometry';
import { useTableRoom } from './use-table-room';
import { useTokenKeyboard } from './use-token-keyboard';
import type { TableCanvasProps } from './table-canvas';
import TableLibrary from './table-library';
import SceneLibrary from './scene-library';
import { assetUrl } from '@/lib/table/assets';
import './table.css';

export default function TableApp({ campaignId, testMode = false }: { campaignId: string; testMode?: boolean }) {
  const router = useRouter();
  const room = useTableRoom(campaignId);
  const [Canvas, setCanvas] = useState<ComponentType<TableCanvasProps> | null>(null);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [snap, setSnap] = useState(true), [selectedId, setSelectedId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [timezone, setTimezone] = useState('UTC');
  useTokenKeyboard({ scene: room.scene, actor: room.bootstrap?.actor, selectedId, connection: room.connection, pending: room.pending,
    motionStore: room.motionStore, startMotion: room.startMotion, previewMotion: room.previewMotion, endMotion: room.endMotion });
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
  const canMove = !!(actor && selected && canMoveToken(selected, actor));
  const disabled = room.connection !== 'connected' || room.pending;
  const previewing = master && scene?.id !== room.activeSceneId;
  const activeSceneName = room.scenes.find(value => value.id === room.activeSceneId)?.name;
  const shownScene = scene;
  function move(token: TableToken, point: Point) {
    if (!room.startMotion(token)) return false;
    room.previewMotion(token, point, 85); room.endMotion(token.id); return true;
  }
  function updateToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    room.send({ type: 'update', tokenId: selected.id, expectedVersion: selected.version,
      name: String(form.get('name')), size: Number(form.get('size')), ownerId: String(form.get('ownerId')) || null });
  }
  return <div className="table-app">
    <header className="table-header"><button className="table-back" onClick={back} aria-label="Вернуться к календарю"><ArrowLeft size={18}/><span>Календарь</span></button><div className="table-title"><h1>{bootstrap?.campaign.name || 'Игровой стол'}</h1><small>{testMode ? 'Тест · Виртуальный стол' : 'Виртуальный стол'} · {master ? 'За ширмой мастера' : 'Место игрока'}</small></div><span className="table-connection" data-state={room.connection} role="status">{room.connection === 'connected' ? 'В сети' : room.connection === 'connecting' ? 'Подключаемся…' : 'Нет соединения'}</span><button className="table-theme-button" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button></header>
    {testMode && <div className="table-test-notice"><strong>Тест</strong><span>Экспериментальный виртуальный стол. Сцены и материалы сохраняются отдельно от календаря.</span></div>}
    {room.error && <div className="table-error" role="alert">{room.error} <button className="text-button" onClick={room.clearError}>Закрыть</button></div>}
    {room.connection === 'offline' && scene && <div className="table-notice">Соединение потеряно. На карте — последнее подтверждённое состояние. <button className="text-button" onClick={room.reconnect}><RefreshCw size={14}/>Подключиться</button></div>}
    {previewing && scene && <div className="scene-preview-notice" role="status"><span>За ширмой: <strong>{scene.name}</strong>. Группа остаётся на сцене «{activeSceneName}».</span><button className="small-button" disabled={disabled} onClick={() => room.send({ type: 'scene-activate', targetSceneId: scene.id })}>Показать группе</button><button className="text-button" disabled={disabled} onClick={() => room.send({ type: 'scene-view', targetSceneId: room.activeSceneId })}>Вернуться к группе</button></div>}
    <div className="table-main">
      <aside className="table-tools" aria-label="Инструменты карты"><button className="table-tool" title="Выбор токенов" aria-label="Выбор токенов" aria-pressed={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={20}/></button><button className="table-tool" title="Перемещение карты" aria-label="Перемещение карты" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')}><Hand size={21}/></button><button className="table-tool" title="Привязка к клеткам" aria-label="Привязка к клеткам" aria-pressed={snap} onClick={() => setSnap(value => !value)}><Grid2X2 size={20}/></button><button className="table-tool" title="Добавить токен" aria-label="Добавить токен" disabled={disabled} onClick={() => room.send({ type: 'add', ownerId: actor?.userId ?? null })}><Plus size={22}/></button><button className="table-tool" title="Библиотека материалов" aria-label="Библиотека материалов" onClick={() => setLibraryOpen(true)}><FolderOpen size={21}/></button></aside>
      {Canvas && shownScene && actor ? <Canvas key={shownScene.id} scene={shownScene} actor={actor} selectedId={selectedId} tool={tool} snap={snap} pending={disabled} onSelect={setSelectedId} onMove={move} motionStore={room.motionStore} onMotionStart={room.startMotion} onMotionPreview={room.previewMotion} onMotionEnd={room.endMotion}/> : <div className="table-stage-wrap"><div className="table-stage-loading">Готовим карту и фигурки…</div></div>}
      <aside className="table-inspector" aria-label="Настройки игрового стола">
        {master && scene && <SceneLibrary scenes={room.scenes} activeSceneId={room.activeSceneId} viewedSceneId={scene.id} disabled={disabled} send={room.send}/>}
        <section className="table-card"><div className="table-section-heading"><Layers size={17}/> Сцена</div><h2>{scene?.name || 'Готовим таверну…'}</h2><p>Поле 1600 × 1120 px · {scene?.mapAssetId ? 'ваша карта' : 'карта таверны'}. Карта, сетка и токены сохраняются для этой кампании.</p><button className="small-button library-open-button" onClick={() => setLibraryOpen(true)}><FolderOpen size={16}/> Открыть библиотеку</button>{master && scene?.mapAssetId && <button className="text-button" disabled={disabled} onClick={() => room.send({ type: 'map', assetId: null })}>Вернуть карту таверны</button>}<span className="table-chip">{scene?.tokens.length ?? 0} токенов · ревизия {scene?.revision ?? 0}</span>
          {scene && <form key={scene.gridSize + ':' + scene.gridVisible} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); room.send({ type: 'grid', gridSize: Number(form.get('gridSize')), gridVisible: form.get('gridVisible') === 'yes' }); }}><div className="table-field-row"><label>Размер клетки<select name="gridSize" defaultValue={scene.gridSize} disabled={!master || disabled}>{[40, 60, 80, 100, 120].map(value => <option key={value} value={value}>{value} px</option>)}</select></label><label>Сетка<select name="gridVisible" defaultValue={scene.gridVisible ? 'yes' : 'no'} disabled={!master || disabled}><option value="yes">Включена</option><option value="no">Скрыта</option></select></label></div>{master && <button className="small-button" disabled={disabled}>Применить сетку</button>}</form>}
        </section>
        <section className="table-card"><div className="table-section-heading"><Users size={17}/> За столом · {room.peers.length}</div><div className="table-participants">{room.peers.map(peer => <span className="table-chip" key={peer.userId}>{peer.name}{peer.role === 'master' ? ' · мастер' : ''}</span>)}</div><p>{'Все участники могут добавлять и двигать любые токены. Настройки сцены меняет мастер.'}</p></section>
        <section className="table-card"><h2>{selected ? 'Выбранный токен' : 'Токены сцены'}</h2>
          {selected && <><div className="table-token-heading"><span className="table-token-avatar" style={{ borderColor: selected.color }}>{selected.assetId ? <img src={assetUrl(campaignId, selected.assetId)} alt=""/> : selected.name.slice(0, 2)}</span><strong>{selected.name}</strong></div><p>X {Math.round(selected.x)} · Y {Math.round(selected.y)} · {selected.size} клетки</p>
            <div className="table-nudge" aria-label="Переместить выбранный токен">{[{ x: -1, y: 0, icon: MoveLeft, label: 'Влево' }, { x: 0, y: -1, icon: ArrowUp, label: 'Вверх' }, { x: 0, y: 1, icon: ArrowDown, label: 'Вниз' }, { x: 1, y: 0, icon: ArrowRight, label: 'Вправо' }].map(({ x, y, icon: Icon, label }) => <button className="small-button" key={label} aria-label={label} disabled={!canMove || disabled} onClick={() => move(selected, { x: selected.x + x * scene!.gridSize, y: selected.y + y * scene!.gridSize })}><Icon size={16}/></button>)}</div><p className="table-keyboard-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — шаг на клетку · удерживайте для движения</p>
            {master && <form key={selected.id + ':' + selected.name + ':' + selected.size + ':' + selected.ownerId} onSubmit={updateToken}><label>Имя токена<input name="name" defaultValue={selected.name} maxLength={40} required disabled={disabled}/></label><div className="table-field-row"><label>Размер<select name="size" defaultValue={selected.size} disabled={disabled}>{[0.5, 1, 2, 3].map(value => <option key={value} value={value}>{value} кл.</option>)}</select></label><label>Владелец<select name="ownerId" defaultValue={selected.ownerId ?? ''} disabled={disabled}><option value="">Мастер</option>{bootstrap?.roster.map(member => <option value={member.userId} key={member.userId}>{member.name}</option>)}</select></label></div><button className="small-button" disabled={disabled}>Сохранить токен</button></form>}
          </>}
          <div className="table-token-list" aria-label="Список токенов">{scene?.tokens.map(token => <button key={token.id} aria-pressed={selectedId === token.id} onClick={() => setSelectedId(token.id)}><span style={{ color: token.color }}>●</span><span>{token.name}</span><small>{'Двигать'}</small></button>)}</div>
        </section>
        {master && <section className="table-card"><div className="table-section-heading"><Swords size={17}/> Проверка большой сцены</div><p>Добавляет фигуры до 100, сохраняя существующие токены.</p><button className="small-button" disabled={disabled || (scene?.tokens.length ?? 0) >= 100} onClick={() => room.send({ type: 'benchmark' })}>Добавить до 100 токенов</button></section>}
        <div className="table-shortcuts"><kbd>W A S D</kbd> — двигать выбранный токен (Ц Ф Ы В)<br/><kbd>Пробел</kbd> + перетаскивание — камера<br/><kbd>Alt</kbd> — двигать без привязки<br/>Колесо или жест — масштаб</div>
      </aside>
    </div>{libraryOpen && actor && <TableLibrary campaignId={campaignId} actor={actor} version={room.libraryVersion} disabled={disabled} actionError={room.error} onClose={() => setLibraryOpen(false)} onAdd={asset => room.send({ type: 'add', ownerId: actor.userId, assetId: asset.id, name: asset.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Токен' })} onMap={asset => room.send({ type: 'map', assetId: asset.id })}/>}<footer className="table-status-bar"><span>Таверна · игровой стол</span><span>{scene ? `Сохранено в ${new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(scene.updatedAt)}` : 'Подключение к кампании…'}</span><span>Карта · токены · общая сцена</span></footer>
  </div>;
}
