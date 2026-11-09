import { createPublicClient, getAddress, http, isAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';
import type { Env } from './env';
import type { Board } from './board';
import { randomHex, toHex } from '../src/shared/hash';

/**
 * Sign-in with Ethereum (EIP-4361). The wallet only signs a readable text message: no transaction,
 * no gas, no approval. Each nonce is single-use and expires in 10 minutes, so a signature can't be
 * replayed. The session lives in an HttpOnly cookie that page scripts can't read.
 */
export const SEPOLIA_ID = 11155111;
const NONCE_TTL_S = 600;
const SESSION_TTL_S = 7 * 24 * 3600;
const COOKIE = 'ss_session';
const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function secret(env: Env, purpose: string) {
  if (!env.TICKET_SECRET || env.TICKET_SECRET.length < 16) throw new Error('TICKET_SECRET is not set');
  return `${purpose}:${env.TICKET_SECRET}`;
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const board = (env: Env) => env.BOARD.get(env.BOARD.idFromName('global')) as DurableObjectStub<Board>;

/** nonce = random(24 hex) + expiry(8 hex) + mac(24 hex): alphanumeric, as EIP-4361 requires. */
export async function issueNonce(env: Env) {
  const exp = Math.floor(Date.now() / 1000) + NONCE_TTL_S;
  const body = randomHex(12) + exp.toString(16).padStart(8, '0');
  const mac = (await hmac(secret(env, 'nonce'), body)).slice(0, 24);
  return { nonce: body + mac, chainId: SEPOLIA_ID };
}

async function nonceOk(env: Env, nonce: string): Promise<boolean> {
  if (!/^[0-9a-f]{56}$/.test(nonce)) return false;
  const body = nonce.slice(0, 32);
  const mac = nonce.slice(32);
  if (!equal((await hmac(secret(env, 'nonce'), body)).slice(0, 24), mac)) return false;
  const exp = parseInt(body.slice(24), 16);
  if (exp < Date.now() / 1000) return false;
  // Single use.
  return board(env).consumeNonce(nonce, exp);
}

export async function verifySignIn(env: Env, req: Request, body: unknown): Promise<{ address: string } | { error: string }> {
  const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
  if (typeof message !== 'string' || message.length > 2000 || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) {
    return { error: 'bad_request' };
  }
  const m = parseSiweMessage(message);
  const url = new URL(req.url);
  const origin = req.headers.get('Origin') ?? url.origin;
  if (!m.address || !isAddress(m.address)) return { error: 'bad_address' };
  if (m.domain !== new URL(origin).host) return { error: 'wrong_domain' };
  if (m.uri !== origin) return { error: 'wrong_uri' };
  if (m.version !== '1') return { error: 'wrong_version' };
  if (m.chainId !== SEPOLIA_ID) return { error: 'wrong_chain' };
  const now = Date.now();
  if (!m.issuedAt || Math.abs(now - m.issuedAt.getTime()) > NONCE_TTL_S * 1000) return { error: 'stale' };
  if (m.expirationTime && m.expirationTime.getTime() < now) return { error: 'expired' };
  if (!m.nonce || !(await nonceOk(env, m.nonce))) return { error: 'bad_nonce' };

  // Works for normal wallets and for smart-contract wallets (EIP-1271 / EIP-6492), via a Sepolia RPC.
  const client = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com') });
  const ok = await client.verifyMessage({ address: m.address, message, signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) return { error: 'bad_signature' };
  return { address: getAddress(m.address) };
}

export async function sessionCookie(env: Env, address: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const body = `${address.toLowerCase()}.${exp}`;
  const mac = await hmac(secret(env, 'session'), body);
  return `${COOKIE}=${body}.${mac}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The signed-in wallet (lowercase), or null. */
export async function sessionAddress(env: Env, req: Request): Promise<string | null> {
  const raw = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const m = /^(0x[0-9a-f]{40})\.(\d{10})\.([0-9a-f]{64})$/.exec(raw.slice(COOKIE.length + 1));
  if (!m) return null;
  if (Number(m[2]) < Date.now() / 1000) return null;
  const mac = await hmac(secret(env, 'session'), `${m[1]}.${m[2]}`);
  return equal(mac, m[3]) ? m[1] : null;
}
