import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTableServer } from './table-server.mjs';

const secret = randomBytes(32).toString('hex');
const table = await startTableServer({ secret });
console.log(`Local game table: ws://127.0.0.1:${table.port}`);
const child = spawn(process.execPath, [fileURLToPath(new URL('./run-framework.mjs', import.meta.url)), 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, TABLE_LOCAL_SECRET: secret, TABLE_LOCAL_WS_URL: `ws://127.0.0.1:${table.port}` },
});
let closing = false;
async function close() { if (closing) return; closing = true; child.kill(); await table.close(); }
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
child.on('exit', async code => { await close(); process.exitCode = code ?? 0; });
child.on('error', async error => { console.error(error.message); await close(); process.exitCode = 1; });
