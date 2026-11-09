/** Tiny pixel-art sprites drawn from character grids. Each character is one pixel; '.' is transparent. */
const PALETTE: Record<string, string> = {
  k: '#1b1530', w: '#fff6e0', c: '#f6e7c8', o: '#e8a25a', b: '#9a5b2c', p: '#f4a6b5', r: '#ff4d5a',
  g: '#3fbf6a', y: '#ffd23f', Y: '#ffcf4a', d: '#7a5a1a', s: '#4ee6ff', S: '#1a8fb0', a: '#8b8698',
  A: '#4a4558', e: '#ffe14d', m: '#d8d2c0', t: '#b7794a',
};

const SPRITES: Record<string, string[]> = {
  hamster: [
    '....oo..oo....',
    '...opo..opo...',
    '..oooooooooo..',
    '.oooooooooooo.',
    '.ookoooooooko.',
    'ooowooooooowoo',
    'oocccoppoccco.',
    '.occcckkcccco.',
    '..occccccccco.',
    '...oocccccoo..',
    '....pp...pp...',
  ],
  wheel: [
    '....ssssss....',
    '..ss......ss..',
    '.s..s....s..s.',
    '.s...s..s...s.',
    's.....ss.....s',
    's.....SS.....s',
    's.....SS.....s',
    's.....ss.....s',
    '.s...s..s...s.',
    '.s..s....s..s.',
    '..ss......ss..',
    '....ssssss....',
  ],
  pencil: [
    '..............',
    '..............',
    'ppyyyyyyyyyttk',
    'ppyddyyyddyttk',
    'ppyyyyyyyyyttk',
    '..............',
  ],
  roll: [
    '...wwwwww...',
    '..wmmmmmmw..',
    '..wmkkkkmw..',
    '..wmmmmmmw..',
    '..wwwwwwww..',
    '..wwwwwwww..',
    '..wmwwwwmw..',
    '..wwwwwwww..',
    '..wwwwwwww..',
    '...wwwwww...',
  ],
  seed: [
    '....kk....',
    '...kYYk...',
    '..kYyYYk..',
    '..kYyYYk..',
    '.kYYyYYYk.',
    '.kYYyYYYk.',
    '..kYYYYk..',
    '...kYYk...',
    '....kk....',
  ],
  chili: [
    '........gg.',
    '.......gg..',
    '.....rrg...',
    '...rrrrr...',
    '..rrwrrr...',
    '.rrrrrr....',
    '.rrrr......',
    'rrr........',
  ],
  cat: [
    'A..........A',
    'AA........AA',
    'AaA......AaA',
    'AaaAAAAAAaaA',
    'AaaaaaaaaaaA',
    'AaeekaaekeaA',
    'AaeekaaekeaA',
    'AaaaaapaaaaA',
    '.AaaawwwaaA.',
    '..AAAAAAAA..',
  ],
  block: [
    '....ssss....',
    '..ssSSSSss..',
    'ssSSSSSSSSss',
    'sSssSSSSssSs',
    'sSSSssssSSSs',
    'sSSSSssSSSSs',
    'sSSSSssSSSSs',
    'sSSSSssSSSSs',
    '.ssSSssSSss.',
    '...ssssss...',
  ],
  worm: [
    '..........',
    '.....ddd..',
    '...ddkYdd.',
    '..dYYYYYd.',
    '.dYYdddd..',
    '.dYd......',
    '.dYYd.....',
    '..dYYYdd..',
    '...ddYYYd.',
    '.....dddd.',
  ],
  truck: [
    '.....wwww...',
    '.....wkkw...',
    'rrrrrwwwwrr.',
    'rrrrrrrrrrrr',
    'rrwrrrrrrrrr',
    'rrrrrrrrrrrr',
    '.kk.....kk..',
    '.kk.....kk..',
  ],
  pit: [
    '.tttttttttt.',
    'tkkkkkkkkkkt',
    'tkkkkkkkkkkt',
    'tkkkkkkkkkkt',
    'tkkkkkkkkkkt',
    '.tttttttttt.',
  ],
  ramp: [
    '..........yy',
    '........yyyy',
    '......yyyyyy',
    '....yyyyyyyy',
    '..yyyyyyyyyy',
    'yyyyyyyyyyyy',
  ],
  pad: [
    'SSSSSSSSSSSS',
    'SssSSssSSssS',
    'SSssSSssSSsS',
    'SSSssSSssSSs',
    'SSssSSssSSsS',
    'SssSSssSSssS',
    'SSSSSSSSSSSS',
  ],
  eye: [
    '...kkkk...',
    '.kkeeeekk.',
    'keeekkeeek',
    'keeekkeeek',
    '.kkeeeekk.',
    '...kkkk...',
  ],
  heart: [
    '.rr.rr.',
    'rrrrrrr',
    'rrrrrrr',
    '.rrrrr.',
    '..rrr..',
    '...r...',
  ],
};

export type SpriteName = keyof typeof SPRITES;

export function spriteSvg(name: SpriteName, scale = 4): string {
  const rows = SPRITES[name];
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  let rects = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = PALETTE[row[x]];
      if (col) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${col}"/>`;
    }
  });
  return `<svg class="px" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

/** Replaces every <i data-sprite="name" data-scale="n"></i> on the page with its sprite. */
export function hydrateSprites(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-sprite]').forEach((el) => {
    const name = el.dataset.sprite as SpriteName;
    if (!SPRITES[name]) return;
    el.innerHTML = spriteSvg(name, Number(el.dataset.scale) || 4);
  });
}

/** 5×7 dot-matrix glyphs for the logo, in the LED style Squeekchain uses. */
const GLYPHS: Record<string, string[]> = {
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

let gradId = 0;
/** Renders a word as a dot-matrix SVG with a top-to-bottom colour gradient. */
export function dotText(text: string, top: string, bottom: string): string {
  const id = `dg${gradId++}`;
  let dots = '';
  let x0 = 0;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    g.forEach((row, y) => {
      for (let x = 0; x < 5; x++) {
        if (row[x] === '#') dots += `<rect x="${x0 + x + 0.08}" y="${y + 0.08}" width="0.84" height="0.84" rx="0.18"/>`;
      }
    });
    x0 += 6;
  }
  const w = x0 - 1;
  return `<svg class="dots" viewBox="0 0 ${w} 7" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="7" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><g fill="url(#${id})">${dots}</g></svg>`;
}

export function hydrateDotText(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-dots]').forEach((el) => {
    const text = el.dataset.dots ?? '';
    el.innerHTML = dotText(text, el.dataset.top ?? '#ffe3a3', el.dataset.bottom ?? '#d9772b');
    // Words sit side by side at the same dot size: each takes width in proportion to its letters.
    el.style.setProperty('--dw', String(text.length * 6 - 1));
  });
}
