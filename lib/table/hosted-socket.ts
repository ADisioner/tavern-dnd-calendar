import { MAX_TABLE_MESSAGE_BYTES } from './motion.ts';
import { authorizeHosted, requireDb, type HostedEnv } from './hosted-store.ts';
import { hostedClient, hostedMessage, pollHosted, hostedError } from './hosted-room.ts';

export async function upgradeHostedSocket(request: Request, env: HostedEnv) {
  const url = new URL(request.url);
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
  if (request.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403 });
  try {
    const client = hostedClient(url.searchParams.get('client') ?? '', url.searchParams.get('campaign') ?? '');
    await authorizeHosted(env, request, client.campaignId, true);
    const pair = new WebSocketPair(), browser = pair[0], socket = pair[1]; socket.accept();
    let closed = false, polling = false, chain = Promise.resolve(), pendingFrame: unknown = null, writingFrame = false;
    let windowStarted = Date.now(), actions = 0, frames = 0, measurementFrames = 0;
    const send = (value: unknown) => { if (!closed) try { socket.send(JSON.stringify(value)); } catch { stop(); } };
    const deliver = (result: { events: Record<string, unknown>[] }) => { for (const event of result.events) send(event); };
    async function poll() {
      if (polling || closed) return; polling = true;
      try { const actor = await authorizeHosted(env, request, client.campaignId, true); deliver(await pollHosted(env, actor, client)); }
      catch (error) { send(hostedError(error)); stop(); }
      finally { polling = false; }
    }
    const timer = setInterval(() => void poll(), 100);
    function stop(code = 1000) { if (closed) return; closed = true; clearInterval(timer); try { socket.close(code, code === 1009 ? 'Message too large' : 'Closed'); } catch { /* already closed */ }
      void requireDb(env).prepare('DELETE FROM test_table_peers WHERE client_id=? AND campaign_id=?').bind(client.id, client.campaignId).run().catch(() => {});
      void requireDb(env).prepare('DELETE FROM test_table_measurements WHERE client_id=? AND campaign_id=?').bind(client.id, client.campaignId).run().catch(() => {});
      void requireDb(env).prepare("UPDATE test_table_motions SET status='cancelled',expires=? WHERE client_id=? AND campaign_id=? AND status='moving'").bind(Date.now() + 3000, client.id, client.campaignId).run().catch(() => {});
    }
    async function flushFrames() {
      if (writingFrame || closed) return; writingFrame = true;
      try { while (pendingFrame && !closed) { const frame = pendingFrame; pendingFrame = null; try { deliver(await hostedMessage(env, request, client, frame)); } catch (error) { send(hostedError(error, frame)); } } }
      finally { writingFrame = false; }
    }
    socket.addEventListener('message', event => {
      if (closed) return;
      if (typeof event.data !== 'string') { if (event.data instanceof ArrayBuffer && event.data.byteLength > MAX_TABLE_MESSAGE_BYTES) stop(1009); return; }
      if (new TextEncoder().encode(event.data).byteLength > MAX_TABLE_MESSAGE_BYTES) { stop(1009); return; }
      let raw: { type?: string }; try { raw = JSON.parse(event.data); } catch { return; }
      if (Date.now() - windowStarted > 10000) { windowStarted = Date.now(); actions = frames = measurementFrames = 0; }
      if (raw.type === 'motion-frame') { if (++frames > 300) return; pendingFrame = raw; void flushFrames(); return; }
      if (raw.type === 'measurement-frame') { if (++measurementFrames > 300) return; }
      else if (++actions > 80) { send({ type: 'error', code: 'rate', message: 'Слишком много действий. Подождите несколько секунд.' }); return; }
      chain = chain.then(async () => { try { deliver(await hostedMessage(env, request, client, raw)); } catch (error) { const value = hostedError(error, raw); send(value); if (value.code === 'auth') stop(); else await poll(); } });
    });
    socket.addEventListener('close', () => stop()); socket.addEventListener('error', () => stop());
    void poll();
    return new Response(null, { status: 101, webSocket: browser });
  } catch (error) { const value = hostedError(error); return Response.json({ error: value.message }, { status: value.code === 'auth' ? 401 : 403 }); }
}
