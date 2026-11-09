import { describe, expect, it } from 'vitest';
import { generateCourse, courseHash, carD } from '../src/shared/course';
import { initState, step, baseSpeed, tired, ENERGY_MAX, SNACKS_PER_BOLT, type PState } from '../src/shared/sim';
import { Bot } from '../src/shared/bot';
import { MAX_TICKS, TICK_HZ } from '../src/shared/constants';
import { leadingZeroBits } from '../src/shared/hash';

function run(seed: string, skill: number): PState {
  const course = generateCourse(seed, false);
  const s = initState();
  const bot = new Bot(seed.slice(0, 32), skill);
  while (!tired(s) && s.tick < MAX_TICKS) step(s, bot.keys(s, course), course);
  return s;
}

const seeds = Array.from({ length: 16 }, (_, i) => ((i + 1) * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(8));

describe('runner', () => {
  it('is deterministic', () => {
    expect(run(seeds[3], 0.7)).toEqual(run(seeds[3], 0.7));
  });

  it('speeds up sensibly and never past the ceiling', () => {
    expect(baseSpeed(0)).toBe(8);
    expect(baseSpeed(30 * 60)).toBeGreaterThan(10.5);
    expect(baseSpeed(60 * 60)).toBeCloseTo(13, 0);
    expect(baseSpeed(MAX_TICKS)).toBeLessThan(18);
  });

  it('an idle runner soon runs out of energy', () => {
    const course = generateCourse(seeds[0], false);
    const s = initState();
    while (!tired(s) && s.tick < MAX_TICKS) step(s, [], course);
    expect(tired(s)).toBe(true);
    expect(s.tick / TICK_HZ).toBeLessThan(20);
  });

  it('every stretch of road leaves at least one lane free of tall things', () => {
    for (const sd of seeds) {
      const course = generateCourse(sd, true);
      // Where each tall thing actually is when you reach it (cars drive towards you and meet you early).
      const tall = course
        .filter((o) => o.kind === 'block' || o.kind === 'car')
        .map((o) => ({ lane: o.lane, at: o.kind === 'car' ? o.d - 16.9 : o.d, len: o.kind === 'car' ? 6 : o.len }));
      for (const t of tall) {
        const lanes = new Set(tall.filter((u) => u.at < t.at + t.len + 2 && u.at + u.len + 2 > t.at).map((u) => u.lane));
        expect(lanes.size).toBeLessThan(3);
      }
    }
  });

  it('a decent player lasts a while but not forever', () => {
    const times = seeds.map((sd) => {
      const s = run(sd, 0.6);
      return tired(s) ? s.tiredTick / TICK_HZ : MAX_TICKS / TICK_HZ;
    });
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log('bot (0.6) survival s:', times.map((t) => t.toFixed(0)).join(', '), 'avg', avg.toFixed(0));
    expect(avg).toBeGreaterThan(25);
  });

  it('a jump keeps you over a fence, a slide under a bar', () => {
    const course = [
      { id: 0, d: 10, kind: 'low' as const, lane: 1, len: 0.6 },
      { id: 1, d: 30, kind: 'high' as const, lane: 1, len: 0.8 },
    ];
    const s = initState();
    while (s.dist < 40) {
      const keys: ('J' | 'S')[] = [];
      if (Math.abs(10 - s.dist - 2.5) < 0.1) keys.push('J');
      if (Math.abs(30 - s.dist - 1.5) < 0.1) keys.push('S');
      step(s, keys, course);
    }
    expect(s.stumbles).toBe(0);
  });

  it('three bumps use up all the energy and the hamster stops', () => {
    const course = [
      { id: 0, d: 20, kind: 'low' as const, lane: 1, len: 0.6 },
      { id: 1, d: 40, kind: 'high' as const, lane: 1, len: 0.8 },
      { id: 2, d: 60, kind: 'block' as const, lane: 1, len: 2.4 },
    ];
    const s = initState();
    while (!tired(s) && s.dist < 50) step(s, [], course);
    expect(s.energy).toBe(ENERGY_MAX - 2);
    expect(tired(s)).toBe(false);
    while (!tired(s) && s.dist < 80) step(s, [], course);
    expect(s.stumbles).toBe(3);
    expect(tired(s)).toBe(true);
    const at = s.dist;
    step(s, [], course);
    expect(s.dist).toBe(at);
  });

  it('snacks give a bolt back, never above the max', () => {
    const course = Array.from({ length: SNACKS_PER_BOLT * 2 }, (_, i) => ({ id: i + 1, d: 30 + i * 2.4, kind: 'worm' as const, lane: 1, len: 0.6 }));
    course.unshift({ id: 0, d: 10, kind: 'low' as const, lane: 1, len: 0.6 } as never);
    const s = initState();
    while (s.dist < 30 + SNACKS_PER_BOLT * 2 * 2.4 + 5) step(s, [], course);
    expect(s.worms).toBe(SNACKS_PER_BOLT * 2);
    expect(s.energy).toBe(ENERGY_MAX);
  });

  it('cars drive towards you', () => {
    const o = { id: 0, d: 200, kind: 'car' as const, lane: 0, len: 2.2 };
    expect(carD(o, 100)).toBe(200);
    expect(carD(o, 180)).toBeLessThan(200);
  });

  it('course hash is stable', async () => {
    const c = generateCourse(seeds[0], true);
    expect(await courseHash(c)).toBe(await courseHash(generateCourse(seeds[0], true)));
    expect(c.length).toBeGreaterThan(150);
  });

  it('counts leading zero bits', () => {
    expect(leadingZeroBits('00ff')).toBe(8);
    expect(leadingZeroBits('1fff')).toBe(3);
  });
});

describe('ramp rules (wide version)', () => {
  it('keeps speeding up with no ceiling, so a decent bot always tires out', async () => {
    const { RAMP } = await import('../src/shared/sim');
    expect(RAMP.speed(0)).toBe(8);
    expect(RAMP.speed(60 * 300)).toBeGreaterThan(RAMP.speed(60 * 180));
    const times = seeds.slice(0, 8).map((sd) => {
      const course = generateCourse(sd, false, 20000);
      const s = initState();
      const bot = new Bot(sd.slice(0, 32), 0.6);
      while (!tired(s) && s.tick < 60 * 600) step(s, bot.keys(s, course), course, RAMP);
      return s.tick / TICK_HZ;
    });
    console.log('bot (0.6) on ramp, s:', times.map((t) => t.toFixed(0)).join(', '));
    expect(Math.max(...times)).toBeLessThan(600);
  });
});
