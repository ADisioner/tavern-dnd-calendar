import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as geometry from '../lib/table/geometry.ts';
import * as selection from '../lib/table/selection.ts';
import * as sceneModule from '../lib/table/scene.ts';
import * as conditions from '../lib/table/conditions.ts';

// Render the actual canvas handlers without a browser or GPU.
function canvas(tool = 'select', options = {}) {
  const effects = [], refs = [], listeners = new Map(), previews = [], ended = [], drawings = [], erased = [], selections = [];
  let refCursor = 0;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState: value => [value?.scale && options.camera ? options.camera : value, () => {}],
    useRef: value => refs[refCursor++] ?? (refs[refCursor - 1] = { current: value }),
    useEffect: effect => effects.push(effect), useCallback: callback => callback,
  };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL('../app/table/table-canvas.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-konva') return Object.fromEntries(['Stage','Layer','Image','Line','Rect','Group','Circle','Text'].map(key => [key, key]));
    if (name.includes('/geometry')) return geometry;
    if (name.includes('/selection')) return selection;
    if (name.includes('/conditions')) return conditions;
    if (name.includes('/scene')) return { ...sceneModule, canMoveToken: () => true };
    if (name.includes('/motion')) return { boundedPoint: (_token, _grid, point) => point };
    return {};
  }, crypto: { randomUUID: () => 'stroke-one' }, document: { querySelector: () => null }, HTMLElement: class {}, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: () => {} } });
  const token = { id: 'one', x: 40, y: 40, size: 1, name: 'Hero' };
  const scene = { tokens: [token], drawings: [], width: 800, height: 600, gridSize: 80, ...options.scene };
  const props = { scene, actor: {}, tool, snap: true, pending: false,
    onSelect: (id, additive) => previews.push(['select', id, additive]), motionStore: { position: (_id, point) => point },
    onMotionStart: () => true, onMotionPreview: (_token, point) => previews.push(['move', point]), onMotionEnd: id => ended.push(id),
    onDraw: drawing => drawings.push(drawing), onErase: id => erased.push(id), onSelectMany: (ids, additive) => selections.push([ids, additive]), ...options, scene };
  const tree = exports.default(props);
  const stage = tree.props.children[0];
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const group = nodes(stage).find(node => node.type === 'Group' && node.props.id === 'one');
  return { tree, stage, group, refs, effects, listeners, previews, ended, drawings, erased, selections, nodes,
    rerender: next => { refCursor = 0; return exports.default({ ...props, ...next }); } };
}

for (const tool of ['select', 'pan', 'draw', 'erase']) test(`middle mouse starts camera drag over tokens in ${tool} mode without selection`, () => {
  const view = canvas(tool);
  let started = 0, prevented = false, stopped = false;
  const nativeEvent = { button: 1 };
  const stage = { setPointersPositions: event => assert.equal(event, nativeEvent), startDrag: () => started++ };
  view.refs[1].current = stage;
  view.tree.props.onMouseDownCapture?.({ button: 1, nativeEvent,
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(started, 1);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(view.previews, []);
});

for (const [modifier, expected] of [['ctrlKey', { x: 57, y: 93 }], ['altKey', { x: 57, y: 93 }], ['none', { x: 40, y: 120 }]]) {
  test(`token drop respects ${modifier} snap override`, () => {
    const view = canvas();
    const group = view.group;
    group.props.onDragStart({ target: {}, evt: {} });
    group.props.onDragEnd({ target: { x: () => 57, y: () => 93 }, evt: { [modifier]: true } });
    const point = view.previews.find(entry => entry[0] === 'move')[1];
    assert.equal(point.x, expected.x); assert.equal(point.y, expected.y);
  });
}

test('switching away from a token drag finalizes its motion without a native event', () => {
  const view = canvas();
  const group = view.group;
  group.props.onDragStart({ target: {}, evt: {} });
  assert.doesNotThrow(() => group.props.onDragEnd({ target: { x: () => 57, y: () => 93 } }));
  assert.equal(view.previews.find(entry => entry[0] === 'move')[1].x, 40);
  assert.deepEqual(view.ended, ['one']);
});

test('middle mouse finishes an active token gesture before starting the camera', () => {
  const view = canvas();
  const group = view.group;
  const nativeEvent = { button: 1, ctrlKey: true };
  group.props.onDragStart({ target: {}, evt: {} });
  // A real Group.stopDrag emits dragend; use it to exercise the transition ordering.
  group.props.ref({
    stopDrag: evt => group.props.onDragEnd({ target: { x: () => 57, y: () => 93 }, evt }),
  });
  let started = false;
  view.refs[1].current = { setPointersPositions: () => {}, startDrag: () => {
    assert.deepEqual(view.ended, ['one']); started = true;
  } };
  view.tree.props.onMouseDownCapture({ button: 1, nativeEvent, preventDefault() {}, stopPropagation() {} });
  assert.equal(started, true);
  assert.equal(view.previews.find(entry => entry[0] === 'move')[1].x, 57);
});

function pointerStage(view) {
  let point = { x: 10, y: 15 };
  const stage = { getPointerPosition: () => point, stopDrag() {}, setPointersPositions() {}, startDrag() {} };
  view.stage.props.ref.current = stage;
  return { stage, point: next => { point = next; } };
}
test('brush commits one world-coordinate stroke on release, including a single-point tap', () => {
  const view = canvas('draw', { brushColor: '#123456', brushWidth: 7 });
  const pointer = pointerStage(view);
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0 } });
  assert.equal(view.drawings.length, 0);
  pointer.point({ x: 30, y: 35 }); view.stage.props.onMouseMove({ evt: {} });
  view.stage.props.onMouseUp?.({ evt: {} }); view.stage.props.onMouseUp?.({ evt: {} });
  assert.equal(view.drawings.length, 1);
  assert.deepEqual(Array.from(view.drawings[0].points), [20, 30, 60, 70]);
  assert.equal(view.drawings[0].color, '#123456'); assert.equal(view.drawings[0].width, 7);
  view.stage.props.onTouchStart({ target: pointer.stage, evt: { touches: [{}] } });
  view.stage.props.onTouchEnd({ evt: { touches: [] } });
  assert.equal(view.drawings.length, 2);
  assert.deepEqual(Array.from(view.drawings[1].points), [60, 70, 60, 70]);
});
test('rectangle selection uses world coordinates and Shift adds to selection', () => {
  const view = canvas('select'); const pointer = pointerStage(view);
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0, shiftKey: true } });
  pointer.point({ x: 30, y: 30 }); view.stage.props.onMouseMove({ evt: {} });
  view.stage.props.onMouseUp?.({ evt: {} });
  assert.equal(view.selections.length, 1);
  assert.deepEqual(Array.from(view.selections[0][0]), ['one']); assert.equal(view.selections[0][1], true);
});
test('brush and rectangle selection account for both camera zoom and offset', () => {
  const drawing = canvas('draw', { camera: { x: 100, y: -20, scale: 2 } }); const dp = pointerStage(drawing);
  dp.point({ x: 120, y: 20 }); drawing.stage.props.onMouseDown({ target: dp.stage, evt: { button: 0 } });
  dp.point({ x: 200, y: 100 }); drawing.stage.props.onMouseMove({ evt: {} }); drawing.stage.props.onMouseUp({ evt: {} });
  assert.deepEqual(Array.from(drawing.drawings[0].points), [10, 20, 50, 60]);
  const selection = canvas('select', { camera: { x: 100, y: -20, scale: 2 } }); const sp = pointerStage(selection);
  sp.point({ x: 120, y: 20 }); selection.stage.props.onMouseDown({ target: sp.stage, evt: { button: 0 } });
  sp.point({ x: 200, y: 100 }); selection.stage.props.onMouseMove({ evt: {} }); selection.stage.props.onMouseUp({ evt: {} });
  assert.deepEqual(Array.from(selection.selections[0][0]), ['one']);
});
test('touch rectangle and blank click preserve additive-selection semantics', () => {
  const view = canvas('select'); const pointer = pointerStage(view);
  view.stage.props.onTouchStart({ target: pointer.stage, evt: { touches: [{}] } });
  pointer.point({ x: 30, y: 30 }); view.stage.props.onTouchMove({ evt: { touches: [{}] } });
  view.stage.props.onTouchEnd({ evt: { touches: [] } });
  assert.deepEqual(Array.from(view.selections[0][0]), ['one']);
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0, shiftKey: true } }); view.stage.props.onMouseUp({ evt: {} });
  assert.deepEqual(view.previews, []);
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0 } }); view.stage.props.onMouseUp({ evt: {} });
  assert.deepEqual(view.previews, [['select', null, undefined]]);
});
test('Shift click toggles selection and dragging a selected token preserves the full selection', () => {
  const view = canvas('select', { selectedIds: ['one', 'two'] });
  view.group.props.onClick({ evt: { shiftKey: true } });
  assert.deepEqual(view.previews, [['select', 'one', true]]);
  view.group.props.onDragStart({ target: {}, evt: {} });
  assert.equal(view.previews.length, 1);
});
for (const tool of ['draw', 'erase', 'pan']) test(`${tool} cannot select or start token motion`, () => {
  const view = canvas(tool); let stopped = false;
  assert.equal(view.group.props.draggable, false);
  view.group.props.onClick({ evt: {} });
  view.group.props.onDragStart({ target: { stopDrag: () => { stopped = true; } }, evt: {} });
  assert.deepEqual(view.previews, []); assert.equal(stopped, true);
});
test('eraser removes a whole shared stroke on mouse and touch press', () => {
  const view = canvas('erase', { scene: { drawings: [{ id: 'ink', points: [1, 2, 3, 4], color: '#123456', width: 4 }] } });
  const stroke = view.nodes(view.stage).find(node => node.type === 'Line' && node.props.points?.[0] === 1);
  assert.ok(stroke);
  stroke.props.onMouseDown({ evt: { button: 0 } }); stroke.props.onTouchStart({ evt: { touches: [{}] } });
  assert.deepEqual(view.erased, ['ink', 'ink']);
});
test('pinch cancels a draft instead of committing accidental ink', () => {
  const view = canvas('draw'); const pointer = pointerStage(view);
  view.stage.props.onTouchStart({ target: pointer.stage, evt: { touches: [{}] } });
  view.stage.props.onTouchStart({ target: pointer.stage, evt: { touches: [{}, {}] } });
  view.stage.props.onTouchEnd({ evt: { touches: [] } });
  assert.deepEqual(view.drawings, []);
});
test('middle mouse cancels draft before panning and cannot erase', () => {
  const view = canvas('draw'); const pointer = pointerStage(view);
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0 } });
  view.tree.props.onMouseDownCapture({ button: 1, nativeEvent: { button: 1 }, preventDefault() {}, stopPropagation() {} });
  view.stage.props.onMouseUp?.({ evt: { button: 0 } });
  assert.deepEqual(view.drawings, []);
});
test('single-touch brush follows the finger in world coordinates', () => {
  const view = canvas('draw'); const pointer = pointerStage(view);
  view.stage.props.onTouchStart({ target: pointer.stage, evt: { touches: [{}] } });
  pointer.point({ x: 45, y: 55 });
  view.stage.props.onTouchMove({ evt: { touches: [{}] } });
  view.stage.props.onTouchEnd({ evt: { touches: [] } });
  assert.deepEqual(Array.from(view.drawings[0].points), [20, 30, 90, 110]);
});
test('Space cancels a draft and takes camera priority before the next render', () => {
  const view = canvas('draw'); const pointer = pointerStage(view);
  view.effects[2]();
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0 } });
  view.listeners.get('keydown')({ code: 'Space', preventDefault() {} });
  view.stage.props.onMouseUp?.({ evt: {} });
  view.stage.props.onMouseDown({ target: pointer.stage, evt: { button: 0 } });
  view.stage.props.onMouseUp?.({ evt: {} });
  assert.deepEqual(view.drawings, []);
});
test('Space camera priority prevents erasing a shared stroke', () => {
  const view = canvas('erase', { scene: { drawings: [{ id: 'ink', points: [1, 2, 3, 4], color: '#123456', width: 4 }] } });
  view.effects[2]();
  view.listeners.get('keydown')({ code: 'Space', preventDefault() {} });
  const stroke = view.nodes(view.stage).find(node => node.type === 'Line' && node.props.points?.[0] === 1);
  stroke.props.onMouseDown({ evt: { button: 0 } });
  assert.deepEqual(view.erased, []);
});
test('using the pan tool does not lock out brush gestures after switching tools', () => {
  const view = canvas('pan'); pointerStage(view);
  view.tree.props.onMouseDownCapture({ button: 0, nativeEvent: { button: 0 }, preventDefault() {}, stopPropagation() {} });
  const brush = view.rerender({ tool: 'draw' }).props.children[0];
  brush.props.onMouseDown({ target: view.stage.props.ref.current, evt: { button: 0 } });
  brush.props.onMouseUp({ evt: {} });
  assert.equal(view.drawings.length, 1);
});
test('dragging a grouped token clamps its displayed position before previewing the whole group', () => {
  const view = canvas('select', { scene: { width: 1600, height: 1120, tokens: [
    { id: 'one', groupId: 'pair', x: 1400, y: 200, size: 1, name: 'Hero' },
    { id: 'two', groupId: 'pair', x: 1500, y: 200, size: 1, name: 'Other' },
  ] } });
  view.group.props.onDragStart({ target: {}, evt: {} });
  let displayed;
  view.group.props.onDragMove({ target: { x: () => 1580, y: () => 230, position: point => { displayed = point; } }, evt: {} });
  assert.equal(displayed.x, 1460); assert.equal(displayed.y, 230);
  const preview = view.previews.find(entry => entry[0] === 'move')[1];
  assert.equal(preview.x, 1460); assert.equal(preview.y, 230);
});
test('locked tokens and groups containing a locked token cannot begin mouse motion', () => {
  const view = canvas('select', { scene: { tokens: [
    { id: 'one', x: 80, y: 80, size: 1, name: 'Hero', groupId: 'pair' },
    { id: 'two', x: 180, y: 80, size: 1, name: 'Other', groupId: 'pair', locked: true },
  ] } });
  assert.equal(view.group.props.draggable, false);
  let stopped = false;
  view.group.props.onDragStart({ evt: {}, target: { stopDrag() { stopped = true; } } });
  assert.equal(stopped, true); assert.deepEqual(view.previews, []);
});
test('token layers determine draw order even when the lower token is selected', () => {
  const view = canvas('select', { selectedId: 'one', scene: { tokens: [
    { id: 'one', x: 80, y: 80, size: 1, name: 'Hero', layer: -1, showLabel: false, rotation: 45 },
    { id: 'two', x: 180, y: 80, size: 1, name: 'Other', layer: 1 },
  ] } });
  const groups = view.nodes(view.stage).filter(node => node.type === 'Group' && node.props.id);
  assert.deepEqual(groups.map(node => node.props.id), ['one', 'two']);
  assert.equal(view.nodes(view.group).some(node => node.type === 'Text' && node.props.text === 'Hero'), false);
  assert.ok(view.nodes(view.group).some(node => node.type === 'Group' && node.props.rotation === 45));
});
test('condition badges remain upright and show four conditions plus overflow with accessible full names', () => {
  const view = canvas('select', { scene: { tokens: [{ id: 'one', x: 80, y: 80, size: 1, name: 'Hero', rotation: 90, statuses: ['blinded', 'charmed', 'deafened', 'poisoned', 'prone'], showLabel: false }] } });
  const badges = view.nodes(view.group).find(node => node.props?.name === 'condition-badges');
  assert.ok(badges); assert.equal(badges.props.rotation ?? 0, 0);
  const text = view.nodes(badges).filter(node => node.type === 'Text').map(node => node.props.text);
  assert.equal(text.length, 5); assert.equal(text.at(-1), '+1');
  assert.ok(view.nodes(view.tree).some(node => node.props?.['aria-label'] === 'Состояния фигур'));
});
test('native menu scrolling is available while canvas touch gestures remain isolated', () => {
  const view = canvas();
  assert.notEqual(view.tree.props.style.touchAction, 'none');
  assert.equal(view.stage.props.style?.touchAction, 'none');
});
