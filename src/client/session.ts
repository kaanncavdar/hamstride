import { generateCourse, sortCourse, type Obs } from '../shared/course';
import { MAX_TICKS, TICK_HZ } from '../shared/constants';
import { RULES, TICK_CAP } from './variant';
import { GAME_RULES, tired, cloneState, initState, sameState, step, type Key, type PState } from '../shared/sim';
import { Bot } from '../shared/bot';
import { randomHex } from '../shared/hash';
import type { Conn } from './net';
import type { LiveInfo } from '../shared/protocol';

export type Mode = 'online' | 'practice' | 'attract';

const HISTORY = 420;
const MAX_ONLINE = MAX_TICKS;

/**
 * A race as seen by this browser. "me" is simulated locally from my own key presses (no lag);
 * online, the server re-runs it and sends back its confirmed state, and we rewind and replay if
 * we disagree. The rival is drawn from the server's last confirmed state, run forward with their
 * key presses as the server relays them, so their moves look as smooth as your own.
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
  /** The rival's relayed key presses, by tick (display only). */
  private oppInputs = new Map<number, Key[]>();
  /** The rival run forward from the last snapshot; rebuilt when a snapshot or a past press arrives. */
  private oppPred: PState | null = null;
  resyncs = 0;
  /** Online races always use the server's rules. */
  rules = GAME_RULES;

  private constructor(readonly mode: Mode, t0: number, clock: () => number, readonly conn: Conn | null = null) {
    this.t0 = t0;
    this.clock = clock;
  }

  static practice(mode: 'practice' | 'attract', skill = 0.7, live: LiveInfo | null = null): Session {
    const s = new Session(mode, performance.now() + (mode === 'attract' ? 0 : 3500), () => performance.now());
    const seed = randomHex(32);
    s.course = generateCourse(seed + seed, !!live?.active);
    s.rules = RULES;
    s.live = live;
    s.names = mode === 'attract' ? ['Pip', 'Nugget'] : ['You', 'Biscuit (bot)'];
    if (mode === 'attract') s.bots[0] = new Bot(randomHex(16), 0.9);
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

  /** When an offline race was paused (ms on its clock), or null. Online races can't pause. */
  private pausedAt: number | null = null;
  private now() {
    return this.pausedAt ?? this.clock();
  }

  get paused() {
    return this.pausedAt !== null;
  }

  /** Practice only: stop the clock (the wheel freezes) until resume(). */
  pause() {
    if (this.mode === 'online' || this.pausedAt !== null || this.ended) return;
    this.pausedAt = this.clock();
  }

  resume() {
    if (this.pausedAt === null) return;
    this.t0 += this.clock() - this.pausedAt;
    this.pausedAt = null;
  }

  /** Current tick by the clock; negative during the countdown. */
  clockTick() {
    return Math.floor(((this.now() - this.t0) * TICK_HZ) / 1000);
  }

  countdownMs() {
    return this.t0 - this.now();
  }

  press(k: Key) {
    if (this.pausedAt !== null) return;
    if (this.ended || this.mode === 'attract' || this.countdownMs() > 0) return;
    const t = Math.max(0, this.clockTick(), this.me.tick);
    const list = this.myInputs.get(t) ?? [];
    list.push(k);
    this.myInputs.set(t, list);
    if (this.mode === 'online') this.outbox.push([t, k]);
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
    this.oppPred = null;
    for (const t of this.oppInputs.keys()) if (t < theirs.tick) this.oppInputs.delete(t);
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
      step(s, this.myInputs.get(s.tick) ?? [], this.course, this.rules);
    }
    this.me = s;
  }

  /** The server's final states: freeze both hamsters exactly there, so the screen matches the result. */
  finish(p: [PState, PState]) {
    this.ended = true;
    this.me = cloneState(p[this.you]);
    const theirs = p[this.you === 0 ? 1 : 0];
    this.opp = cloneState(theirs);
    this.oppSnap = { st: cloneState(theirs), at: performance.now() };
    this.oppPred = cloneState(theirs);
    this.oppInputs.clear();
  }

  /** Advances local simulation to the clock and flushes inputs to the server. */
  update() {
    if (this.ended && this.mode === 'online') return;
    const target = Math.min(this.clockTick(), this.mode === 'online' ? MAX_ONLINE : TICK_CAP);
    if (target < 0) return;
    let guard = 0;
    while (this.me.tick <= target && guard++ < 600) {
      const t = this.me.tick;
      if (this.mode === 'online') {
        this.history.set(t, cloneState(this.me));
        this.history.delete(t - HISTORY);
      }
      const keys = this.bots[0] ? this.bots[0].keys(this.me, this.course) : this.myInputs.get(t) ?? [];
      step(this.me, keys, this.course, this.rules);
      if (this.mode !== 'online') {
        this.myInputs.delete(t);
        step(this.opp, this.bots[1]!.keys(this.opp, this.course), this.course, this.rules);
      }
    }
    if (this.mode === 'online' && this.outbox.length) {
      this.conn!.send({ type: 'in', a: this.outbox.splice(0, 30) });
    }
  }

  /** The rival's key presses, relayed by the server as they arrive. */
  onOppInputs(a: [number, Key][]) {
    if (this.mode !== 'online' || !Array.isArray(a)) return;
    for (const [t, k] of a) {
      if (!Number.isInteger(t) || (this.oppSnap && t < this.oppSnap.st.tick)) continue;
      const list = this.oppInputs.get(t) ?? [];
      list.push(k);
      this.oppInputs.set(t, list);
      // A press for a tick we already ran forward: run it again from the snapshot.
      if (this.oppPred && t < this.oppPred.tick) this.oppPred = null;
    }
  }

  /**
   * The rival for drawing: the last confirmed state, run forward to now with their relayed presses
   * (the same engine as your own hamster). Ticks whose presses haven't arrived yet run with none, and
   * the next snapshot or press corrects them. Display only: results come from the server.
   */
  oppView(): PState {
    if (this.mode !== 'online' || !this.oppSnap) return this.opp;
    if (!this.oppPred) this.oppPred = cloneState(this.oppSnap.st);
    if (this.ended) return this.oppPred;
    const target = Math.min(this.clockTick(), MAX_ONLINE);
    let guard = 0;
    while (this.oppPred.tick < target && !tired(this.oppPred) && guard++ < 600) {
      step(this.oppPred, this.oppInputs.get(this.oppPred.tick) ?? [], this.course, this.rules);
    }
    return this.oppPred;
  }

}
