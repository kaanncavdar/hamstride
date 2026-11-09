import { Rng } from './rng';
import { sha256Hex } from './hash';

/**
 * A 3-lane track on the inside of a giant hamster wheel. Every row leaves at least one way through,
 * and every bump costs one energy bolt.
 * block: a wooden hideout in one lane. Too tall to jump → change lane.
 * low:   a cork log in one lane → jump (or change lane).
 * high:  a wooden bridge at head height in one lane → slide under (or change lane).
 * car:   a seagrass ball rolling towards you in one lane. Tall → change lane.
 * worm:  a snack (seed, broccoli, courgette, mealworm). Enough snacks give a bolt back.
 * wheel: a small saucer wheel to ride: faster, and it takes one bump for you.
 * ball:  a hamster ball: rolls through logs and bridges, and takes one bump for you.
 * bdrop: a Squeekchain block, only when the real hamster completes one mid-race. Gives a bolt back.
 */
export type ObsKind = 'block' | 'low' | 'high' | 'car' | 'worm' | 'wheel' | 'ball' | 'bdrop';

export interface Obs {
  id: number;
  /** Distance from the start, metres (front edge). */
  d: number;
  kind: ObsKind;
  /** 0 = left, 1 = middle, 2 = right. */
  lane: number;
  /** Length along the road, metres. */
  len: number;
}

export const LEN: Record<ObsKind, number> = { block: 2.4, low: 0.6, high: 0.8, car: 2.2, worm: 0.6, wheel: 0.9, ball: 0.9, bdrop: 0.9 };
/** The course is long enough for the longest possible race (3 minutes at top speed). */
export const COURSE_M = 3800;
/** Cars start driving at you once you're this close. */
export const CAR_WAKE = 45;
const CAR_CLOSE = 0.6;

/** Where a car's front is, given how far the runner is. A pure function of distance, so both players meet it the same way. */
export function carD(o: Obs, dist: number): number {
  const start = o.d - CAR_WAKE;
  return dist <= start ? o.d : o.d - (dist - start) * CAR_CLOSE;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function sortCourse(obs: Obs[]): Obs[] {
  return obs.sort((a, b) => a.d - b.d || a.id - b.id);
}

/** Builds the course from a seed (server seed + both players' seeds, so nobody picks it alone). */
export function generateCourse(seedHex: string, live: boolean, length = COURSE_M): Obs[] {
  const r = new Rng(seedHex);
  const out: Obs[] = [];
  let id = 0;
  let d = 50;
  let nextPower = r.range(160, 260);
  const push = (kind: ObsKind, lane: number, at: number) => out.push({ id: id++, d: round1(at), kind, lane, len: LEN[kind] });
  const worms = (lane: number, from: number, n: number) => {
    for (let i = 0; i < n; i++) push('worm', lane, from + i * 2.4);
  };
  const others = (lane: number) => [0, 1, 2].filter((l) => l !== lane);

  while (d < length) {
    const prog = Math.min(1, d / 2400);
    d += r.range(14, 21) + prog * 3;
    const free = r.int(0, 2);
    const roll = r.next();

    if (roll < 0.22) {
      // One box; two ways round it.
      push('block', r.int(0, 2), d);
      if (r.chance(0.5)) worms(free, d - 9, 3 + (live ? 1 : 0));
    } else if (roll < 0.4 && d > 90) {
      // Two boxes: find the one open lane.
      for (const l of others(free)) push('block', l, d);
      if (r.chance(0.6)) worms(free, d - 9, 4);
    } else if (roll < 0.53) {
      // Fences: jump them (one lane may be a box instead).
      if (r.chance(0.6)) for (const l of [0, 1, 2]) push('low', l, d);
      else {
        push('block', free, d);
        for (const l of others(free)) push('low', l, d);
      }
    } else if (roll < 0.66) {
      // Bars: slide under them.
      if (r.chance(0.6)) for (const l of [0, 1, 2]) push('high', l, d);
      else {
        push('block', free, d);
        for (const l of others(free)) push('high', l, d);
      }
    } else if (roll < 0.78 && d > 160) {
      // A car coming at you. Extra room before it, because it meets you early.
      d += 20;
      const lane = r.int(0, 2);
      push('car', lane, d);
      if (r.chance(0.5)) push('block', others(lane)[r.int(0, 1)], d - 18);
    } else if (roll < 0.9) {
      // A mixed row: a fence, a bar and a box, one per lane. Jump or slide.
      const lanes = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = r.int(0, i);
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }
      push('low', lanes[0], d);
      push('high', lanes[1], d);
      push('block', lanes[2], d);
    } else {
      // A breather with treats.
      worms(free, d - 4, 5 + (live ? 2 : 0));
    }

    if (d >= nextPower) {
      // A ride in an open lane, a little after this row.
      d += 9;
      push(r.chance(0.55) ? 'wheel' : 'ball', r.int(0, 2), d);
      nextPower = d + r.range(240, 400);
    }
  }
  return sortCourse(out);
}

/** Hash of the generated course, without live Block Drops. Clients recompute it after the match. */
export async function courseHash(obs: readonly Obs[]): Promise<string> {
  const base = obs.filter((o) => o.kind !== 'bdrop').map((o) => [o.id, o.d, o.kind, o.lane]);
  return sha256Hex(JSON.stringify(base));
}
