'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as CanvasImage, Line, Rect, Group, Circle, Path, Text } from 'react-konva';
import type Konva from 'konva';
import { ZoomIn, ZoomOut, Scan } from 'lucide-react';
import { fitCamera, zoomAt, snapCenter, screenToWorld, worldToScreen, type Camera, type Point } from '@/lib/table/geometry';
import { boundedGroupPoint, boundedSelectionPoint, canMoveToken, linkedTokens, type TableActor, type TableScene, type TableToken } from '@/lib/table/scene';
import { assetUrl } from '@/lib/table/assets';
import { boundedPoint, type MotionStore } from '@/lib/table/motion';
import { tokensInRect } from '@/lib/table/selection';
import { areaPoints, distanceFeet, snapMeasurePoint, type AreaMode, type MeasureMode } from '@/lib/table/measurement';
import TokenContextMenu, { tokenMenuPlacement, type TokenActionHandler } from './token-context-menu';
import { CONDITIONS } from '@/lib/table/conditions';

type CanvasDrawing = { id: string; color: string; width: number; points: number[] };
type MeasureGesture = { kind: 'measure'; mode: AreaMode; from: Point; to: Point; committed?: boolean };
type CanvasGesture = { kind: 'draw'; drawing: CanvasDrawing } | { kind: 'select'; from: Point; to: Point; additive: boolean } | MeasureGesture;
type SelectionMotion = { draggedId: string; origin: Point; members: TableToken[]; units: { token: TableToken; origin: Point }[] };

function TokenPortrait({ campaignId, assetId, radius }: { campaignId: string; assetId: string; radius: number }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image(); let active = true;
    img.onload = () => { if (active) setImage(img); }; img.src = assetUrl(campaignId, assetId);
    return () => { active = false; };
  }, [campaignId, assetId]);
  if (!image) return <Text text="…" x={-radius} y={-10} width={radius * 2} align="center" fill="#fff0d2" listening={false}/>;
  const edge = Math.min(image.width, image.height);
  return <Group listening={false} clipFunc={ctx => { ctx.arc(0, 0, radius, 0, Math.PI * 2); }}><CanvasImage image={image} x={-radius} y={-radius} width={radius * 2} height={radius * 2} crop={{ x: (image.width - edge) / 2, y: (image.height - edge) / 2, width: edge, height: edge }}/></Group>;
}

function formatFeet(value: number) { return `${Number.isInteger(value) ? value : value.toFixed(1)} ft`; }

export type TableCanvasProps = {
  scene: TableScene; actor: TableActor; selectedId: string | null; selectedIds?: string[]; tool: 'select' | 'pan' | 'draw' | 'erase' | 'measure'; measureMode?: MeasureMode; snap: boolean;
  pending: boolean; onSelect: (id: string | null, additive?: boolean) => void; onSelectMany?: (ids: string[], additive?: boolean) => void; onMove: (token: TableToken, point: Point) => boolean;
  brushColor?: string; brushWidth?: number; onDraw?: (drawing: CanvasDrawing) => void; onErase?: (drawingId: string) => void;
  onTokenAction?: TokenActionHandler;
  motionStore: MotionStore; onMotionStart: (token: TableToken) => boolean; onMotionPreview: (token: TableToken, point: Point, duration?: number) => boolean; onMotionEnd: (tokenId: string) => void;
};
export default function TableCanvas({ scene, actor, selectedId, selectedIds, tool, measureMode = 'line', snap, pending, onSelect, onSelectMany, brushColor = '#efd18b', brushWidth = 4, onDraw, onErase, onTokenAction, motionStore, onMotionStart, onMotionPreview, onMotionEnd }: TableCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null), stageRef = useRef<Konva.Stage>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 0.5 });
  const [map, setMap] = useState<HTMLImageElement | null>(null);
  const [space, setSpace] = useState(false), [pointer, setPointer] = useState<Point | null>(null);
  const [middlePan, setMiddlePan] = useState(false);
  const previousViewport = useRef<{ width: number; height: number } | null>(null), touchRef = useRef<{ distance: number; point: Point } | null>(null);
  const tokenNodes = useRef(new Map<string, Konva.Group>()), dragging = useRef(new Set<string>()), dragStarts = useRef(new Map<string, Point>());
  const selectionMotion = useRef<SelectionMotion | null>(null);
  const gestureRef = useRef<CanvasGesture | null>(null), cameraOverride = useRef(false), pinching = useRef(false);
  const [gesture, setGesture] = useState<CanvasGesture | null>(null);
  const [measurePreview, setMeasurePreview] = useState<MeasureGesture | null>(null);
  const measurePreviewRef = useRef<MeasureGesture | null>(null);
  const updateMeasurePreview = (next: MeasureGesture | null) => { measurePreviewRef.current = next; setMeasurePreview(next); };
  const [movementPreview, setMovementPreview] = useState<{ tokenId: string; from: Point; to: Point } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; version: number; size: number; committed: boolean } | null>(null);
  const primary = scene.tokens.find(token => token.id === (selectedId ?? selectedIds?.at(-1)));
  const previewToken = (token: TableToken) => resizePreview?.id === token.id ? { ...token, size: resizePreview.size } : token;
  const resize = (size: number | null) => setResizePreview(size === null || !primary ? null : { id: primary.id, version: primary.version, size, committed: false });
  const tokenAction: TokenActionHandler = (token, action, value) => {
    if (action === 'resize' && typeof value === 'number') setResizePreview({ id: token.id, version: token.version, size: value, committed: true });
    onTokenAction?.(token, action, value);
  };
  const movable = (token: TableToken) => canMoveToken(token, actor) && !linkedTokens(scene, token).some(member => member.locked);
  const selectedSet = new Set(selectedIds ?? (selectedId ? [selectedId] : []));
  const cancelGesture = () => { gestureRef.current = null; setGesture(null); };
  const finishTokenDrags = (event?: MouseEvent) => { for (const id of dragging.current) tokenNodes.current.get(id)?.stopDrag(event); };
  const cameraActive = () => tool === 'pan' || space || middlePan || cameraOverride.current || pinching.current;
  const worldPointer = () => { const point = stageRef.current?.getPointerPosition(); return point ? screenToWorld(point, camera) : null; };
  const drawingPoint = (point: Point) => ({ x: Math.max(0, Math.min(scene.width, point.x)), y: Math.max(0, Math.min(scene.height, point.y)) });
  const beginGesture = (blank: boolean, additive = false) => {
    if (cameraActive() || pending) return;
    const pointer = worldPointer(); if (!pointer) return;
    let next: CanvasGesture;
    if (tool === 'draw' && onDraw) {
      const point = drawingPoint(pointer);
      next = { kind: 'draw', drawing: { id: crypto.randomUUID(), color: brushColor, width: brushWidth, points: [point.x, point.y] } };
    } else if (tool === 'measure' && measureMode !== 'move') {
      const point = snapMeasurePoint(pointer, scene.gridSize);
      next = { kind: 'measure', mode: measureMode, from: point, to: point };
      updateMeasurePreview(null);
    } else if (tool === 'select' && blank) next = { kind: 'select', from: pointer, to: pointer, additive };
    else return;
    gestureRef.current = next; setGesture(next);
  };
  const moveGesture = () => {
    const point = worldPointer(); if (point) setPointer(point);
    const current = gestureRef.current; if (!current || !point || cameraActive()) return;
    let next: CanvasGesture;
    if (current.kind === 'draw') {
      const bounded = drawingPoint(point), points = current.drawing.points;
      // Keep the draft within the same validated point limit as a shared stroke.
      if (points.length >= 2048 || (points.at(-2) === bounded.x && points.at(-1) === bounded.y)) return;
      next = { kind: 'draw', drawing: { ...current.drawing, points: [...points, bounded.x, bounded.y] } };
    } else if (current.kind === 'measure') next = { ...current, to: snapMeasurePoint(point, scene.gridSize) };
    else next = { ...current, to: point };
    gestureRef.current = next; setGesture(next);
  };
  const finishGesture = () => {
    const current = gestureRef.current; cancelGesture();
    if (!current || cameraActive() || pending) return;
    if (current.kind === 'draw') {
      const drawing = current.drawing;
      onDraw?.({ ...drawing, points: drawing.points.length === 2 ? [...drawing.points, ...drawing.points] : drawing.points });
    } else if (current.kind === 'measure') {
      if (current.from.x !== current.to.x || current.from.y !== current.to.y) updateMeasurePreview({ ...current, committed: true });
    } else if (Math.hypot(current.to.x - current.from.x, current.to.y - current.from.y) * camera.scale < 3) {
      if (!current.additive) onSelect(null);
    } else {
      const ids = tokensInRect(scene, current.from, current.to);
      if (onSelectMany) onSelectMany(ids, current.additive);
      else onSelect(ids.at(-1) ?? null, current.additive);
    }
  };
  const eraseDrawing = (id: string) => { if (tool === 'erase' && !cameraActive() && !pending) onErase?.(id); };
  useEffect(() => {
    const image = new window.Image(); let active = true;
    image.onload = () => { if (active) setMap(image); };
    image.onerror = () => { if (active) { image.src = '/images/table-prototype-map.svg'; image.onerror = null; } };
    image.src = scene.mapAssetId ? assetUrl(scene.campaignId, scene.mapAssetId) : '/images/table-prototype-map.svg';
    return () => { active = false; };
  }, [scene.campaignId, scene.mapAssetId]);
  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
      if (size.width <= 0 || size.height <= 0) return;
      const previous = previousViewport.current;
      previousViewport.current = size; setViewport(size);
      setCamera(current => {
        if (!previous) return fitCamera({ width: 1600, height: 1120 }, size);
        const center = screenToWorld({ x: previous.width / 2, y: previous.height / 2 }, current);
        return { ...current, x: size.width / 2 - center.x * current.scale, y: size.height / 2 - center.y * current.scale };
      });
    });
    observer.observe(wrap); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.code === 'Escape' && (gestureRef.current?.kind === 'measure' || measurePreviewRef.current)) {
        event.preventDefault(); cancelGesture(); updateMeasurePreview(null); return;
      }
      if (event.code === 'Space') {
        event.preventDefault(); cameraOverride.current = true; cancelGesture(); finishTokenDrags(); setSpace(true);
      }
    };
    const up = (event: KeyboardEvent | FocusEvent) => { if (event.type === 'blur' || (event as KeyboardEvent).code === 'Space') { cameraOverride.current = false; setSpace(false); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, []);
  useEffect(() => {
    const finish = (event: MouseEvent | FocusEvent) => {
      if (event.type !== 'blur' && (event as MouseEvent).button !== 1) return;
      if (middlePan) stageRef.current?.stopDrag();
      cameraOverride.current = false;
      if (event.type === 'blur') { cancelGesture(); pinching.current = false; }
      setMiddlePan(false);
    };
    window.addEventListener('mouseup', finish); window.addEventListener('blur', finish);
    return () => { window.removeEventListener('mouseup', finish); window.removeEventListener('blur', finish); };
  }, [middlePan]);
  useEffect(() => { cancelGesture(); updateMeasurePreview(null); setMovementPreview(null); dragStarts.current.clear(); selectionMotion.current = null; }, [tool, measureMode, scene.id]);
  const fit = useCallback(() => setCamera(fitCamera(scene, viewport)), [scene, viewport]);
  const zoom = (factor: number) => setCamera(current => zoomAt(current, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
  const grid: React.ReactNode[] = [];
  if (scene.gridVisible) {
    for (let x = 0; x <= scene.width; x += scene.gridSize) grid.push(<Line key={'x' + x} points={[x, 0, x, scene.height]} stroke={scene.gridColor} opacity={scene.gridOpacity} strokeWidth={1 / camera.scale} listening={false}/>);
    for (let y = 0; y <= scene.height; y += scene.gridSize) grid.push(<Line key={'y' + y} points={[0, y, scene.width, y]} stroke={scene.gridColor} opacity={scene.gridOpacity} strokeWidth={1 / camera.scale} listening={false}/>);
  }
  const panning = tool === 'pan' || space || middlePan;
  const activeMeasure = gesture?.kind === 'measure' ? gesture : measurePreview;
  const measurePoints = activeMeasure ? areaPoints(activeMeasure.mode, activeMeasure.from, activeMeasure.to, scene.gridSize) : [];
  const measureDistance = activeMeasure ? distanceFeet(activeMeasure.from, activeMeasure.to, scene.gridSize) : 0;
  const squareSide = activeMeasure?.mode === 'square' && measurePoints.length > 1
    ? Math.abs(measurePoints[1].x - measurePoints[0].x) / scene.gridSize * 5 : measureDistance;
  const measureLabel = activeMeasure?.mode === 'sphere' ? `Сфера · радиус ${formatFeet(measureDistance)}`
    : activeMeasure?.mode === 'square' ? `Квадрат · сторона ${formatFeet(squareSide)}`
      : activeMeasure?.mode === 'cone' ? `Конус · ${formatFeet(measureDistance)}` : formatFeet(measureDistance);
  const measureLabelWidth = Math.max(68, measureLabel.length * 6.2 + 16);
  useEffect(() => {
    let frame = 0, firstFrame = true; const animated = new Set<string>();
    function animate() {
      for (const token of scene.tokens) {
        const track = motionStore.tracks.get(token.id);
        if (!firstFrame && !track && !animated.has(token.id)) continue;
        const node = tokenNodes.current.get(token.id); if (!node) continue;
        const point = resizePreview?.id === token.id ? boundedPoint(previewToken(token), scene.gridSize, token) : motionStore.position(token.id, token);
        if (node.isDragging() && !track?.local) { dragging.current.delete(token.id); node.stopDrag(); }
        if (!node.isDragging()) node.position(point);
        const foreign = !!track && !track.local && !track.finished;
        node.draggable(movable(token) && tool === 'select' && !panning && !pending && !foreign);
        node.findOne<Konva.Circle>('.motion-indicator')?.visible(foreign);
        const label = node.findOne<Konva.Text>('.motion-label'); label?.visible(foreign); if (foreign) label?.text(track.name || 'Участник');
        node.getLayer()?.batchDraw();
        if (motionStore.tracks.has(token.id)) animated.add(token.id); else animated.delete(token.id);
      }
      if (primary && menuRef.current) {
        const displayed = resizePreview?.id === primary.id ? boundedPoint(previewToken(primary), scene.gridSize, primary) : motionStore.position(primary.id, primary);
        const point = tokenMenuPlacement(worldToScreen(displayed, camera), previewToken(primary).size * scene.gridSize * 0.42 * camera.scale, viewport);
        menuRef.current.style.left = `${point.x}px`; menuRef.current.style.top = `${point.y}px`;
        menuRef.current.style.setProperty('--token-menu-radius', `${point.radius}px`);
        menuRef.current.style.setProperty('--token-menu-scale', String(point.scale));
        const track = motionStore.tracks.get(primary.id);
        menuRef.current.style.visibility = cameraActive() || dragging.current.size > 0 || (!!track && !track.finished) ? 'hidden' : '';
      }
      firstFrame = false;
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame);
  }, [scene, actor, tool, panning, pending, motionStore, primary, camera, viewport, resizePreview]);
  useEffect(() => {
    if (resizePreview && (resizePreview.id !== primary?.id || resizePreview.version !== primary.version || resizePreview.committed && !pending)) setResizePreview(null);
  }, [primary?.id, primary?.version, pending, resizePreview]);
  return <div className="table-stage-wrap" ref={wrapRef} style={{ cursor: panning ? 'grab' : tool === 'draw' || tool === 'erase' ? 'crosshair' : 'default', touchAction: 'auto' }}
    onMouseDownCapture={event => {
      if ((event.target as Element)?.closest?.('[data-token-menu]')) return;
      if (event.button !== 1 && !(event.button === 0 && (space || tool === 'pan' || cameraOverride.current))) return;
      const stage = stageRef.current; if (!stage) return;
      event.preventDefault(); event.stopPropagation();
      // Capture before Konva handles a token: middle mouse always belongs to the camera.
      cancelGesture(); finishTokenDrags(event.nativeEvent);
      if (event.button === 1) cameraOverride.current = true;
      stage.setPointersPositions(event.nativeEvent); if (event.button === 1) setMiddlePan(true);
      stage.startDrag({ evt: event.nativeEvent });
    }}
    onAuxClick={event => { if (event.button === 1) event.preventDefault(); }}>
    <Stage ref={stageRef} style={{ touchAction: 'none' }} width={viewport.width} height={viewport.height} x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale} draggable={panning}
      onDragEnd={event => { if (event.target === stageRef.current) setCamera(current => ({ ...current, x: event.target.x(), y: event.target.y() })); }}
      onWheel={event => { event.evt.preventDefault(); const point = stageRef.current?.getPointerPosition(); if (point) setCamera(current => zoomAt(current, point, event.evt.deltaY < 0 ? 1.12 : 1 / 1.12)); }}
      onMouseDown={event => { if (event.evt.button === 0) beginGesture(event.target === stageRef.current, event.evt.shiftKey); }}
      onMouseMove={moveGesture} onMouseUp={finishGesture} onMouseLeave={finishGesture}
      onTouchStart={event => {
        if (event.evt.touches.length >= 2) { cancelGesture(); finishTokenDrags(); stageRef.current?.stopDrag(); touchRef.current = null; pinching.current = true; }
        else if (!pinching.current) {
          if (cameraActive()) { stageRef.current?.startDrag({ evt: event.evt }); return; }
          beginGesture(event.target === stageRef.current);
        }
      }}
      onTouchMove={event => {
        const touches = event.evt.touches;
        if (touches.length === 1 && !pinching.current) { moveGesture(); return; }
        if (touches.length !== 2) return; event.evt.preventDefault();
        stageRef.current?.stopDrag();
        const rect = wrapRef.current!.getBoundingClientRect();
        const point = { x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left, y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top };
        const distance = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        const previous = touchRef.current;
        if (previous) setCamera(current => { const next = zoomAt(current, previous.point, distance / previous.distance); return { ...next, x: next.x + point.x - previous.point.x, y: next.y + point.y - previous.point.y }; });
        touchRef.current = { point, distance };
      }} onTouchEnd={event => { if (!pinching.current) finishGesture(); touchRef.current = null; if (event.evt.touches.length === 0) pinching.current = false; }} onTouchCancel={() => { cancelGesture(); pinching.current = false; touchRef.current = null; }}>
      <Layer><CanvasImage image={map ?? undefined} x={map ? (scene.width - map.width * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} y={map ? (scene.height - map.height * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} width={map ? map.width * Math.min(scene.width / map.width, scene.height / map.height) : scene.width} height={map ? map.height * Math.min(scene.width / map.width, scene.height / map.height) : scene.height} listening={false}/>{grid}</Layer>
      <Layer>{(scene.drawings ?? []).map(drawing => <Line key={drawing.id} points={drawing.points} stroke={drawing.color} strokeWidth={drawing.width} lineCap="round" lineJoin="round" listening={tool === 'erase' && !panning && !pending} hitStrokeWidth={Math.max(drawing.width, 12 / camera.scale)}
        onMouseDown={event => { if (event.evt.button === 0) { event.cancelBubble = true; eraseDrawing(drawing.id); } }}
        onTouchStart={event => { if (event.evt.touches.length === 1) { event.cancelBubble = true; eraseDrawing(drawing.id); } }}/>) }
        {gesture?.kind === 'draw' && <Line points={gesture.drawing.points.length === 2 ? [...gesture.drawing.points, ...gesture.drawing.points] : gesture.drawing.points} stroke={gesture.drawing.color} strokeWidth={gesture.drawing.width} lineCap="round" lineJoin="round" listening={false}/>}</Layer>
      <Layer>{scene.tokens.slice().sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)).map(sourceToken => {
        const token = previewToken(sourceToken);
        const radius = token.size * scene.gridSize * 0.42, selected = selectedSet.has(token.id);
        const allowed = movable(token);
        const displayed = resizePreview?.id === token.id ? boundedPoint(token, scene.gridSize, token) : motionStore.position(token.id, token);
        return <Group ref={node => { if (node) tokenNodes.current.set(token.id, node); else tokenNodes.current.delete(token.id); }} key={token.id} id={token.id} x={displayed.x} y={displayed.y} listening={tool === 'select' || panning} draggable={allowed && tool === 'select' && !panning && !pending}
          onClick={event => { event.cancelBubble = true; if (tool === 'select' && !cameraActive() && event.evt.button !== 1) onSelect(token.id, event.evt.shiftKey); }} onTap={() => { if (tool === 'select' && !cameraActive()) onSelect(token.id); }}
          onDragStart={event => {
            event.cancelBubble = true;
            if (!allowed || tool !== 'select' || cameraActive() || pending) { event.target.stopDrag(); return; }
            if (!selected) onSelect(token.id, event.evt?.shiftKey);
            const chosen = selected ? scene.tokens.filter(value => selectedSet.has(value.id)) : [token];
            const members = [...new Map(chosen.flatMap(value => linkedTokens(scene, value)).map(value => [value.id, value])).values()];
            const units = [...new Map(chosen.map(value => linkedTokens(scene, value)[0]).map(value => [value.id, value])).values()];
            if (members.some(value => !movable(value))) { event.target.stopDrag(); return; }
            const started: TableToken[] = [];
            for (const unit of units) {
              if (!onMotionStart(unit)) { for (const active of started) onMotionEnd(active.id); event.target.stopDrag(); event.target.position({ x: token.x, y: token.y }); return; }
              started.push(unit);
            }
            const origin = motionStore.position(token.id, token);
            selectionMotion.current = { draggedId: token.id, origin, members, units: units.map(unit => ({ token: unit, origin: motionStore.position(unit.id, unit) })) };
            dragging.current.add(token.id);
            if (measureMode === 'move') { dragStarts.current.set(token.id, origin); setMovementPreview({ tokenId: token.id, from: origin, to: origin }); }
          }}
          onDragMove={event => {
            event.cancelBubble = true;
            const active = selectionMotion.current;
            if (!dragging.current.has(token.id) || !active || active.draggedId !== token.id) return;
            const point = boundedSelectionPoint(scene, active.members, token, { x: event.target.x(), y: event.target.y() });
            event.target.position(point);
            const dx = point.x - active.origin.x, dy = point.y - active.origin.y;
            for (const unit of active.units) onMotionPreview(unit.token, { x: unit.origin.x + dx, y: unit.origin.y + dy });
            const from = dragStarts.current.get(token.id);
            if (measureMode === 'move' && from) setMovementPreview({ tokenId: token.id, from, to: point });
          }}
          onDragEnd={event => {
            event.cancelBubble = true;
            if (!dragging.current.delete(token.id)) return;
            const active = selectionMotion.current;
            if (!active || active.draggedId !== token.id) return;
            const desired = snapCenter({ x: event.target.x(), y: event.target.y() }, scene.gridSize, snap && !event.evt?.ctrlKey && !event.evt?.altKey);
            const point = boundedSelectionPoint(scene, active.members, token, desired);
            const dx = point.x - active.origin.x, dy = point.y - active.origin.y;
            for (const unit of active.units) { onMotionPreview(unit.token, { x: unit.origin.x + dx, y: unit.origin.y + dy }, 85); onMotionEnd(unit.token.id); }
            selectionMotion.current = null; dragStarts.current.delete(token.id); setMovementPreview(null);
          }}>
          <Circle name="motion-indicator" visible={false} radius={radius + 6} stroke="#87b2c2" strokeWidth={3 / camera.scale} listening={false}/>
          <Text name="motion-label" visible={false} text="" x={-80} y={-radius - 27} width={160} align="center" fontSize={13} fill="#b7deeb" stroke="#1c2020" strokeWidth={3} fillAfterStrokeEnabled listening={false}/>
          {selected && <Circle radius={radius + 7} stroke="#efd18b" strokeWidth={2.5 / camera.scale} dash={[7 / camera.scale, 4 / camera.scale]} listening={false}/>}
          <Group rotation={token.rotation ?? 0}>{token.assetId ? <><Circle radius={radius} fill="#252627" shadowColor="#000000" shadowBlur={8} shadowOpacity={0.6}/><TokenPortrait campaignId={scene.campaignId} assetId={token.assetId} radius={radius}/></> : <><Circle radius={radius} fill="#252627" stroke={token.color} strokeWidth={4} shadowColor="#000000" shadowBlur={8} shadowOpacity={0.6}/>
          <Circle radius={radius - 5} fill={token.color} opacity={0.16} listening={false}/>
          <Text text={token.name.match(/^Противник (\d+)$/)?.[1] ?? token.name.slice(0, 2).toLocaleUpperCase('ru-RU')} x={-radius} y={-radius * 0.44} width={radius * 2} fontSize={radius * 0.72} align="center" fill="#fff0d2" fontStyle="bold" listening={false}/></>}</Group>
          {token.showLabel !== false && (token.showLabel || selected || token.ownerId) && <Text text={token.name} x={-70} y={radius + 8} width={140} fontSize={14} align="center" fill="#f7e8ca" stroke="#1c2020" strokeWidth={3} fillAfterStrokeEnabled listening={false}/>}
          {!!token.statuses?.length && <Group name="condition-badges" listening={false} x={radius - 9 / camera.scale} y={-radius - 9 / camera.scale} scaleX={1 / camera.scale} scaleY={1 / camera.scale}>
            {token.statuses.slice(0, 4).map((status, index) => <Group key={status} x={(index % 2) * 21} y={Math.floor(index / 2) * 21}>
              <Circle x={10} y={10} radius={9} fill="#202525" stroke={CONDITIONS[status].color} strokeWidth={1.5}/>
              <Path data={CONDITIONS[status].icon} x={3} y={3} scaleX={7 / 12} scaleY={7 / 12} stroke={CONDITIONS[status].color} strokeWidth={2} lineCap="round" lineJoin="round" fillEnabled={false}/>
            </Group>)}
            {token.statuses.length > 4 && <Text text={`+${token.statuses.length - 4}`} x={0} y={43} width={42} height={15} align="center" fontSize={11} fill="#f7e8ca" stroke="#202525" strokeWidth={3} fillAfterStrokeEnabled/>}
          </Group>}
          {token.ownerId && <Circle radius={5} x={radius * 0.75} y={-radius * 0.7} fill="#a9c496" stroke="#202723" strokeWidth={2} listening={false}/>}
        </Group>;
      })}</Layer>
      <Layer name="measurement-overlay" listening={false}>
        {activeMeasure && <>
          {activeMeasure.mode !== 'line' && <Line name="measurement-shape" points={measurePoints.flatMap(point => [point.x, point.y])} closed fill="#a78bfa" opacity={0.14} stroke="#c6a7ff" strokeWidth={2.5 / camera.scale} lineJoin="round"/>}
          {activeMeasure.mode === 'line' && <><Line name="measurement-shape" points={measurePoints.flatMap(point => [point.x, point.y])} stroke="#c6a7ff" strokeWidth={3 / camera.scale} dash={[8 / camera.scale, 5 / camera.scale]} lineCap="round"/><Circle x={measurePoints[0].x} y={measurePoints[0].y} radius={4 / camera.scale} fill="#c6a7ff"/><Circle x={measurePoints.at(-1)!.x} y={measurePoints.at(-1)!.y} radius={4 / camera.scale} fill="#c6a7ff"/></>}
          <Group x={(activeMeasure.from.x + activeMeasure.to.x) / 2} y={(activeMeasure.from.y + activeMeasure.to.y) / 2 - 18 / camera.scale} scaleX={1 / camera.scale} scaleY={1 / camera.scale}>
            <Rect x={-measureLabelWidth / 2} y={-12} width={measureLabelWidth} height={24} cornerRadius={6} fill="#24252ddd" stroke="#c6a7ff" strokeWidth={1}/>
            <Text text={measureLabel} x={-measureLabelWidth / 2} y={-12} width={measureLabelWidth} height={24} align="center" verticalAlign="middle" fontSize={11} fontStyle="bold" fill="#f2eafd"/>
          </Group>
        </>}
        {movementPreview && measureMode === 'move' && <>
          <Line name="movement-ruler" points={[movementPreview.from.x, movementPreview.from.y, movementPreview.to.x, movementPreview.to.y]} stroke="#f0c36d" strokeWidth={3 / camera.scale} dash={[8 / camera.scale, 4 / camera.scale]} lineCap="round"/>
          <Group x={(movementPreview.from.x + movementPreview.to.x) / 2} y={(movementPreview.from.y + movementPreview.to.y) / 2 - 18 / camera.scale} scaleX={1 / camera.scale} scaleY={1 / camera.scale}>
            <Rect x={-34} y={-12} width={68} height={24} cornerRadius={6} fill="#24251ddd" stroke="#f0c36d" strokeWidth={1}/>
            <Text text={formatFeet(distanceFeet(movementPreview.from, movementPreview.to, scene.gridSize))} x={-34} y={-12} width={68} height={24} align="center" verticalAlign="middle" fontSize={11} fontStyle="bold" fill="#f7e3bd"/>
          </Group>
        </>}
      </Layer>
      <Layer listening={false}>{gesture?.kind === 'select' && <Rect x={Math.min(gesture.from.x, gesture.to.x)} y={Math.min(gesture.from.y, gesture.to.y)} width={Math.abs(gesture.to.x - gesture.from.x)} height={Math.abs(gesture.to.y - gesture.from.y)} fill="#efd18b" opacity={0.22} stroke="#efd18b" strokeWidth={2 / camera.scale} dash={[6 / camera.scale, 4 / camera.scale]}/>}</Layer>
    </Stage>
    <div className="table-token-status-accessibility" role="list" aria-label="Состояния фигур">{scene.tokens.filter(token => token.statuses?.length).map(token => <div role="listitem" key={token.id}>{token.name}: {token.statuses!.map(id => CONDITIONS[id].label + (id === 'exhaustion' ? ` ${token.exhaustionLevel ?? 1}` : '')).join(', ')}</div>)}</div>
    {primary && onTokenAction && tool === 'select' && !panning && !gesture && <TokenContextMenu key={primary.id} menuRef={menuRef} token={previewToken(primary)} pending={pending} onAction={tokenAction} onResizePreview={resize} resizePixelsPerCell={Math.max(24, scene.gridSize * camera.scale)} position={worldToScreen(resizePreview?.id === primary.id ? boundedPoint(previewToken(primary), scene.gridSize, primary) : motionStore.position(primary.id, primary), camera)} radius={previewToken(primary).size * scene.gridSize * 0.42 * camera.scale} viewport={viewport}/>}
    {!map && <div className="table-stage-loading">Расстилаем карту…</div>}
    <div className="table-zoom"><button aria-label="Уменьшить карту" onClick={() => zoom(1 / 1.25)}><ZoomOut size={18}/></button><output aria-label="Масштаб карты">{Math.round(camera.scale * 100)}%</output><button aria-label="Увеличить карту" onClick={() => zoom(1.25)}><ZoomIn size={18}/></button><button aria-label="Показать всю карту" onClick={fit}><Scan size={18}/></button></div>
    <div className="table-coordinate">{pointer ? `X ${Math.round(pointer.x)} · Y ${Math.round(pointer.y)}` : 'Колесо — масштаб'} · {scene.gridSize} px / 5 футов</div>
  </div>;
}
