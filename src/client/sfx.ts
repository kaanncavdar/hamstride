/**
 * Sound effects from real recorded samples (see public/sfx/CREDITS.txt: CC0 retro sound pack by
 * Juhani Junkala). Loaded once, after the first click or key press, and played through WebAudio.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const buffers = new Map<string, AudioBuffer>();

const FILES = [
  'step-l', 'step-r', 'jump', 'land', 'bonk', 'overheat', 'food', 'pad', 'fall', 'block',
  'cat-warn', 'cat-look', 'scared', 'beep', 'go', 'win', 'lose',
] as const;
type Name = (typeof FILES)[number];

/** Per-sound volume, so the pack's different levels sit together. */
const GAIN: Record<Name, number> = {
  'step-l': 0.35, 'step-r': 0.35, jump: 0.45, land: 0.9, bonk: 0.8, overheat: 0.7, food: 0.7, pad: 0.6,
  fall: 0.6, block: 0.6, 'cat-warn': 0.45, 'cat-look': 0.6, scared: 0.8, beep: 0.8, go: 0.6, win: 0.8, lose: 0.6,
};

try {
  muted = localStorage.getItem('wd.muted') === '1';
} catch {
  /* storage blocked */
}

async function loadAll() {
  if (!ctx) return;
  await Promise.all(
    FILES.map(async (n) => {
      try {
        const res = await fetch(`/sfx/${n}.wav`);
        if (!res.ok) return;
        buffers.set(n, await ctx!.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* a missing sound just stays silent */
      }
    }),
  );
}

export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
    loadAll();
  } catch {
    ctx = null;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.8;
  try {
    localStorage.setItem('wd.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Plays a sample. `rate` shifts the pitch; a little random wobble keeps repeats from sounding robotic. */
function play(n: Name, rate = 1, wobble = 0.04, pan = 0) {
  if (!ctx || !master || muted) return;
  const buf = buffers.get(n);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * wobble);
  const g = ctx.createGain();
  g.gain.value = GAIN[n];
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(g).connect(p).connect(master);
  src.start();
}

export const sfx = {
  /** A footstep. It gets a little higher as you speed up, so you can hear yourself go faster. */
  tap(speed: number, left: boolean) {
    play(left ? 'step-l' : 'step-r', 0.85 + Math.min(speed, 20) * 0.025, 0.05, left ? -0.25 : 0.25);
  },
  jump: () => play('jump'),
  slide: () => play('land', 0.7, 0.05),
  move: () => play('step-l', 1.4, 0.05),
  land: () => play('land', 1, 0.08),
  bonk: () => play('bonk', 0.9),
  overheat: () => play('overheat', 1, 0),
  hot: () => {},
  seed: () => play('food', 1, 0.06),
  fall: () => play('fall', 1, 0),
  pad: () => play('pad', 1, 0.03),
  catWarn: () => play('cat-warn', 1, 0),
  catLook: () => play('cat-look', 0.8, 0),
  scared: () => play('scared', 1.1, 0.05),
  block: () => play('block', 1, 0),
  beep: (go = false) => play(go ? 'go' : 'beep', 1, 0),
  finish: (win: boolean) => play(win ? 'win' : 'lose', 1, 0),
};
