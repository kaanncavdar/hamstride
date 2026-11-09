import { carD, type Obs } from '../shared/course';
import { laneX, tired, type PState } from '../shared/sim';

/**
 * First-time tips that appear right when they're needed and stop once you've handled each thing
 * twice. The race never pauses.
 */
type Lesson = 'move' | 'block' | 'low' | 'high' | 'car' | 'ride' | 'energy';
const NEED = 2;
const BLANK: Record<Lesson, number> = { move: 0, block: 0, low: 0, high: 0, car: 0, ride: 0, energy: 0 };

function load(): Record<Lesson, number> {
  try {
    return { ...BLANK, ...JSON.parse(localStorage.getItem('wd.coach3') ?? '{}') };
  } catch {
    return { ...BLANK };
  }
}

export class Coach {
  private learned = load();
  private passed = new Set<number>();
  private lastStumbles = 0;
  private bumpTick = -999;

  constructor(private el: HTMLElement) {}

  static reset() {
    try {
      localStorage.removeItem('wd.coach3');
    } catch {
      /* ignore */
    }
  }

  private save() {
    try {
      localStorage.setItem('wd.coach3', JSON.stringify(this.learned));
    } catch {
      /* ignore */
    }
  }

  newRace() {
    this.passed.clear();
    this.lastStumbles = 0;
    this.hide();
  }

  endRace() {
    if (this.learned.move < NEED) this.learned.move++;
    this.save();
    this.hide();
  }

  private hide() {
    this.el.hidden = true;
    this.el.dataset.key = '';
  }

  private show(key: string, keys: string[], text: string) {
    if (this.el.dataset.key === key) return;
    this.el.dataset.key = key;
    this.el.textContent = '';
    for (const k of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      this.el.append(kbd);
    }
    const span = document.createElement('span');
    span.textContent = text;
    this.el.append(span);
    this.el.hidden = false;
  }

  update(s: PState, course: readonly Obs[], countdownMs: number) {
    // Grade what you just passed: cleanly handled things count towards learning them.
    const clean = s.stumbles === this.lastStumbles;
    for (const o of course) {
      if (o.d > s.dist) break;
      if (this.passed.has(o.id)) continue;
      this.passed.add(o.id);
      const l: Lesson | null = o.kind === 'block' || o.kind === 'low' || o.kind === 'high' || o.kind === 'car' ? o.kind : o.kind === 'wheel' || o.kind === 'ball' ? 'ride' : null;
      if (l && clean && this.learned[l] < NEED && (l === 'ride' ? s.ride > 0 : true)) this.learned[l]++;
    }
    if (s.stumbles > this.lastStumbles && this.learned.energy < NEED) this.learned.energy++;
    const stumbledNow = s.stumbles > this.lastStumbles;
    if (stumbledNow) this.bumpTick = s.tick;
    this.lastStumbles = s.stumbles;

    if (countdownMs > 0) {
      if (this.learned.move < NEED) return this.show('start', ['←', '→', '↑', '↓'], 'Run! Change lanes, jump logs, slide under bridges. Every bump costs a ⚡.');
      return this.hide();
    }
    if (tired(s)) return this.hide();
    if (stumbledNow && this.learned.energy <= NEED)
      return this.show(`e${s.stumbles}`, [], s.energy === 1 ? 'Last ⚡ left! One more bump and your hamster is too tired to run.' : 'Bump! That cost one ⚡. Snacks slowly win it back.');
    if (this.el.dataset.key?.startsWith('e') && s.tick - this.bumpTick < 150) return;

    const lane = Math.round(laneX(s));
    const reach = Math.max(18, s.speed * 1.8);
    for (const o of course) {
      const ahead = (o.kind === 'car' ? carD(o, s.dist) : o.d) - s.dist;
      if (ahead <= 0) continue;
      if (ahead > reach) break;
      const mine = o.lane === lane;
      const side = lane === 0 ? ['→'] : lane === 2 ? ['←'] : ['←', '→'];
      if (o.kind === 'block' && mine && this.learned.block < NEED) return this.show(`b${o.id}`, side, 'A hideout in your lane. Too tall to jump: change lanes.');
      if (o.kind === 'car' && mine && this.learned.car < NEED) return this.show(`c${o.id}`, side, 'A chew ball is rolling at you. Get out of its lane!');
      if (o.kind === 'low' && mine && this.learned.low < NEED) return this.show(`l${o.id}`, ['↑'], 'A cork log: jump it.');
      if (o.kind === 'high' && mine && this.learned.high < NEED) return this.show(`h${o.id}`, ['↓'], 'A wooden bridge at head height: slide under it.');
      if ((o.kind === 'wheel' || o.kind === 'ball') && this.learned.ride < NEED)
        return this.show(
          `r${o.id}`,
          o.lane < lane ? ['←'] : o.lane > lane ? ['→'] : [],
          o.kind === 'wheel' ? 'A mini wheel! Ride it: you go faster and it takes one bump for you.' : 'A hamster ball! You roll over logs and bridges, and it takes one bump for you.',
        );
    }
    this.hide();
  }
}
