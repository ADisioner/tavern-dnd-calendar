'use client';
import { useEffect, useRef } from 'react';
import { canMoveToken, type TableActor, type TableScene } from '@/lib/table/scene';
import type { TableToken } from '@/lib/table/scene';
import type { MotionStore, MotionPoint } from '@/lib/table/motion';

type KeyboardState = { scene: TableScene | null; actor: TableActor | undefined; selectedId: string | null;
  connection: string; pending: boolean; motionStore: MotionStore; startMotion: (token: TableToken) => boolean;
  previewMotion: (token: TableToken, point: MotionPoint, duration?: number) => boolean; endMotion: (tokenId: string) => void };
const directions: Record<string, { x: number; y: number }> = { KeyW: { x: 0, y: -1 }, KeyA: { x: -1, y: 0 }, KeyS: { x: 0, y: 1 }, KeyD: { x: 1, y: 0 } };
const editing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
export function useTokenKeyboard(state: KeyboardState) {
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);
  useEffect(() => {
    let held: string | null = null, lastStep = 0, timer: ReturnType<typeof setInterval> | null = null;
    let movingToken: string | null = null, movingScene: string | null = null;
    function stop() { held = null; if (timer) clearInterval(timer); timer = null; if (movingToken) latest.current.endMotion(movingToken); movingToken = null; movingScene = null; }
    function step() {
      if (!held || Date.now() - lastStep < 160) return;
      if (document.querySelector('dialog[open]') || editing(document.activeElement)) { stop(); return; }
      const { scene, actor, selectedId, connection, pending, motionStore, previewMotion } = latest.current;
      const token = scene?.tokens.find(value => value.id === selectedId);
      if (!scene || !actor || !token || token.id !== movingToken || scene.id !== movingScene || !canMoveToken(token, actor) || connection !== 'connected') { stop(); return; }
      if (pending) return;
      const direction = directions[held];
      const current = motionStore.target(token);
      const radius = token.size * scene.gridSize / 2;
      const x = Math.max(radius, Math.min(scene.width - radius, current.x + direction.x * scene.gridSize));
      const y = Math.max(radius, Math.min(scene.height - radius, current.y + direction.y * scene.gridSize));
      if (x === current.x && y === current.y) return;
      if (previewMotion(token, { x, y }, 160)) lastStep = Date.now();
    }
    function down(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) { stop(); return; }
      if (!directions[event.code]) return;
      if (document.querySelector('dialog[open]') || editing(event.target)) return;
      const { scene, actor, selectedId, connection, startMotion } = latest.current;
      const token = scene?.tokens.find(value => value.id === selectedId);
      if (!token || !actor || !canMoveToken(token, actor) || connection !== 'connected') return;
      event.preventDefault();
      if (movingToken && movingToken !== token.id) stop();
      if (!movingToken) { if (!startMotion(token)) return; movingToken = token.id; movingScene = scene!.id; }
      if (held !== event.code) { held = event.code; lastStep = 0; step(); }
      if (held && !timer) timer = setInterval(step, 40);
    }
    function up(event: KeyboardEvent) { if (event.code === held) stop(); }
    function visibility() { if (document.hidden) stop(); }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', visibility);
    return () => { stop(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', visibility); };
  }, []);
}
