import { generateCourse, sortCourse, type Obs } from '../shared/course';
import { MAX_TICKS, TICK_HZ } from '../shared/constants';
import { cloneState, initState, sameState, step, type Key, type PState } from '../shared/sim';
import { Bot } from '../shared/bot';
import { randomHex } from '../shared/hash';
import type { Conn } from './net';
import type { LiveInfo } from '../shared/protocol';

export type Mode = 'online' | 'practice' | 'attract';

const HISTORY = 420;

/**
 * A race as seen by this browser. "me" is simulated locally from my own key presses (no lag);
 * online, the server re-runs it and sends back its confirmed state, and we rewind and replay if
 * we disagree. The rival is drawn from the server's snapshots.
 */
export class Session {
  course: Obs[] = [];
  me = initState();
  opp = initState();
  names: [string, string] = ['You', 'Rival'];
  live: LiveInfo | null = null;
  ended = false;
  /** Time of tick 0 in this session's clock (ms). */
  private t0: number;
  private clock: () => number;
  private history = new Map<number, PState>();
  private myInputs = new Map<number, Key[]>();
  private outbox: [number, Key][] = [];
  private bots: [Bot | null, Bot | null] = [null, null];
  private oppSnap: { st: PState; at: number } | null = null;
  /** Recent foot press times, for the rhythm meter. */
  readonly footTimes: number[] = [];
  resyncs = 0;

  private constructor(readonly mode: Mode, t0: number, clock: () => number, readonly conn: Conn | null = null) {
    this.t0 = t0;
    this.clock = clock;
  }

  static practice(mode: 'practice' | 'attract', skill = 0.7, live: LiveInfo | null = null): Session {
    const s = new Session(mode, performance.now() + (mode === 'attract' ? 0 : 3500), () => performance.now());
    const seed = randomHex(32);
    s.course = generateCourse(seed + seed, !!live?.active);
    s.live = live;
    s.names = mode === 'attract' ? ['Pip', 'Nugget'] : ['You', 'Bot Biscuit'];
    if (mode === 'attract') s.bots[0] = new Bot(randomHex(16), 0.8);
    s.bots[1] = new Bot(randomHex(16), skill);
    return s;
  }

  static online(conn: Conn, t0: number, names: [string, string], you: 0 | 1, live: LiveInfo | null): Session {
    const s = new Session('online', t0, () => conn.serverNow(), conn);
    s.names = you === 0 ? names : [names[1], names[0]];
    s.live = live;
    s.you = you;
    return s;
  }

  you: 0 | 1 = 0;

  /** Current tick by the clock; negative during the countdown. */
  clockTick() {
    return Math.floor(((this.clock() - this.t0) * TICK_HZ) / 1000);
  }

  countdownMs() {
    return this.t0 - this.clock();
  }

  press(k: Key) {
    if (this.ended || this.mode === 'attract') return;
    const t = Math.max(0, this.clockTick(), this.me.tick);
    const list = this.myInputs.get(t) ?? [];
    list.push(k);
    this.myInputs.set(t, list);
    if (this.mode === 'online') this.outbox.push([t, k]);
    if (k === 'L' || k === 'R') {
      this.footTimes.push(performance.now());
      if (this.footTimes.length > 12) this.footTimes.shift();
    }
  }

  addObstacles(obs: Obs[]) {
    const known = new Set(this.course.map((o) => o.id));
    for (const o of obs) if (!known.has(o.id)) this.course.push(o);
    sortCourse(this.course);
  }

  /** Server snapshot: both players' confirmed states. */
  onSnap(p: [PState, PState]) {
    const mine = p[this.you];
    const theirs = p[this.you === 0 ? 1 : 0];
    this.oppSnap = { st: theirs, at: performance.now() };
    this.opp = cloneState(theirs);
    const local = this.history.get(mine.tick);
    if (local && sameState(local, mine)) return;
    if (mine.tick > this.me.tick) {
      this.me = cloneState(mine);
      return;
    }
    // Disagreement (a late input on a slow link): rewind to the server's state and replay.
    this.resyncs++;
    const target = this.me.tick;
    const s = cloneState(mine);
    this.history.clear();
    while (s.tick < target) {
      this.history.set(s.tick, cloneState(s));
      step(s, this.myInputs.get(s.tick) ?? [], this.course);
    }
    this.me = s;
  }

  /** Advances local simulation to the clock and flushes inputs to the server. */
  update() {
    const target = Math.min(this.clockTick(), MAX_TICKS);
    if (target < 0) return;
    let guard = 0;
    while (this.me.tick <= target && guard++ < 600) {
      const t = this.me.tick;
      if (this.mode === 'online') {
        this.history.set(t, cloneState(this.me));
        this.history.delete(t - HISTORY);
      }
      const keys = this.bots[0] ? this.bots[0].keys(this.me, this.course) : this.myInputs.get(t) ?? [];
      step(this.me, keys, this.course);
      if (this.mode !== 'online') {
        this.myInputs.delete(t);
        step(this.opp, this.bots[1]!.keys(this.opp, this.course), this.course);
      }
    }
    if (this.mode === 'online' && this.outbox.length) {
      this.conn!.send({ type: 'in', a: this.outbox.splice(0, 30) });
    }
  }

  /** The rival for drawing: the last confirmed state, nudged forward by its speed. */
  oppView(): PState {
    if (this.mode !== 'online' || !this.oppSnap) return this.opp;
    const v = cloneState(this.oppSnap.st);
    if (v.finishTick < 0) {
      const ahead = Math.min(0.5, (performance.now() - this.oppSnap.at) / 1000 + 0.4);
      v.dist += v.speed * ahead;
    }
    return v;
  }

  /** Presses per second from the last few foot presses. */
  cadence(): number {
    const f = this.footTimes;
    if (f.length < 3 || performance.now() - f[f.length - 1] > 600) return 0;
    return ((f.length - 1) * 1000) / (f[f.length - 1] - f[0]);
  }
}
