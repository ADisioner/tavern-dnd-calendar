import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as sceneModel from '../lib/table/scene.ts';
import * as conditions from '../lib/table/conditions.ts';

function app() {
  const tokens = [
    { id: 'a', name: 'First', version: 2, size: 1, x: 40, y: 40 },
    { id: 'b', name: 'Second', version: 4, size: 1, x: 120, y: 40, groupId: 'group' },
    { id: 'c', name: 'Third', version: 5, size: 1, x: 200, y: 40, groupId: 'group' },
  ];
  const scene = { id: 'scene', tokens, gridSize: 80, updatedAt: 0 }, sent = [], state = [];
  const room = { scene, bootstrap: { actor: { role: 'player' }, campaign: { name: 'Party' }, roster: [] },
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
  } });
  function render() { cursor = 0; return exports.default({ campaignId: 'campaign' }); }
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
  const canvas = () => nodes(render()).find(node => node.type === 'Canvas').props;
  return { tokens, sent, render, canvas, keyboard: () => keyboard, nodes };
}

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
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка и AoE').props.onClick();
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Сфера').props.onClick();
  assert.equal(view.canvas().tool, 'measure'); assert.equal(view.canvas().measureMode, 'sphere');
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка и AoE').props.onClick();
  nodes = view.nodes(view.render());
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Линейка движения токена').props.onClick();
  assert.equal(view.canvas().tool, 'select'); assert.equal(view.canvas().measureMode, 'move');
});
