import type { Env } from './env';
import type { Board } from './board';
import { issueTicket, verifyTicket } from './ticket';
import { clearCookie, issueNonce, sessionAddress, sessionCookie, verifySignIn } from './auth';
import { sha256Hex } from '../src/shared/hash';
import { ROOM_CODE } from '../src/shared/protocol';
import { isStakeAmount, TIERS } from '../src/shared/escrow';
import { stakeConfig } from './stake';

export { Room } from './room';
export { Lobby } from './lobby';
export { Board } from './board';

/**
 * Headless and scripting clients, kept out of play, sign-in and the stake flow (anti-cheat, not
 * anti-reading). Easy to fake, but it stops the lazy ones. Pages and public read-only data are open
 * to every reader, crawler and agent, so reviewers can check the site freely.
 */
const SCRIPTED = /(HeadlessChrome|PhantomJS|python-requests|python-urllib|aiohttp|httpx|Go-http-client|node-fetch|undici|axios|curl\/|Wget|libwww|Java\/|okhttp)/i;

/** Read-only public data anyone may fetch, scripts and agents included. */
const PUBLIC_READ = new Set(['/api/leaderboard', '/api/challenges', '/api/stake/config']);

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://api.squeekchain.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function originOk(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  // Browsers leave Origin off same-origin GET requests; Sec-Fetch-Site tells us it came from our own page.
  if (!origin) return req.headers.get('Sec-Fetch-Site') === 'same-origin';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) return allowed.includes(origin);
  return new URL(origin).host === new URL(req.url).host;
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(init.headers ?? {}) },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ua = req.headers.get('user-agent') ?? '';
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
    const publicRead = req.method === 'GET' && PUBLIC_READ.has(url.pathname);

    if (isApi && !publicRead && (SCRIPTED.test(ua) || !ua)) return json({ error: 'forbidden' }, { status: 403 });

    try {
      if (url.pathname === '/api/ticket') {
        if (!originOk(req, env)) return json({ error: 'forbidden' }, { status: 403 });
        return json(await issueTicket(env));
      }

      if (url.pathname.startsWith('/api/auth/')) {
        if (!originOk(req, env)) return json({ error: 'forbidden' }, { status: 403 });
        const route = url.pathname.slice('/api/auth/'.length);
        if (route === 'nonce' && req.method === 'GET') return json(await issueNonce(env));
        if (route === 'me' && req.method === 'GET') return json({ address: await sessionAddress(env, req), guests: env.ALLOW_GUESTS === 'true' });
        if (route === 'logout' && req.method === 'POST') return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } });
        if (route === 'verify' && req.method === 'POST') {
          if (Number(req.headers.get('content-length') ?? 0) > 8000) return json({ error: 'too_large' }, { status: 413 });
          const out = await verifySignIn(env, req, await req.json().catch(() => null));
          if ('error' in out) return json(out, { status: 401 });
          return json(out, { headers: { 'Set-Cookie': await sessionCookie(env, out.address) } });
        }
        return json({ error: 'not_found' }, { status: 404 });
      }

      if (url.pathname === '/api/stake/config') {
        const cfg = stakeConfig(env);
        return json({ enabled: !!cfg, escrow: cfg?.escrow ?? null, token: cfg?.token ?? null, tiers: TIERS });
      }

      if (url.pathname === '/api/stakes') {
        // Your own staked matches, for claiming a win or taking back a deposit later.
        if (!originOk(req, env)) return json({ error: 'forbidden' }, { status: 403 });
        const addr = await sessionAddress(env, req);
        if (!addr) return json({ error: 'sign_in' }, { status: 401 });
        const board = env.BOARD.get(env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
        return json({ rows: await board.stakesFor(addr) });
      }

      if (url.pathname === '/api/challenges') {
        const board = env.BOARD.get(env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
        return json({ rows: await board.listChallenges() });
      }

      if (url.pathname === '/api/leaderboard') {
        const board = env.BOARD.get(env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
        return json({ rows: await board.top(25) }, { headers: { 'cache-control': 'public, max-age=15' } });
      }

      if (url.pathname === '/ws/lobby' || url.pathname.startsWith('/ws/room/')) {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
        if (!originOk(req, env)) return new Response(`Forbidden origin${env.ALLOW_GUESTS === 'true' ? ` (${req.headers.get('Origin')})` : ''}`, { status: 403 });
        if (!(await verifyTicket(env, url.searchParams))) return new Response('Invalid ticket', { status: 403 });
        // Online play needs a signed-in wallet. Who you are comes only from the session cookie.
        let player = await sessionAddress(env, req);
        const guest = url.searchParams.get('g') ?? '';
        if (!player && env.ALLOW_GUESTS === 'true' && /^[0-9a-f]{64}$/.test(guest)) player = `guest:${(await sha256Hex(guest)).slice(0, 40)}`;
        if (!player) return new Response('Sign in with your wallet first', { status: 401 });
        // Staked play: only signed-in wallets, only valid amounts, only when the escrow is configured.
        const stakeParam = url.searchParams.get('stake');
        const stake = stakeParam === null ? 0 : Number(stakeParam);
        if (stakeParam !== null && stake !== 0) {
          if (!isStakeAmount(stake)) return new Response('Bad stake', { status: 400 });
          if (!player.startsWith('0x')) return new Response('Races for SQK need a signed-in wallet', { status: 401 });
          if (!stakeConfig(env)) return new Response('Races for SQK are not switched on yet', { status: 503 });
        }
        const fwd = new Request(req);
        fwd.headers.delete('X-Player-Id');
        fwd.headers.set('X-Player-Id', player);
        if (url.pathname === '/ws/lobby') {
          if (stake && !(TIERS as readonly number[]).includes(stake)) return new Response('Quick match uses the fixed tables', { status: 400 });
          return env.LOBBY.get(env.LOBBY.idFromName(stake ? `t${stake}` : 'main')).fetch(fwd);
        }
        const code = url.pathname.slice('/ws/room/'.length);
        if (!ROOM_CODE.test(code)) return new Response('Bad room code', { status: 400 });
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(fwd);
      }
    } catch (e) {
      return json({ error: 'server_error', detail: e instanceof Error ? e.message : 'unknown' }, { status: 500 });
    }

    if (isApi) return json({ error: 'not_found' }, { status: 404 });
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;
