import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as sceneModel from '../lib/table/scene.ts';

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
  const view = app(); view.canvas().onSelect('a');
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
