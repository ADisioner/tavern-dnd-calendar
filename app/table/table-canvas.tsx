'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as CanvasImage, Line, Rect, Group, Circle, Path, Text } from 'react-konva';
import type Konva from 'konva';
import { ZoomIn, ZoomOut, Scan } from 'lucide-react';
import { fitCamera, zoomAt, snapCenter, screenToWorld, worldToScreen, type Camera, type Point } from '@/lib/table/geometry';
import { boundedGroupPoint, canMoveToken, linkedTokens, type TableActor, type TableScene, type TableToken } from '@/lib/table/scene';
import { assetUrl } from '@/lib/table/assets';
import { boundedPoint, type MotionStore } from '@/lib/table/motion';
import { tokensInRect } from '@/lib/table/selection';
import { areaPoints, distanceFeet, snapMeasurePoint, type AreaMode, type MeasureMode } from '@/lib/table/measurement';
import TokenContextMenu, { tokenMenuPlacement, type TokenActionHandler } from './token-context-menu';
import { CONDITIONS } from '@/lib/table/conditions';

type CanvasDrawing = { id: string; color: string; width: number; points: number[] };
type MeasureGesture = { kind: 'measure'; mode: AreaMode; from: Point; to: Point; committed?: boolean };
type CanvasGesture = { kind: 'draw'; drawing: CanvasDrawing } | { kind: 'select'; from: Point; to: Point; additive: boolean } | MeasureGesture;

function TokenPortrait({ campaignId, assetId, radius }: { campaignId: string; assetId: string; radius: number }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image(); let active = true;
    img.onload = () => { if (active) setImage(img); }; img.src = assetUrl(campaignId, assetId);
    return () => { active = false; };
  }, [campaignId, assetId]);
  if (!image) return <Text text="â€¦" x={-radius} y={-10} width={radius * 2} align="center" fill="#fff0d2" listening={false}/>;
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
  useEffect(() => { cancelGesture(); updateMeasurePreview(null); setMovementPreview(null); dragStarts.current.clear(); }, [tool, measureMode, scene.id]);
  const fit = useCallback(() => setCamera(fitCamera(scene, viewport)), [scene, viewport]);
  const zoom = (factor: number) => setCamera(current => zoomAt(current, { x: viewport.width / 2, y: viewport.height / 2 }, factor));
  const grid: React.ReactNode[] = [];
  if (scene.gridVisible) {
    for (let x = 0; x <= scene.width; x += scene.gridSize) grid.push(<Line key={'x' + x} points={[x, 0, x, scene.height]} stroke="#decea1" opacity={0.18} strokeWidth={1 / camera.scale} listening={false}/>);
    for (let y = 0; y <= scene.height; y += scene.gridSize) grid.push(<Line key={'y' + y} points={[0, y, scene.width, y]} stroke="#decea1" opacity={0.18} strokeWidth={1 / camera.scale} listening={false}/>);
  }
  const panning = tool === 'pan' || space || middlePan;
  const activeMeasure = gesture?.kind === 'measure' ? gesture : measurePreview;
  const measurePoints = activeMeasure ? areaPoints(activeMeasure.mode, activeMeasure.from, activeMeasure.to, scene.gridSize) : [];
  const measureDistance = activeMeasure ? distanceFeet(activeMeasure.from, activeMeasure.to, scene.gridSize) : 0;
  const squareSide = activeMeasure?.mode === 'square' && measurePoints.length > 1
    ? Math.abs(measurePoints[1].x - measurePoints[0].x) / scene.gridSize * 5 : measureDistance;
  const measureLabel = activeMeasure?.mode === 'sphere' ? `Ð¡Ñ„ÐµÑ€Ð° Â· Ñ€Ð°Ð´Ð¸ÑƒÑ ${formatFeet(measureDistance)}`
    : activeMeasure?.mode === 'square' ? `ÐšÐ²Ð°Ð´Ñ€Ð°Ñ‚ Â· ÑÑ‚Ð¾Ñ€Ð¾Ð½Ð° ${formatFeet(squareSide)}`
      : activeMeasure?.mode === 'cone' ? `ÐšÐ¾Ð½ÑƒÑ Â· ${formatFeet(measureDistance)}` : formatFeet(measureDistance);
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
        const label = node.findOne<Konva.Text>('.motion-label'); label?.visible(foreign); if (foreign) label?.text(track.name || 'Ð£Ñ‡Ð°ÑÑ‚Ð½Ð¸Ðº');
        node.getLayer()?.batchDraw();
        if (motionStore.tracks.has(token.id)) animated.add(token.id); else animated.delete(token.id);
      }
      if (primary && menuRef.current) {
        const displayed = resizePreview?.id === primary.id ? boundedPoint(previewToken(primary), scene.gridSize, primary) : motionStore.position(primary.id, primary);
        const point = tokenMenuPlacement(worldToScreen(displayed, camera), previewToken(primary).size * scene.gridSize * 0.42 * camera.scale, viewport);
        menuRef.current.style.left = `${point.x}px`; menuRef.current.style.top = `${point.y}px`;
        menuRef.current.style.setProperty('--token-menu-radius', `${point.radius}px`);
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
      <Layer><CanvasImage image={map ?? undefined} x={map ? (scene.width - map.width * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} y={map ? (scene.height - map.height * Math.min(scene.width / map.width, scene.height / map.height)) / 2 : 0} width={map ? map.width * Math.min(scene.width / map.width, scene.height / map.height) : scene.width} height={map ? map.height * Math.min(scene.width / map.width, scene.height / map.height) : scene.height} listening={false}/>{grid}</Layer6ç~¼¶‰žËkºwµçcÓcƒU¢Ö&Vf÷&RÖG&r×Fö¶Vâ×&W6—¦RçF"æw¦â
Ââµ½	=í-í’-íµÕÒàÐ ­	ý=½­mò=}]¢}Í]ýíM--]mM]Ý¢&öGV7F–öâ'V–ÆBýí³²6—FW2-]ó’w&¥ófS&C3“Cƒƒ“&S#Scc–33†gæwfW%ó633v6S“S6Sƒƒ“†cSƒCcs6V3S#F#fÂ6÷W&6RsS&6#†63sS33–SVC–3ƒ6S#†cƒV6#ƒc3FÂFWÆ÷–ÖVçBvFWófS&C†6&3f63ƒ“FS#VSFF3“C“&&(	G7V66VVFVBâv—D‡V"Ö–âvfc&CFvSCc#VC##SssfSc†C–F&C3–CƒVíÝí-½Ò}]]rÝ-]=mã²í]RM]]-âV&#Ss&Cv3V3FCs–#f6#scS6#Sƒ–s“–33&Fâ	MíÍ]Òæ÷FvÖ&ç'R‚ý=½}Ý½’Mí-=òí]Ý]Ý²â6†V6·ö–çBMâý=½­mƒ¢##bÓÓ#•CRÓ#2ÓSÓ…¢Ö&Vf÷&R×V&Æ—6‚ÖG&r×Fö¶Vâ×&W6—¦RçF"æw¦²]"í­ƒ¢##bÓÓ#’ÖG&r×Fö¶Vâ×&W6—¦R×&VÆV6RçF"æw¦â
í--]ÝÝ½R­íÍÝM²}-]½Ã²&Wf–Wrý=}]Ý½R'VçF–ÖR"Ý-í’}M}RÝR}ý=­½Ââ
Ý-}ýÂ½í­½ÍÝòÂMí-½]Ýýí½Rý=½­m‚àÐ ¢22	-]­-íÝ½R}Ý­‚í-íýÝ’Â­íÝm]Ý-mò‚Í]-À ­	ÝM==R=­-]ÝÝ½Rý½­‚}Í]Ý]Ý²­íÍý­-Ý½Í‚--í­Í‚-]­-íÝ½Í‚ý­-í=ÍÍÍƒ²-mRý­-í=ÍÍýí­}ÝýMíÂÝ}-Ý]Âí-íýÝò"Í]Ýââ	­-½í2íM]m"í-M]½ÍÝ½RÍ-í½²M½òR-ÝM-Ý½Rí-íýÝ’BdCVRÂ*½	­íÝm]Ý-mŒ+²‚*½
Í]-Œ+²â	ýí½]MÝRM-(	BÍí-íý-]½ÍÝ½R=}Ý½Rí-Í]-­‚ÂÝR=½í-òríMm½ÍÝí=âý­²--íÍ-}]­Rý-²­íÝm]Ý-m‚ýÍ]-‚Ý]"â	M½ò-í]ÝòÝ­-Rí-ímí-òý]í}Ý½R}²Â=í-]ÝÃâãbí--ò"Í]Ýâ‚Ý­ÝÝíÂ}-]Ý‚à ­	ýí-]]Ýã¢F&vWFVBF&ÆRÖ–çWFÂF&ÆR×66VæVÂF&ÆRÖÂFö¶VâÖ6öçFW‡BÖÖVçV(	CsRósS²ç‚G62ÒÖæôVÖ—F(	M=ý]Ýã²çÒ'Vâ'V–ÆF(	M=ý]Ýââ	-}=½ÍÝòýí-]­"=}]RÝR}ý=­½Ââ	ýâí-M]½ÍÝíÍ2}ýí2ýí½Í}í--]½ò}Í]Ý]Ýòíý=½­í-Ý³¢6—FW26÷W&6R3C“3C3†c##–#–C†3cf#c“VF#S3Ccss#“&C†Â-]ów&¥ófS&C3“Cƒƒ“&S#Scc–33†gæwfW%óƒ6fcC“sv3ƒ““s#6#scc–SSCvc6ÂFWÆ÷–ÖVçBvFWófS&F3VSƒƒƒƒ“##6f#ScSFS#†6(	G7V66VVFVC²MíÍ]Ò¶æ÷FvÖ&ç'UÒ†‡GG3¢òöæ÷FvÖ&ç'R’í]ÝÒý=½}Ý½Ââv—D‡V"Ö–æ¢#sC3&cC†–C†F&Cc#3&SC–6V&CSV#vC–F²M]]-âv—D‡V"õ6—FW2í-ý½â†c&&VvFCC#VFSfSVVC6#fSf33v&6FSsƒv’â	ý]]Bý=½­m]’í]Ý]Ý­íýòc¥ÄDäB4ÄTäD%Æ6†V6·ö–çG5Ã##bÓÓ#•CRÓ3rÓ3’Óƒs•¢Ö&Vf÷&R×V&Æ—6‚×7FGW2Ö–6öç2çF&²]"&öGV7F–öâÝí­ƒ¢c¥ÄDäB4ÄTäD%Æ6†V6·ö–çG5Ã##bÓÓ#’×7FGW2Ö–6öç2×&VÆV6RçF"æw¦â	-í}Ý­ƒ¢½­-½í2}Ý}­í%Ò‚ââòââöÆ–"÷F&ÆRö6öæF—F–öç2çG2’Â´6çf5Ò‚ââòââö÷F&ÆR÷F&ÆRÖ6çf2çG7‚’Â½Í]Ýâí-íýÝ•Ò‚ââòââö÷F&ÆR÷Fö¶VâÖ6öçFW‡BÖÖVçRçG7‚’à Ð Ð¢22	½mRí­Ý­½]ÝMðÐ Ð­	ýâ}ýí2ýí½Í}í--]½òMí-½]Ý²½mRý]M½ím]Ýòý‚í-=---‚(	3"=}-Ý­í"Â}½âMí-=ýÝ½R‚Í]Ý]rýíM]íMý]=â-ííMÝí=â-]Í]Ý‚â	=½í}­*½
-í½Í­â­í=MÍí=="-\+²-í}-]"-í=’ýíMíâ	Í-]=}--=]""}-S²ýíM--]mMÝÝ½R]‚­½í}í-òÂUD2‚”äF–ÖW¦öæRí]Ý]Ý²â
Ââµ½	­½]ÝMÂ‚-]ÍõÕÒàÐ Ð­	ý]-}Ýòýí-]­¢B-]-í"ý½Ýí-­ý]=]’­½]ÝMòýí½‚ÂG—U67&—Býí²â	"í]’í}]’ýý­Rýí½Ý½’çÒFW7C¢3Bó3rÂ-‚íò"ý½½]½ÍÝâ}Í]Ýý]ÍíÂF&ÆRÖçFW7BæÖ§2†÷&F–æ'’'F–6—çG26VRFö¶VâVF—Bf÷&Ó²–ç7V7F÷"g&7F–öæÂ6—¦S²6ö×7BFööÆ&"’â	M½ò]½}­½]ÝMòýí½Í}=]-òí-M]½ÍÝò­íýòíý=½­í-ÝÝí=â6÷W&6R]rÝ]}-]ÝÝ½R}Í]Ý]Ý’-í½â	ýí½Í}í--]½Âí-M]½ÍÝâ}]²ý=½­mâ-‚v—D‡V"M½òÝ-í’}M}‚àÐ Ð­
}]­ýíÝ#¢c¥ÄDäB4ÄTäD%Æ6†V6·ö–çG5Ã##bÓÓ#’ÓS"Ö&Vf÷&RÖ6ÆVæF"ÖæV"ÖÖF6†W2çF"æw¦â	ý]-}ÝòÝ]=M}Ýòýíý½-­F"í]Ý]ÝÂý]M½M=R]-²ÝR=M½ý½Ââ	-í=í-½Rýí-]­‚‚ý=½­mò=M="MíýÝ²ýí½R-½ýí½Ý]ÝòàÐ Ð¢222	ýí-]­‚]½}Ýí’­íý‚­½]ÝMðÐ Ð­	"í-M]½ÍÝíÂ6†V6¶÷WBc¥ÄDäB4ÄTäD%Æ6ÆVæF"×&VÆV6RÓ##c#–Ý}Ríý=½­í-ÝÝí=â6÷W&6R3C“3C3ý]]Ý]]Ý²-í½Í­âM½²­½]ÝMò‚-ý}ÝÝ½R¶æ÷vÆVFvRâ	ýí½Ý½’çÒFW7C¢32ó32Â&öGV7F–öâ'V–ÆBýí²â	"½í­½ÍÝíÂ=}]RÝ-]-í-í’­ÍýÝ‚ýí-]]Ý²½m]Rs£	Íí’]M‚í-=---=íR‚“£M½òýí½Ýí=âí--²ý]]­½í}-]½ÂM½Í-=]"-½M}2â	Ým-RÝ]ýí½Ýí=â-Ý-ý]M½=]"í=½í--ÂMí-=ýÝí-ÂÂ]-]ÝíR-]í-ÝRýí½Ýí=âí--M½òÝ}Ý}]Ýòí]Ý]Ýââ
}Í]²3“9sƒCB‚CC9s¢=í}íÝ-½ÍÝíRý]]ýí½Ý]ÝRMí­=Í]Ý-í-=---=]"Âí½-Â=½í}­‚-½í-í’CB‚â	í-M]½ÍÝò--íÍ-}]­òýí-]­Ö÷F–öâ&ö&R‚ýí½Ý½’=M"Mí-=ýÝí-‚ÝR-½ýí½Ýý½ÂàÐ Ð¢222	ý=½­mò­½]ÝMò}-]]Ý Ð Ð¥6—FW3¢-]òw&¥ófS&C3“Cƒƒ“&S#Scc–33†gæwfW%ó†6C3ƒS“CccCƒ““SFC#†c63Cs#cVÂ6÷W&6RVc“c#6fVCcF33FSv&6&CVS““ƒ#sCs“ƒV6V6c36ÂFWÆ÷–ÖVçBvFWófS&SCc3ƒ“–6s–V&c63SVV(	B7V66VVFVBâ
"¶æ÷FvÖ&ç'UÒ†‡GG3¢òöæ÷FvÖ&ç'R’Â-]­=RÝ-í­‚MíÍ]Ý‚Mí-=ýí]Ý]Ý²âv—D‡V"Ö–âíÝí-½Ò}]]rýíM­½í}ÝÝ=âÝ-]=mã¢33C&3FCC6&3fS6V#ƒfV#v6cVC“C“ƒV&S–â	M]]-Íò6—FR6÷W&6R‚v—D‡V"í-ý½ƒ¢V3V33cc#ccSVc3ƒs&FS†“s#“V#SfàÐ Ð­
MÝ½ÍÝòýí-]­G—U67&—B]½}Ýí’­íý‚ýí½â	ý]]Bý=½­m]’í]ÝÒc¥ÄDäB4ÄTäD%Æ6†V6·ö–çG5Ã##bÓÓ#•CRÓSRÓ‚ÓƒsU¢Ö&Vf÷&R×V&Æ—6‚Ö6ÆVæF"ÖæV"ÖÖF6†W2çF"æw¦²]"í­‚##bÓÓ#’Ö6ÆVæF"ÖæV"ÖÖF6†W2×&VÆV6RçF"æw¦â&Wf–Wr6W76–öâ“ƒ“}-]Ó²ýí"Sƒrí-íímMÒÂF6²Ö÷væVBýím]í"&VÆV6RÝRí-½íÂâ
-]-í-ò-­½M­}­½-Â7V÷&WÂí]ÒÂ}]-½R½í­½ÍÝ½RÝ­­=Ý-‚R­ÍýÝò=M½]Ý²àÐ Ð­	íÝí-Ýí’6†V6¶÷WBÝÍ]]ÝÝâí]Ýý]"ý½½]½ÍÝ½RÝ]}-]ÝÝ½R}Í]Ý]Ýò-í½‚]íMÝ=âv—BÝ}23C“3C3²íý=½­í-ÝÝ½’6÷W&6R-]ý]ÂVc“c#6fR"í-M]½ÍÝíÂ&VÆV6R6†V6¶÷WBâ	ý]]B½]M=í]’ý=½­m]’ríÝí-Ýí=â6†V6¶÷WB-]=]-òí=½í--Â]=â-íâÝí-í’&VÖ÷FR6—FR6÷W&6RÂí]Ý"­½]ÝMÂ‚}=m=âí-2â	-í=í-ò}ýÂMí-½]Ý½í­½ÍÝâýí½R-½ý=­àÐ