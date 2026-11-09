import * as THREE from 'three';

/**
 * Painted textures, made once at start-up on small canvases: wood, cork, seagrass, the wheel's
 * running surface, paper bedding, soft particles. Smooth and filtered, not pixel art.
 */

function canvas(w: number, h: number) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return { cv, g: cv.getContext('2d')! };
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finish(cv: HTMLCanvasElement, repeat = false, srgb = true) {
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const cache = new Map<string, THREE.Texture>();
function once(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

/** Light birch wood with soft grain, for the hideout and the bridge. */
export const woodTex = () =>
  once('wood', () => {
    const { cv, g } = canvas(256, 256);
    const r = seeded(7);
    g.fillStyle = '#d9b07a';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 70; i++) {
      const y = r() * 256;
      g.strokeStyle = `rgba(${120 + r() * 40},${70 + r() * 30},${30 + r() * 20},${0.08 + r() * 0.14})`;
      g.lineWidth = 1 + r() * 3;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 3 + (r() - 0.5) * 2);
      g.stroke();
    }
    return finish(cv, true);
  });

/** Cork bark: warm brown with dark pits. */
export const corkTex = () =>
  once('cork', () => {
    const { cv, g } = canvas(256, 256);
    const r = seeded(11);
    g.fillStyle = '#9a6a3c';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const x = r() * 256;
      const y = r() * 256;
      const s = 1 + r() * 5;
      g.fillStyle = r() < 0.5 ? `rgba(60,34,16,${0.2 + r() * 0.4})` : `rgba(196,150,100,${0.15 + r() * 0.3})`;
      g.beginPath();
      g.ellipse(x, y, s * 1.6, s, 0, 0, Math.PI * 2);
      g.fill();
    }
    return finish(cv, true);
  });

/** Woven seagrass for the rolling chew ball. */
export const weaveTex = () =>
  once('weave', () => {
    const { cv, g } = canvas(256, 256);
    g.fillStyle = '#b89a5a';
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 16)
      for (let x = 0; x < 256; x += 16) {
        const along = ((x + y) / 16) % 2 === 0;
        const grd = along ? g.createLinearGradient(x, y, x, y + 16) : g.createLinearGradient(x, y, x + 16, y);
        grd.addColorStop(0, '#8d7238');
        grd.addColorStop(0.5, '#d8bf7c');
        grd.addColorStop(1, '#8d7238');
        g.fillStyle = grd;
        g.fillRect(x + 1, y + 1, 14, 14);
      }
    return finish(cv, true);
  });

/**
 * The running surface on the inside of the big wheel: smooth plastic with grip ribs and two soft
 * lane lines. u runs around the wheel, v across it.
 */
export const treadTex = () =>
  once('tread', () => {
    const { cv, g } = canvas(512, 256);
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#c9d2dc');
    grd.addColorStop(0.5, '#e4e9ef');
    grd.addColorStop(1, '#c9d2dc');
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 256);
    // Grip ribs across the track.
    for (let x = 0; x < 512; x += 32) {
      g.fillStyle = 'rgba(70,86,104,0.16)';
      g.fillRect(x, 0, 6, 256);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(x + 6, 0, 2, 256);
    }
    // Lane lines (the track is 3 lanes wide, with a lip at each edge).
    for (const v of [256 * 0.37, 256 * 0.63]) {
      g.fillStyle = 'rgba(255,190,90,0.75)';
      for (let x = 0; x < 512; x += 64) g.fillRect(x + 8, v - 3, 40, 6);
    }
    for (const v of [6, 250]) {
      g.fillStyle = 'rgba(60,70,90,0.35)';
      g.fillRect(0, v - 6, 512, 12);
    }
    return finish(cv, true);
  });

/** The back of the wheel: a disc with moulded ribs and the hub. Drawn once, spun as a whole. */
export const discTex = () =>
  once('disc', () => {
    const S = 1024;
    const { cv, g } = canvas(S, S);
    const c = S / 2;
    g.fillStyle = '#9fb6c9';
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.fill();
    const rings = g.createRadialGradient(c, c, 0, c, c, c);
    rings.addColorStop(0, '#dbe6ef');
    rings.addColorStop(0.18, '#c4d3df');
    rings.addColorStop(0.2, '#8ea6ba');
    rings.addColorStop(0.9, '#b3c6d6');
    rings.addColorStop(0.97, '#7d93a8');
    rings.addColorStop(1, '#5d7186');
    g.fillStyle = rings;
    g.fill();
    for (let i = 0; i < 12; i++) {
      g.save();
      g.translate(c, c);
      g.rotate((i / 12) * Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(S * 0.11, -9, S * 0.36, 7);
      g.fillStyle = 'rgba(40,56,74,0.25)';
      g.fillRect(S * 0.11, -2, S * 0.36, 9);
      g.restore();
    }
    // Vent holes, the way real wheels have them.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + 0.13;
      g.fillStyle = 'rgba(30,40,55,0.45)';
      g.beginPath();
      g.ellipse(c + Math.cos(a) * S * 0.4, c + Math.sin(a) * S * 0.4, 18, 30, a, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f2c14e';
    g.beginPath();
    g.arc(c, c, S * 0.06, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#4b5bd6';
    g.font = `bold ${S * 0.035}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('WHEELY9000', c, c + S * 0.14);
    return finish(cv);
  });

/** Paper bedding: off-white with soft fibres. */
export const beddingTex = () =>
  once('bedding', () => {
    const { cv, g } = canvas(512, 512);
    const r = seeded(23);
    g.fillStyle = '#efe6d2';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 1600; i++) {
      const x = r() * 512;
      const y = r() * 512;
      const a = r() * Math.PI;
      const l = 4 + r() * 16;
      g.strokeStyle = r() < 0.6 ? `rgba(255,255,255,${0.4 + r() * 0.5})` : `rgba(170,150,120,${0.15 + r() * 0.25})`;
      g.lineWidth = 1 + r() * 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    return finish(cv, true);
  });

/** Fur strands for the shell layers: each texel is how long the hair at that spot is. */
export const furTex = () =>
  once('fur', () => {
    const S = 256;
    const { cv, g } = canvas(S, S);
    const r = seeded(31);
    const img = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      img.data[i * 4 + 3] = 255;
    }
    for (let i = 0; i < 9000; i++) {
      const x = Math.floor(r() * S);
      const y = Math.floor(r() * S);
      const v = Math.floor(120 + r() * 135);
      const k = (y * S + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    return t;
  });

/** A soft round dot for dust, sparkles and bedding bits. */
export const softDot = () =>
  once('dot', () => {
    const { cv, g } = canvas(64, 64);
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return finish(cv);
  });

/** A rounded label with a name on it, for the rival's tag. */
export function labelTex(text: string, bg = '#7fd4ff', fg = '#10202c') {
  const { cv, g } = canvas(256, 72);
  g.font = 'bold 40px system-ui, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 40);
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 56, 28);
  g.fill();
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 38);
  return finish(cv);
}

/**
 * The wide wheel's running surface: six lanes, three per player, with a bold divider down the
 * middle where the screen splits. u runs around the wheel, v across it.
 */
export const tread6Tex = () =>
  once('tread6', () => {
    const W = 512;
    const H = 512;
    const { cv, g } = canvas(W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#c3ccd6');
    grd.addColorStop(0.5, '#e6ebf0');
    grd.addColorStop(1, '#c3ccd6');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 32) {
      g.fillStyle = 'rgba(70,86,104,0.15)';
      g.fillRect(x, 0, 6, H);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(x + 6, 0, 2, H);
    }
    // Lane lines; edges get a dark lip; the middle a solid two-tone stripe.
    const lane = (H - 24) / 6;
    for (let i = 1; i < 6; i++) {
      const v = 12 + i * lane;
      if (i === 3) {
        g.fillStyle = '#4b5bd6';
        g.fillRect(0, v - 7, W, 14);
        g.fillStyle = '#f2b544';
        for (let x = 0; x < W; x += 64) g.fillRect(x, v - 7, 32, 14);
      } else {
        g.fillStyle = 'rgba(255,190,90,0.8)';
        for (let x = 0; x < W; x += 64) g.fillRect(x + 8, v - 3, 40, 6);
      }
    }
    g.fillStyle = 'rgba(60,70,90,0.4)';
    g.fillRect(0, 0, W, 12);
    g.fillRect(0, H - 12, W, 12);
    return finish(cv, true);
  });

/**
 * A dot-matrix LED board that scrolls a line of text, in Squeekchain's orange and blue.
 * Call `set(text)` when the text changes and `tick(dt)` every frame.
 */
export function ledBoard(cols = 96) {
  const DOT = 4;
  const ROWS = 9;
  const { cv, g } = canvas(4096, ROWS * DOT);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = (cols * DOT) / cv.width;
  // A tiny 5x7 font is drawn by sampling a normal font onto a coarse grid.
  const probe = canvas(4096, 7);
  let text = '';
  let shown = '';
  const draw = () => {
    probe.g.clearRect(0, 0, 4096, 7);
    probe.g.fillStyle = '#fff';
    probe.g.font = 'bold 8px monospace';
    probe.g.textBaseline = 'top';
    probe.g.fillText(text, 0, -1);
    const px = probe.g.getImageData(0, 0, 4096, 7).data;
    g.fillStyle = '#120d08';
    g.fillRect(0, 0, cv.width, cv.height);
    const width = Math.min(cv.width / DOT, Math.ceil(probe.g.measureText(text).width) + 2);
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < cv.width / DOT; x++) {
        const on = y > 0 && y < 8 && x < width && px[((y - 1) * 4096 + x) * 4 + 3] > 90;
        g.fillStyle = on ? (Math.floor(x / 6) % 9 === 0 ? '#7f8cff' : '#ffb347') : '#2a1d12';
        g.beginPath();
        g.arc(x * DOT + DOT / 2, y * DOT + DOT / 2, on ? DOT * 0.42 : DOT * 0.3, 0, Math.PI * 2);
        g.fill();
      }
    tex.needsUpdate = true;
  };
  return {
    tex,
    set(t: string) {
      if (t === shown) return;
      shown = t;
      // Repeat the line to fill the whole strip, so the scroll never shows a gap.
      text = t.repeat(Math.max(1, Math.floor(1000 / Math.max(1, t.length * 5))));
      draw();
    },
    tick(dt: number) {
      tex.offset.x = (tex.offset.x + dt * 0.02) % 1;
    },
  };
}
