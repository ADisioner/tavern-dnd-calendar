import { z } from 'zod';
export const ticketClaimsSchema = z.object({
  userId: z.string().uuid(), campaignId: z.string().uuid(), sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.string().url(), expires: z.number().int(), nonce: z.string().uuid(),
}).strict();
export type TableTicket = z.infer<typeof ticketClaimsSchema>;
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decode(value: string) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0)); }
async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function issueTableTicket(claims: TableTicket, secret: string) {
  const body = base64url(encoder.encode(JSON.stringify(ticketClaimsSchema.parse(claims))));
  return body + '.' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body))));
}
export async function verifyTableTicket(ticket: string, secret: string): Promise<TableTicket | null> {
  try {
    if (ticket.length > 2000) return null;
    const parts = ticket.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(secret), decode(parts[1]), encoder.encode(parts[0]))) return null;
    const claims = ticketClaimsSchema.parse(JSON.parse(new TextDecoder().decode(decode(parts[0]))));
    return claims.expires > Date.now() ? claims : null;
  } catch { return null; }
}
