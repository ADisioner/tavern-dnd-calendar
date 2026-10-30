import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as conditions from '../lib/table/conditions.ts';

function menu(options = {}) {
  const states = [], refs = [], deps = [], effects = [], listeners = new Map(), actions = [];
  let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useEffect(effect, next) { const i = cursor++; if (!deps[i] || next.some((value, j) => value !== deps[i][j])) { effects.push(effect); deps[i] = next; } },
  };
  const exports = {}, jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(fs.readFileSync(new URL('../app/table/token-context-menu.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name.includes('/conditions')) return conditions;
    return new Proxy({}, { get: (_target, key) => key });
  }, document: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener() {} }, window: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener() {} } });
  let props = { token: { id: 'one', name: 'Hero', size: 1 }, pending: false, radius: 32, position: { x: 100, y: 100 }, viewport: { width: 800, height: 600 }, onAction: (...args) => actions.push(args), ...options };
  const render = next => { props = { ...props, ...next }; cursor = 0; const tree = exports.default(props); effects.splice(0).forEach(effect => effect()); return tree; };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
  const find = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label);
  return { render, nodes, find, actions, listeners, exports };
}
test('token controls send the selected token action and pending disables every button', () => {
  const view = menu(); const tree = view.render();
  for (const [label, action] of [['Повернуть фигуру', 'rotate'], ['Заблокировать фигуру', 'lock'], ['Создать копию', 'duplicate'], ['Удалить фигуру', 'delete']]) {
    view.find(tree, label).props.onClick(); assert.equal(view.actions.at(-1)[1], action); assert.equal(view.actions.at(-1)[0].id, 'one');
  }
  const pending = view.render({ pending: true });
  assert.ok(view.nodes(pending).filter(node => node.type === 'button').every(node => node.props.disabled));
});

for (const side of ['слева', 'справа']) test(`resize handle ${side} grows right, shrinks left and commits once on release`, () => {
  const previews = [], view = menu({ resizePixelsPerCell: 80, onResizePreview: value => previews.push(value) });
  const handle = view.find(view.render(), `Изменить размер ${side}`);
  assert.ok(handle);
  const evt = x => ({ button: 0, pointerId: 1, clientX: x, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } });
  handle.props.onPointerDown(evt(100));
  handle.props.onPointerMove(evt(140)); assert.equal(previews.at(-1), 1.5);
  handle.props.onPointerMove(evt(60)); assert.equal(previews.at(-1), 0.5);
  assert.equal(view.actions.length, 0);
  handle.props.onPointerUp(evt(120));
  assert.equal(view.actions.length, 1); assert.equal(view.actions[0][1], 'resize'); assert.equal(view.actions[0][2], 1.25);
  handle.props.onLostPointerCapture(evt(120)); assert.equal(view.actions.length, 1);
});

test('resize clamps limits, cancels on Escape and never saves a plain press', () => {
  const previews = [], view = menu({ resizePixelsPerCell: 80, onResizePreview: value => previews.push(value) });
  const handle = view.find(view.render(), 'Изменить размер слева');
  assert.ok(handle);
  const evt = x => ({ button: 0, pointerId: 1, clientX: x, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } });
  handle.props.onPointerDown(evt(100)); handle.props.onPointerMove(evt(1000)); assert.equal(previews.at(-1), 3);
  view.listeners.get('keydown')({ key: 'Escape' }); assert.equal(previews.at(-1), null);
  handle.props.onPointerUp(evt(1000)); assert.equal(view.actions.length, 0);
  handle.props.onPointerDown(evt(100)); handle.props.onPointerUp(evt(100)); assert.equal(view.actions.length, 0);
});
test('layer popup dispatches front/back; Escape and token change close popups', () => {
  const view = menu(); let tree = view.render();
  view.find(tree, 'Порядок слоёв').props.onClick(); tree = view.render();
  view.find(tree, 'На передний план').props.onClick(); assert.equal(view.actions.at(-1)[1], 'front');
  view.find(tree, 'На задний план').props.onClick(); assert.equal(view.actions.at(-1)[1], 'back');
  view.listeners.get('keydown')({ key: 'Escape' }); tree = view.render();
  assert.equal(view.find(tree, 'На передний план'), undefined);
  view.find(tree, 'Дополнительно').props.onClick(); tree = view.render();
  assert.ok(view.find(tree, 'Дополнительные действия'));
  view.render({ token: { id: 'two', name: 'Other', size: 1 } }); tree = view.render();
  assert.equal(view.find(tree, 'Дополнительные действия'), undefined);
});
test('label popup edits name and visibility through separate explicit actions', () => {
  const view = menu(); let tree = view.render();
  view.find(tree, 'Подпись фигуры').props.onClick(); tree = view.render();
  view.find(tree, 'Имя фигуры').props.onChange({ target: { value: 'Renamed' } }); tree = view.render();
  view.nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(view.actions.at(-1)[1], 'label'); assert.equal(view.actions.at(-1)[2], 'Renamed');
  view.find(tree, 'Показывать подпись').props.onChange({ target: { checked: false } });
  assert.equal(view.actions.at(-1)[2], false);
});
test('menu placement keeps fixed-size controls within viewport edges', () => {
  const view = menu();
  const point = view.exports.tokenMenuPlacement({ x: -500, y: 900 }, 120, { width: 360, height: 420 });
  assert.ok(point.x >= 140 && point.x <= 220); assert.ok(point.y >= 100 && point.y <= 310);
});
test('large-token controls follow the circumference until viewport space is exhausted', () => {
  const view = menu();
  const roomy = view.exports.tokenMenuPlacement({ x: 400, y: 300 }, 180, { width: 800, height: 600 });
  assert.equal(roomy.radius, 180);
  const edge = view.exports.tokenMenuPlacement({ x: -100, y: 999 }, 180, { width: 800, height: 600 });
  assert.ok(edge.x >= 232); assert.ok(edge.y + edge.radius + 68 <= 600);
  const narrow = view.exports.tokenMenuPlacement({ x: 180, y: 210 }, 180, { width: 360, height: 420 });
  assert.ok(narrow.radius > 80); assert.ok(narrow.x - narrow.radius - 50 >= 0); assert.ok(narrow.x + narrow.radius + 50 <= 360);
  assert.ok(narrow.scale <= 0.675);
});
test('token menu controls scale with the token radius and stay inside practical limits', () => {
  const view = menu();
  const small = view.exports.tokenMenuPlacement({ x: 100, y: 100 }, 10, { width: 800, height: 600 });
  const regular = view.exports.tokenMenuPlacement({ x: 100, y: 100 }, 32, { width: 800, height: 600 });
  const large = view.exports.tokenMenuPlacement({ x: 100, y: 100 }, 200, { width: 800, height: 600 });
  assert.ok(small.scale < regular.scale);
  assert.ok(large.scale > regular.scale);
  assert.ok(small.scale >= 0.35);
  assert.ok(large.scale <= 0.675);
  assert.equal(large.scale, 0.675);
  assert.equal(small.scale, 0.375);
});
test('outside pointer closes popup and menu events cannot bubble into canvas gestures', () => {
  const view = menu(); let tree = view.render();
  view.find(tree, 'Дополнительно').props.onClick(); tree = view.render();
  tree.props.ref.current = { contains: () => false };
  view.listeners.get('pointerdown')({ target: {} }); tree = view.render();
  assert.equal(view.find(tree, 'Дополнительные действия'), undefined);
  for (const name of ['onMouseDown', 'onPointerDown', 'onTouchStart', 'onWheel', 'onClick']) {
    let stopped = false; tree.props[name]({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
  }
});
test('copy and paste shortcuts can leave the token menu while other keys stay scoped to it', () => {
  const view = menu(), tree = view.render();
  let stopped = false;
  tree.props.onKeyDown({ key: 'c', ctrlKey: true, stopPropagation() { stopped = true; } });
  assert.equal(stopped, false);
  tree.props.onKeyDown({ key: 'ArrowRight', stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});
test('status tab exposes all conditions and independently toggles conditions, exhaustion and clear', () => {
  const view = menu({ token: { id: 'one', name: 'Hero', size: 1, statuses: ['blinded', 'poisoned'], exhaustionLevel: 3 } });
  let tree = view.render(); view.find(tree, 'Дополнительно').props.onClick(); tree = view.render();
  view.find(tree, 'Статус').props.onClick(); tree = view.render();
  const checks = view.nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checks.length, 17);
  assert.ok(checks.some(node => node.props.value === 'concentration'));
  assert.ok(checks.some(node => node.props.value === 'dead'));
  const symbols = view.nodes(tree).filter(node => node.type === 'svg' && node.props.className === 'token-condition-icon');
  assert.equal(symbols.length, 17);
  assert.ok(symbols.every(node => view.nodes(node).some(child => child.type === 'path' && child.props.d)));
  const blind = checks.find(node => node.props.value === 'blinded'), poison = checks.find(node => node.props.value === 'poisoned');
  assert.equal(blind.props.checked, true); assert.equal(poison.props.checked, true);
  blind.props.onChange(); assert.equal(view.actions.at(-1)[1], 'status'); assert.equal(view.actions.at(-1)[2], 'blinded');
  view.find(tree, 'Уровень истощения').props.onChange({ target: { value: '5' } }); assert.equal(view.actions.at(-1)[2], 'exhaustion:5');
  view.find(tree, 'Снять все состояния').props.onClick(); assert.equal(view.actions.at(-1)[2], 'clear');
  tree = view.render({ pending: true });
  assert.ok(view.nodes(tree).filter(node => node.type === 'input' || node.type === 'select').every(node => node.props.disabled));
});
