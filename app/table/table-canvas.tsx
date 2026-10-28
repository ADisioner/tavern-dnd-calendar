'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as CanvasImage, Line, Group, Circle, Text } from 'react-konva';
import type Konva from 'konva';
import { ZoomIn, ZoomOut, Scan } from 'lucide-react';
import { fitCamera, zoomAt, snapCenter, screenToWorld, type Camera, type Point } from '@/lib/table/geometry';
import { canMoveToken, type TableActor, type TableScene, type TableToken } from '@/lib/table/scene';
import { assetUrl } from '@/lib/table/assets';
import { boundedPoint, type MotionStore } from '@/lib/table/motion';

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

export type TableCanvasProps = {
  scene: TableScene; actor: TableActor; selectedId: string | null; tool: 'select' | 'pan'; snap: boolean;
  pending: boolean; onSelect: (id: string | null) => void; onMove: (token: TableToken, point: Point) => boolean;
  motionStore: MotionStore; onMotionStart: (token: TableToken) => boolean; onMotionPreview: (token: TableToken, point: Point, duration?: number) => boolean; onMotionEnd: (tokenId: string) => void;
};
export default function TableCanvas({ scene, actor, selectedId, tool, snap, pending, onSelect, motionStore, onMotionStart, onMotionPreview, onMotionEnd }: TableCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null), stageRef = useRef<Konva.Stage>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 0.5 });
  const [map, setMap] = useState<HTMLImageElement | null>(null);
  const [space, setSpace] = useState(false), [pointer, setPointer] = useState<Point | null>(null);
  const previousViewport = useRef<{ width: number; height: number } | null>(null), touchRef = useRef<{ distance: number; point: Point } | null>(null);
  const tokenNodes = useRef(new Map<string, Konva.Group>()), dragging = useRef(new Set<string>());
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
      if (event.code === 'Space') { event.preventDefault(); setSpace(true); }
    };
    const up = () => setSpace(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, []);
  const fit = useCallback(() => setCamera(fitCamera(scene, viewport)), [scene, viewport]);
  const zoom = (factor: number) => setCamera(current => zoomAt(current, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
  const grid: React.ReactNode[] = [];
  if (scene.gridVisible) {
    for (let x = 0; x <= scene.width; x += scene.gridSize) grid.push(<Line key={'x' + x} points={[x, 0, x, scene.height]} stroke="#decea1" opacity={0.18} strokeWidth={1 / camera.scale} listening={false}/>);
    for (let y = 0; y <= scene.height; y += scene.gridSize) grid.push(<Line key={'y' + y} points={[0, y, scene.width, y]} stroke="#decea1" opacity={0.18} strokeWidth={1 / camera.scale} listening={false}/>);
  }
  const panning = tool === 'pan' || space;
  useEffect(() => {
    let frame = 0, firstFrame = true; const animated = new Set<string>();
    function animate() {
      for (const token of scene.tokens) {
        const track = motionStore.tracks.get(token.id);
        if (!firstFrame && !track && !animated.has(token.id)) continue;
        const node = tokenNodes.current.get(token.id); if (!node) continue;
        const point = motionStore.position(token.id, token);
        if (node.isDragging() && !track?.local) { dragging.current.delete(token.id); node.stopDrag(); }
        if (!node.isDragging()) node.position(point);
        const foreign = !!track && !track.local && !track.finished;
        node.draggable(canMoveToken(token, actor) && !panning && !pending && !foreign);
        node.findOne<Konva.Circle>('.motion-indicator')?.visible(foreign);
        const label = node.findOne<Konva.Text>('.motion-label'); label?.visible(foreign); if (foreign) label?.text(track.name || 'Участник');
        node.getLayer()?.batchDraw();
        if (motionStore.tracks.has(token.id)) animated.add(token.id); else animated.delete(token.id);
      }
      firstFrame = false;
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame);
  }, [scene, actor, panning, pending, motionStore]);
  return <div className="table-stage-wrap" ref={wrapRef} style={{ cursor: panning ? 'grab' : 'default', touchAction: 'none' }}>
    <Stage ref={stageRef} width={viewport.width} height={viewport.height} x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale} draggable={panning}
      onDragEnd={event => { if (event.target === stageRef.current) setCamera(current => ({ ...current, x: event.target.x(), y: event.target.y() })); }}
      onWheel={event => { event.evt.preventDefault(); const point = stageRef.current?.getPointerPosition(); if (point) setCamera(current => zoomAt(current, point, event.evt.deltaY < 0 ? 1.12 : 1 / 1.12)); }}
      onMouseDown={event => { if (event.target === stageRef.current) onSelect(null); }}
      onMouseMove={() => { const point = stageRef.current?.getPointerPosition(); if (point) setPointer(screenToWorld(point, camera)); }}
      onTouchStart={event => { if (event.evt.touches.length === 2) { stageRef.current?.stopDrag(); touchRef.current = null; } }}
      onTouchMove={event => {
        const touches = event.evt.touches; if (touches.length !== 2) return; event.evt.preventDefault();
        stageRef.current?.stopDrag();
        const rect = wrapRef.current!.getBoundingClientRect();
        const point = { x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left, y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top };
        const distance = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        const previous = touchRef.current;
        if (previous) setCamera(current => { const next = zoomAt(current, previous.point, distance / previous.distance); return { ...next, x: next.x + point.x - previous.point.x, y: next.y + point.y - previous.point.y }; });
        touchRef.current = { point, distance };
      }} onTouchEnd={() => { touchRef.current = null; }}>
      <Layer><CanvasImage image={map ?? undefined} x={map ? (scene.width - map.width * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} y={map ? (scene.height - map.height * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} width={map ? map.width * Math.min(scene.width / map.width, scene.height / map.height) : scene.width} height={map ? map.height * Math.min(scene.width / map.width, scene.height / map.height) : scene.height} listening={false}/>{grid}</Layer>
      <Layer>{scene.tokens.slice().sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId)).map(token => {
        const radius = token.size * scene.gridSize * 0.42, selected = selectedId === token.id;
        const allowed = canMoveToken(token, actor);
        const displayed = motionStore.position(token.id, token);
        return <Group ref={node => { if (node) tokenNodes.current.set(token.id, node); else tokenNodes.current.delete(token.id); }} key={token.id} id={token.id} x={displayed.x} y={displayed.y} draggable={allowed && !panning && !pending}
          onClick={event => { event.cancelBubble = true; onSelect(token.id); }} onTap={() => onSelect(token.id)}
          onDragStart={event => { event.cancelBubble = true; onSelect(token.id); if (onMotionStart(token)) dragging.current.add(token.id); else { event.target.stopDrag(); event.target.position({ x: token.x, y: token.y }); } }}
          onDragMove={event => { event.cancelBubble = true; if (!dragging.current.has(token.id)) return; const point = boundedPoint(token, scene.gridSize, { x: event.target.x(), y: event.target.y() }); event.target.position(point); onMotionPreview(token, point); }}
          onDragEnd={event => { event.cancelBubble = true; if (!dragging.current.delete(token.id)) return; const point = snapCenter({ x: event.target.x(), y: event.target.y() }, scene.gridSize, snap && !event.evt.altKey); onMotionPreview(token, point, 85); onMotionEnd(token.id); }}>
          <Circle name="motion-indicator" visible={false} radius={radius + 6} stroke="#87b2c2" strokeWidth={3 / camera.scale} listening={false}/>
          <Text name="motion-label" visible={false} text="" x={-80} y={-radius - 27} width={160} align="center" fontSize={13} fill="#b7deeb" stroke="#1c2020" strokeWidth={3} fillAfterStrokeEnabled listening={false}/>
          {selected && <Circle radius={radius + 7} stroke="#efd18b" strokeWidth={2.5 / camera.scale} dash={[7 / camera.scale, 4 / camera.scale]} listening={false}/>}
          {token.assetId ? <><Circle radius={radius} fill="#252627" shadowColor="#000000" shadowBlur={8} shadowOpacity={0.6}/><TokenPortrait campaignId={scene.campaignId} assetId={token.assetId} radius={radius}/></> : <><Circle radius={radius} fill="#252627" stroke={token.color} strokeWidth={4} shadowColor="#000000" shadowBlur={8} shadowOpacity={0.6}/>
          <Circle radius={radius - 5} fill={token.color} opacity={0.16} listening={false}/>
          <Text text={token.name.match(/^Противник (\d+)$/)?.[1] ?? token.name.slice(0, 2).toLocaleUpperCase('ru-RU')} x={-radius} y={-radius * 0.44} width={radius * 2} fontSize={radius * 0.72} align="center" fill="#fff0d2" fontStyle="bold" listening={false}/></>}
          {(selected || token.ownerId) && <Text text={token.name} x={-70} y={radius + 8} width={140} fontSize={14} align="center" fill="#f7e8ca" stroke="#1c2020" strokeWidth={3} fillAfterStrokeEnabled listening={false}/>}
          {token.ownerId && <Circle radius={5} x={radius * 0.75} y={-radius * 0.7} fill="#a9c496" stroke="#202723" strokeWidth={2} listening={false}/>}
        </Group>;
      })}</Layer>
    </Stage>
    {!map && <div className="table-stage-loading">Расстилаем карту…</div>}
    <div className="table-zoom"><button aria-label="Уменьшить карту" onClick={() => zoom(1 / 1.25)}><ZoomOut size={18}/></button><output aria-label="Масштаб карты">{Math.round(camera.scale * 100)}%</output><button aria-label="Увеличить карту" onClick={() => zoom(1.25)}><ZoomIn size={18}/></button><button aria-label="Показать всю карту" onClick={fit}><Scan size={18}/></button></div>
    <div className="table-coordinate">{pointer ? `X ${Math.round(pointer.x)} · Y ${Math.round(pointer.y)}` : 'Колесо — масштаб'} · {scene.gridSize} px / 5 футов</div>
  </div>;
}
