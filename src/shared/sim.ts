import { DT, FINISH_M } from './constants';
import type { Obs } from './course';

/** L / R = the hamster's feet (alternate them). J = jump. U = far lane. D = near lane. */
export type Key = 'L' | 'R' | 'J' | 'U' | 'D';
export const KEYS: readonly Key[] = ['L', 'R', 'J', 'U', 'D'];

export const AIR_TICKS = 36; // 0.6 s in the air
export const CRASH_TICKS = 45;
export const OVERHEAT_TICKS = 80;
export const SCARE_TICKS = 60;
export const CAT_TELE = 50; // ticks of warning before the cat opens its eyes
export const CAT_LEAVE = 30;
export const LANE_TICKS = 10;
export const BOOST_TICKS = 120;
const IMPULSE = 1.0;
export const VMAX = 16;
const DECAY = 0.985;
const AIR_DECAY = 0.996;
const COOL = 0.45 / 60;
const SEED_BOOST = 3.0;

/** Stun reasons, for the HUD. */
export const STUN_NONE = 0;
export const STUN_CRASH = 1;
export const STUN_HEAT = 2;
export const STUN_SCARED = 3;

/** One player's run. Plain numbers only, so it serialises to JSON and back without change. */
export interface PState {
  tick: number;
  dist: number;
  speed: number;
  heat: number;
  lastFoot: number;
  lastFootTick: number;
  stun: number;
  stunKind: number;
  air: number;
  lane: number;
  laneP: number;
  boost: number;
  catId: number;
  catT: number;
  catDur: number;
  finishTick: number;
  finishFrac: number;
  presses: number;
  missteps: number;
  jumps: number;
  crashes: number;
  overheats: number;
  scares: number;
  seeds: number;
  chilis: number;
  blocks: number;
  nIv: number;
  sumIv: number;
  sumIv2: number;
}

export function initState(): PState {
  return {
    tick: 0,
    dist: 0,
    speed: 0,
    heat: 0,
    lastFoot: 0,
    lastFootTick: -1,
    stun: 0,
    stunKind: 0,
    air: 0,
    lane: 0,
    laneP: 0,
    boost: 0,
    catId: -1,
    catT: 0,
    catDur: 0,
    finishTick: -1,
    finishFrac: 0,
    presses: 0,
    missteps: 0,
    jumps: 0,
    crashes: 0,
    overheats: 0,
    scares: 0,
    seeds: 0,
    chilis: 0,
    blocks: 0,
    nIv: 0,
    sumIv: 0,
    sumIv2: 0,
  };
}

export const cloneState = (s: PState): PState => ({ ...s });

export function sameState(a: PState, b: PState): boolean {
  for (const k in a) if (a[k as keyof PState] !== b[k as keyof PState]) return false;
  return true;
}

/** 0 = near lane, 1 = far lane. A lane change counts once the wheel is more than halfway across. */
export const curLane = (s: PState) => (s.laneP * 2 >= LANE_TICKS ? 1 : 0);
export const laneT = (s: PState) => s.laneP / LANE_TICKS;

export const catWarning = (s: PState) => s.catId >= 0 && s.catT <= CAT_TELE;
export const catWatching = (s: PState) => s.catId >= 0 && s.catT > CAT_TELE && s.catT <= CAT_TELE + s.catDur;

/** Finish time in ticks with sub-tick precision, or Infinity. */
export const finishTime = (s: PState) => (s.finishTick >= 0 ? s.finishTick + s.finishFrac : Infinity);

function overheat(s: PState) {
  s.stun = OVERHEAT_TICKS;
  s.stunKind = STUN_HEAT;
  s.speed *= 0.3;
  s.heat = 0.5;
  s.overheats++;
}

function crash(s: PState, o: Obs) {
  s.dist = o.d - 0.5;
  s.speed = 0;
  s.stun = CRASH_TICKS;
  s.stunKind = STUN_CRASH;
  s.air = 0;
  s.crashes++;
}

/** Applies one obstacle the wheel just rolled over. Returns true if the wheel crashed. */
function touch(s: PState, o: Obs): boolean {
  const lane = curLane(s);
  switch (o.kind) {
    case 'hurdle':
      if (s.air === 0) {
        crash(s, o);
        return true;
      }
      return false;
    case 'block':
      if (o.lane === lane) {
        crash(s, o);
        return true;
      }
      return false;
    case 'seed':
      if (o.lane === lane && s.air === 0) {
        s.speed = Math.min(VMAX + 4, s.speed + SEED_BOOST);
        s.heat = Math.max(0, s.heat - 0.3);
        s.seeds++;
      }
      return false;
    case 'chili':
      if (o.lane === lane && s.air === 0) {
        s.heat += 0.55;
        s.chilis++;
        if (s.heat >= 1 && s.stun === 0) overheat(s);
      }
      return false;
    case 'cat':
      s.catId = o.id;
      s.catT = 0;
      s.catDur = o.dur ?? 80;
      return false;
    case 'bdrop':
      s.boost = BOOST_TICKS;
      s.blocks++;
      return false;
  }
}

/**
 * Advances one player by one tick (1/60 s), applying the keys pressed at this tick.
 * Pure arithmetic only (no Math.sin and the like), so every JavaScript engine gives the same result.
 * The course must be sorted with sortCourse().
 */
export function step(s: PState, keys: readonly Key[], course: readonly Obs[]): void {
  if (s.finishTick >= 0) {
    s.tick++;
    return;
  }
  const watching = catWatching(s);

  for (const k of keys) {
    if (k === 'U') s.lane = 1;
    else if (k === 'D') s.lane = 0;
    else if (k === 'J') {
      if (s.air === 0 && s.stun === 0) {
        s.air = AIR_TICKS;
        s.jumps++;
      }
    } else {
      const foot = k === 'L' ? 1 : 2;
      if (watching) {
        if (s.stun === 0) {
          s.stun = SCARE_TICKS;
          s.stunKind = STUN_SCARED;
          s.speed = 0;
          s.scares++;
        }
        continue;
      }
      if (s.stun > 0 || s.air > 0) continue;
      s.presses++;
      if (foot === s.lastFoot) {
        // Same foot twice: the hamster trips over itself. One-key autoclickers go nowhere.
        s.missteps++;
        s.speed *= 0.85;
        s.lastFootTick = s.tick;
        continue;
      }
      if (s.lastFootTick >= 0) {
        const iv = s.tick - s.lastFootTick;
        if (iv > 0 && iv <= 30) {
          s.nIv++;
          s.sumIv += iv;
          s.sumIv2 += iv * iv;
        }
        // Faster than ~10 presses a second heats the wheel. Mashing loses.
        if (iv <= 4) s.heat += 0.2;
        else if (iv === 5) s.heat += 0.1;
        else if (iv === 6) s.heat += 0.03;
      }
      s.speed = Math.max(s.speed, s.speed + IMPULSE * (1 - s.speed / VMAX));
      s.lastFoot = foot;
      s.lastFootTick = s.tick;
      if (s.heat >= 1) overheat(s);
    }
  }

  s.heat = Math.max(0, s.heat - COOL);
  if (s.stun > 0) {
    s.stun--;
    if (s.stun === 0) s.stunKind = STUN_NONE;
    s.speed *= 0.92;
  }
  if (s.air > 0) {
    s.air--;
    s.speed *= AIR_DECAY;
  } else {
    s.speed *= DECAY;
  }
  if (s.boost > 0) {
    s.boost--;
    s.speed = Math.min(VMAX + 4, s.speed + 0.12);
  }
  if (s.speed < 0.001) s.speed = 0;

  if (s.laneP < s.lane * LANE_TICKS) s.laneP++;
  else if (s.laneP > s.lane * LANE_TICKS) s.laneP--;

  const prev = s.dist;
  s.dist += s.speed * DT;
  for (const o of course) {
    if (o.d > s.dist) break;
    if (o.d > prev && touch(s, o)) break;
  }

  if (s.catId >= 0) {
    s.catT++;
    if (s.catT > CAT_TELE + s.catDur + CAT_LEAVE) s.catId = -1;
  }

  if (s.dist >= FINISH_M) {
    s.finishTick = s.tick;
    s.finishFrac = s.dist > prev ? (FINISH_M - prev) / (s.dist - prev) : 0;
  }
  s.tick++;
}
