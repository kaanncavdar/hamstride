import { BALL_TICKS, ENERGY_MAX, tired, RIDE_BALL, RIDE_WHEEL, WHEEL_TICKS, type PState } from '../shared/sim';
import { TICK_HZ } from '../shared/constants';
import type { Viewport } from './scene';
import { RULES } from './variant';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function meter(cls: string, label: string) {
  const root = el('div', `meter ${cls}`);
  const lbl = el('div', 'lbl');
  const val = el('span');
  lbl.append(el('span', '', label), val);
  const bar = el('div', 'bar');
  const fill = el('div', 'fill');
  bar.append(fill);
  root.append(lbl, bar);
  return { root, val, fill, label: lbl.firstChild as HTMLElement };
}

const counters = (s: PState) => ({ stumbles: s.stumbles, breaks: s.breaks, worms: s.worms, rides: s.rides, blocks: s.blocks, tired: tired(s), ride: s.ride, energy: s.energy });

const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1.5 3.5 13.6h6.9l-1.6 8.9 10.7-12.6h-7z"/></svg>';

/** Three lightning bolts: your energy. Each bump empties one. */
function energyBar() {
  const root = el('div', 'energy');
  const bolts: HTMLElement[] = [];
  for (let i = 0; i < ENERGY_MAX; i++) {
    const b = el('i', 'bolt on');
    b.innerHTML = BOLT;
    root.append(b);
    bolts.push(b);
  }
  const snack = el('div', 'snack');
  const snackFill = el('div');
  snack.append(snackFill);
  root.append(snack);
  return { root, bolts, snackFill };
}

class SideHud {
  readonly root = el('div', 'side');
  readonly fx = el('div', 'side-fx');
  private name = el('span');
  private dist = meter('dist', 'DISTANCE');
  private energy = energyBar();
  private ride = meter('ride', 'RIDE');
  private vignette = el('div', 'vignette');
  private osd = el('div', 'osd');
  private osdText = el('span');
  private last: ReturnType<typeof counters> | null = null;

  constructor(readonly mine: boolean) {
    const tag = el('div', 'tag');
    tag.append(this.name, el('span', mine ? 'who' : 'who rival', mine ? 'YOU' : 'RIVAL'));
    this.root.append(tag, this.energy.root, this.dist.root, this.ride.root);
    this.osd.append(el('i', 'rec'), this.osdText);
    this.fx.append(this.vignette, this.osd);
    this.fx.style.position = 'absolute';
  }

  place(v: Viewport, alignRight: boolean) {
    this.root.style.left = alignRight ? '' : `${v.x}px`;
    this.root.style.right = alignRight ? `${(this.root.parentElement?.clientWidth ?? 0) - v.x - v.w}px` : '';
    this.root.style.top = `${v.y + 44}px`;
    this.root.style.alignItems = alignRight ? 'flex-end' : 'flex-start';
    Object.assign(this.fx.style, { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` });
  }

  update(name: string, s: PState) {
    if (this.name.textContent !== name) this.name.textContent = name;
    this.dist.val.textContent = `${s.dist.toFixed(0)} m · ${s.speed.toFixed(1)} m/s`;
    this.dist.fill.style.width = '0';

    // Energy: one bolt per bump you can still take.
    this.energy.bolts.forEach((b, i) => b.classList.toggle('on', i < s.energy));
    this.energy.root.classList.toggle('low', s.energy === 1);
    this.energy.snackFill.style.width = `${(s.snack / RULES.snacksPerBolt) * 100}%`;
    this.vignette.style.opacity = String(tired(s) ? 0.55 : s.energy === 1 ? 0.35 : 0);

    this.ride.root.hidden = s.ride === 0;
    if (s.ride) {
      const total = s.ride === RIDE_WHEEL ? WHEEL_TICKS : BALL_TICKS;
      this.ride.label.textContent = s.ride === RIDE_WHEEL ? 'WHEEL' : 'BALL';
      this.ride.val.textContent = `${Math.ceil(s.rideT / TICK_HZ)}s`;
      this.ride.fill.style.width = `${(s.rideT / total) * 100}%`;
    }

    const now = counters(s);
    const was = this.last;
    this.last = now;
    if (!was) return;
    if (now.tired && !was.tired) {
      this.toast('TOO TIRED', '#ffb347');
      this.flash();
    } else if (now.stumbles > was.stumbles) {
      this.toast('BUMP!', '#ffb347');
      this.flash();
      this.loseBolt(now.energy);
    }
    if (now.energy > was.energy && !now.tired) this.toast('+1 ENERGY', '#ffd84d');
    // Ramp rules: the hamster tires on its own as the run goes on.
    if (now.energy < was.energy && now.stumbles === was.stumbles && !now.tired) {
      this.toast('GETTING TIRED', '#ffb347', 'small');
      this.loseBolt(now.energy);
    }
    if (now.breaks > was.breaks) this.toast(was.ride === RIDE_BALL ? 'BALL POPPED!' : 'WHEEL BROKE!', '#7fd4ff');
    if (now.rides > was.rides) this.toast(now.ride === RIDE_WHEEL ? 'WHEEL!' : 'HAMSTER BALL!', '#7fd4ff');
    if (now.blocks > was.blocks) this.toast('BLOCK DROP!', '#4ee6ff');
    if (now.worms > was.worms && now.energy === was.energy) this.toast('+SNACK', '#b8f28a', 'small');
  }

  /** The on-screen camera label, like the real stream's: CAM, a recording dot, the clock, IR at night. */
  camera(night: number, tick: number) {
    const ir = night > 0.5;
    const t = 21 * 3600 + 14 * 60 + Math.floor(tick / 60);
    const clock = `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const text = `${this.mine ? 'CAM 1' : 'CAM 2'} ${ir ? 'IR' : 'DAY'} · ${clock}`;
    if (this.osdText.textContent !== text) this.osdText.textContent = text;
    this.osd.classList.toggle('ir', ir);
  }

  private loseBolt(index: number) {
    const b = this.energy.bolts[index];
    if (!b) return;
    b.classList.remove('lost');
    void b.offsetWidth;
    b.classList.add('lost');
  }

  private flash() {
    const f = el('div', 'flash');
    this.fx.append(f);
    setTimeout(() => f.remove(), 260);
  }

  toast(text: string, color: string, size = '') {
    const t = el('div', `toast ${size}`, text);
    t.style.color = color;
    this.fx.append(t);
    setTimeout(() => t.remove(), 950);
  }

  reset() {
    this.last = null;
    this.fx.querySelectorAll('.toast').forEach((t) => t.remove());
  }
}

export class Hud {
  private me = new SideHud(true);
  private op = new SideHud(false);
  private track = el('div', 'track');
  private gap = el('div', 'gap');
  private divider = el('div', 'divider');

  constructor(root: HTMLElement) {
    root.append(this.divider, this.me.fx, this.op.fx, this.me.root, this.op.root, this.track, this.gap);
  }

  layout(halves: [Viewport, Viewport], stacked: boolean) {
    this.me.place(halves[0], false);
    this.op.place(halves[1], !stacked);
    if (stacked) {
      Object.assign(this.divider.style, { left: '0', right: '0', top: `${halves[0].y - 2}px`, height: '4px', width: '', bottom: '' });
      this.track.style.top = `${halves[0].y - 17}px`;
      this.gap.style.top = `${halves[0].y + 22}px`;
    } else {
      Object.assign(this.divider.style, { top: '0', bottom: '0', left: `${halves[1].x - 2}px`, width: '4px', height: '', right: '' });
      this.track.style.top = '10px';
      this.gap.style.top = '48px';
    }
  }

  update(names: [string, string], me: PState, op: PState, nights: [number, number] = [0, 0]) {
    this.me.update(names[0], me);
    this.op.update(names[1], op);
    this.me.camera(nights[0], me.tick);
    this.op.camera(nights[1], op.tick);
    const t = Math.max(0, Math.min(me.tick, tired(me) ? me.tiredTick : me.tick)) / TICK_HZ;
    this.track.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    let text: string;
    let color: string;
    if (tired(me) && !tired(op)) [text, color] = ['YOUR HAMSTER IS RESTING', '#ffb347'];
    else if (tired(op) && !tired(me)) [text, color] = ['RIVAL IS TOO TIRED. YOU WIN!', '#4fd18b'];
    else if (me.energy !== op.energy) {
      const d = me.energy - op.energy;
      [text, color] = d > 0 ? [`+${d} ENERGY AHEAD`, '#ffd84d'] : [`${-d} ENERGY BEHIND`, '#8fd8ff'];
    } else {
      const g = me.dist - op.dist;
      text = Math.abs(g) < 1 ? 'NECK AND NECK' : g > 0 ? `YOU LEAD BY ${g.toFixed(0)} M` : `${(-g).toFixed(0)} M BEHIND`;
      color = Math.abs(g) < 1 ? '#fff6e0' : g > 0 ? '#ffcf4a' : '#8fd8ff';
    }
    this.gap.textContent = text;
    this.gap.style.color = color;
  }

  reset() {
    this.me.reset();
    this.op.reset();
  }
}
