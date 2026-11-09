import './style.css';
import { Arena, renderIcons } from './scene';
import { WideArena } from './scene-wide';
import { TICK_CAP, WIDE } from './variant';
import { Hud } from './hud';
import { Session } from './session';
import { Conn } from './net';
import { readLive, readTotals } from './live';
import { hydrateDotText, hydrateSprites } from './pixel';
import { sfx, unlockAudio, isMuted, setMuted } from './sfx';
import { Coach } from './coach';
import { listWallets, me as whoAmI, short, signIn, signOut, type WalletInfo } from './wallet';
import { courseHash, generateCourse } from '../shared/course';
import { randomHex, sha256Hex } from '../shared/hash';
import { tired, tiredAt, winnerAtCap, type Key, type PState } from '../shared/sim';
import { TICK_HZ } from '../shared/constants';
import { Bot } from '../shared/bot';
import { humanReport } from '../shared/stats';
import { ROOM_CODE, type EndInfo, type LiveInfo, type ServerMsg } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- small persistence helpers (storage may be blocked) ----------
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}
/** A secret id kept in this browser. The server only ever stores its hash, as the leaderboard key. */
const pid = load('wd.pid') ?? randomHex(32);
save('wd.pid', pid);

// ---------- state ----------
const canvas = $<HTMLCanvasElement>('arena');
const arena = WIDE ? new WideArena(canvas) : new Arena(canvas);
const hud = new Hud($('hud'));
let coach = new Coach($('coach'));
let session: Session = Session.practice('attract');
let screen: 'landing' | 'play' = 'landing';
let live: LiveInfo | null = null;
let heroVisible = true;

let lobby: Conn | null = null;
let conn: Conn | null = null;
let you: 0 | 1 = 0;
let commitAtStart = '';
let nextCommit = '';
let liveAtStart: LiveInfo | null = null;
let mySeed = '';
let waitingSince = 0;
let waitKind: 'queue' | 'room' | null = null;
let practiceWhileWaiting = false;
let rivalLeft = false;
let resultShown = false;
let roomCode = '';
let practiceEnding = false;

// ---------- landing ----------
hydrateSprites();
hydrateDotText();
renderIcons();
const nameInput = $<HTMLInputElement>('name');
nameInput.value = load('wd.name') ?? '';
nameInput.addEventListener('change', () => save('wd.name', nameInput.value.trim()));
const myName = () => nameInput.value.trim().slice(0, 16) || 'Hamster';

function heroError(msg: string) {
  $('hero-error').textContent = msg;
}

function moveCanvas(to: HTMLElement) {
  if (canvas.parentElement !== to) to.prepend(canvas);
  arena.resize();
  hud.layout(arena.halves(), arena.stacked);
}

new ResizeObserver(() => {
  arena.resize();
  hud.layout(arena.halves(), arena.stacked);
}).observe(document.body);
new IntersectionObserver((e) => (heroVisible = e[0].isIntersecting)).observe($('hero-stage'));
moveCanvas($('hero-stage'));

async function refreshLive() {
  live = await readLive();
  const on = !!live?.active;
  $('hero-dot').classList.toggle('on', on);
  $('live-dot').classList.toggle('on', on);
  $('live-ham').classList.toggle('sleep', !on);
  if (!live) {
    $('hero-live').textContent = 'Squeektoshi: offline';
    $('live-title').textContent = "Can't reach the wheel right now";
    $('live-sub').textContent = 'The Squeekchain API is not answering. Races still work.';
    return;
  }
  $('hero-live').textContent = on ? `Squeektoshi is running · ${live.kmToday.toFixed(2)} km today` : `Squeektoshi is resting · ${live.kmToday.toFixed(2)} km today`;
  $('live-title').textContent = on ? 'Squeektoshi is running!' : 'Squeektoshi is resting';
  $('live-sub').textContent = on
    ? 'Every race right now is a Night Race, and his blocks can drop into your road.'
    : 'Hamsters run at night. When he wakes up, the races turn into Night Races.';
  $('live-speed').textContent = `${(live.speedMm / 1000).toFixed(2)} m/s`;
  $('live-rpm').textContent = String(live.rpm);
  $('live-km').textContent = `${live.kmToday.toFixed(2)} km`;
  $('live-block').textContent = `#${live.blockHeight}`;
}

let totalKm: number | null = null;

/** The scrolling LED board in the wide version: real numbers from Squeektoshi's wheel. */
function tickerText(): string {
  const l = session.live ?? live;
  const parts = [l?.active ? 'SQUEEKTOSHI IS RUNNING NOW' : 'SQUEEKTOSHI IS ASLEEP AND DREAMING'];
  if (l) parts.push(`${l.kmToday.toFixed(2)} KM TODAY`, `BLOCK #${l.blockHeight}`);
  if (totalKm !== null) parts.push(`${totalKm.toFixed(1)} KM SO FAR`);
  parts.push('WHEELY9000', 'HAMSTER-POWERED PROOF OF WORK');
  return parts.join('  ·  ') + '  ·  ';
}

async function refreshTotals() {
  const t = await readTotals();
  if (!t) return;
  totalKm = t.km;
  $('live-total').textContent = `${t.km.toFixed(1)} km`;
  $('live-since').textContent = t.since ? `since ${t.since.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
  $('live-days').textContent = String(t.activeDays);
}

async function refreshBoard() {
  const body = $('board-rows');
  const empty = (text: string) => {
    body.textContent = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = text;
    tr.append(td);
    body.append(tr);
  };
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error();
    const { rows } = (await res.json()) as { rows: { name: string; wallet: string | null; elo: number; wins: number; losses: number; bestM: number | null }[] };
    if (!rows.length) return empty('No ranked races yet. Win one and the top spot is yours.');
    body.textContent = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      for (const v of [String(i + 1), r.name, r.wallet ?? 'guest', String(r.elo), String(r.wins), String(r.losses), r.bestM ? `${r.bestM} m` : '–']) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      body.append(tr);
    });
  } catch {
    empty('The leaderboard is unavailable right now.');
  }
}

// ---------- wallet ----------
let account: string | null = null;
let guestsAllowed = false;
let activeWallet: WalletInfo | null = null;

function paintWallet() {
  $('wallet-box').hidden = !!account;
  $('signed').hidden = !account;
  $('signed-addr').textContent = account ? short(account) : '';
  const top = $('wallet-top');
  top.textContent = '';
  const chip = document.createElement(account ? 'span' : 'button');
  chip.className = account ? 'chip ok' : 'btn small';
  chip.textContent = account ? short(account) : 'CONNECT WALLET';
  if (!account) chip.addEventListener('click', openWallets);
  top.append(chip);
}

async function refreshMe() {
  const m = await whoAmI().catch(() => ({ address: null, guests: false }));
  account = m.address;
  guestsAllowed = m.guests;
  paintWallet();
}

async function openWallets() {
  $('wallets').hidden = false;
  $('wallet-status').textContent = 'Looking for wallets…';
  const list = $('wallet-list');
  list.textContent = '';
  const wallets = await listWallets();
  $('wallet-status').textContent = wallets.length ? '' : '';
  if (!wallets.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.append('No browser wallet found. Install ');
    for (const [name, href] of [['MetaMask', 'https://metamask.io/download/'], ['Rabby', 'https://rabby.io/']]) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = name;
      p.append(a, name === 'MetaMask' ? ' or ' : ', then reload this page.');
    }
    list.append(p);
    return;
  }
  for (const w of wallets) {
    const b = document.createElement('button');
    b.className = 'wallet-item';
    if (w.icon) {
      const img = document.createElement('img');
      img.src = w.icon;
      img.alt = '';
      b.append(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'ph';
      b.append(ph);
    }
    b.append(document.createTextNode(w.name));
    b.addEventListener('click', () => connectWith(w));
    list.append(b);
  }
}

async function connectWith(w: WalletInfo) {
  $('wallet-status').textContent = 'Check your wallet: approve the connection, switch to Sepolia, then sign the message.';
  try {
    account = await signIn(w);
    activeWallet = w;
    w.provider.on?.('accountsChanged', onAccountsChanged);
    $('wallets').hidden = true;
    paintWallet();
    heroError('');
  } catch (e) {
    const code = (e as { code?: number }).code;
    $('wallet-status').textContent = code === 4001 ? 'You cancelled in the wallet. Nothing was signed.' : e instanceof Error ? e.message : 'Sign-in failed.';
  }
}

async function onAccountsChanged(...args: unknown[]) {
  const accs = args[0] as string[] | undefined;
  if (!account || (accs?.[0] ?? '').toLowerCase() === account.toLowerCase()) return;
  // A different account in the wallet: sign out so the leaderboard can't mix them up.
  await signOut();
  account = null;
  paintWallet();
  heroError('Your wallet switched accounts. Connect again to play online.');
}

/** Online play needs a signed-in wallet (guests only in local development). */
async function needWallet(): Promise<boolean> {
  if (account || guestsAllowed) return true;
  heroError('Connect your wallet first. It is free and only takes a signature.');
  openWallets();
  return false;
}
const guestQuery = () => (!account && guestsAllowed ? `g=${pid}` : '');

// ---------- screens ----------
function enterPlay() {
  screen = 'play';
  $('play').hidden = false;
  document.body.style.overflow = 'hidden';
  moveCanvas($('stage'));
  $('touch').hidden = true; // phones swipe instead
}

function goHome() {
  lobby?.close();
  lobby = null;
  conn?.close();
  conn = null;
  waitKind = null;
  practiceWhileWaiting = false;
  screen = 'landing';
  $('play').hidden = true;
  $('wait').hidden = true;
  $('result').hidden = true;
  $('countdown').hidden = true;
  $('night-badge').hidden = true;
  document.body.style.overflow = '';
  history.replaceState(null, '', location.pathname);
  moveCanvas($('hero-stage'));
  session = Session.practice('attract', 0.7, live);
  arena.resetCourse();
  hud.reset();
  refreshBoard();
}

function showWait(kind: 'queue' | 'room', code = '') {
  waitKind = kind;
  waitingSince = performance.now();
  $('wait').hidden = false;
  $('wait-ideas').hidden = true;
  $('wait-room').hidden = kind !== 'room';
  $('wait-title').textContent = kind === 'queue' ? 'Finding a rival…' : 'Waiting for your friend…';
  $('wait-sub').textContent = kind === 'queue' ? 'This usually takes a few seconds.' : 'The race starts as soon as they join.';
  if (kind === 'room') {
    const link = `${location.origin}/?r=${code}`;
    $<HTMLInputElement>('room-link').value = link;
    $('room-code').textContent = code;
  }
}

function startPractice() {
  practiceWhileWaiting = waitKind !== null;
  $('wait').hidden = true;
  $('result').hidden = true;
  resultShown = false;
  practiceEnding = false;
  arena.resetCourse();
  hud.reset();
  session = Session.practice('practice', 0.45, live);
  coach.newRace();
  resetFx();
}

function failOnline(msg: string) {
  goHome();
  heroError(msg);
}

// ---------- online ----------
async function quickMatch() {
  heroError('');
  if (!(await needWallet())) return;
  enterPlay();
  showWait('queue');
  try {
    lobby = await Conn.open('/ws/lobby', guestQuery());
  } catch (e) {
    return failOnline(e instanceof Error ? e.message : 'Could not reach the server.');
  }
  lobby.on((m) => {
    if (m.type === 'matched') {
      lobby?.close();
      lobby = null;
      joinRoom(m.code, 'queue');
    }
  });
  lobby.onClose(() => {
    if (waitKind === 'queue' && !conn) failOnline('Lost the connection to the queue.');
  });
}

function newRoomCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  for (const b of r) s += abc[b % abc.length];
  return s;
}

let reconnecting = false;

async function joinRoom(code: string, kind: 'queue' | 'room' | 'resume') {
  heroError('');
  if (kind !== 'resume' && !(await needWallet())) return;
  if (screen !== 'play') enterPlay();
  roomCode = code;
  if (kind === 'room') {
    history.replaceState(null, '', `/?r=${code}`);
    showWait('room', code);
  }
  try {
    conn = await Conn.open(`/ws/room/${code}`, guestQuery());
  } catch (e) {
    if (kind === 'resume') throw e;
    return failOnline(e instanceof Error ? e.message : 'Could not reach the server.');
  }
  const c = conn;
  c.startClock();
  c.on(onServer);
  c.onClose(() => {
    if (conn !== c || screen !== 'play') return;
    conn = null;
    // Mid-race: try to get back in. Your seat is kept until the race ends.
    if (session.mode === 'online' && !session.ended && !resultShown) resume();
    else if (!resultShown) failOnline('Disconnected from the race.');
  });
}

async function resume() {
  if (reconnecting) return;
  reconnecting = true;
  $('reconnect').hidden = false;
  for (let i = 0; i < 40 && screen === 'play'; i++) {
    try {
      await joinRoom(roomCode, 'resume');
      reconnecting = false;
      $('reconnect').hidden = true;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  reconnecting = false;
  $('reconnect').hidden = true;
  failOnline('Could not get back into the race.');
}

function sendHello() {
  mySeed = randomHex(16);
  conn?.send({ type: 'hello', name: myName(), seed: mySeed, wd: navigator.webdriver === true });
}

function onServer(m: ServerMsg) {
  switch (m.type) {
    case 'welcome':
      you = m.you;
      nextCommit = m.commit;
      if (!m.resumed) sendHello();
      break;
    case 'roster': {
      const other = m.names[you === 0 ? 1 : 0];
      if (waitKind === 'room' && other) $('wait-sub').textContent = `${other} is here. Starting…`;
      break;
    }
    case 'start': {
      const resumed = session.mode === 'online' && !session.ended && commitAtStart === m.commit;
      commitAtStart = m.commit;
      liveAtStart = m.live;
      waitKind = null;
      rivalLeft = false;
      resultShown = false;
      $('wait').hidden = true;
      $('result').hidden = true;
      $('peer-banner').hidden = true;
      if (!resumed) {
        arena.resetCourse();
        hud.reset();
        coach.newRace();
        resetFx();
      }
      session = Session.online(conn!, m.t0, m.names, you, m.live);
      if (practiceWhileWaiting) {
        practiceWhileWaiting = false;
        hudToastCenter('RIVAL FOUND!');
      }
      break;
    }
    case 'course':
      session.addObstacles(m.obs);
      break;
    case 'snap':
      if (session.mode === 'online') session.onSnap(m.p);
      break;
    case 'peer':
      $('peer-banner').hidden = !m.away;
      break;
    case 'end':
      if (session.mode === 'online') {
        session.ended = true;
        session.onSnap(m.final);
      }
      $('peer-banner').hidden = true;
      nextCommit = m.nextCommit;
      showOnlineResult(m);
      break;
    case 'rematch_wait':
      $('res-wait').textContent = 'Your rival wants a rematch.';
      break;
    case 'left':
      rivalLeft = true;
      if (resultShown) $('res-wait').textContent = 'Your rival left. Press rematch to wait for a new one in this room.';
      break;
    case 'error':
      failOnline(m.msg);
      break;
  }
}

function hudToastCenter(text: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  t.style.color = '#ffcf4a';
  $('hud').append(t);
  setTimeout(() => t.remove(), 950);
}

const lasted = (s: PState) => {
  const t = (tired(s) ? s.tiredTick : s.tick) / TICK_HZ;
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

function fillGrid(me: PState, op: PState, names: [string, string]) {
  const g = $('res-grid');
  g.textContent = '';
  const rows: [string, string, string][] = [
    ['', names[0], names[1]],
    ['Distance', `${me.dist.toFixed(0)} m`, `${op.dist.toFixed(0)} m`],
    ['Lasted', lasted(me), lasted(op)],
    ['Energy left', `${me.energy} / 3`, `${op.energy} / 3`],
    ['Bumps', String(me.stumbles), String(op.stumbles)],
    ['Snacks', String(me.worms), String(op.worms)],
    ['Rides', String(me.rides), String(op.rides)],
    ['Jumps / slides', `${me.jumps} / ${me.slides}`, `${op.jumps} / ${op.slides}`],
    ['Block Drops', String(me.blocks), String(op.blocks)],
  ];
  rows.forEach((r, i) => {
    r.forEach((v, j) => {
      const d = document.createElement('div');
      d.textContent = v;
      d.className = i === 0 ? 'h' : j === 1 ? 'me' : j === 2 ? 'op' : 'h';
      g.append(d);
    });
  });
}

const humanLine = (h: { verdict: string; reactMs: number; cv: number }) =>
  h.verdict === 'few'
    ? 'Reactions: not enough to judge'
    : h.verdict === 'human'
      ? `Reactions look human (${h.reactMs.toFixed(0)} ms on average, varying ${(h.cv * 100).toFixed(0)}%)`
      : 'Reactions look scripted, so this race is not ranked';

function check(ok: boolean, text: string, detail = '') {
  const d = document.createElement('div');
  d.className = ok ? 'ok' : 'bad';
  d.textContent = `${ok ? '✓' : '✗'} ${text}`;
  if (detail) {
    const c = document.createElement('code');
    c.textContent = ` ${detail}`;
    d.append(c);
  }
  $('res-checks').append(d);
}

async function showOnlineResult(m: { type: 'end' } & EndInfo) {
  resultShown = true;
  coach.endRace();
  const meIdx = you;
  const me = m.final[meIdx];
  const op = m.final[meIdx === 0 ? 1 : 0];
  const won = m.winner === meIdx;
  $('res-title').textContent = m.winner === -1 ? 'DEAD HEAT!' : won ? 'YOU WIN!' : 'OUT OF ENERGY';
  $('res-sub').textContent =
    m.reason === 'forfeit'
      ? won
        ? "Your rival left and their hamster ran out of energy before they came back."
        : "You left and your hamster ran out of energy before you came back."
      : m.reason === 'timeout'
        ? won
          ? 'Three minutes and you both kept going. You had more energy left (or got further).'
          : m.winner === -1
            ? 'Three minutes, both still running, exactly level.'
            : 'Three minutes and you both kept going. Your rival had more energy left (or got further).'
        : m.reason === 'abandoned'
          ? 'Both players left, so it is a draw.'
          : won
            ? 'Your rival got too tired and stopped to rest first.'
            : 'Your hamster got too tired and stopped to rest first. Rematch and get them back.';
  fillGrid(me, op, session.names);
  $('res-wait').textContent = m.ranked ? 'This race counts for the leaderboard.' : 'This race does not count for the leaderboard.';
  $('res-checks').textContent = '';
  $('btn-rematch').textContent = 'REMATCH';
  $('result').hidden = false;

  // Provably fair: check the revealed seed against the hash shown before the race, rebuild the course.
  const okCommit = (await sha256Hex(m.reveal.serverSeed)) === commitAtStart;
  check(okCommit, 'Server seed matches the hash it locked in before the race', commitAtStart.slice(0, 16) + '…');
  const okMine = m.reveal.seeds[meIdx] === mySeed;
  check(okMine, 'Your own random seed was used');
  const courseSeed = await sha256Hex(`${m.reveal.serverSeed}:${m.reveal.seeds[0]}:${m.reveal.seeds[1]}`);
  const regen = generateCourse(courseSeed, !!liveAtStart?.active);
  const regenIds = new Map(regen.map((o) => [o.id, o]));
  const seen = session.course.filter((o) => o.kind !== 'bdrop');
  const okSeen = seen.every((o) => {
    const r = regenIds.get(o.id);
    return !!r && r.d === o.d && r.kind === o.kind && r.lane === o.lane;
  });
  check(okSeen && (await courseHash(regen)) === m.courseHash, 'Every obstacle you saw was built from those seeds', m.courseHash.slice(0, 16) + '…');
  const h = m.human[meIdx];
  check(h.verdict !== 'steady', humanLine(h));
  check(true, 'Replay fingerprint', m.inputHash.slice(0, 24) + '…');
}

function showPracticeResult() {
  resultShown = true;
  coach.endRace();
  const me = session.me;
  const op = session.opp;
  const won = tiredAt(me) > tiredAt(op) || (!tired(me) && !tired(op) && winnerAtCap(me, op) === 0);
  $('res-title').textContent = won ? 'YOU OUTLASTED THE BOT!' : 'OUT OF ENERGY';
  $('res-sub').textContent = practiceWhileWaiting ? "Still waiting for a rival. Go again, we'll pull you in when they arrive." : 'Practice race. Nothing is recorded.';
  fillGrid(me, op, session.names);
  $('res-checks').textContent = '';
  const h = humanReport(me);
  check(h.verdict !== 'steady', humanLine(h));
  $('res-wait').textContent = '';
  $('btn-rematch').textContent = 'AGAIN';
  $('result').hidden = false;
}

// ---------- buttons ----------
$('btn-quick').addEventListener('click', () => quickMatch());
$('btn-create').addEventListener('click', () => joinRoom(newRoomCode(), 'room'));
$('btn-practice').addEventListener('click', () => {
  enterPlay();
  startPractice();
});
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>('join-code').value.trim();
  const code = (/[?&]r=([a-z0-9]+)/i.exec(raw)?.[1] ?? raw).toLowerCase();
  if (!ROOM_CODE.test(code)) return heroError('That room code does not look right.');
  joinRoom(code, 'room');
});
$('btn-cancel').addEventListener('click', goHome);
$('btn-connect').addEventListener('click', openWallets);
// Theme: System (default) → Light → Dark.
const THEMES = ['system', 'light', 'dark'] as const;
const themeLabel: Record<(typeof THEMES)[number], string> = { system: '◐ SYSTEM', light: '☀ LIGHT', dark: '☾ DARK' };
let theme = (load('wd.theme') as (typeof THEMES)[number] | null) ?? 'system';
if (!THEMES.includes(theme)) theme = 'system';
const paintTheme = () => {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('btn-theme').textContent = themeLabel[theme];
};
paintTheme();
$('btn-theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  save('wd.theme', theme);
  paintTheme();
});
$('btn-wallets-close').addEventListener('click', () => ($('wallets').hidden = true));
$('btn-signout').addEventListener('click', async () => {
  await signOut();
  activeWallet?.provider.removeListener?.('accountsChanged', onAccountsChanged);
  account = null;
  paintWallet();
});
const muteBtn = $('btn-mute');
const paintMute = () => (muteBtn.textContent = isMuted() ? 'SOUND: OFF' : 'SOUND: ON');
paintMute();
muteBtn.addEventListener('click', () => {
  unlockAudio();
  setMuted(!isMuted());
  paintMute();
});
$('btn-tips').addEventListener('click', () => {
  Coach.reset();
  coach = new Coach($('coach'));
  $('btn-tips').textContent = 'Tips will show in your next race ✓';
});
$('btn-leave').addEventListener('click', goHome);
$('btn-home').addEventListener('click', goHome);
$('btn-wait-practice').addEventListener('click', startPractice);
$('btn-copy').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('room-link');
  try {
    await navigator.clipboard.writeText(input.value);
    $('btn-copy').textContent = 'COPIED';
  } catch {
    input.select();
  }
});
$('btn-rematch').addEventListener('click', () => {
  if (session.mode !== 'online') {
    if (practiceWhileWaiting || !conn) return startPractice();
  }
  if (!conn) return goHome();
  if (rivalLeft) {
    $('result').hidden = true;
    resultShown = false;
    showWait('room', roomCode);
    sendHello();
    return;
  }
  mySeed = randomHex(16);
  conn.send({ type: 'rematch', seed: mySeed });
  $('res-wait').textContent = 'Waiting for your rival to hit rematch…';
});

// ---------- input ----------
// Arrow keys or WASD: ← → change lane, ↑ jump, ↓ slide. On a phone: swipe.
const KEYMAP: Record<string, Key> = {
  ArrowLeft: 'L', KeyA: 'L', ArrowRight: 'R', KeyD: 'R', ArrowUp: 'J', KeyW: 'J', Space: 'J', ArrowDown: 'S', KeyS: 'S',
};
function press(k: Key) {
  unlockAudio();
  if (session.countdownMs() > 0 || tired(session.me)) return;
  const s = session.me;
  if (k === 'J' && s.air === 0) sfx.jump();
  else if (k === 'S' && s.slide === 0) sfx.slide();
  else if (k === 'L' || k === 'R') sfx.move();
  session.press(k);
}
window.addEventListener('keydown', (e) => {
  if (screen !== 'play') return;
  const k = KEYMAP[e.code];
  if (!k) return;
  e.preventDefault();
  // Ignore held-key auto-repeat and events synthesised by scripts on the page.
  if (e.repeat || !e.isTrusted) return;
  if (!$('result').hidden || !$('wait').hidden) return;
  press(k);
});
// Swipes anywhere on the play screen.
let swipe: { x: number; y: number; id: number } | null = null;
$('play').addEventListener('pointerdown', (e) => {
  if (!e.isTrusted || e.pointerType === 'mouse' || (e.target as HTMLElement).closest('button, .modal')) return;
  swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
$('play').addEventListener('pointerup', (e) => {
  if (!swipe || swipe.id !== e.pointerId || !e.isTrusted) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  press(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'L' : 'R') : dy < 0 ? 'J' : 'S');
});

// ---------- sound cues from what just happened ----------
let fx = { stumbles: 0, breaks: 0, worms: 0, rides: 0, blocks: 0, energy: 3, low: false, tired: false, beep: 99, step: 0, air: 0 };
function resetFx() {
  fx = { stumbles: 0, breaks: 0, worms: 0, rides: 0, blocks: 0, energy: 3, low: false, tired: false, beep: 99, step: 0, air: 0 };
}
function playEvents(me: PState, op: PState) {
  const isCaught = tired(me);
  if (isCaught && !fx.tired) sfx.finish(false);
  else if (me.stumbles > fx.stumbles) sfx.bonk();
  if (me.energy > fx.energy && !isCaught) sfx.pad();
  if (me.breaks > fx.breaks) sfx.overheat();
  if (me.worms > fx.worms) sfx.seed();
  if (me.rides > fx.rides) sfx.pad();
  if (me.blocks > fx.blocks) sfx.block();
  // One bolt left: a warning, once each time you get there.
  const low = !isCaught && me.energy === 1;
  if (low && !fx.low) sfx.catWarn();
  if (fx.air > 0 && me.air === 0 && !isCaught) sfx.land();
  // Footsteps, faster as you speed up.
  if (!isCaught && me.air === 0 && me.slide === 0 && me.dist - fx.step > 1.7) {
    fx.step = me.dist;
    sfx.tap(me.speed, Math.floor(me.dist / 1.7) % 2 === 0);
  }
  if (!isCaught && tired(op) && !fx.tired && session.mode !== 'attract' && fx.beep !== -9) {
    sfx.finish(true);
    fx.beep = -9;
  }
  const cd = session.countdownMs();
  const n = cd > 0 ? Math.ceil(cd / 1000) : 0;
  if (n !== fx.beep && n <= 3 && fx.beep !== -9) {
    sfx.beep(n === 0);
    fx.beep = n;
  }
  Object.assign(fx, { stumbles: me.stumbles, breaks: me.breaks, worms: me.worms, rides: me.rides, blocks: me.blocks, energy: me.energy, low, tired: isCaught, air: me.air });
}

// ---------- main loop ----------
function frame(now: number) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  if (screen === 'landing' && !heroVisible) return;
  session.update();

  if (session.mode === 'attract') {
    if ((tired(session.me) && tired(session.opp)) || session.me.tick >= TICK_CAP) {
      session = Session.practice('attract', 0.7, live);
      arena.resetCourse();
    }
  } else if (session.mode === 'practice' && !practiceEnding && (tired(session.me) || tired(session.opp) || session.me.tick >= TICK_CAP)) {
    practiceEnding = true;
    const s = session;
    setTimeout(() => session === s && showPracticeResult(), 1400);
  }

  if (waitKind && !$('wait').hidden) {
    const sec = Math.floor((now - waitingSince) / 1000);
    $('wait-timer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (sec >= 12) $('wait-ideas').hidden = false;
  }

  const isLive = !!session.live?.active;
  const opp = session.oppView();
  arena.render(
    { state: session.me, course: session.course, live: isLive, ghost: opp, ghostName: session.names[1], ticker: WIDE ? tickerText() : undefined },
    { state: opp, course: session.course, live: isLive, ghost: session.me, ghostName: session.names[0], ticker: WIDE ? tickerText() : undefined },
    t,
  );
  if (screen === 'play' && session.mode !== 'attract') {
    playEvents(session.me, opp);
    coach.update(session.me, session.course, session.countdownMs());
  }

  if (screen === 'play') {
    hud.update(session.names, session.me, session.oppView(), arena.nights());
    const cd = session.countdownMs();
    const cdEl = $('countdown');
    if (cd > 0) {
      cdEl.hidden = false;
      const n = Math.ceil(cd / 1000);
      cdEl.innerHTML = n > 3 ? '<div>READY<small>← → change lane · ↑ jump · ↓ slide · every bump costs ⚡</small></div>' : `<div>${n}</div>`;
    } else if (cd > -700) {
      cdEl.hidden = false;
      cdEl.innerHTML = '<div>GO!</div>';
    } else cdEl.hidden = true;
    $('night-badge').hidden = !isLive;
  }
}
requestAnimationFrame(frame);

// Browsers only allow sound after a user gesture: unlock (and start loading samples) on the first one.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => unlockAudio(), { once: true, capture: true });

// ---------- boot: a short loading bar, then the game menu ----------
async function boot() {
  const fill = $('loader-fill');
  const text = $('loader-text');
  let done = 0;
  const steps = 4;
  const tick = (label: string) => {
    done++;
    fill.style.width = `${Math.round((done / steps) * 100)}%`;
    text.textContent = label;
  };
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  tick('Building the road…');
  await withTimeout(document.fonts.ready, 1500);
  tick('Waking up the hamsters…');
  await withTimeout(Promise.all([refreshLive(), refreshMe()]), 2500);
  tick('Checking on Squeektoshi…');
  // Background tabs don't paint, so never wait on a frame forever.
  await withTimeout(new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), 400);
  tick('Ready!');
  await new Promise((r) => setTimeout(r, 350));
  $('loader').classList.add('done');
  document.body.classList.remove('loading');
  refreshBoard();
  refreshTotals();
  setInterval(refreshLive, 20_000);
  setInterval(refreshTotals, 120_000);
  // Invite links: /?r=code
  const invite = new URLSearchParams(location.search).get('r');
  if (invite && ROOM_CODE.test(invite)) joinRoom(invite, 'room');
}
boot();

// Development-only debugging handle (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__wd = {
    get session() {
      return session;
    },
    arena,
    /** Two bots racing on the full play screen, for checking visuals. */
    demo() {
      enterPlay();
      arena.resetCourse();
      hud.reset();
      session = Session.practice('attract', 0.7, live);
    },
    practice: startPractice,
    /** Lets a bot press your keys, to watch effects and tips without typing. */
    autoplay(skill = 0.7) {
      const b = new Bot(randomHex(16), skill);
      const id = setInterval(() => {
        for (const k of b.keys(session.me, session.course)) press(k);
      }, 16);
      return () => clearInterval(id);
    },
  };
}
