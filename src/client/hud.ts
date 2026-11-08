import { FINISH_M } from '../shared/constants';
import { catWarning, catWatching, type PState } from '../shared/sim';
import type { Viewport } from './scene';
import { spriteSvg } from './pixel';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function meter(cls: string, label: string) {
  const root = el('div', `meter ${cls}`);
  const lbl = el('div', 'lbl');
  const name = el('span', '', label);
  const val = el('span', '', '');
  lbl.append(name, val);
  const bar = el('div', 'bar');
  const fill = el('div', 'fill');
  bar.append(fill);
  root.append(lbl, bar);
  return { root, val, fill, bar };
}

interface Counters {
  crashes: number;
  overheats: number;
  scares: number;
  seeds: number;
  chilis: number;
  blocks: number;
  finished: boolean;
}

const counters = (s: PState): Counters => ({
  crashes: s.crashes, overheats: s.overheats, scares: s.scares, seeds: s.seeds, chilis: s.chilis, blocks: s.blocks,
  finished: s.finishTick >= 0,
});

class SideHud {
  readonly root = el('div', 'side');
  readonly fx = el('div', 'side-fx');
  private name = el('span');
  private dist = meter('dist', 'DISTANCE');
  private heat = meter('heat', 'HEAT');
  private rhythm = meter('rhythm', 'RHYTHM');
  private cat = el('div', 'catbar');
  private last: Counters | null = null;

  constructor(readonly mine: boolean) {
    const tag = el('div', 'tag');
    const who = el('span', mine ? 'who' : 'who rival', mine ? 'YOU' : 'RIVAL');
    tag.append(this.name, who);
    this.root.append(tag, this.dist.root, this.heat.root);
    if (mine) {
      const zone = el('div', 'zone');
      this.rhythm.bar.append(zone);
      this.root.append(this.rhythm.root);
    }
    this.cat.hidden = true;
    this.fx.append(this.cat);
    this.fx.style.position = 'absolute';
  }

  place(v: Viewport, alignRight: boolean) {
    this.root.style.left = alignRight ? '' : `${v.x}px`;
    this.root.style.right = alignRight ? `${(this.root.parentElement?.clientWidth ?? 0) - v.x - v.w}px` : '';
    this.root.style.top = `${v.y + 44}px`;
    this.root.style.alignItems = alignRight ? 'flex-end' : 'flex-start';
    Object.assign(this.fx.style, { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` });
  }

  update(name: string, s: PState, cadence: number) {
    if (this.name.textContent !== name) this.name.textContent = name;
    const d = Math.min(FINISH_M, s.dist);
    this.dist.val.textContent = `${d.toFixed(0)} / ${FINISH_M} M · ${s.speed.toFixed(1)} M/S`;
    this.dist.fill.style.width = `calc(${(d / FINISH_M) * 100}% - 4px)`;
    const heat = Math.min(1, s.heat);
    this.heat.val.textContent = s.stunKind === 2 && s.stun > 0 ? 'OVERHEATED' : `${Math.round(heat * 100)}%`;
    this.heat.fill.style.width = `calc(${heat * 100}% - 4px)`;
    this.heat.root.classList.toggle('warn', heat > 0.7);
    if (this.mine) {
      const c = Math.min(16, cadence);
      this.rhythm.val.textContent = c > 0 ? `${c.toFixed(1)}/S` : '–';
      this.rhythm.fill.style.width = `calc(${(c / 16) * 100}% - 4px)`;
      this.rhythm.fill.className = `fill ${c > 11 ? 'fast' : c < 6 ? 'slow' : ''}`;
    }

    // Cat warning
    if (catWatching(s)) {
      this.cat.hidden = false;
      this.cat.className = 'catbar watch';
      this.setCat(this.mine ? "FREEZE! IT'S LOOKING" : 'THE CAT IS LOOKING');
    } else if (catWarning(s)) {
      this.cat.hidden = false;
      this.cat.className = 'catbar';
      this.setCat('THE CAT IS COMING…');
    } else this.cat.hidden = true;

    // Pop-ups for things that just happened.
    const now = counters(s);
    const was = this.last;
    this.last = now;
    if (!was) return;
    if (now.crashes > was.crashes) this.toast('BONK!', '#ff4d5a');
    if (now.overheats > was.overheats) this.toast('TOO HOT!', '#ff4d5a');
    if (now.scares > was.scares) this.toast('EEK!', '#ffe14d');
    if (now.seeds > was.seeds) this.toast('+SEED', '#ffcf4a');
    if (now.chilis > was.chilis) this.toast('SPICY!', '#ff4d5a');
    if (now.blocks > was.blocks) this.toast('BLOCK DROP!', '#4ee6ff');
    if (now.finished && !was.finished) this.toast('FINISH!', '#fff6e0');
  }

  private catText = '';
  private setCat(text: string) {
    if (text === this.catText) return;
    this.catText = text;
    this.cat.innerHTML = spriteSvg('eye', 3);
    this.cat.append(document.createTextNode(text));
  }

  toast(text: string, color: string) {
    const t = el('div', 'toast', text);
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
  private pinMe = el('div', 'pin me', 'U');
  private pinOp = el('div', 'pin op', 'R');
  private gap = el('div', 'gap');
  private divider = el('div', 'divider');

  constructor(private root: HTMLElement) {
    const flag = el('div', 'flag', 'FIN');
    this.track.append(flag, this.pinOp, this.pinMe);
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

  update(names: [string, string], me: PState, op: PState, cadence: number) {
    this.me.update(names[0], me, cadence);
    this.op.update(names[1], op, 0);
    const pos = (s: PState) => `calc(${(Math.min(FINISH_M, s.dist) / FINISH_M) * 92 + 4}%)`;
    this.pinMe.style.left = pos(me);
    this.pinOp.style.left = pos(op);
    const g = me.dist - op.dist;
    this.gap.textContent = Math.abs(g) < 1 ? 'NECK AND NECK' : g > 0 ? `YOU LEAD BY ${g.toFixed(0)} M` : `${(-g).toFixed(0)} M BEHIND`;
    this.gap.style.color = Math.abs(g) < 1 ? '#fff6e0' : g > 0 ? '#ffcf4a' : '#4ee6ff';
  }

  reset() {
    this.me.reset();
    this.op.reset();
  }
}
