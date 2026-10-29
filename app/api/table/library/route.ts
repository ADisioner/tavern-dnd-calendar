import { NextRequest, NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import { GET as bootstrapTable } from '../route';
import { MAX_ASSET_BYTES } from '@/lib/table/assets';
import { hostedLibrary } from '@/lib/table/hosted-library';
import { hostedError } from '@/lib/table/hosted-room';

export const dynamic = 'force-dynamic';
async function handle(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (request.method !== 'GET' && request.headers.get('origin') !== request.nextUrl.origin)
      return NextResponse.json({ error: 'Запрос должен исходить со страницы стола.' }, { status: 403, headers });
    if (!env.TABLE_LOCAL_SECRET || !env.TABLE_LOCAL_WS_URL || request.nextUrl.searchParams.get('storage')==='hosted') {
      try { return await hostedLibrary(request, env); }
      catch (error) { const value = hostedError(error); return NextResponse.json({ error: value.message }, { status: value.code === 'auth' ? 401 : value.code === 'forbidden' ? 403 : value.code === 'limit' ? 413 : 400, headers }); }
    }
    const bootstrap = await bootstrapTable(request);
    if (!bootstrap.ok) return bootstrap;
    const { ticket } = await bootstrap.json() as { ticket: string };
    const url = new URL(env.TABLE_LOCAL_WS_URL!); url.protocol = 'http:'; url.pathname = '/library';
    for (const key of ['asset', 'name', 'kind', 'scope']) {
      const value = request.nextUrl.searchParams.get(key); if (value !== null) url.searchParams.set(key, value);
    }
    let body: Uint8Array | undefined;
    if (request.method === 'POST') {
      const reader = request.body?.getReader();
      if (!reader) return NextResponse.json({ error: 'Выберите файл.' }, { status: 400, headers });
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > MAX_ASSET_BYTES) { await reader.cancel(); return NextResponse.json({ error: 'Размер файла — до 8 МБ.' }, { status: 413, headers }); }
        chunks.push(value);
      }
      body = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
    const result = await fetch(url, { method: request.method, headers: { Authorization: `Bearer ${ticket}` },
      body: body as BodyInit | undefined, signal: AbortSignal.timeout(30000) });
    return new Response(result.body, { status: result.status, headers: { ...headers,
      'Content-Type': result.headers.get('content-type') || 'application/json',
      ...(result.headers.get('content-disposition') ? { 'Content-Disposition': result.headers.get('content-disposition')! } : {}),
    } });
  } catch { return NextResponse.json({ error: 'Локальная библиотека недоступна. Повторите попытку.' }, { status: 503, headers }); }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
