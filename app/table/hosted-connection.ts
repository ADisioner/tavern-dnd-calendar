'use client';
export type RoomTransport = { readyState: number; bufferedAmount: number; send(data: string): void; close(): void;
  onopen: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: Event) => void) | null; onclose: ((event: CloseEvent) => void) | null };
type Packet = { version?: number; events?: Record<string, unknown>[]; previewSceneId?: string; error?: string };
export class HostedConnection implements RoomTransport {
  readyState = 0; bufferedAmount = 0;
  onopen: RoomTransport['onopen'] = null; onmessage: RoomTransport['onmessage'] = null; onerror: RoomTransport['onerror'] = null; onclose: RoomTransport['onclose'] = null;
  private clientId = crypto.randomUUID(); private socket: WebSocket | null = null; private closed = false; private http = false;
  private version = -1; private sceneId = ''; private preview: string | undefined; private generation = 0;
  private controller = new AbortController(); private timer?: ReturnType<typeof setTimeout>; private upgradeTimer?: ReturnType<typeof setTimeout>;
  private queue = Promise.resolve(); private sendingFrame = false; private frame: Record<string,unknown> | null = null;
  private seen = new Map<string, string>();
  private motionOrder = new Map<string, number>();
  constructor(private campaignId: string) {
    const url = new URL('/api/test/table/socket', location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('campaign', campaignId); url.searchParams.set('client', this.clientId);
    try {
      const socket = new WebSocket(url); this.socket = socket;
      socket.onopen = () => { if (this.http || this.closed) return; clearTimeout(this.upgradeTimer); this.readyState = 1; this.onopen?.(new Event('open')); };
      socket.onmessage = event => { if (!this.http && !this.closed) { try { this.deliver(JSON.parse(event.data)); } catch { this.onerror?.(new Event('error')); } } };
      socket.onerror = () => { if (this.readyState === 0) this.fallback(); else if (!this.http) this.onerror?.(new Event('error')); };
      socket.onclose = () => { if (this.closed || this.http) return; if (this.readyState === 0) this.fallback(); else this.close(); };
      this.upgradeTimer = setTimeout(() => { if (this.readyState === 0) this.fallback(); }, 2000);
    } catch { queueMicrotask(() => this.fallback()); }
  }
  private deliver(event: Record<string,unknown>) {
    if (event.type === 'snapshot') { this.sceneId = (event.scene as { id: string }).id; }
    if (typeof event.motionId === 'string') {
      if (event.type === 'motion-started' || event.type === 'motion-frame') {
        const seq = typeof event.seq === 'number' ? event.seq : -1;
        if (seq <= (this.motionOrder.get(event.motionId) ?? -2)) return;
        this.motionOrder.set(event.motionId, seq);
      } else if (['motion-committed','motion-cancelled','motion-rejected'].includes(String(event.type))) this.motionOrder.set(event.motionId, Infinity);
      if (this.motionOrder.size > 1000) this.motionOrder.delete(this.motionOrder.keys().next().value!);
      const key = event.type + ':' + (event.seq ?? '') + ':' + ((event.token as { version?: number } | undefined)?.version ?? '');
      const id = event.motionId + ':' + event.type;
      if (this.seen.get(id) === key) return;
      this.seen.set(id, key); if (this.seen.size > 1000) this.seen.clear();
    }
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
  private consume(packet: Packet) {
    // Only a snapshot confirms that this client has seen the whole room version.
    // A frame response may observe a concurrent command without carrying its state.
    if (typeof packet.version === 'number' && packet.events?.some(event => event.type === 'snapshot')) this.version = Math.max(this.version, packet.version);
    for (const event of packet.events ?? []) this.deliver(event);
  }
  private fallback() {
    if (this.http || this.closed || this.readyState === 1) return;
    this.http = true; clearTimeout(this.upgradeTimer); this.socket?.close(); this.socket = null; void this.poll();
  }
  private async poll() {
    if (this.closed || !this.http) return;
    const generation = this.generation;
    try {
      const query = new URLSearchParams({ campaign: this.campaignId, client: this.clientId, version: String(this.version), scene: this.sceneId, ...(this.preview ? { preview: this.preview } : {}) });
      const response = await fetch('/api/test/table?' + query, { signal: this.controller.signal, cache: 'no-store' });
      const packet = await response.json() as Packet;
      if (!response.ok) throw new Error(packet.error);
      if (this.closed) return;
      if (this.readyState === 0) { this.readyState = 1; this.onopen?.(new Event('open')); }
      if (generation === this.generation) this.consume(packet);
    } catch { if (!this.closed) { this.onerror?.(new Event('error')); this.close(); } }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), 100);
  }
  private async post(message: Record<string,unknown>) {
    if (this.closed) return;
    const response = await fetch('/api/test/table', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: this.controller.signal,
      body: JSON.stringify({ clientId: this.clientId, campaignId: this.campaignId, preview: this.preview, message }) });
    const packet = await response.json() as Packet;
    if (this.closed) return;
    if (packet.previewSceneId !== undefined) this.preview = packet.previewSceneId;
    this.consume(packet); if (!response.ok) throw new Error(packet.error);
  }
  send(data: string) {
    if (this.readyState !== 1 || this.closed) return;
    if (!this.http) { this.socket?.send(data); return; }
    const message = JSON.parse(data) as Record<string,unknown>;
    if (message.type === 'hello') return;
    if (message.type === 'motion-frame') { this.frame = message; void this.flushFrame(); return; }
    this.generation++;
    if (message.type === 'motion-end' && this.frame?.motionId === message.motionId) this.frame = null;
    this.queue = this.queue.then(() => this.post(message)).catch(() => { if (!this.closed) { this.onerror?.(new Event('error')); this.close(); } });
  }
  private async flushFrame() {
    if (this.sendingFrame || this.closed) return; this.sendingFrame = true;
    try { while (this.frame && !this.closed) { const message = this.frame; this.frame = null; await this.post(message); } }
    catch { /* the polling lane detects transport failure and reconnects */ }
    finally { this.sendingFrame = false; }
  }
  close() {
    if (this.closed) return; this.closed = true; this.readyState = 3; clearTimeout(this.timer); clearTimeout(this.upgradeTimer); this.controller.abort(); this.socket?.close(); this.onclose?.(new CloseEvent('close'));
  }
}
