'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sceneSchema, tokenSchema, linkedTokens, type TableToken, type TableScene, type TableActor, type TableMember } from '@/lib/table/scene';
import { sceneSummarySchema, type SceneSummary, type RoomCommand } from '@/lib/table/room';
import { MotionStore, MOTION_INTERVAL, type MotionPoint } from '@/lib/table/motion';
import { HostedConnection, type RoomTransport } from './hosted-connection';

export type CommandInput = RoomCommand extends infer C ? C extends RoomCommand ? Omit<C, 'id' | 'baseRevision' | 'sceneId' | 'expectedRoomRevision'> : never : never;
export type Bootstrap = {
  user: { id: string; name: string }; campaign: { id: string; name: string };
  actor: TableActor; roster: TableMember[]; ticket: string; socketUrl: string; transport?: 'hosted';
};
export function useTableRoom(campaignId: string) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [scene, setScene] = useState<TableScene | null>(null);
  const [peers, setPeers] = useState<TableActor[]>([]);
  const [scenes, setScenes] = useState<SceneSummary[]>([]), [activeSceneId, setActiveSceneId] = useState('');
  const roomRevisionRef = useRef(0);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [entryError, setEntryError] = useState('');
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<{ tokenId: string; x: number; y: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const sceneRef = useRef<TableScene | null>(null), socketRef = useRef<RoomTransport | null>(null);
  const pendingRef = useRef<string | null>(null);
  const [motionPending, setMotionPending] = useState(false);
  const [motionStore] = useState(() => new MotionStore());
  type LocalMotion = { motionId: string; sceneId: string; tokenId: string; expectedVersion: number; seq: number; ending: boolean; timeout?: ReturnType<typeof setTimeout> };
  const localMotions = useRef(new Map<string, LocalMotion>());
  const resetMotions = useCallback(() => {
    for (const motion of localMotions.current.values()) clearTimeout(motion.timeout);
    localMotions.current.clear(); motionStore.clear(); setMotionPending(false);
  }, [motionStore]);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, refresh: ReturnType<typeof setInterval>;
    const controller = new AbortController();
    let attempt = 0;
    const endpoint = '/api/table?campaign=' + encodeURIComponent(campaignId);
    async function credentials() {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
      const result = await response.json() as Bootstrap & { error?: string };
      if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось открыть стол.'), { status: response.status });
      return result as Bootstrap;
    }
    async function connect() {
      if (stopped) return;
      setConnection('connecting'); setEntryError(''); setPending(false); setOptimistic(null); pendingRef.current = null; resetMotions();
      try {
        const value = await credentials(); if (stopped) return;
        setBootstrap(value);
        const socket: RoomTransport = value.transport === 'hosted' ? new HostedConnection(campaignId) : new WebSocket(value.socketUrl); socketRef.current = socket;
        let joined = false;
        socket.onopen = () => { socket.send(JSON.stringify({ type: 'hello', ticket: value.ticket })); };
        socket.onmessage = event => {
          if (stopped) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'snapshot') {
              if (!joined) { joined = true; setError(''); }
              const received = sceneSchema.parse(message.scene);
              const summaries = sceneSummarySchema.array().parse(message.scenes);
              setScenes(summaries); setActiveSceneId(message.activeSceneId); roomRevisionRef.current = message.roomRevision;
              if (sceneRef.current?.id !== received.id) { pendingRef.current = null; setPending(false); setOptimistic(null); resetMotions(); }
              if (message.commandId && localMotions.current.has(message.commandId)) { const motion = localMotions.current.get(message.commandId)!; clearTimeout(motion.timeout); localMotions.current.delete(message.commandId); motionStore.cancelMotion(motion.motionId); setMotionPending(localMotions.current.size > 0); }
              sceneRef.current = received; setScene(received); setPeers(message.peers);
              setBootstrap(previous => previous ? { ...previous, actor: message.actor, roster: message.roster } : previous);
              setConnection('connected'); attempt = 0;
              if (!pendingRef.current || message.commandId === pendingRef.current) { pendingRef.current = null; setPending(false); setOptimistic(null); }
            } else if (message.type === 'motion-started' || message.type === 'motion-frame') {
              const current = sceneRef.current, token = current?.tokens.find(value => value.id === message.tokenId);
              if (!current || current.id !== message.sceneId || !token || localMotions.current.has(message.motionId)) return;
              if (Number.isFinite(message.x) && Number.isFinite(message.y)) motionStore.updateGroup(current, token, message.motionId, message, { userId: message.userId, name: message.name });
            } else if (message.type === 'motion-committed') {
              const current = sceneRef.current;
              const own = localMotions.current.get(message.motionId);
              if (own) { clearTimeout(own.timeout); localMotions.current.delete(message.motionId); setMotionPending(localMotions.current.size > 0); }
              if (!current || current.id !== message.sceneId) return;
              const committed = tokenSchema.array().parse(message.tokens ?? [message.token]);
              const changed = new Map<string, TableToken>();
              for (const token of committed) {
                const previous = current.tokens.find(value => value.id === token.id);
                if (!previous || token.version < previous.version) continue;
                motionStore.finish(token.id, message.motionId, token, previous); changed.set(token.id, token);
              }
              const next = { ...current, revision: Math.max(current.revision, message.sceneRevision), updatedAt: Math.max(current.updatedAt, message.updatedAt), tokens: current.tokens.map(value => changed.get(value.id) ?? value) };
              sceneRef.current = next; setScene(next);
            } else if (message.type === 'motion-cancelled' || message.type === 'motion-rejected') {
              motionStore.cancelMotion(message.motionId);
              const own = localMotions.current.get(message.motionId);
              if (own) { clearTimeout(own.timeout); localMotions.current.delete(message.motionId); setMotionPending(localMotions.current.size > 0); }
              if (message.type === 'motion-rejected' && own) setError(message.message);
            } else if (message.type === 'presence') setPeers(message.peers);
            else if (message.type === 'library-changed') setLibraryVersion(value => value + 1);
            else if (message.type === 'error') {
              setError(message.message);
              if (!message.commandId || !pendingRef.current || message.commandId === pendingRef.current) { pendingRef.current = null; setPending(false); setOptimistic(null); }
            }
          } catch { setError('Получено некорректное состояние сцены. Переподключитесь.'); }
        };
        socket.onerror = () => { if (!stopped) setError('Соединение со столом прервано.'); };
        socket.onclose = () => {
          clearInterval(refresh);
          if (stopped) return;
          setConnection('offline'); setPending(false); setOptimistic(null); pendingRef.current = null; resetMotions();
          timer = setTimeout(() => void connect(), Math.min(8000, 1000 * 2 ** attempt++));
        };
        refresh = setInterval(() => { void credentials().then(next => {
          if (!stopped && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'hello', ticket: next.ticket }));
        }).catch(() => socket.close()); }, 40000);
      } catch (failure) {
        if (stopped) return;
        setConnection('offline');
        const message = failure instanceof Error ? failure.message : 'Не удалось подключиться.';
        if (failure instanceof Error && 'status' in failure) setEntryError(message);
        else {
          setError('Локальный сервер недоступен. Повторяем подключение…');
          timer = setTimeout(() => void connect(), Math.min(8000, 1000 * 2 ** attempt++));
        }
      }
    }
    void connect();
    return () => { stopped = true; clearTimeout(timer); clearInterval(refresh); controller.abort(); socketRef.current?.close(); socketRef.current = null; resetMotions(); };
  }, [campaignId, retry, resetMotions, motionStore]);
  const startMotion = useCallback((token: TableToken) => {
    const socket = socketRef.current, scene = sceneRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !scene || pendingRef.current) return false;
    const grabbed = scene.tokens.find(value => value.id === token.id); if (!grabbed) return false;
    if (linkedTokens(scene, grabbed).some(member => member.locked)) { setError('Движение этой фигуры или её группы заблокировано.'); return false; }
    token = linkedTokens(scene, grabbed)[0];
    const track = motionStore.tracks.get(token.id);
    if (track && !track.local && !track.finished && track.expires > performance.now()) { setError('Этот токен сейчас двигает другой участник.'); return false; }
    const previous = [...localMotions.current.values()].filter(value => value.tokenId === token.id && value.sceneId === scene.id);
    if (previous.some(value => !value.ending)) return true;
    const canonical = scene.tokens.find(value => value.id === token.id); if (!canonical) return false;
    const motion: LocalMotion = { motionId: crypto.randomUUID(), sceneId: scene.id, tokenId: token.id,
      expectedVersion: Math.max(canonical.version, ...previous.map(value => value.expectedVersion + 1)), seq: 0, ending: false };
    const point = motionStore.target(canonical);
    localMotions.current.set(motion.motionId, motion); setMotionPending(true); setError('');
    motionStore.updateGroup(scene, canonical, motion.motionId, point, { local: true });
    socket.send(JSON.stringify({ type: 'motion-start', motionId: motion.motionId, sceneId: scene.id, tokenId: token.id, expectedVersion: motion.expectedVersion }));
    return true;
  }, [motionStore]);
  const previewMotion = useCallback((token: TableToken, point: MotionPoint, duration = 0) => {
    const scene = sceneRef.current;
    if (!scene) return false;
    const grabbed = scene.tokens.find(value => value.id === token.id); if (!grabbed) return false;
    const anchor = linkedTokens(scene, grabbed)[0];
    const motion = [...localMotions.current.values()].find(value => value.tokenId === anchor.id && !value.ending);
    if (!motion || motion.sceneId !== scene.id) return false;
    motionStore.updateGroup(scene, anchor, motion.motionId, { x: point.x + anchor.x - grabbed.x, y: point.y + anchor.y - grabbed.y }, { local: true, duration }); return true;
  }, [motionStore]);
  const endMotion = useCallback((tokenId: string) => {
    const scene = sceneRef.current, socket = socketRef.current;
    const grabbed = scene?.tokens.find(value => value.id === tokenId); if (!scene || !grabbed) return;
    const token = linkedTokens(scene, grabbed)[0]; tokenId = token.id;
    const motion = [...localMotions.current.values()].find(value => value.tokenId === tokenId && !value.ending);
    if (!motion || motion.sceneId !== scene.id || socket?.readyState !== WebSocket.OPEN) return;
    motion.ending = true;
    socket.send(JSON.stringify({ type: 'motion-end', motionId: motion.motionId, sceneId: motion.sceneId, tokenId, seq: ++motion.seq, ...motionStore.target(token) }));
    motion.timeout = setTimeout(() => { setError('Подтверждение движения задержалось. Восстанавливаем соединение…'); socket.close(); }, 10000);
  }, [motionStore]);
  useEffect(() => {
    const finish = () => { for (const motion of localMotions.current.values()) if (!motion.ending) endMotion(motion.tokenId); };
    const hidden = () => { if (document.hidden) finish(); };
    window.addEventListener('blur', finish); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', finish); document.removeEventListener('visibilitychange', hidden); };
  }, [endMotion]);
  useEffect(() => {
    const timer = setInterval(() => {
      const socket = socketRef.current, scene = sceneRef.current;
      if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65536 || !scene) return;
      for (const motion of localMotions.current.values()) if (!motion.ending && motion.sceneId === scene.id) {
        const token = scene.tokens.find(value => value.id === motion.tokenId); if (!token) continue;
        for (const member of linkedTokens(scene, token)) { const track = motionStore.tracks.get(member.id); if (track?.motionId === motion.motionId) track.expires = performance.now() + 4000; }
        socket.send(JSON.stringify({ type: 'motion-frame', motionId: motion.motionId, sceneId: motion.sceneId, tokenId: motion.tokenId, seq: ++motion.seq, ...motionStore.position(token.id, token) }));
      }
    }, MOTION_INTERVAL);
    return () => clearInterval(timer);
  }, [motionStore]);
  const send = useCallback((input: CommandInput) => {
    const socket = socketRef.current, current = sceneRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !current || pendingRef.current) return false;
    const id = crypto.randomUUID(); pendingRef.current = id; setPending(true); setError('');
    if (input.type === 'move') setOptimistic({ tokenId: input.tokenId, x: input.x, y: input.y });
    socket.send(JSON.stringify({ type: 'command', command: { ...input, id, baseRevision: current.revision, sceneId: current.id,
      ...(input.type.startsWith('scene-') ? { expectedRoomRevision: roomRevisionRef.current } : {}) } }));
    return true;
  }, []);
  return { bootstrap, scene, scenes, activeSceneId, peers, connection, error, entryError, pending, optimistic, send, libraryVersion, motionStore, motionPending, startMotion, previewMotion, endMotion,
    clearError: () => setError(''), reconnect: () => setRetry(value => value + 1) };
}
