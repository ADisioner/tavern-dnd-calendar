import { NextRequest } from 'next/server';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { authorizeHosted } from '@/lib/table/hosted-store';
import { hostedClient, hostedMessage, pollHosted, hostedError } from '@/lib/table/hosted-room';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl, campaignId = url.searchParams.get('campaign') ?? '';
    const actor = await authorizeHosted(env, request, campaignId, false);
    const client = hostedClient(url.searchParams.get('client') ?? '', campaignId, url.searchParams.get('preview') || undefined);
    client.version = z.coerce.number().int().min(-1).parse(url.searchParams.get('version') ?? -1);
    client.sceneId = url.searchParams.get('scene') ?? '';
    if (client.sceneId) z.string().uuid().parse(client.sceneId);
    return Response.json(await pollHosted(env, actor, client), { headers });
  } catch (error) { const event = hostedError(error); return Response.json({ error: event.message, events: [event] }, { status: event.code === 'auth' ? 401 : event.code === 'forbidden' ? 403 : 400, headers }); }
}
export async function POST(request: NextRequest) {
  let message: unknown;
  try {
    if (request.headers.get('origin') !== request.nextUrl.origin) return Response.json({ error: 'Недопустимый источник запроса.' }, { status: 403, headers });
    if (Number(request.headers.get('content-length') ?? 0) > 24000) return Response.json({ error: 'Слишком большой запрос.' }, { status: 413, headers });
    const body = await request.text(); if (body.length > 24000) return Response.json({ error: 'Слишком большой запрос.' }, { status: 413, headers });
    const raw = JSON.parse(body) as { clientId: string; campaignId: string; preview?: string; message: unknown };
    const client = hostedClient(raw.clientId, raw.campaignId, raw.preview); message = raw.message;
    return Response.json(await hostedMessage(env, request, client, message), { headers });
  } catch (error) { const event = hostedError(error, message); return Response.json({ events: [event] }, { status: event.code === 'auth' ? 401 : 200, headers }); }
}
