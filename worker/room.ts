import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Board } from './board';
import { fetchLive } from './live';
import {
  CONFIRM_LAG_TICKS, COUNTDOWN_MS, FUTURE_TOLERANCE_TICKS, MAX_BLOCK_DROPS,
  MAX_INPUTS_PER_SEC, MAX_TICKS, REVEAL_AHEAD_M, TICK_HZ,
} from '../src/shared/constants';
import { courseHash, generateCourse, LEN, sortCourse, type Obs } from '../src/shared/course';
import { HEX32, randomHex, sha256Hex } from '../src/shared/hash';
import { cleanName, type ClientMsg, type LiveInfo, type ServerMsg } from '../src/shared/protocol';
import { tiredAt, winnerAtCap, initState, KEYS, step, type Key, type PState } from '../src/shared/sim';
import { humanReport } from '../src/shared/stats';
import { STATUS, type ResultJson, type TicketJson } from '../src/shared/escrow';
import { makeTicket, readMatch, signResult, stakeConfig, type StakeConfig } from './stake';

interface Player {
  /** null while the player is disconnected mid-race; they can come back until it ends. */
  ws: WebSocket | null;
  name: string;
  /** Who this is: a signed-in wallet address (lowercase), or `guest:<hash>` in dev. The leaderboard key. */
  key: string;
  away: boolean;
  awaySince: number;
  seed: string | null;
  webdriver: boolean;
  st: PState;
  /** Inputs received but not yet simulated, sorted by tick. */
  q: [number, Key][];
  /** Inputs as actually applied: [tick, key]. Hashed into the match record. */
  log: [number, Key][];
  late: number;
  dropped: number;
  rateSec: number;
  rateCount: number;
}

/** 'deposit': a staked room waiting for both stakes to land in the escrow before the race. */
type Phase = 'lobby' | 'deposit' | 'countdown' | 'running' | 'ended';

/**
 * One match room. The server is the referee: it re-runs both players' races from their raw key
 * presses with the shared simulation, so a modified client can't fake distance, speed or a finish.
 */
export class Room extends DurableObject<Env> {
  private players: (Player | null)[] = [null, null];
  private phase: Phase = 'lobby';
  private serverSeed = randomHex(32);
  private commit = '';
  private course: Obs[] = [];
  private sent = new Set<number>();
  private t0 = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loopN = 0;
  private live: LiveInfo | null = null;
  private lastLive = 0;
  private lastBlock = 0n;
  private drops = 0;
  private nextDropId = 1000;
  private code = '';
  private startCommit = '';

  private sentOrder: Obs[] = [];
  private lastEnd: ServerMsg | null = null;

  // ---- races for SQK
  /** Whole SQK each player puts in; 0 = a free race. Fixed by whoever opens the room. */
  private stake = 0;
  /** Listed on the public challenge board while waiting for a rival. */
  private listed = false;
  private wantsListing = false;
  private deposit: { ticket: TicketJson; sig: `0x${string}`; cfg: StakeConfig; poll: ReturnType<typeof setInterval> | null; failAt: number } | null = null;
  /** The escrow match this race is for, once both stakes are in. */
  private activeMatch: { ticket: TicketJson; cfg: StakeConfig } | null = null;
  private checking = false;
  private lastPayout: ServerMsg | null = null;

  private board() {
    return this.env.BOARD.get(this.env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
  }

  private stakeMsg(): ServerMsg | null {
    if (!this.deposit) return null;
    const d = this.deposit;
    return { type: 'stake', ticket: d.ticket, sig: d.sig, escrow: d.cfg.escrow, token: d.cfg.token };
  }

  async fetch(req: Request): Promise<Response> {
    if (!this.commit) this.commit = await sha256Hex(this.serverSeed);
    this.code = new URL(req.url).pathname.split('/').pop() ?? '';
    // Set by the Worker after it checked the wallet session; clients can't forge it.
    const id = req.headers.get('X-Player-Id') ?? '';
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const reply = () => new Response(null, { status: 101, webSocket: pair[0] });
    if (!id) {
      this.send(ws, { type: 'error', msg: 'Connect your wallet to play online.' });
      ws.close(1008, 'auth');
      return reply();
    }

    // Coming back to a race you dropped out of (or a second tab): take your seat back.
    const mine = this.players.findIndex((p) => p?.key === id);
    if (mine >= 0) {
      const p = this.players[mine]!;
      if (p.ws && p.ws !== ws) {
        try {
          p.ws.close(4000, 'replaced');
        } catch {
          /* ignore */
        }
      }
      p.ws = ws;
      const wasAway = p.away;
      p.away = false;
      this.listen(mine as 0 | 1, ws);
      const live = this.phase === 'running' || this.phase === 'countdown';
      this.send(ws, { type: 'welcome', you: mine as 0 | 1, commit: this.commit, code: this.code, resumed: live, stake: this.stake });
      if (live) {
        const [a, b] = this.players;
        this.send(ws, { type: 'start', t0: this.t0, names: [a?.name ?? '?', b?.name ?? '?'], live: this.live, commit: this.startCommit });
        if (this.sentOrder.length) this.send(ws, { type: 'course', obs: this.sentOrder });
        if (a && b) this.send(ws, { type: 'snap', p: [a.st, b.st] });
        if (wasAway) this.sendOther(mine as 0 | 1, { type: 'peer', away: false });
      } else if (this.phase === 'deposit') {
        const sm = this.stakeMsg();
        if (sm) this.send(ws, sm);
        if (wasAway) this.sendOther(mine as 0 | 1, { type: 'peer', away: false });
      } else if (this.phase === 'ended' && this.lastEnd) {
        this.send(ws, this.lastEnd);
        if (this.lastPayout) this.send(ws, this.lastPayout);
      }
      this.roster();
      return reply();
    }

    // The first player in an empty room sets its stake (the Worker already checked the amount).
    const url = new URL(req.url);
    if (!this.players[0] && !this.players[1] && this.phase === 'lobby') {
      const s = Number(url.searchParams.get('stake') ?? 0);
      this.stake = Number.isInteger(s) && s > 0 ? s : 0;
      this.wantsListing = this.stake > 0 && url.searchParams.get('pub') === '1';
    }
    if (this.stake > 0 && (!id.startsWith('0x') || !stakeConfig(this.env))) {
      this.send(ws, { type: 'error', msg: !id.startsWith('0x') ? 'Races for SQK need a signed-in wallet.' : 'Races for SQK are not switched on yet.' });
      ws.close(1008, 'stake');
      return reply();
    }

    const slot = this.players.findIndex((p) => p === null);
    if (slot < 0 || this.phase !== 'lobby') {
      this.send(ws, { type: 'error', msg: slot < 0 ? 'This room is full.' : 'This match has already started.' });
      ws.close(1008, 'full');
      return reply();
    }

    const p: Player = {
      ws, name: 'Hamster', key: id, away: false, awaySince: 0, seed: null, webdriver: false, st: initState(),
      q: [], log: [], late: 0, dropped: 0, rateSec: 0, rateCount: 0,
    };
    this.players[slot] = p;
    this.listen(slot as 0 | 1, ws);
    this.send(ws, { type: 'welcome', you: slot as 0 | 1, commit: this.commit, code: this.code, stake: this.stake });
    this.roster();
    if (this.players[0] && this.players[1] && this.listed) {
      this.listed = false;
      this.board().closeChallenge(this.code).catch(() => {});
    }
    return reply();
  }

  private listen(slot: 0 | 1, ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      if (this.players[slot]?.ws !== ws) return;
      if (typeof ev.data !== 'string' || ev.data.length > 4096) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(slot, msg).catch(() => {});
    });
    const gone = () => this.onLeave(slot, ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  private sendOther(slot: 0 | 1, m: ServerMsg) {
    const o = this.players[slot === 0 ? 1 : 0];
    if (o?.ws) this.send(o.ws, m);
  }

  private send(ws: WebSocket, m: ServerMsg) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      /* socket already gone */
    }
  }

  private broadcast(m: ServerMsg) {
    const text = JSON.stringify(m);
    for (const p of this.players) {
      try {
        p?.ws?.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  private roster() {
    this.broadcast({ type: 'roster', names: this.players.map((p) => (p ? p.name : null)) });
  }

  private nowTick() {
    return Math.floor(((Date.now() - this.t0) * TICK_HZ) / 1000);
  }

  private async onMessage(slot: 0 | 1, m: ClientMsg) {
    const p = this.players[slot];
    if (!p) return;
    switch (m.type) {
      case 'ping':
        if (typeof m.c === 'number' && p.ws) this.send(p.ws, { type: 'pong', c: m.c, s: Date.now() });
        return;
      case 'hello':
        if (p.seed || !HEX32.test(String(m.seed))) return;
        p.name = cleanName(m.name);
        p.seed = m.seed;
        p.webdriver = m.wd === true;
        this.roster();
        if (this.wantsListing && !this.listed && !(this.players[0] && this.players[1])) {
          this.listed = true;
          this.board().openChallenge({ code: this.code, stake: this.stake, name: p.name, addr: p.key }).catch(() => {});
        }
        this.maybeStart();
        return;
      case 'rematch':
        if (this.phase !== 'ended' || !HEX32.test(String(m.seed))) return;
        p.seed = m.seed;
        if (this.players.every((x) => x?.seed)) {
          this.phase = 'lobby';
          this.maybeStart();
        } else {
          for (const x of this.players) if (x && x !== p && x.ws) this.send(x.ws, { type: 'rematch_wait' });
        }
        return;
      case 'in':
        this.onInputs(p, m.a);
        return;
      case 'paid':
        // A player says their deposit went through: look at the contract now.
        this.checkDeposits().catch(() => {});
        return;
    }
  }

  private onInputs(p: Player, a: unknown) {
    if ((this.phase !== 'running' && this.phase !== 'countdown') || !Array.isArray(a)) return;
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== p.rateSec) {
      p.rateSec = sec;
      p.rateCount = 0;
    }
    const now = this.nowTick();
    // Nothing counts before GO: otherwise countdown taps would all land on tick 0.
    if (now < 0) return;
    for (const item of a.slice(0, 30)) {
      if (!Array.isArray(item)) continue;
      let [t, k] = item as [number, Key];
      if (!Number.isInteger(t) || !KEYS.includes(k)) continue;
      if (++p.rateCount > MAX_INPUTS_PER_SEC) {
        p.dropped++;
        continue;
      }
      if (t > now + FUTURE_TOLERANCE_TICKS) t = Math.max(0, now);
      if (t < p.st.tick) {
        p.late++;
        t = p.st.tick;
      }
      if (t < 0) t = 0;
      const q = p.q;
      if (q.length === 0 || q[q.length - 1][0] <= t) q.push([t, k]);
      else {
        q.push([t, k]);
        q.sort((x, y) => x[0] - y[0]);
      }
    }
  }

  private maybeStart() {
    if (this.phase !== 'lobby') return;
    const [a, b] = this.players;
    if (!a?.seed || !b?.seed) return;
    if (this.stake > 0) {
      this.phase = 'deposit';
      this.beginDeposit(a, b).catch(() => this.failDeposit(null));
      return;
    }
    this.phase = 'countdown';
    this.start(a, b).catch(() => this.reset());
  }

  /** Staked room: sign a ticket for both wallets and wait for both stakes to land on-chain. */
  private async beginDeposit(a: Player, b: Player) {
    const cfg = stakeConfig(this.env);
    if (!cfg) {
      this.broadcast({ type: 'error', msg: 'Races for SQK are not switched on yet.' });
      this.failDeposit(null);
      return;
    }
    const { ticket, sig } = await makeTicket(this.env, cfg, a.key, b.key, this.stake);
    // Give up a little after the contract's own deadline, so late deposits can't slip in after we did.
    this.deposit = { ticket, sig, cfg, poll: null, failAt: (ticket.joinDeadline + 20) * 1000 };
    this.lastPayout = null;
    await this.board().stakeOpened({ matchId: ticket.matchId, a: a.key, b: b.key, stake: ticket.stake, deadline: ticket.joinDeadline, ticket: JSON.stringify(ticket) });
    const sm = this.stakeMsg();
    if (sm) this.broadcast(sm);
    this.deposit.poll = setInterval(() => this.checkDeposits().catch(() => {}), 4000);
  }

  private async checkDeposits() {
    const d = this.deposit;
    if (!d || this.phase !== 'deposit' || this.checking) return;
    this.checking = true;
    try {
      const m = await readMatch(this.env, d.cfg, d.ticket.matchId);
      if (this.deposit !== d || this.phase !== 'deposit') return;
      this.broadcast({ type: 'stake_status', paid: [m.paidA, m.paidB] });
      if (m.status === STATUS.Active) {
        // Both stakes are locked in the contract: race.
        if (d.poll) clearInterval(d.poll);
        this.deposit = null;
        this.activeMatch = { ticket: d.ticket, cfg: d.cfg };
        await this.board().stakeState(d.ticket.matchId, 'racing');
        const [a, b] = this.players;
        if (!a || !b) return;
        this.phase = 'countdown';
        await this.start(a, b);
        return;
      }
      if (Date.now() > d.failAt) this.failDeposit(m);
    } finally {
      this.checking = false;
    }
  }

  /** Not both paid in time: no race. Whoever paid takes it back with cancel() on the contract. */
  private failDeposit(m: { paidA: boolean; paidB: boolean } | null) {
    const d = this.deposit;
    if (d?.poll) clearInterval(d.poll);
    this.deposit = null;
    this.phase = 'lobby';
    for (const p of this.players) if (p) p.seed = null;
    if (d) {
      this.broadcast({ type: 'stake_failed', matchId: d.ticket.matchId, paid: [m?.paidA ?? false, m?.paidB ?? false] });
      this.board().stakeState(d.ticket.matchId, 'failed').catch(() => {});
    }
  }

  private async start(a: Player, b: Player) {
    const courseSeed = await sha256Hex(`${this.serverSeed}:${a.seed}:${b.seed}`);
    this.live = await fetchLive();
    this.lastLive = Date.now();
    this.lastBlock = BigInt(this.live?.blockHeight ?? '0');
    this.drops = 0;
    this.course = generateCourse(courseSeed, !!this.live?.active);
    this.sent = new Set();
    this.sentOrder = [];
    this.startCommit = this.commit;
    this.lastEnd = null;
    for (const p of [a, b]) {
      p.st = initState();
      p.q = [];
      p.log = [];
      p.late = 0;
      p.dropped = 0;
    }
    this.t0 = Date.now() + COUNTDOWN_MS;
    this.broadcast({ type: 'start', t0: this.t0, names: [a.name, b.name], live: this.live, commit: this.commit });
    this.reveal();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.loop(), 50);
  }

  private reset() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.deposit?.poll) clearInterval(this.deposit.poll);
    this.deposit = null;
    this.phase = 'lobby';
  }

  private loop() {
    if (this.phase !== 'countdown' && this.phase !== 'running') return;
    const now = this.nowTick();
    if (now < 0) return;
    this.phase = 'running';
    const target = Math.min(now - CONFIRM_LAG_TICKS, MAX_TICKS);
    for (const p of this.players) if (p) this.advance(p, target);
    this.reveal();
    if (++this.loopN % 2 === 0) {
      const [a, b] = this.players;
      if (a && b) this.broadcast({ type: 'snap', p: [a.st, b.st] });
    }
    if (Date.now() - this.lastLive > 6000) {
      this.lastLive = Date.now();
      this.pollLive().catch(() => {});
    }
    this.checkEnd(target);
  }

  private advance(p: Player, target: number) {
    while (p.st.tick < target) {
      const t = p.st.tick;
      const keys: Key[] = [];
      while (p.q.length && p.q[0][0] <= t) {
        const [, k] = p.q.shift()!;
        if (keys.length < 4) {
          keys.push(k);
          p.log.push([t, k]);
        }
      }
      step(p.st, keys, this.course);
    }
  }

  /** Sends obstacles only as the leader gets close to them, so nobody can read the whole course ahead. */
  private reveal() {
    const lead = Math.max(...this.players.map((p) => p?.st.dist ?? 0));
    const out = this.course.filter((o) => o.d <= lead + REVEAL_AHEAD_M && !this.sent.has(o.id));
    if (!out.length) return;
    for (const o of out) this.sent.add(o.id);
    this.sentOrder.push(...out);
    this.broadcast({ type: 'course', obs: out });
  }

  /** When the real hamster completes a block mid-race, both players get a Block Drop at the same spot. */
  private async pollLive() {
    const live = await fetchLive();
    if (!live || this.phase !== 'running') return;
    const h = BigInt(live.blockHeight || '0');
    if (h <= this.lastBlock || this.drops >= MAX_BLOCK_DROPS) return;
    this.lastBlock = h;
    const lead = Math.max(...this.players.map((p) => p?.st.dist ?? 0));
    let d = Math.round((lead + REVEAL_AHEAD_M - 6) * 10) / 10;
    while (this.course.some((o) => Math.abs(o.d - d) < 3)) d += 3;
    this.course.push({ id: this.nextDropId++, d, kind: 'bdrop', lane: this.drops % 3, len: LEN.bdrop });
    sortCourse(this.course);
    this.drops++;
  }

  private checkEnd(target: number) {
    const [a, b] = this.players;
    if (!a || !b) return;
    // Last one running wins. A leaver's hamster keeps running with nobody steering, so it soon tires out.
    const ca = tiredAt(a.st);
    const cb = tiredAt(b.st);
    if (ca < Infinity && cb < Infinity) {
      if (ca === cb) this.end(a.st.dist === b.st.dist ? -1 : a.st.dist > b.st.dist ? 0 : 1, 'tired');
      else this.end(ca > cb ? 0 : 1, 'tired');
    } else if (ca < Infinity && b.st.tick > ca) this.end(1, a.away ? 'forfeit' : 'tired');
    else if (cb < Infinity && a.st.tick > cb) this.end(0, b.away ? 'forfeit' : 'tired');
    else if (target >= MAX_TICKS) {
      // Both still running after 3 minutes: more energy left wins, then distance.
      this.end(winnerAtCap(a.st, b.st), 'timeout');
    } else if (a.away && b.away && Date.now() - Math.max(a.awaySince, b.awaySince) > 30_000) {
      this.end(-1, 'abandoned');
    }
  }

  private async end(winner: 0 | 1 | -1, reason: 'tired' | 'timeout' | 'forfeit' | 'abandoned') {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const [a, b] = this.players as [Player, Player];
    const cvMin = Number(this.env.BOT_CV_MIN) || 0.12;
    const human: [ReturnType<typeof humanReport>, ReturnType<typeof humanReport>] = [
      humanReport(a?.st ?? initState(), cvMin),
      humanReport(b?.st ?? initState(), cvMin),
    ];
    const reveal = { serverSeed: this.serverSeed, seeds: [a?.seed ?? '', b?.seed ?? ''] as [string, string] };
    const inputHash = await sha256Hex(JSON.stringify([a?.log ?? [], b?.log ?? []]));
    const cHash = await courseHash(this.course);
    // Ranked only when both look human, nobody automated the browser, and the match was raced out.
    const ranked =
      reason !== 'abandoned' && winner !== -1 && !!a && !!b && a.key !== b.key &&
      human.every((h) => h.verdict !== 'steady') && !a.webdriver && !b.webdriver &&
      Math.max(a.st.dist, b.st.dist) > 150;

    this.serverSeed = randomHex(32);
    this.commit = await sha256Hex(this.serverSeed);
    for (const p of this.players) if (p) p.seed = null;

    const endMsg: ServerMsg = {
      type: 'end', winner, reason, final: [a?.st ?? initState(), b?.st ?? initState()], reveal,
      courseHash: cHash, inputHash, human, ranked, nextCommit: this.commit,
    };
    this.lastEnd = endMsg;
    this.broadcast(endMsg);

    // A race for SQK: sign the result for the contract. 1 = A wins, 2 = B wins, 3 = draw.
    const staked = this.activeMatch;
    this.activeMatch = null;
    if (staked) {
      const res: ResultJson = {
        matchId: staked.ticket.matchId,
        outcome: winner === 0 ? 1 : winner === 1 ? 2 : 3,
        replayHash: `0x${inputHash}`,
      };
      try {
        const sig = await signResult(this.env, staked.cfg, res);
        this.lastPayout = { type: 'payout', result: res, sig, escrow: staked.cfg.escrow, stake: staked.ticket.stake };
        this.broadcast(this.lastPayout);
        await this.board().stakeResult(res.matchId, JSON.stringify(res), sig);
      } catch {
        // No signature means nobody can settle; the contract refunds both after its window.
      }
    }
    // Players who never came back give up their seat so the room can be reused.
    for (let i = 0; i < 2; i++) if (this.players[i]?.away) this.players[i] = null;
    if (!this.players[0] || !this.players[1]) {
      this.broadcast({ type: 'left' });
      this.roster();
    }

    if (ranked && (winner === 0 || winner === 1)) {
      const w = winner === 0 ? a : b;
      const board = this.env.BOARD.get(this.env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
      // "Best" on the leaderboard is the longest run, in metres.
      await board.record({
        a: { key: a.key, name: a.name },
        b: { key: b.key, name: b.name },
        winner,
        best: Math.round(w.st.dist),
      });
    }
  }

  private onLeave(slot: 0 | 1, ws: WebSocket) {
    const p = this.players[slot];
    if (!p || p.ws !== ws) return;
    if (this.phase === 'running' || this.phase === 'countdown' || this.phase === 'deposit') {
      // Mid-race (or while stakes are going in): keep the seat. The wheel stops while you're gone; come back before the race ends.
      p.ws = null;
      p.away = true;
      p.awaySince = Date.now();
      this.sendOther(slot, { type: 'peer', away: true });
      return;
    }
    this.players[slot] = null;
    if (this.phase === 'ended') this.phase = 'lobby';
    if (this.listed && !this.players[0] && !this.players[1]) {
      this.listed = false;
      this.board().closeChallenge(this.code).catch(() => {});
    }
    for (const x of this.players) if (x) x.seed = null;
    this.broadcast({ type: 'left' });
    this.roster();
    if (!this.players[0] && !this.players[1]) this.reset();
  }
}
