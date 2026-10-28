import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../app/table/hosted-connection.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { HostedConnection } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
test('HTTP frame replies cannot advance past unseen room changes; stale motion frames do not revive completed gestures', () => {
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), priorSocket = globalThis.WebSocket;
  globalThis.location = { origin: 'https://table.test', protocol: 'https:' };
  globalThis.WebSocket = class { close() {} };
  const connection = new HostedConnection(crypto.randomUUID()), messages = [];
  connection.onmessage = event => messages.push(JSON.parse(event.data));
  try {
    connection.consume({ version: 2, events: [{ type: 'snapshot', scene: { id: 'scene' } }] });
    connection.consume({ version: 7, events: [] });
    assert.equal(connection.version, 2);
    connection.consume({ version: 8, events: [{ type: 'motion-committed', motionId: 'motion', token: { version: 1 } }] });
    assert.equal(connection.version, 2);
    connection.consume({ version: 8, events: [{ type: 'snapshot', scene: { id: 'scene' } }] });
    assert.equal(connection.version, 8);
    connection.deliver({ type: 'motion-frame', motionId: 'motion', seq: 3 });
    connection.deliver({ type: 'motion-frame', motionId: 'other', seq: 4 });
    connection.deliver({ type: 'motion-frame', motionId: 'other', seq: 2 });
    assert.deepEqual(messages.filter(event => event.type === 'motion-frame').map(event => event.seq), [4]);
  } finally {
    connection.close(); globalThis.WebSocket = priorSocket;
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation); else delete globalThis.location;
  }
});
