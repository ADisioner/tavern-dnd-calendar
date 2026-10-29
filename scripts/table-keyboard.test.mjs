import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { canMoveToken } from '../lib/table/scene.ts';

function keyboard(overrides = {}, { editing = false, dialog = false } = {}) {
  const handlers = new Map(), effects = [], removed = [];
  class Element { closest() { return editing; } }
  const token = { id: 'selected', version: 3 };
  const state = { scene: { id: 'scene', tokens: [token] }, actor: { role: 'player' }, selectedId: token.id,
    connection: 'connected', pending: false, removeToken: value => removed.push(value.id), ...overrides };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL('../app/table/use-token-keyboard.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports, Element, setInterval, clearInterval,
    window: { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {} },
    document: { querySelector: () => dialog, addEventListener() {}, removeEventListener() {} },
    require: name => name === 'react' ? { useRef: current => ({ current }), useEffect: fn => effects.push(fn) } : { canMoveToken },
  });
  exports.useTokenKeyboard(state); const cleanups = effects.map(fn => fn());
  let prevented = false;
  const press = changes => { prevented = false; handlers.get('keydown')({ code: 'Delete', target: new Element(), preventDefault() { prevented = true; }, ...changes }); return prevented; };
  return { press, removed, prevented: () => prevented, cleanup: () => cleanups.forEach(fn => fn?.()) };
}

test('Delete removes the selected token for an ordinary participant', () => {
  const view = keyboard(); try { view.press(); assert.deepEqual(view.removed, ['selected']); assert.equal(view.prevented(), true); } finally { view.cleanup(); }
});

test('Delete can remove a locked token because locking blocks movement only', () => {
  const view = keyboard({ scene: { id: 'scene', tokens: [{ id: 'selected', version: 3, locked: true }] } });
  try { view.press(); assert.deepEqual(view.removed, ['selected']); } finally { view.cleanup(); }
});

for (const [label, state, environment, event] of [
  ['text field', {}, { editing: true }, {}], ['dialog', {}, { dialog: true }, {}],
  ['no selection', { selectedId: null }, {}, {}], ['offline', { connection: 'offline' }, {}, {}],
  ['pending command', { pending: true }, {}, {}], ['auto-repeat', {}, {}, { repeat: true }],
  ['modified shortcut', {}, {}, { ctrlKey: true }], ['Backspace', {}, {}, { code: 'Backspace' }],
]) test(`Delete does not remove tokens in ${label}`, () => {
  const view = keyboard(state, environment); try { view.press(event); assert.deepEqual(view.removed, []); } finally { view.cleanup(); }
});

test('Ctrl+C copies the selected token and Ctrl+V creates a copy on the scene', () => {
  const pasted = [], view = keyboard({ duplicateToken: token => pasted.push([token.id, token.version]) });
  try {
    assert.equal(view.press({ code: 'KeyC', ctrlKey: true }), true);
    assert.deepEqual(pasted, []);
    assert.equal(view.press({ code: 'KeyV', ctrlKey: true }), true);
    assert.deepEqual(pasted, [['selected', 3]]);
  } finally { view.cleanup(); }
});

test('copy and paste shortcuts leave editors, dialogs and empty clipboard to the browser', () => {
  const pasteInEditor = keyboard({ duplicateToken() {} }, { editing: true });
  try { assert.equal(pasteInEditor.press({ code: 'KeyV', ctrlKey: true }), false); } finally { pasteInEditor.cleanup(); }
  const pasteEmpty = keyboard({ duplicateToken() {} });
  try { assert.equal(pasteEmpty.press({ code: 'KeyV', ctrlKey: true }), false); } finally { pasteEmpty.cleanup(); }
});
