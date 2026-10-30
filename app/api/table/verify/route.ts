import { tableRole } from '@/lib/campaign-roles';
import { NextRequest, NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { campaigns, members, logins, users } from '@/db/schema';
import { equalHashes } from '@/lib/auth';
import { verifyTableTicket } from '@/lib/table/ticket';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
// Server-to-server permission recheck. The service credential never reaches a browser.
export async function POST(request: NextRequest) {
  try {
    const secret = env.TABLE_LOCAL_SECRET;
    if (!secret || !['127.0.0.1', 'localhost'].includes(request.nextUrl.hostname) ||
        !equalHashes(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) return reply({ error: 'Forbidden' }, 403);
    const body = await request.json() as { ticket?: unknown };
    if (typeof body.ticket !== 'string') return reply({ error: 'Invalid ticket' }, 401);
    const claims = await verifyTableTicket(body.ticket, secret);
    if (!claims || claims.origin !== request.nextUrl.origin) return reply({ error: 'Expired ticket' }, 401);
    const db = getDb();
    const session = await db.select().from(logins).where(and(eq(logins.tokenHash, claims.sessionHash), eq(logins.userId, claims.userId), gt(logins.expires, Date.now()))).get();
    const user = await db.select().from(users).where(eq(users.id, claims.userId)).get();
    if (!session || !user || user.disabled) return reply({ error: 'Session ended' }, 401);
    const campaign = await db.select().from(campaigns).where(eq(campaigns.id, claims.campaignId)).get();
    const roster = await db.select({ userId: members.userId, name: members.name, role: members.role }).from(members).where(eq(members.campaignId, claims.campaignId));
    const member = roster.find(m => m.userId === claims.userId);
    if (!campaign || !member) return reply({ error: 'Membership ended' }, 403);
    return reply({ actor: { userId: claims.userId, name: member.name, role: tableRole(member) }, roster: roster.map(value => ({ ...value, role: tableRole(value) })), campaignId: campaign.id });
  } catch { return reply({ error: 'Permission check failed' }, 503); }
}
