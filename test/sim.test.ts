import { describe, expect, it } from 'vitest';
import { generateCourse, courseHash } from '../src/shared/course';
import { initState, step, finishTime, type PState } from '../src/shared/sim';
import { Bot } from '../src/shared/bot';
import { MAX_TICKS, TICK_HZ } from '../src/shared/constants';
import { humanReport } from '../src/shared/stats';
import { leadingZeroBits } from '../src/shared/hash';

function race(seed: string, skill: number): PState {
  const course = generateCourse(seed, false);
  const s = initState();
  const bot = new Bot(seed.slice(0, 32), skill);
  while (s.finishTick < 0 && s.tick < MAX_TICKS) step(s, bot.keys(s, course), course);
  return s;
}

const seeds = Array.from({ length: 12 }, (_, i) => (i * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(8));

describe('simulation', () => {
  it('is deterministic', () => {
    const a = race(seeds[3], 0.7);
    const b = race(seeds[3], 0.7);
    expect(a).toEqual(b);
  });

  it('a decent player finishes 500 m in a sensible time', () => {
    const times = seeds.map((sd) => finishTime(race(sd, 0.75)) / TICK_HZ);
    for (const t of times) {
      expect(t).toBeGreaterThan(45);
      expect(t).toBeLessThan(120);
    }
    console.log('bot finish times (s):', times.map((t) => t.toFixed(1)).join(', '));
  });

  it('a single-key autoclicker barely moves', () => {
    const course = generateCourse(seeds[1], false);
    const s = initState();
    for (let i = 0; i < 60 * TICK_HZ; i++) step(s, i % 2 === 0 ? ['L'] : [], course);
    expect(s.dist).toBeLessThan(60);
  });

  it('a perfect two-key autoclicker overheats or trips', () => {
    const course = generateCourse(seeds[1], false);
    const s = initState();
    for (let i = 0; i < 30 * TICK_HZ; i++) step(s, i % 2 === 0 ? [i % 4 === 0 ? 'L' : 'R'] : [], course);
    expect(s.overheats).toBeGreaterThan(3);
  });

  it('flags a metronome-steady rhythm', () => {
    const course = generateCourse(seeds[2], false);
    const s = initState();
    let f = 0;
    for (let i = 0; i < 40 * TICK_HZ; i++) step(s, i % 7 === 0 ? [f++ % 2 ? 'R' : 'L'] : [], course);
    expect(humanReport(s).verdict).toBe('steady');
  });

  it('course hash is stable', async () => {
    const c = generateCourse(seeds[0], true);
    expect(await courseHash(c)).toBe(await courseHash(generateCourse(seeds[0], true)));
    expect(c.length).toBeGreaterThan(20);
  });

  it('counts leading zero bits', () => {
    expect(leadingZeroBits('00ff')).toBe(8);
    expect(leadingZeroBits('1fff')).toBe(3);
    expect(leadingZeroBits('0800')).toBe(4);
  });
});
