import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as sceneModel from '../lib/table/scene.ts';
import * as conditions from '../lib/table/conditions.ts';

function app(role = 'player') {
  const tokens = [
    { id: 'a', name: 'First', version: 2, size: 1, x: 40, y: 40 },
    { id: 'b', name: 'Second', version: 4, size: 1, x: 120, y: 40, groupId: 'group' },
    { id: 'c', name: 'Third', version: 5, size: 1, x: 200, y: 40, groupId: 'group' },
  ];
  const scene = { id: 'scene', tokens, gridSize: 80, gridVisible: true, gridColor: '#decea1', gridOpacity: 0.18, updatedAt: 0 }, sent = [], state = [];
  const room = { scene, bootstrap: { actor: { role }, campaign: { name: 'Party' }, roster: [] },
    connection: 'connected', pending: false, scenes: [], peers: [], send: command => { sent.push(command); return true; } };
  let cursor = 0, keyboard;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../app/table/table-app.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, FormData, Intl, require: name => {
    if (name === 'react') return { useEffect() {}, useState: initial => {
      const index = cursor++; if (!(index in state)) state[index] = index === 0 ? 'Canvas' : initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    } };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'next/navigation') return { useRouter: () => ({}) };
    if (name.includes('use-table-room')) return { useTableRoom: () => room };
    if (name.includes('use-token-keyboard')) return { useTokenKeyboard: value => { keyboard = value; } };
    if (name.endsWith('/scene')) return sceneModel;
    if (name.endsWith('/conditions')) return conditions;
    return {};
  }, FormData: class TestFormData { constructor(form) { this.form = form; } get(key) { return this.form.values?.[key] ?? null; } } });
  function render() { cursor = 0; return exports.default({ campaignId: 'campaign' }); }
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
  const canvas = () => nodes(render()).find(node => node.type === 'Canvas').props;
  return { scene, tokens, sent, render, canvas, keyboard: () => keyboard, nodes };
}

test('music window hides locally without sending a shared pause and retains the iframe', () => {
  const exports = {}, sent = [];
  let closed = false;
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../app/table/table-music-panel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: name => {
    if (name === 'react') return { useState: initial => [initial, () => {}], useMemo: callback => callback() };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    return {};
  } });
  const props = { music: { tracks: [{ id: 'track', videoId: 'dQw4w9WgXcQ', title: 'Song' }], currentTrackId: 'track', playing: true, startedAt: 0, positionSeconds: 0 },
    disabled: false, hidden: false, send: command => sent.push(command), onClose: () => { closed = true; } };
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
  nodes(exports.default(props)).find(node => node.props?.['aria-label'] === 'Скрыть окно музыки').props.onClick();
  assert.equal(closed, true);
  assert.deepEqual(sent, []);
  const hidden = exports.default({ ...props, hidden: true });
  assert.equal(hidden.props.hidden, true);
  assert.ok(nodes(hidden).some(node => node.type === 'iframe'));
});

test('Shift selection expands groups and toggles them without losing the primary token', () => {
  const view = app();
  view.canvas().onSelect('a'); view.canvas().onSelect('b', true);
  assert.deepEqual([...view.canvas().selectedIds].sort(), ['a', 'b', 'c']);
  assert.equal(view.canvas().selectedId, 'b');
  view.canvas().onSelect('c', true);
  assert.deepEqual([...view.canvas().selectedIds], ['a']);
});

test('rectangle selection expands groups; Delete sends one atomic command for the current selection', () => {
  const view = app();
  view.canvas().onSelectMany(['a', 'b']); view.render();
  view.keyboard().removeToken(view.tokens[1]);
  const command = view.sent[0];
  assert.equal(command.type, 'remove-many');
  assert.deepEqual(Array.from(command.tokens, token => [token.tokenId, token.expectedVersion]), [['a', 2], ['b', 4], ['c', 5]]);
});

test('ordinary participants see token edit form and an explicit delete action', () => {
  const view = app(); view.nodes(view.render()).find(node => node.type === 'button' && node.props?.['aria-label'] === 'Открыть панель стола').props.onClick(); view.canvas().onSelect('a');
  const nodes = view.nodes(view.render());
  assert.ok(nodes.some(node => node.type === 'input' && node.props.name === 'name'));
  const remove = nodes.find(node => node.type === 'button' && node.props.className?.includes('table-delete-token'));
  assert.ok(remove); assert.equal(remove.props.disabled, false);
  remove.props.onClick(); assert.equal(view.sent[0].type, 'remove'); assert.equal(view.sent[0].tokenId, 'a');
});

test('master can configure grid color and opacity and submits both with the scene grid settings', () => {
  const view = app('master');
  view.nodes(view.render()).find(node => node.type === 'button' && node.props?.['aria-label'] === 'Открыть панель стола').props.onClick();
  const nodes = view.nodes(view.render());
  const color = nodes.find(node => node.type === 'input' && node.props.name === 'gridColor');
  const opacity = nodes.find(node => node.type === 'input' && node.props.name === 'gridOpacity');
  assert.equal(color.props.type, 'color'); assert.equal(color.props.defaultValue, '#decea1');
  assert.equal(opacity.props.type, 'range'); assert.equal(opacity.props.defaultValue, 18);
  const form = nodes.find(node => node.type === 'form' && node.props.onSubmit);
  form.props.onSubmit({ preventDefault() {}, currentTarget: { values: { gridSize: '60', gridVisible: 'yes', gridColor: '#336699', gridOpacity: '42' } } });
  assert.equal(view.sent[0].type, 'grid'); assert.equal(view.sent[0].gridSize, 60); assert.equal(view.sent[0].gridVisible, true);
  assert.equal(view.sent[0].gridColor, '#336699'); assert.equal(view.sent[0].gridOpacity, 0.42);
});

test('selection follows a remotely merged group and Shift can still deselect the whole group', () => {
  const view = app(); view.canvas().onSelect('a');
  view.tokens[0].groupId = 'group';
  assert.deepEqual([...view.canvas().selectedIds].sort(), ['a', 'b', 'c']);
  assert.equal(view.canvas().selectedId, 'a');
  view.canvas().onSelect('b', true);
  assert.deepEqual([...view.canvas().selectedIds], []);
});

test('token menu updates size, rotation, lock, layer and label using the selected version', () => {
  const view = app(); view.canvas().onSelect('a');
  for (const [action, value, field, expected] of [
    ['resize', 1.73, 'size', 1.73], ['resize', 10, 'size', 3], ['resize', -1, 'size', 0.5],
    ['larger', undefined, 'size', 1.5], ['smaller', undefined, 'size', 0.5],
    ['rotate', undefined, 'rotation', 45], ['lock', undefined, 'locked', true],
    ['front', undefined, 'layer', 1], ['back', undefined, 'layer', -1],
    ['label', false, 'showLabel', false], ['label', 'New label', 'name', 'New label'],
  ]) {
    view.canvas().onTokenAction?.(view.tokens[0], action, value);
    const command = view.sent.at(-1);
    assert.ok(command, action); assert.equal(command.type, 'update');
    assert.equal(command.expectedVersion, 2); assert.equal(command[field], expected);
  }
});

test('token menu copy and delete target the primary token only', () => {
  const view = app(); view.canvas().onSelectMany(['a', 'b']);
  view.canvas().onTokenAction?.(view.tokens[0], 'duplicate');
  view.canvas().onTokenAction?.(view.tokens[0], 'delete');
  assert.deepEqual(Array.from(view.sent, value => [value.type, value.tokenId, value.expectedVersion]), [['duplicate', 'a', 2], ['remove', 'a', 2]]);
});

test('keyboard copy-paste duplicates the selected token through the shared scene command', () => {
  const view = app();
  view.render();
  view.keyboard().duplicateToken(view.tokens[0]);
  assert.equal(view.sent[0].type, 'duplicate');
  assert.equal(view.sent[0].tokenId, 'a');
  assert.equal(view.sent[0].expectedVersion, 2);
});

test('the inspector can preserve a fractional size from dragging when editing other properties', () => {
  const view = app(); view.tokens[0].size = 1.37; view.nodes(view.render()).find(node => node.type === 'button' && node.props?.['aria-label'] === 'Открыть панель стола').props.onClick(); view.canvas().onSelect('a');
  const field = view.nodes(view.render()).find(node => node.props?.name === 'size');
  assert.ok(field); assert.equal(field.props.defaultValue, 1.37);
  if (field.type === 'select') assert.ok(view.nodes(field).some(node => node.type === 'option' && node.props.value === 1.37));
  else { assert.equal(field.props.type, 'number'); assert.equal(field.props.step, 0.01); }
});

test('status menu toggles validated conditions, exhaustion level and clear without changing other token properties', () => {
  const view = app(); view.canvas().onSelect('a');
  view.tokens[0].statuses = ['poisoned'];
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'frightened');
  assert.deepEqual([...view.sent.at(-1).statuses], ['poisoned', 'frightened']);
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'poisoned');
  assert.deepEqual([...view.sent.at(-1).statuses], []);
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'exhaustion:4');
  assert.deepEqual([...view.sent.at(-1).statuses], ['poisoned', 'exhaustion']);
  assert.equal(view.sent.at(-1).exhaustionLevel, 4);
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'clear');
  assert.deepEqual([...view.sent.at(-1).statuses], []);
  view.tokens[0].statuses = [];
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'concentration');
  assert.deepEqual([...view.sent.at(-1).statuses], ['concentration']);
  view.tokens[0].statuses = ['concentration'];
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'dead');
  assert.deepEqual([...view.sent.at(-1).statuses], ['concentration', 'dead']);
  const count = view.sent.length;
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'invalid');
  view.canvas().onTokenAction?.(view.tokens[0], 'status', 'exhaustion:9');
  assert.equal(view.sent.length, count);
});

test('compact toolbar keeps the inspector closed, opens it on demand and selects ruler modes', () => {
  const view = app();
  let nodes = view.nodes(view.render());
  assert.equal(nodes.some(node => node.props?.className === 'table-inspector'), false);
  const panel = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Открыть панель стола');
  assert.ok(panel); panel.props.onClick(); nodes = view.nodes(view.render());
  assert.ok(nodes.some(node => node.props?.className === 'table-inspector'));
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Закрыть панель стола').props.onClick();
  nodes = view.nodes(view.render()); assert.equal(nodes.some(node => node.props?.className === 'table-inspector'), false);
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка и AoE').props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 300, height: 42 }), closest: () => ({ getBoundingClientRect: () => ({ top: 100, height: 600 }) }) } });
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Сфера').props.onClick();
  assert.equal(view.canvas().tool, 'measure'); assert.equal(view.canvas().measureMode, 'sphere');
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка и AoE').props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 300, height: 42 }), closest: () => ({ getBoundingClientRect: () => ({ top: 100, height: 600 }) }) } });
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка движения токена').props.onClick();
  assert.equal(view.canvas().tool, 'select'); assert.equal(view.canvas().measureMode, 'move');
});

test('ruler button activates the line and its menu escapes the clipping toolbar', () => {
  const view = app();
  const tree = view.nodes(view.render());
  const ruler = tree.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка и AoE');
  ruler.props.onClick({ currentTarget: {
    getBoundingClientRect: () => ({ top: 300, height: 42 }),
    closest: selector => selector === '.table-main' ? { getBoundingClientRect: () => ({ top: 100, height: 600 }) } : null,
  } });
  const afterClick = view.nodes(view.render());
  assert.equal(view.canvas().tool, 'measure');
  assert.equal(view.canvas().measureMode, 'line');
  const toolbar = afterClick.find(node => node.props?.className === 'table-tools');
  const main = afterClick.find(node => node.props?.className === 'table-main');
  assert.equal(view.nodes(toolbar).some(node => node.props?.className === 'table-ruler-menu'), false);
  assert.ok(view.nodes(main).some(node => node.props?.className === 'table-ruler-menu'));
});


test('minimizing initiative retains panel and server combat, and exposes current turn in dock',()=>{
 const view=app('master');view.scene.combat={running:true,round:3,currentId:'e',entries:[{id:'e',tokenId:'a'}]};
 let nodes=view.nodes(view.render());const toggle=()=>nodes.find(n=>n.type==='button'&&n.props?.['aria-label']==='Инициатива и бой').props.onClick();
 const panel=()=>nodes.find(n=>n.props?.onClose&&n.props?.onSelect&&n.props?.scene===view.scene);
 assert.equal(panel().props.open,false);assert.ok(nodes.some(n=>n.props?.className==='combat-mini'));
 toggle();nodes=view.nodes(view.render());assert.equal(panel().props.open,true);
 panel().props.onClose();nodes=view.nodes(view.render());assert.equal(panel().props.open,false);assert.equal(panel().props.scene.combat.currentId,'e');assert.equal(view.sent.length,0);
});
