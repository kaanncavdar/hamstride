import type { Obs } from './course';
import { AIR_TICKS, CAT_TELE, catWarning, catWatching, curLane, type Key, type PState } from './sim';
import { DT } from './constants';
import { Rng } from './rng';

/** A practice opponent. It plays like a decent human: a wobbly rhythm, late reactions, the odd mistake. */
export class Bot {
  private rng: Rng;
  private nextFoot = 0;
  private foot: Key = 'L';
  private plans = new Map<number, { act: boolean; at: number }>();
  private crashes = 0;

  constructor(seedHex: string, private skill = 0.75) {
    this.rng = new Rng(seedHex);
  }

  keys(s: PState, course: readonly Obs[]): Key[] {
    const out: Key[] = [];
    const t = s.tick;
    const r = this.rng;

    // After a crash, a human tries again properly: replan everything just ahead.
    if (s.crashes > this.crashes) {
      this.crashes = s.crashes;
      for (const o of course) if (o.d > s.dist && o.d - s.dist < 3) this.plans.set(o.id, { act: true, at: 0.4 });
    }

    // Cat: stop running during the warning, sometimes a bit too late.
    const catPlan = s.catId >= 0 ? this.plan(s.catId, () => (r.chance(this.skill) ? CAT_TELE - r.int(5, 20) : CAT_TELE + r.int(1, 8))) : null;
    const frozen = catPlan !== null && (catWatching(s) || (catWarning(s) && s.catT >= catPlan.at));

    // Look ahead and decide on lanes and jumps.
    const lane = curLane(s);
    for (const o of course) {
      const ahead = o.d - s.dist;
      if (ahead <= 0) continue;
      if (ahead > 14) break;
      if (o.kind === 'block' && o.lane === lane && ahead < 9) {
        const p = this.plan(o.id, () => (r.chance(0.55 + this.skill * 0.4) ? 1 : 0));
        if (p.act) out.push(lane === 0 ? 'U' : 'D');
      } else if (o.kind === 'seed' && o.lane !== lane && ahead < 8) {
        const blocked = course.some((x) => x.d === o.d && x.kind === 'block' && x.lane === o.lane);
        const p = this.plan(o.id, () => (r.chance(this.skill * 0.8) ? 1 : 0));
        if (p.act && !blocked) out.push(o.lane === 1 ? 'U' : 'D');
      } else if (o.kind === 'hurdle' || (o.kind === 'chili' && o.lane === lane)) {
        const hop = s.speed * AIR_TICKS * DT;
        const p = this.plan(o.id, () => (r.chance(0.6 + this.skill * 0.35) ? 1 : 0), () => r.range(0.25, 0.55));
        if (p.act && s.air === 0 && ahead < hop * p.at && ahead > 0.3) out.push('J');
      }
    }

    if (!frozen && s.stun === 0 && s.air === 0 && t >= this.nextFoot) {
      out.push(this.foot);
      this.foot = this.foot === 'L' ? 'R' : 'L';
      const base = 7.4 - this.skill * 1.4;
      this.nextFoot = t + Math.max(5, Math.round(base + r.range(-1.2, 1.4)));
    }
    return out;
  }

  private plan(id: number, act: () => number, at?: () => number): { act: boolean; at: number } {
    let p = this.plans.get(id);
    if (!p) {
      const a = act();
      p = { act: a > 0, at: at ? at() : a };
      this.plans.set(id, p);
    }
    return p;
  }
}
