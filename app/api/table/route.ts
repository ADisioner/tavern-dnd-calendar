import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { campaigns, members } from '@/db/schema';
import { COOKIE, currentUser, digest } from '@/lib/auth';
import { issueTableTicket } from '@/lib/table/ticket';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
  try {
    const local = !!(env.TABLE_LOCAL_SECRET && env.TABLE_LOCAL_WS_URL && ['127.0.0.1','localhost'].includes(request.nextUrl.hostname));
    const user = await currentUser();
    if (!user) return reply({ error: 'Войдите в аккаунт в календаре, чтобы открыть игровой стол.' }, 401);
    const campaignId = z.string().uuid().safeParse(request.nextUrl.searchParams.get('campaign'));
    if (!campaignId.success) return reply({ error: 'Выберите кампанию в календаре.' }, 400);
    const db = getDb();
    const membership = await db.select().from(members).where(and(eq(members.campaignId, campaignId.data), eq(members.userId, user.id))).get();
    if (!membership) return reply({ error: 'Игровой стол доступен только участникам кампании.' }, 403);
    const campaign = await db.select().from(campaigns).where(eq(campaigns.id, campaignId.data)).get();
    if (!campaign) return reply({ error: 'Кампания не найдена.' }, 404);
    const roster = await db.select({ userId: members.userId, name: members.name, role: members.role }).from(members).where(eq(members.campaignId, campaignId.data));
    if (!local) {
      const socket = new URL('/api/test/table/socket', request.nextUrl.origin); socket.protocol = request.nextUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      socket.searchParams.set('campaign', campaign.id); socket.searchParams.set('client', crypto.randomUUID());
      return reply({ user, campaign: { id: campaign.id, name: campaign.name }, roster, actor: { userId: user.id, name: membership.name, role: campaign.ownerId === user.id ? 'master' : 'player' },
        transport: 'hosted', ticket: '', socketUrl: socket.href });
    }
    const token = (await cookies()).get(COOKIE)!.value;
    const ticket = await issueTableTicket({ userId: user.id, campaignId: campaign.id, sessionHash: await digest(token),
      origin: request.nextUrl.origin, expires: Date.now() + 90000, nonce: crypto.randomUUID() }, env.TABLE_LOCAL_SECRET!);
    return reply({ user, campaign: { id: campaign.id, name: campaign.name }, roster,
      actor: { userId: user.id, name: membership.name, role: campaign.ownerId === user.id ? 'master' : 'player' },
      ticket, socketUrl: env.TABLE_LOCAL_WS_URL });
  } catch (error) { console.error('Table bootstrap failed', error); return reply({ error: 'Не удалось открыть игровой стол.' }, 500); }
}
