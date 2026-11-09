// Full staked race through the real game server, against a local chain:
// two wallets sign in (SIWE), meet at the 10 SQK table, get a server-signed ticket, deposit,
// the server sees both deposits on-chain and starts the race, signs the result, and the result
// pays out through the contract.
//
//   (cd contracts && npx hardhat build && npx hardhat node --chain-id 11155111 --port 8546)
//   node scripts/e2e-room.mjs
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';

const RPC = 'http://127.0.0.1:8546';
const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
// The page origin the browser would send (one of the dev ALLOWED_ORIGINS in .dev.vars).
const ORIGIN = 'http://localhost:8787';
const UA = 'Mozilla/5.0 (e2e test)';
const root = new URL('..', import.meta.url);
const art = (p) => JSON.parse(readFileSync(new URL(`contracts/artifacts/contracts/${p}`, root), 'utf8'));
const escrowArt = art('SprintEscrow.sol/SprintEscrow.json');
const tokenArt = art('test/Mocks.sol/MockSQK.json');
const ONE = 10n ** 18n;

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const rpc = (method, params = []) => pub.request({ method, params });
const wc = (a) => createWalletClient({ account: a, chain: sepolia, transport: http(RPC) });
const wait = (hash) => pub.waitForTransactionReceipt({ hash });
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) process.exitCode = 1;
};

async function funded() {
  const a = privateKeyToAccount(generatePrivateKey());
  await rpc('hardhat_setBalance', [a.address, '0x56BC75E2D63100000']);
  return a;
}

// ---- chain
const owner = await funded();
const alice = await funded();
const bob = await funded();
// .dev.vars already holds the server's REFEREE_KEY, and it wins over --var: use its address.
const referee = JSON.parse(readFileSync(new URL('tools/referee.json', root), 'utf8')).referee;
const deploy = async (a, artifact, args) => getAddress((await wait(await wc(a).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args }))).contractAddress);
const sqk = await deploy(owner, tokenArt, []);
const escrow = await deploy(owner, escrowArt, [sqk, referee, owner.address]);
for (const p of [alice, bob]) await wait(await wc(owner).writeContract({ address: sqk, abi: tokenArt.abi, functionName: 'mint', args: [p.address, 100n * ONE] }));
const bal = (a) => pub.readContract({ address: sqk, abi: tokenArt.abi, functionName: 'balanceOf', args: [a] });

// ---- game server pointed at the local chain
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', '/tmp/wd-e2e-state',
  '--var', `ESCROW_ADDRESS:${escrow}`, '--var', `SQK_ADDRESS:${sqk}`, '--var', `SEPOLIA_RPC:${RPC}`, '--var', 'TICKET_BITS:8'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const guard = setTimeout(() => {
  console.log('✗ timed out\n--- server log ---\n' + serverLog.join('').slice(-3000));
  server.kill('SIGTERM');
  process.exit(1);
}, 180_000);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 60_000);
  const on = (d) => String(d).includes('Ready on') && (clearTimeout(t), res());
  server.stdout.on('data', on);
  server.stderr.on('data', on);
});
const stop = () => server.kill('SIGTERM');

try {
  const headers = (cookie) => ({ Origin: ORIGIN, 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) });
  async function signIn(a) {
    const { nonce } = await (await fetch(`${BASE}/api/auth/nonce`, { headers: headers() })).json();
    const message = createSiweMessage({ domain: 'localhost:8787', address: a.address, statement: 'Sign in to Hamstride.', uri: ORIGIN, version: '1', chainId: 11155111, nonce, issuedAt: new Date() });
    const r = await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ message, signature: await a.signMessage({ message }) }) });
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    check(r.ok && cookie.startsWith('ss_session='), `${a === alice ? 'Alice' : 'Bob'} signed in with her/his wallet`);
    return cookie;
  }
  async function ticketQuery() {
    const t = await (await fetch(`${BASE}/api/ticket`, { headers: headers() })).json();
    if (!t.bits || !t.c) throw new Error(`no join ticket: ${JSON.stringify(t)}`);
    for (let n = 0; n < 50_000_000; n++) {
      const h = createHash('sha256').update(`${t.c}:${n}`).digest();
      let z = 0;
      for (const b of h) {
        if (b === 0) z += 8;
        else {
          z += Math.clz32(b) - 24;
          break;
        }
      }
      if (z >= t.bits) return `c=${encodeURIComponent(t.c)}&s=${t.s}&n=${n}`;
    }
    throw new Error('could not solve the join ticket');
  }
  function open(path, cookie, extra) {
    return ticketQuery().then((q) => new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${PORT}${path}?${q}&${extra}`, { headers: headers(cookie) });
      const msgs = [];
      const waiters = [];
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        msgs.push(m);
        for (const w of [...waiters]) if (w.type === m.type) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
      });
      ws.next = (type, ms = 60_000) => {
        const got = msgs.find((m) => m.type === type && !m.__used);
        if (got) return (got.__used = true, Promise.resolve(got));
        return new Promise((r, j) => {
          const w = { type, res: (m) => (m.__used = true, r(m)) };
          waiters.push(w);
          setTimeout(() => j(new Error(`no ${type}`)), ms);
        });
      };
      ws.sendJson = (m) => ws.send(JSON.stringify(m));
      ws.on('open', () => res(ws));
      ws.on('error', rej);
      ws.on('unexpected-response', (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
    }));
  }

  const ca = await signIn(alice);
  const cb = await signIn(bob);
  const cfg = await (await fetch(`${BASE}/api/stake/config`, { headers: headers() })).json();
  check(cfg.enabled && cfg.escrow === escrow, 'races for SQK are switched on and point at the escrow');

  // Both join the 10 SQK table.
  const la = await open('/ws/lobby', ca, 'stake=10');
  const lb = await open('/ws/lobby', cb, 'stake=10');
  const [ma, mb] = await Promise.all([la.next('matched'), lb.next('matched')]);
  check(ma.code === mb.code && ma.stake === 10, `paired at the 10 SQK table in room ${ma.code}`);

  const ra = await open(`/ws/room/${ma.code}`, ca, 'stake=10');
  const rb = await open(`/ws/room/${ma.code}`, cb, 'stake=10');
  const [wa, wb] = await Promise.all([ra.next('welcome'), rb.next('welcome')]);
  check(wa.stake === 10 && wb.stake === 10, 'the room knows it is a 10 SQK race');
  const seed = () => randomBytes(16).toString('hex');
  ra.sendJson({ type: 'hello', name: 'Alice', seed: seed(), wd: false });
  rb.sendJson({ type: 'hello', name: 'Bob', seed: seed(), wd: false });
  const [sa, sb] = await Promise.all([ra.next('stake'), rb.next('stake')]);
  check(sa.ticket.matchId === sb.ticket.matchId && sa.ticket.stake === (10n * ONE).toString(), 'both got the same signed ticket for 10 SQK');
  const seat = (w) => (w.you === 0 ? alice : bob);
  check(getAddress(sa.ticket.playerA) === seat(wa).address, 'player A on the ticket is the wallet in seat A');

  // Deposits, straight to the contract (the browser code path is covered by the vitest e2e).
  const tArg = { ...sa.ticket, stake: BigInt(sa.ticket.stake), joinDeadline: BigInt(sa.ticket.joinDeadline) };
  for (const [p, ws] of [[alice, ra], [bob, rb]]) {
    await wait(await wc(p).writeContract({ address: sqk, abi: tokenArt.abi, functionName: 'approve', args: [escrow, 10n * ONE] }));
    await wait(await wc(p).writeContract({ address: escrow, abi: escrowArt.abi, functionName: 'deposit', args: [tArg, sa.sig] }));
    ws.sendJson({ type: 'paid' });
  }
  const [sta] = await Promise.all([ra.next('start', 30_000), rb.next('start', 30_000)]);
  check(!!sta.t0, 'the server saw both stakes on-chain and started the race');

  // Nobody presses anything: both hamsters tire at the same moment, so it is a draw.
  const [ea, pa] = await Promise.all([ra.next('end', 90_000), ra.next('payout', 90_000)]);
  check(ea.winner === -1 && pa.result.outcome === 3, `race ended (${ea.reason}), draw signed for the contract`);
  check(pa.result.replayHash === `0x${ea.inputHash}`, 'the signed result carries the replay hash');
  const a0 = await bal(alice.address);
  await wait(await wc(bob).writeContract({ address: escrow, abi: escrowArt.abi, functionName: 'settle', args: [pa.result, pa.sig] }));
  check((await bal(alice.address)) === a0 + 10n * ONE && (await bal(bob.address)) === 100n * ONE, 'the draw paid both stakes back through the contract');

  const mine = await (await fetch(`${BASE}/api/stakes`, { headers: headers(ca) })).json();
  check(mine.rows?.[0]?.matchId === sa.ticket.matchId && mine.rows[0].sig === pa.sig, 'the signed result is stored for claiming later');
  for (const w of [la, lb, ra, rb]) w.close();
} catch (e) {
  check(false, e.message);
} finally {
  clearTimeout(guard);
  stop();
}
