import { carD, type Obs } from './course';
import { JUMP_TICKS, laneX, type Key, type PState } from './sim';
import { DT } from './constants';
import { Rng } from './rng';

/**
 * A practice opponent that plays like a decent human: it looks ahead about a second, reacts a bit
 * late, sometimes misjudges, and likes treats.
 */
export class Bot {
  private rng: Rng;
  private plans = new Map<number, { see: number; ok: boolean }>();
  /** A whole row comes into view at once, like it would for a person. */
  private rows = new Map<number, number>();
  private cool = 0;

  constructor(seedHex: string, private skill = 0.75) {
    this.rng = new Rng(seedHex);
  }

  private plan(o: Obs) {
    let p = this.plans.get(o.id);
    if (!p) {
      // How far ahead (seconds) it notices this row, and whether it handles this obstacle right.
      const row = Math.round(o.d / 4);
      let see = this.rows.get(row);
      if (see === undefined) {
        see = this.rng.range(0.55, 1.1) + this.skill * 0.5;
        this.rows.set(row, see);
      }
      p = { see, ok: this.rng.chance(0.86 + this.skill * 0.13) };
      this.plans.set(o.id, p);
    }
    return p;
  }

  keys(s: PState, course: readonly Obs[]): Key[] {
    const out: Key[] = [];
    const v = Math.max(1, s.speed);
    const horizon = v * 2.2;
    const front = (o: Obs) => (o.kind === 'car' ? carD(o, s.dist) : o.d);

    // Score each lane by how far you can run in it before something tall is in the way.
    const score = [0, 0, 0].map((_, l) => {
      // A lane with nothing tall ahead always beats one with a box in it, however far the box is.
      let sc = horizon * 3;
      let tall = Infinity;
      for (const o of course) {
        const a = front(o) - s.dist;
        if (a + o.len < -0.5) continue;
        if (a > horizon) break;
        if (o.lane !== l) continue;
        const p = this.plan(o);
        if (a > v * p.see) continue; // not noticed yet
        if (o.kind === 'block' || o.kind === 'car') tall = Math.min(tall, a);
        else if (o.kind === 'low' || o.kind === 'high') sc -= 1;
        else if (o.kind === 'worm' || o.kind === 'wheel' || o.kind === 'ball') sc += 2;
      }
      return tall < Infinity ? tall : sc;
    });
    let best = s.lane;
    for (const l of [0, 1, 2]) if (score[l] > score[best] + 0.5) best = l;
    if (best !== s.lane && this.cool <= 0) {
      out.push(best < s.lane ? 'L' : 'R');
      this.cool = 7;
    }
    this.cool--;

    // Jump fences and slide under bars in the lane we're in.
    for (const o of course) {
      const a = o.d - s.dist;
      if (a < 0) continue;
      if (a > v * 1.2) break;
      if (Math.abs(laneX(s) - o.lane) > 0.6) continue;
      const p = this.plan(o);
      if (!p.ok) continue;
      if (o.kind === 'low' && s.air === 0 && a < v * JUMP_TICKS * DT * 0.45 && a > 0.4) out.push('J');
      if (o.kind === 'high' && s.slide === 0 && a < v * 0.35) out.push('S');
    }
    return out;
  }
}
