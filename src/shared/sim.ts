import { DT } from './constants';
import { carD, type Obs } from './course';

/** L / R = change lane, J = jump, S = slide (or drop fast from a jump). */
export type Key = 'L' | 'R' | 'J' | 'S';
export const KEYS: readonly Key[] = ['L', 'R', 'J', 'S'];

export const LANE_TICKS = 8; // ticks to move one lane
export const JUMP_TICKS = 40;
export const SLIDE_TICKS = 38;
export const STUMBLE_TICKS = 36;
export const GRACE_TICKS = 60;
export const WHEEL_TICKS = 12 * 60;
export const BALL_TICKS = 10 * 60;
/** Energy bolts. Every bump costs one; with none left the hamster is too tired to run on. */
export const ENERGY_MAX = 3;
/** Snacks you need to eat for one bolt back. */
export const SNACKS_PER_BOLT = 20;
const BUMP_TICKS = 50;
/** How long you can be on screen (ticks) before a threat counts as "seen", for reaction timing. */
const SEE_M = 30;
/** Cars are checked a bit ahead of their starting spot because they drive towards you. */
const CAR_LOOKAHEAD = 60;

export const RIDE_NONE = 0;
export const RIDE_WHEEL = 1;
export const RIDE_BALL = 2;

/**
 * Speed grows quickly at first, then slowly, towards a ceiling: 8 m/s at the start, ~11 at 30 s,
 * ~13 at 1 min, ~15.5 at 3 min, never above 18. Pure arithmetic, identical in every engine.
 */
export function baseSpeed(tick: number): number {
  return 8 + (10 * tick) / (tick + 3600);
}

/** How fast the road runs. Classic levels off; Ramp keeps climbing until somebody can't keep up. */
export interface Rules {
  speed(tick: number): number;
  snacksPerBolt: number;
  /** From `start`, one bolt drains away every `every` ticks: the run always ends eventually. */
  drain?: { start: number; every: number };
}
export const CLASSIC: Rules = { speed: baseSpeed, snacksPerBolt: SNACKS_PER_BOLT };
/**
 * 8 m/s, then +0.07 m/s every second with no ceiling: ~12 at 1 min, ~21 at 3 min, ~29 at 5 min.
 * After 90 s the hamster also tires on its own, one bolt every 12 s, and every 14 snacks win one
 * back. Even a very good run ends within a few minutes; the snacks you grab decide who lasts longer.
 */
export const RAMP: Rules = { speed: (tick) => 8 + (0.07 * tick) / 60, snacksPerBolt: 14, drain: { start: 90 * 60, every: 12 * 60 } };
/** The rules of the real game, online and offline. CLASSIC is kept only for the old 45° version. */
export const GAME_RULES = RAMP;

/** One player's run. Plain numbers only, so it round-trips through JSON unchanged. */
export interface PState {
  tick: number;
  dist: number;
  speed: number;
  lane: number;
  laneP: number;
  air: number;
  slide: number;
  stumble: number;
  grace: number;
  /** Energy bolts left (0..ENERGY_MAX). */
  energy: number;
  /** Snacks eaten towards the next bolt. */
  snack: number;
  /** Tick when the hamster ran out of energy and stopped, or -1. */
  tiredTick: number;
  ride: number;
  rideT: number;
  lastHit: number;
  /** The nearest threat in your lane and when it came into view, for reaction timing. */
  threatId: number;
  threatTick: number;
  jumps: number;
  slides: number;
  moves: number;
  stumbles: number;
  breaks: number;
  worms: number;
  rides: number;
  blocks: number;
  nR: number;
  sumR: number;
  sumR2: number;
}

export function initState(): PState {
  return {
    tick: 0, dist: 0, speed: 0, lane: 1, laneP: LANE_TICKS, air: 0, slide: 0, stumble: 0, grace: 0,
    energy: ENERGY_MAX, snack: 0, tiredTick: -1, ride: RIDE_NONE, rideT: 0, lastHit: -1, threatId: -1, threatTick: 0,
    jumps: 0, slides: 0, moves: 0, stumbles: 0, breaks: 0, worms: 0, rides: 0, blocks: 0, nR: 0, sumR: 0, sumR2: 0,
  };
}

export const cloneState = (s: PState): PState => ({ ...s });

export function sameState(a: PState, b: PState): boolean {
  for (const k in a) if (a[k as keyof PState] !== b[k as keyof PState]) return false;
  return true;
}

/** Lateral position, 0..2 (0 = left lane centre, 2 = right lane centre). */
export const laneX = (s: PState) => s.laneP / LANE_TICKS;
export const tired = (s: PState) => s.tiredTick >= 0;
/** For deciding a race: when you ran out of energy, or Infinity. */
export const tiredAt = (s: PState) => (s.tiredTick >= 0 ? s.tiredTick : Infinity);

// Forgiving hitbox: halfway between two lanes you touch neither, so a last-moment dodge works.
const overlaps = (s: PState, lane: number) => Math.abs(laneX(s) - lane) < 0.45;
const isThreat = (k: Obs['kind']) => k === 'block' || k === 'low' || k === 'high' || k === 'car';

function loseBolt(s: PState) {
  s.energy--;
  if (s.energy <= 0) {
    s.energy = 0;
    s.tiredTick = s.tick;
    s.speed = 0;
  }
}

function gainBolt(s: PState) {
  s.energy = Math.min(ENERGY_MAX, s.energy + 1);
}

/** A ride takes the hit for you. Returns true if it did. */
function rideAbsorbs(s: PState): boolean {
  if (s.ride === RIDE_NONE) return false;
  s.ride = RIDE_NONE;
  s.rideT = 0;
  s.grace = GRACE_TICKS;
  s.breaks++;
  return true;
}

function stumble(s: PState) {
  if (s.grace > 0 || rideAbsorbs(s)) return;
  s.stumbles++;
  s.stumble = STUMBLE_TICKS;
  s.grace = GRACE_TICKS;
  loseBolt(s);
}

/** Running into something tall: same cost, but a harder knock. */
function crash(s: PState) {
  if (s.grace > 0 || rideAbsorbs(s)) return;
  s.stumbles++;
  s.stumble = BUMP_TICKS;
  s.grace = GRACE_TICKS;
  loseBolt(s);
}

/** Is anything tall sitting in `lane` right where you are? (For bumping into the side of a box.) */
function tallBeside(course: readonly Obs[], lane: number, dist: number): boolean {
  for (const o of course) {
    if (o.d > dist + 1) break;
    if (o.lane !== lane) continue;
    if (o.kind === 'block' && dist + 0.3 > o.d && dist - 0.3 < o.d + o.len) return true;
  }
  return false;
}

/** Advances one player one tick (1/60 s). Pure arithmetic, so every engine agrees. */
export function step(s: PState, keys: readonly Key[], course: readonly Obs[], rules: Rules = GAME_RULES): void {
  if (s.tiredTick >= 0) {
    s.tick++;
    return;
  }

  for (const k of keys) {
    let acted = false;
    if (k === 'L' || k === 'R') {
      const to = k === 'L' ? s.lane - 1 : s.lane + 1;
      if (to < 0 || to > 2) continue;
      if (tallBeside(course, to, s.dist)) {
        stumble(s); // bumped the side of a box
        continue;
      }
      s.lane = to;
      s.moves++;
      acted = true;
    } else if (k === 'J') {
      if (s.air === 0) {
        s.air = JUMP_TICKS;
        s.slide = 0;
        s.jumps++;
        acted = true;
      }
    } else if (k === 'S') {
      if (s.air > 6) s.air = 6; // drop out of a jump
      if (s.slide === 0) {
        s.slide = SLIDE_TICKS;
        s.slides++;
        acted = true;
      }
    }
    if (acted && s.threatId >= 0) {
      const r = s.tick - s.threatTick;
      if (r > 0 && r < 180) {
        s.nR++;
        s.sumR += r;
        s.sumR2 += r * r;
      }
      s.threatId = -2 - s.threatId; // answered
    }
  }
  if (s.tiredTick >= 0) {
    s.tick++;
    return;
  }

  // Timers
  if (s.air > 0) s.air--;
  if (s.slide > 0 && s.air === 0) s.slide--;
  if (s.stumble > 0) s.stumble--;
  if (s.grace > 0) s.grace--;
  if (s.rideT > 0 && --s.rideT === 0) s.ride = RIDE_NONE;
  const target = s.lane * LANE_TICKS;
  if (s.laneP < target) s.laneP++;
  else if (s.laneP > target) s.laneP--;

  // Tiring out on its own (ramp rules only).
  if (rules.drain && s.tick >= rules.drain.start && (s.tick - rules.drain.start) % rules.drain.every === 0) {
    s.stumble = Math.max(s.stumble, 20);
    loseBolt(s);
    if (s.tiredTick >= 0) {
      s.tick++;
      return;
    }
  }

  // Move
  let v = rules.speed(s.tick);
  if (s.ride === RIDE_WHEEL) v *= 1.2;
  if (s.stumble > 0) v *= s.stumble > STUMBLE_TICKS ? 0.5 : 0.65;
  s.speed = v;
  const prev = s.dist;
  s.dist += v * DT;

  // What did we run into?
  for (const o of course) {
    if (o.d > s.dist + CAR_LOOKAHEAD) break;
    if (o.id === s.lastHit) continue;
    let front = o.d;
    if (o.kind === 'car') front = carD(o, s.dist);
    const hitZone = o.kind === 'car' ? s.dist + 0.3 > front && s.dist - 0.3 < front + o.len : s.dist + 0.3 > front && prev - 0.3 < front + o.len;
    if (!hitZone || !overlaps(s, o.lane)) continue;
    switch (o.kind) {
      case 'block':
      case 'car':
        s.lastHit = o.id;
        crash(s);
        break;
      case 'low':
        if (s.air === 0 && s.ride !== RIDE_BALL) {
          s.lastHit = o.id;
          stumble(s);
        }
        break;
      case 'high':
        if (s.slide === 0 && s.ride !== RIDE_BALL) {
          s.lastHit = o.id;
          stumble(s);
        }
        break;
      case 'worm':
        s.lastHit = o.id;
        s.worms++;
        if (++s.snack >= rules.snacksPerBolt) {
          s.snack = 0;
          gainBolt(s);
        }
        break;
      case 'wheel':
      case 'ball':
        s.lastHit = o.id;
        s.ride = o.kind === 'wheel' ? RIDE_WHEEL : RIDE_BALL;
        s.rideT = o.kind === 'wheel' ? WHEEL_TICKS : BALL_TICKS;
        s.rides++;
        break;
      case 'bdrop':
        s.lastHit = o.id;
        s.blocks++;
        gainBolt(s);
        break;
    }
    if (s.tiredTick >= 0) break;
  }

  // Reaction timing: note when the next threat in your lane comes into view.
  if (s.threatId === -1 || s.threatId <= -2) {
    for (const o of course) {
      const ahead = (o.kind === 'car' ? carD(o, s.dist) : o.d) - s.dist;
      if (ahead < 2) continue;
      if (ahead > SEE_M) break;
      if (isThreat(o.kind) && o.lane === s.lane && o.id !== -2 - s.threatId) {
        s.threatId = o.id;
        s.threatTick = s.tick;
        break;
      }
    }
  } else {
    // Forget a threat we passed without needing to act.
    const o = course.find((x) => x.id === s.threatId);
    if (!o || o.d + o.len < s.dist) s.threatId = -1;
  }
  s.tick++;
}


/** Both still running at the time cap: more energy left wins, then distance. 0 = a, 1 = b, -1 = draw. */
export function winnerAtCap(a: PState, b: PState): 0 | 1 | -1 {
  if (a.energy !== b.energy) return a.energy > b.energy ? 0 : 1;
  if (a.dist !== b.dist) return a.dist > b.dist ? 0 : 1;
  return -1;
}
