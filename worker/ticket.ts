import type { Env } from './env';
import { leadingZeroBits, randomHex, sha256Hex, toHex } from '../src/shared/hash';

/**
 * Join tickets: before opening a game socket, the browser asks for a signed challenge and has to find a
 * nonce whose SHA-256 starts with N zero bits. It costs a real player well under a second, but makes
 * spinning up hundreds of scripted joins expensive. Tickets expire after two minutes.
 */
const enc = new TextEncoder();
const TTL_MS = 120_000;

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function secretOf(env: Env): string {
  if (!env.TICKET_SECRET || env.TICKET_SECRET.length < 16) throw new Error('TICKET_SECRET is not set');
  return env.TICKET_SECRET;
}

export const ticketBits = (env: Env) => Math.min(22, Math.max(8, Number(env.TICKET_BITS) || 14));

export async function issueTicket(env: Env) {
  const c = `${Date.now() + TTL_MS}.${randomHex(12)}`;
  return { c, s: await hmacHex(secretOf(env), c), bits: ticketBits(env) };
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyTicket(env: Env, q: URLSearchParams): Promise<boolean> {
  const c = q.get('c') ?? '';
  const s = q.get('s') ?? '';
  const n = q.get('n') ?? '';
  const m = /^(\d{13})\.[0-9a-f]{24}$/.exec(c);
  if (!m || !/^[0-9a-f]{64}$/.test(s) || !/^\d{1,12}$/.test(n)) return false;
  if (Number(m[1]) < Date.now()) return false;
  if (!sameHex(await hmacHex(secretOf(env), c), s)) return false;
  return leadingZeroBits(await sha256Hex(`${c}:${n}`)) >= ticketBits(env);
}
