'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { Music2, Play, Pause, Plus, Trash2, X } from 'lucide-react';
import { parseYouTubeVideoId } from '@/lib/table/youtube';
import type { MusicState } from '@/lib/table/room';
import type { CommandInput } from './use-table-room';

export default function TableMusicPanel({ music, disabled, hidden, send, onClose }: {
  music: MusicState; disabled: boolean; hidden: boolean;
  send: (command: CommandInput) => boolean; onClose: () => void;
}) {
  const [url, setUrl] = useState(''), [label, setLabel] = useState(''), [error, setError] = useState('');
  const current = music.tracks.find(track => track.id === music.currentTrackId);
  const position = music.playing && music.startedAt !== null ? music.positionSeconds + Math.max(0, Date.now() - music.startedAt) / 1000 : music.positionSeconds;
  const videoId = current?.videoId;
  // Keep the iframe source stable during unrelated room updates. Changing start
  // on every render navigates the iframe and interrupts playback.
  const frameUrl = useMemo(() => {
    if (!videoId) return '';
    const start = music.positionSeconds + (music.playing && music.startedAt !== null ? Math.max(0, Date.now() - music.startedAt) / 1000 : 0);
    return `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${encodeURIComponent(typeof window === 'undefined' ? '' : window.location.origin)}&controls=1&playsinline=1&autoplay=${music.playing ? 1 : 0}&start=${Math.floor(start)}`;
  }, [videoId, current?.id, music.playing, music.positionSeconds, music.startedAt]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const videoId = parseYouTubeVideoId(url);
    if (!videoId) { setError('Вставьте ссылку на YouTube-видео или его ID.'); return; }
    if (send({ type: 'music-add', videoId, ...(label.trim() ? { label: label.trim() } : {}) })) { setUrl(''); setLabel(''); }
  }
  function togglePlayback() {
    if (!current) return;
    send(music.playing
      ? { type: 'music-pause', trackId: current.id, positionSeconds: Math.floor(position) }
      : { type: 'music-play', trackId: current.id, positionSeconds: Math.floor(position) });
  }
  return <section id="table-music-panel" className="table-music-panel" aria-label="Музыка стола" hidden={hidden}>
    <header><strong><Music2 size={17}/> Музыка</strong><button className="table-tool" aria-label="Скрыть окно музыки" title="Скрыть окно — музыка продолжит играть" onClick={onClose}><X size={18}/></button></header>
    {current ? <div className="table-music-player">
      <div className="table-music-track"><strong>{current.title ?? current.label ?? current.videoId}</strong><span>{music.playing ? 'Играет' : 'На паузе'}</span></div>
      <iframe key={`${current.id}:${music.playing}`} src={frameUrl} title={`YouTube: ${current.title ?? current.label ?? current.videoId}`} allow="autoplay; encrypted-media; picture-in-picture; clipboard-write" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
      <button className="small-button" disabled={disabled} onClick={togglePlayback}>{music.playing ? <Pause size={16}/> : <Play size={16}/>} {music.playing ? 'Пауза для всех' : 'Играть для всех'}</button>
      <small>Запуск синхронизируется через стол. Если браузер запретил автовоспроизведение, нажмите Play в плеере YouTube.</small>
    </div> : <p className="table-music-empty">Добавьте видео, чтобы включить общую музыку.</p>}
    <form className="table-music-form" onSubmit={submit}>
      <label>Ссылка на YouTube<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://youtu.be/…" /></label>
      <label>Метка (необязательно)<input value={label} onChange={event => setLabel(event.target.value)} placeholder="Например, бой или таверна" maxLength={60}/></label>
      <small className="table-music-title-hint">Название ролика подставится из YouTube; метку можно задать отдельно.</small>
      <button className="small-button" disabled={disabled}><Plus size={16}/> Добавить видео</button>
      {error && <p className="table-music-error" role="alert">{error}</p>}
    </form>
    <ul className="table-music-list">{music.tracks.map(track => <li key={track.id}>
      <button className="table-music-select" aria-current={current?.id === track.id ? 'true' : undefined} disabled={disabled} onClick={() => send({ type: 'music-select', trackId: track.id })}><span>{track.title ?? track.label ?? track.videoId}</span><small>{track.label ? `${track.label} · ` : ''}Добавил: {track.addedByName}</small></button>
      <button className="table-tool table-music-delete" title="Удалить видео" aria-label={`Удалить ${track.label}`} disabled={disabled} onClick={() => send({ type: 'music-remove', trackId: track.id })}><Trash2 size={16}/></button>
    </li>)}</ul>
  </section>;
}

