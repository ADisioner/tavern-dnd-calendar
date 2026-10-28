import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as geometry from '../lib/table/geometry.ts';

// Render the actual canvas handlers without a browser or GPU.
function canvas(tool = 'select') {
  const effects = [], refs = [], listeners = new Map(), previews = [], ended = [];
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState: value => [value, () => {}],
    useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect: effect => effects.push(effect), useCallback: callback => callback,
  };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL('../app/table/table-canvas.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-konva') return Object.fromEntries(['Stage','Layer','Image','Line','Group','Circle','Text'].map(key => [key, key]));
    if (name.includes('/geometry')) return geometry;
    if (name.includes('/scene')) return { canMoveToken: () => true };
    if (name.includes('/motion')) return { boundedPoint: (_token, _grid, point) => point };
    return {};
  }, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: () => {} } });
  const token = { id: 'one', x: 40, y: 40, size: 1, name: 'Hero' };
  const scene = { tokens: [token], width: 800, height: 600, gridSize: 80 };
  const tree = exports.default({ scene, actor: {}, tool, snap: true, pending: false,
    onSelect: id => previews.push(['select', id]), motionStore: { position: (_id, point) => point },
    onMotionStart: () => true, onMotionPreview: (_token, point) => previews.push(['move', point]), onMotionEnd: id => ended.push(id) });
  const stage = tree.props.children[0];
  return { tree, stage, refs, effects, listeners, previews, ended };
}

for (const tool of ['select', 'pan']) test(`middle mouse starts camera drag over tokens in ${tool} mode without selection`, () => {
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
    const group = view.stage.props.children[1].props.children[0];
    group.props.onDragStart({ target: {}, evt: {} });
    group.props.onDragEnd({ target: { x: () => 57, y: () => 93 }, evt: { [modifier]: true } });
    const point = view.previews.find(entry => entry[0] === 'move')[1];
    assert.equal(point.x, expected.x); assert.equal(point.y, expected.y);
  });
}

test('switching away from a token drag finalizes its motion without a native event', () => {
  const view = canvas();
  const group = view.stage.props.children[1].props.children[0];
  group.props.onDragStart({ target: {}, evt: {} });
  assert.doesNotThrow(() => group.props.onDragEnd({ target: { x: () => 57, y: () => 93 } }));
  assert.equal(view.previews.find(entry => entry[0] === 'move')[1].x, 40);
  assert.deepEqual(view.ended, ['one']);
});

test('middle mouse finishes an active token gesture before starting the camera', () => {
  const view = canvas();
  const group = view.stage.props.children[1].props.children[0];
  const nativeEvent = { button: 1, ctrlKey: true };
  group.props.onDragStart({ target: {}, evt: {} });
  // A real Group.stopDrag emits dragend; use it to exercise the transition ordering.
  view.refs[view.refs.length - 2].current.set('one', {
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
