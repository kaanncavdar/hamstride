import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Board } from './board';
import { fetchLive } from './live';
import {
  CONFIRM_LAG_TICKS, COUNTDOWN_MS, FINISH_M, FUTURE_TOLERANCE_TICKS, MAX_BLOCK_DROPS,
  MAX_INPUTS_PER_SEC, MAX_TICKS, REVEAL_AHEAD_M, TICK_HZ,
} from '../src/shared/constants';
import { courseHash, generateCourse, sortCourse, type Obs } from '../src/shared/course';
import { HEX32, HEX64, randomHex, sha256Hex } from '../src/shared/hash';
import { cleanName, type ClientMsg, type LiveInfo, type ServerMsg } from '../src/shared/protocol';
import { finishTime, initState, KEYS, step, type Key, type PState } from '../src/shared/sim';
import { humanReport } from '../src/shared/stats';

interface Player {
  ws: WebSocket;
  name: string;
  /** sha256 of the browser's secret player id; the leaderboard key. */
  key: string;
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

type Phase = 'lobby' | 'countdown' | 'running' | 'ended';

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

  async fetch(req: Request): Promise<Response> {
    if (!this.commit) this.commit = await sha256Hex(this.serverSeed);
    this.code = new URL(req.url).pathname.split('/').pop() ?? '';
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();

    const slot = this.players.findIndex((p) => p === null);
    if (slot < 0 || this.phase !== 'lobby') {
      this.send(ws, { type: 'error', msg: slot < 0 ? 'This room is full.' : 'This match has already started.' });
      ws.close(1008, 'full');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const p: Player = {
      ws, name: 'Hamster', key: '', seed: null, webdriver: false, st: initState(),
      q: [], log: [], late: 0, dropped: 0, rateSec: 0, rateCount: 0,
    };
    this.players[slot] = p;
    this.send(ws, { type: 'welcome', you: slot as 0 | 1, commit: this.commit, code: this.code });
    this.roster();

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 4096) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(slot as 0 | 1, msg).catch(() => {});
    });
    const gone = () => this.onLeave(slot as 0 | 1, ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: pair[0] });
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
        p?.ws.send(text);
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
        if (typeof m.c === 'number') this.send(p.ws, { type: 'pong', c: m.c, s: Date.now() });
        return;
      case 'hello':
        if (p.seed || !HEX32.test(String(m.seed)) || !HEX64.test(String(m.pid))) return;
        p.name = cleanName(m.name);
        p.seed = m.seed;
        p.key = await sha256Hex(`wheel-duel:${m.pid}`);
        p.webdriver = m.wd === true;
        this.roster();
        this.maybeStart();
        return;
      case 'rematch':
        if (this.phase !== 'ended' || !HEX32.test(String(m.seed))) return;
        p.seed = m.seed;
        if (this.players.every((x) => x?.seed)) {
          this.phase = 'lobby';
          this.maybeStart();
        } else {
          for (const x of this.players) if (x && x !== p) this.send(x.ws, { type: 'rematch_wait' });
        }
        return;
      case 'in':
        this.onInputs(p, m.a);
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
    this.phase = 'countdown';
    this.start(a, b).catch(() => this.reset());
  }

  private async start(a: Player, b: Player) {
    const courseSeed = await sha256Hex(`${this.serverSeed}:${a.seed}:${b.seed}`);
    this.live = await fetchLive();
    this.lastLive = Date.now();
    this.lastBlock = BigInt(this.live?.blockHeight ?? '0');
    this.drops = 0;
    this.course = generateCourse(courseSeed, !!this.live?.active);
    this.sent = new Set();
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
    let d = Math.round((lead + REVEAL_AHEAD_M - 4) * 10) / 10;
    if (d > FINISH_M - 20) return;
    while (this.course.some((o) => Math.abs(o.d - d) < 2)) d += 2.5;
    this.course.push({ id: this.nextDropId++, d, kind: 'bdrop', lane: -1 });
    sortCourse(this.course);
    this.drops++;
  }

  private checkEnd(target: number) {
    const [a, b] = this.players;
    if (!a || !b) return;
    const fa = finishTime(a.st);
    const fb = finishTime(b.st);
    if (fa < Infinity && fb < Infinity) this.end(fa === fb ? -1 : fa < fb ? 0 : 1, 'finish');
    else if (fa < Infinity && b.st.tick > fa) this.end(0, 'finish');
    else if (fb < Infinity && a.st.tick > fb) this.end(1, 'finish');
    else if (target >= MAX_TICKS) this.end(a.st.dist === b.st.dist ? -1 : a.st.dist > b.st.dist ? 0 : 1, 'timeout');
  }

  private async end(winner: 0 | 1 | -1, reason: 'finish' | 'timeout' | 'forfeit') {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const [a, b] = this.players as [Player, Player];
    const cvMin = Number(this.env.BOT_CV_MIN) || 0.06;
    const human: [ReturnType<typeof humanReport>, ReturnType<typeof humanReport>] = [
      humanReport(a?.st ?? initState(), cvMin),
      humanReport(b?.st ?? initState(), cvMin),
    ];
    const reveal = { serverSeed: this.serverSeed, seeds: [a?.seed ?? '', b?.seed ?? ''] as [string, string] };
    const inputHash = await sha256Hex(JSON.stringify([a?.log ?? [], b?.log ?? []]));
    const cHash = await courseHash(this.course);
    // Ranked only when both look human, nobody automated the browser, and the match was raced out.
    const ranked =
      reason !== 'timeout' && winner !== -1 && !!a && !!b && a.key !== b.key &&
      human.every((h) => h.verdict === 'human') && !a.webdriver && !b.webdriver &&
      (reason === 'finish' || Math.max(a.st.dist, b.st.dist) > 100);

    this.serverSeed = randomHex(32);
    this.commit = await sha256Hex(this.serverSeed);
    for (const p of this.players) if (p) p.seed = null;

    this.broadcast({
      type: 'end', winner, reason, final: [a?.st ?? initState(), b?.st ?? initState()], reveal,
      courseHash: cHash, inputHash, human, ranked, nextCommit: this.commit,
    });

    if (ranked && (winner === 0 || winner === 1)) {
      const w = winner === 0 ? a : b;
      const ft = finishTime(w.st);
      const board = this.env.BOARD.get(this.env.BOARD.idFromName('global')) as DurableObjectStub<Board>;
      await board.record({
        a: { key: a.key, name: a.name },
        b: { key: b.key, name: b.name },
        winner,
        winnerMs: ft < Infinity ? Math.round((ft * 1000) / TICK_HZ) : null,
      });
    }
  }

  private onLeave(slot: 0 | 1, ws: WebSocket) {
    const p = this.players[slot];
    if (!p || p.ws !== ws) return;
    if (this.phase === 'running' || this.phase === 'countdown') {
      const other = slot === 0 ? 1 : 0;
      if (this.players[other]) {
        this.end(other as 0 | 1, 'forfeit').finally(() => {
          this.players[slot] = null;
          this.broadcast({ type: 'left' });
          this.phase = 'lobby';
          this.roster();
        });
        return;
      }
    }
    this.players[slot] = null;
    if (this.phase === 'ended') this.phase = 'lobby';
    for (const x of this.players) if (x) x.seed = null;
    this.broadcast({ type: 'left' });
    this.roster();
    if (!this.players[0] && !this.players[1]) this.reset();
  }
}
