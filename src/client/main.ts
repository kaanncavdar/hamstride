import './style.css';
import { Arena } from './scene';
import { Hud } from './hud';
import { Session } from './session';
import { Conn } from './net';
import { readLive } from './live';
import { hydrateSprites } from './pixel';
import { courseHash, generateCourse } from '../shared/course';
import { randomHex, sha256Hex } from '../shared/hash';
import { finishTime, type Key, type PState } from '../shared/sim';
import { MAX_TICKS, TICK_HZ } from '../shared/constants';
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
const arena = new Arena(canvas);
const hud = new Hud($('hud'));
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
  $('hero-live').textContent = on ? 'Squeektoshi is running right now · Night Race is on' : 'A hamster wheel race for two';
  $('live-ham').classList.toggle('sleep', !on);
  if (!live) {
    $('live-title').textContent = "Can't reach the wheel right now";
    $('live-sub').textContent = 'The Squeekchain API is not answering. Races still work.';
    return;
  }
  $('live-title').textContent = on ? 'Squeektoshi is running!' : 'Squeektoshi is resting';
  $('live-sub').textContent = on
    ? 'Every race right now is a Night Race, and his blocks can drop into your road.'
    : 'Hamsters run at night. When he wakes up, the races turn into Night Races.';
  $('live-speed').textContent = `${(live.speedMm / 1000).toFixed(2)} m/s`;
  $('live-rpm').textContent = String(live.rpm);
  $('live-km').textContent = `${live.kmToday.toFixed(2)} km`;
  $('live-block').textContent = `#${live.blockHeight}`;
}
refreshLive();
setInterval(refreshLive, 20_000);

async function refreshBoard() {
  const body = $('board-rows');
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error();
    const { rows } = (await res.json()) as { rows: { name: string; elo: number; wins: number; losses: number; bestMs: number | null }[] };
    body.textContent = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'muted';
      td.textContent = 'No ranked races yet. Win one and the top spot is yours.';
      tr.append(td);
      body.append(tr);
      return;
    }
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i === 0) tr.className = 'top1';
      for (const v of [String(i + 1), r.name, String(r.elo), String(r.wins), String(r.losses), r.bestMs ? `${(r.bestMs / 1000).toFixed(2)}s` : '–']) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      body.append(tr);
    });
  } catch {
    body.innerHTML = '<tr><td colspan="6" class="muted">The leaderboard is unavailable right now.</td></tr>';
  }
}
refreshBoard();

// ---------- screens ----------
function enterPlay() {
  screen = 'play';
  $('play').hidden = false;
  document.body.style.overflow = 'hidden';
  moveCanvas($('stage'));
  $('touch').hidden = !matchMedia('(pointer: coarse)').matches;
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
  session = Session.practice('practice', 0.7, live);
}

function failOnline(msg: string) {
  goHome();
  heroError(msg);
}

// ---------- online ----------
async function quickMatch() {
  heroError('');
  enterPlay();
  showWait('queue');
  try {
    lobby = await Conn.open('/ws/lobby');
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

async function joinRoom(code: string, kind: 'queue' | 'room') {
  heroError('');
  if (screen !== 'play') enterPlay();
  roomCode = code;
  if (kind === 'room') {
    history.replaceState(null, '', `/?r=${code}`);
    showWait('room', code);
  }
  try {
    conn = await Conn.open(`/ws/room/${code}`);
  } catch (e) {
    return failOnline(e instanceof Error ? e.message : 'Could not reach the server.');
  }
  conn.startClock();
  conn.on(onServer);
  conn.onClose(() => {
    if (screen === 'play' && conn) {
      conn = null;
      if (!resultShown) failOnline('Disconnected from the race.');
    }
  });
}

function sendHello() {
  mySeed = randomHex(16);
  conn?.send({ type: 'hello', name: myName(), seed: mySeed, pid, wd: navigator.webdriver === true });
}

function onServer(m: ServerMsg) {
  switch (m.type) {
    case 'welcome':
      you = m.you;
      nextCommit = m.commit;
      sendHello();
      break;
    case 'roster': {
      const other = m.names[you === 0 ? 1 : 0];
      if (waitKind === 'room' && other) $('wait-sub').textContent = `${other} is here. Starting…`;
      break;
    }
    case 'start':
      commitAtStart = m.commit;
      liveAtStart = m.live;
      waitKind = null;
      rivalLeft = false;
      resultShown = false;
      $('wait').hidden = true;
      $('result').hidden = true;
      arena.resetCourse();
      hud.reset();
      session = Session.online(conn!, m.t0, m.names, you, m.live);
      if (practiceWhileWaiting) {
        practiceWhileWaiting = false;
        hudToastCenter('RIVAL FOUND!');
      }
      break;
    case 'course':
      session.addObstacles(m.obs);
      break;
    case 'snap':
      if (session.mode === 'online') session.onSnap(m.p);
      break;
    case 'end':
      if (session.mode === 'online') {
        session.ended = true;
        session.onSnap(m.final);
      }
      nextCommit = m.nextCommit;
      showOnlineResult(m);
      break;
    case 'rematch_wait':
      $('res-wait').textContent = 'Your rival wants a rematch.';
      break;
    case 'left':
      rivalLeft = true;
      if (resultShown) {
        $('res-wait').textContent = 'Your rival left. Press rematch to wait for a new one in this room.';
      } else if (session.mode === 'online' && !session.ended) {
        // The forfeit result arrives separately.
      }
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

const fmt = (s: PState) => (s.finishTick >= 0 ? `${(finishTime(s) / TICK_HZ).toFixed(2)}s` : `${Math.min(500, s.dist).toFixed(0)} m`);

function fillGrid(me: PState, op: PState, names: [string, string]) {
  const g = $('res-grid');
  g.textContent = '';
  const rows: [string, string, string][] = [
    ['', names[0], names[1]],
    ['Time', fmt(me), fmt(op)],
    ['Bonks', String(me.crashes), String(op.crashes)],
    ['Overheats', String(me.overheats), String(op.overheats)],
    ['Cat scares', String(me.scares), String(op.scares)],
    ['Golden seeds', String(me.seeds), String(op.seeds)],
    ['Chilis eaten', String(me.chilis), String(op.chilis)],
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
  const meIdx = you;
  const me = m.final[meIdx];
  const op = m.final[meIdx === 0 ? 1 : 0];
  const won = m.winner === meIdx;
  $('res-title').textContent = m.winner === -1 ? 'DEAD HEAT!' : won ? 'YOU WIN!' : 'SO CLOSE!';
  $('res-sub').textContent =
    m.reason === 'forfeit' ? (won ? 'Your rival left the race.' : 'You left the race.') : m.reason === 'timeout' ? 'Time ran out. The longer distance wins.' : won ? 'Fastest wheel on the road.' : 'Rematch and get them back.';
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
    return !!r && r.d === o.d && r.kind === o.kind && r.lane === o.lane && (r.dur ?? 0) === (o.dur ?? 0);
  });
  check(okSeen && (await courseHash(regen)) === m.courseHash, 'Every obstacle you saw was built from those seeds', m.courseHash.slice(0, 16) + '…');
  const h = m.human[meIdx];
  check(h.verdict !== 'steady', h.verdict === 'few' ? 'Rhythm: not enough presses to judge' : h.verdict === 'human' ? `Rhythm looks human (${h.rate.toFixed(1)}/s, wobble ${(h.cv * 100).toFixed(0)}%)` : 'Rhythm looks scripted, so this race is not ranked');
  check(true, 'Replay fingerprint', m.inputHash.slice(0, 24) + '…');
}

function showPracticeResult() {
  resultShown = true;
  const me = session.me;
  const op = session.opp;
  const won = finishTime(me) < finishTime(op);
  $('res-title').textContent = won ? 'YOU BEAT THE BOT!' : 'THE BOT WINS';
  $('res-sub').textContent = practiceWhileWaiting ? "Still waiting for a rival. Go again, we'll pull you in when they arrive." : 'Practice race. Nothing is recorded.';
  fillGrid(me, op, session.names);
  $('res-checks').textContent = '';
  const h = humanReport(me);
  check(h.verdict !== 'steady', h.verdict === 'human' ? `Rhythm looks human (${h.rate.toFixed(1)}/s)` : h.verdict === 'few' ? 'Rhythm: not enough presses to judge' : 'Rhythm looks scripted');
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
const KEYMAP: Record<string, Key> = {
  KeyA: 'L', ArrowLeft: 'L', KeyD: 'R', ArrowRight: 'R',
  Space: 'J', KeyW: 'U', ArrowUp: 'U', KeyS: 'D', ArrowDown: 'D',
};
window.addEventListener('keydown', (e) => {
  if (screen !== 'play') return;
  const k = KEYMAP[e.code];
  if (!k) return;
  e.preventDefault();
  // Ignore held-key auto-repeat and events synthesised by scripts on the page.
  if (e.repeat || !e.isTrusted) return;
  if (!$('result').hidden || !$('wait').hidden) return;
  session.press(k);
});
document.querySelectorAll<HTMLButtonElement>('#touch .pad').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!e.isTrusted) return;
    const k = b.dataset.key === 'LANE' ? (session.me.lane === 0 ? 'U' : 'D') : (b.dataset.key as Key);
    session.press(k);
  });
});

// ---------- main loop ----------
function frame(now: number) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  if (screen === 'landing' && !heroVisible) return;
  session.update();

  if (session.mode === 'attract') {
    if (session.me.finishTick >= 0 && session.opp.finishTick >= 0 || session.me.tick >= MAX_TICKS) {
      session = Session.practice('attract', 0.7, live);
      arena.resetCourse();
    }
  } else if (session.mode === 'practice' && !practiceEnding && (session.me.finishTick >= 0 || session.opp.finishTick >= 0)) {
    practiceEnding = true;
    const s = session;
    setTimeout(() => session === s && showPracticeResult(), 900);
  }

  if (waitKind && !$('wait').hidden) {
    const sec = Math.floor((now - waitingSince) / 1000);
    $('wait-timer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (sec >= 12) $('wait-ideas').hidden = false;
  }

  const night = !!session.live?.active;
  arena.render({ state: session.me, course: session.course, night }, { state: session.oppView(), course: session.course, night }, t);

  if (screen === 'play') {
    hud.update(session.names, session.me, session.oppView(), session.cadence());
    const cd = session.countdownMs();
    const cdEl = $('countdown');
    if (cd > 0) {
      cdEl.hidden = false;
      const n = Math.ceil(cd / 1000);
      cdEl.innerHTML = n > 3 ? '<div>READY<small>alternate A / D · space jumps · W / S lanes</small></div>' : `<div>${n}</div>`;
    } else if (cd > -700) {
      cdEl.hidden = false;
      cdEl.innerHTML = '<div>GO!</div>';
    } else cdEl.hidden = true;
    $('night-badge').hidden = !night;
  }
}
requestAnimationFrame(frame);

// Invite links: /?r=code
const invite = new URLSearchParams(location.search).get('r');
if (invite && ROOM_CODE.test(invite)) joinRoom(invite, 'room');

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
  };
}
