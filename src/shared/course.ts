import { FINISH_M } from './constants';
import { Rng } from './rng';
import { sha256Hex } from './hash';

/**
 * hurdle: a pencil across both lanes. Jump over it.
 * block:  a toilet-paper roll in one lane. Too tall to jump; switch lanes.
 * seed:   a golden sunflower seed in one lane. Roll over it on the ground for a speed burst.
 * chili:  a hot chili in one lane. Rolling over it heats you up. Jump it or switch lanes.
 * cat:    the cat peeks in. While its eyes are open, any running press scares the hamster.
 * bdrop:  a Squeekchain block. Only appears when the real hamster completes a block mid-race.
 */
export type ObsKind = 'hurdle' | 'block' | 'seed' | 'chili' | 'cat' | 'bdrop';

export interface Obs {
  id: number;
  /** Distance from the start line, metres. */
  d: number;
  kind: ObsKind;
  /** 0 = near lane, 1 = far lane, -1 = both lanes. */
  lane: number;
  /** cat only: how many ticks its eyes stay open. */
  dur?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Both client and server sort the course the same way so the simulation sees obstacles in the same order. */
export function sortCourse(obs: Obs[]): Obs[] {
  return obs.sort((a, b) => a.d - b.d || a.id - b.id);
}

/**
 * Builds the course from a seed. The seed comes from the server seed (committed before the match)
 * plus both players' own seeds, so nobody can choose the course alone.
 * `live` = the real hamster was running at match start ("Night Race"): more seeds, tighter spacing.
 */
export function generateCourse(seedHex: string, live: boolean): Obs[] {
  const r = new Rng(seedHex);
  const out: Obs[] = [];
  let id = 0;
  let d = 28;
  let nextCat = r.range(95, 140);
  let last: ObsKind | '' = '';

  for (;;) {
    let gap = live ? r.range(9, 17) : r.range(10, 19);
    if (last === 'block') gap = Math.max(gap, 11);
    if (last === 'cat') gap = Math.max(gap, 22);
    d += gap;
    if (d > FINISH_M - 14) break;
    const at = round1(d);

    if (d >= nextCat) {
      out.push({ id: id++, d: at, kind: 'cat', lane: -1, dur: r.int(55, 110) });
      nextCat = d + r.range(110, 160);
      last = 'cat';
      continue;
    }

    const roll = r.next();
    const seedW = live ? 0.34 : 0.26;
    if (roll < 0.32) {
      out.push({ id: id++, d: at, kind: 'hurdle', lane: -1 });
      last = 'hurdle';
    } else if (roll < 0.6) {
      const lane = r.int(0, 1);
      out.push({ id: id++, d: at, kind: 'block', lane });
      if (r.chance(0.3)) out.push({ id: id++, d: at, kind: 'seed', lane: 1 - lane });
      last = 'block';
    } else if (roll < 0.6 + seedW) {
      const lane = r.int(0, 1);
      out.push({ id: id++, d: at, kind: 'seed', lane });
      if (r.chance(0.6)) out.push({ id: id++, d: at, kind: 'chili', lane: 1 - lane });
      last = 'seed';
    } else {
      // Chili wall: both lanes. The only way through without heating up is to jump.
      out.push({ id: id++, d: at, kind: 'chili', lane: 0 });
      out.push({ id: id++, d: at, kind: 'chili', lane: 1 });
      last = 'chili';
    }
  }
  return sortCourse(out);
}

/** Hash of the generated course, without live Block Drops. Clients recompute it after the match. */
export async function courseHash(obs: readonly Obs[]): Promise<string> {
  const base = obs.filter((o) => o.kind !== 'bdrop').map((o) => [o.id, o.d, o.kind, o.lane, o.dur ?? 0]);
  return sha256Hex(JSON.stringify(base));
}
