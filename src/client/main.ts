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
import { listWallets, me as whoAmI, short, signIn, signOut, type Eip1193, type WalletInfo } from './wallet';
import { claim, depositStake, readMatch, refundBoth, takeBack, txLink } from './stake';
import { isStakeAmount, ONE_SQK, payout, STATUS, TIERS, type ResultJson, type TicketJson } from '../shared/escrow';
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

let signingIn = false;
async function connectWith(w: WalletInfo) {
  // One sign-in at a time: a second click would only queue a second request in the wallet.
  if (signingIn) return;
  signingIn = true;
  const buttons = [...$('wallet-list').querySelectorAll('button')] as HTMLButtonElement[];
  buttons.forEach((b) => (b.disabled = true));
  const status = $('wallet-status');
  let line = `Opening ${w.name}…`;
  status.textContent = line;
  // If the wallet's window doesn't show up (it can open behind this one), say where to find it.
  const hint = setTimeout(() => (status.textContent = `${line} No window? Click the ${w.name} icon in your browser's toolbar: the request is waiting there.`), 6000);
  const show = (l: string) => {
    line = l;
    status.textContent = l;
  };
  try {
    try {
      account = await signIn(w, show);
    } catch (e) {
      // A wallet that was still switching networks can reject the signature request once: try again,
      // unless the player said no.
      if ((e as { code?: number }).code === 4001) throw e;
      account = await signIn(w, show);
    }
    activeWallet = w;
    w.provider.on?.('accountsChanged', onAccountsChanged);
    $('wallets').hidden = true;
    paintWallet();
    heroError('');
    refreshMySqk();
  } catch (e) {
    const code = (e as { code?: number }).code;
    const msg = (e as { message?: string })?.message;
    status.textContent = code === 4001 ? 'You cancelled in the wallet. Nothing was signed.' : `Sign-in did not finish: ${(msg ?? 'unknown error').replace(/\.$/, '')}. Try again.`;
  } finally {
    clearTimeout(hint);
    signingIn = false;
    buttons.forEach((b) => (b.disabled = false));
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
const joinQuery = (extra: string) => [guestQuery(), extra].filter(Boolean).join('&');

/** Races for SQK need a real signed-in wallet (no guests), even in development. */
async function needRealWallet(): Promise<boolean> {
  if (!stakeEnabled) {
    heroError('Races for SQK are not switched on yet.');
    return false;
  }
  if (account) return true;
  heroError('Connect your wallet to race for SQK.');
  openWallets();
  return false;
}

// ---------- screens ----------
function enterPlay() {
  screen = 'play';
  $('play').hidden = false;
  $('pause').hidden = true;
  fullBtn.hidden = !canFull;
  keepAwake();
  document.body.style.overflow = 'hidden';
  moveCanvas($('stage'));
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
  $('pause').hidden = true;
  letSleep();
  $('wait').hidden = true;
  $('result').hidden = true;
  $('stake').hidden = true;
  stakeTimerStop();
  $('countdown').hidden = true;
  $('night-badge').hidden = true;
  document.body.style.overflow = '';
  history.replaceState(null, '', location.pathname);
  moveCanvas($('hero-stage'));
  session = Session.practice('attract', 0.7, live);
  arena.resetCourse();
  hud.reset();
  refreshBoard();
  refreshChallenges();
  refreshMySqk();
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
async function quickMatch(stake = 0) {
  heroError('');
  if (stake ? !(await needRealWallet()) : !(await needWallet())) return;
  enterPlay();
  showWait('queue');
  if (stake) $('wait-title').textContent = `Finding a rival at the ${stake} SQK table…`;
  try {
    lobby = await Conn.open('/ws/lobby', joinQuery(stake ? `stake=${stake}` : ''));
  } catch (e) {
    return failOnline(e instanceof Error ? e.message : 'Could not reach the server.');
  }
  lobby.on((m) => {
    if (m.type === 'matched') {
      lobby?.close();
      lobby = null;
      joinRoom(m.code, 'queue', m.stake);
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

async function joinRoom(code: string, kind: 'queue' | 'room' | 'resume', stake = 0, listed = false) {
  heroError('');
  if (kind !== 'resume' && !(stake ? await needRealWallet() : await needWallet())) return;
  if (screen !== 'play') enterPlay();
  roomCode = code;
  if (kind === 'room') {
    history.replaceState(null, '', `/?r=${code}`);
    showWait('room', code);
  }
  try {
    conn = await Conn.open(`/ws/room/${code}`, joinQuery(stake ? `stake=${stake}${listed ? '&pub=1' : ''}` : ''));
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
      roomStake = m.stake ?? 0;
      if (roomStake && waitKind === 'room') {
        $('wait-title').textContent = `Race for ${roomStake} SQK`;
        $('wait-sub').textContent = `You each put in ${roomStake} SQK once your rival is here. The winner gets ${fmtSqk(payout(BigInt(roomStake) * ONE_SQK))} SQK.`;
      }
      if (!m.resumed) sendHello();
      break;
    case 'roster': {
      const other = m.names[you === 0 ? 1 : 0];
      if (other) rivalName = other;
      if (waitKind === 'room' && other) $('wait-sub').textContent = `${other} is here. Starting…`;
      break;
    }
    case 'start': {
      $('stake').hidden = true;
      stakeTimerStop();
      lastPayout = null;
      $('res-payout').hidden = true;
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
    case 'oin':
      session.onOppInputs(m.a);
      break;
    case 'peer':
      $('peer-banner').hidden = !m.away;
      break;
    case 'end':
      if (session.mode === 'online') session.finish(m.final);
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
    case 'stake':
      showStake(m);
      break;
    case 'stake_status':
      paintStakeStatus(m.paid);
      break;
    case 'stake_failed':
      onStakeFailed(m.matchId, m.paid);
      break;
    case 'payout':
      lastPayout = m;
      paintPayout();
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
  $('pause').hidden = true;
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
          ? 'Ten minutes and you both kept going. You had more energy left (or got further).'
          : m.winner === -1
            ? 'Ten minutes, both still running, exactly level.'
            : 'Ten minutes and you both kept going. Your rival had more energy left (or got further).'
        : m.reason === 'abandoned'
          ? 'Both players left, so it is a draw.'
          : m.winner === -1
            ? 'You both ran out of energy at the very same moment, so it is a draw.'
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
  $('pause').hidden = true;
  resultShown = true;
  coach.endRace();
  // Freeze the race here, so the numbers on screen match the table instead of the bot running on.
  session.pause();
  const me = session.me;
  const op = session.opp;
  const won = tiredAt(me) > tiredAt(op) || (!tired(me) && !tired(op) && winnerAtCap(me, op) === 0);
  $('res-title').textContent = won ? 'YOU OUTLASTED THE BOT!' : 'OUT OF ENERGY';
  const how = won ? 'The bot ran out of energy first.' : `${session.names[1].replace(' (bot)', '')} kept running longer.`;
  $('res-sub').textContent = practiceWhileWaiting
    ? `${how} Still waiting for a rival: go again, we'll pull you in when they arrive.`
    : `${how} Practice race, nothing is recorded.`;
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
$('btn-stake-room').addEventListener('click', () => {
  const n = Number($<HTMLInputElement>('stake-amount').value);
  if (!isStakeAmount(n)) return heroError('Pick a whole number of SQK between 1 and 100000.');
  joinRoom(newRoomCode(), 'room', n, $<HTMLInputElement>('stake-public').checked);
});
$('btn-deposit').addEventListener('click', doDeposit);
$('btn-stake-back').addEventListener('click', doTakeBack);
$('btn-stake-leave').addEventListener('click', goHome);
$('btn-claim').addEventListener('click', doClaim);
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
  save('wd.name', nameInput.value.trim());
  $('invite-note').hidden = true;
  $('join-form').classList.remove('invited');
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
const paintMute = () => {
  muteBtn.querySelector('.tx')!.textContent = isMuted() ? 'SOUND: OFF' : 'SOUND: ON';
  muteBtn.querySelector('.ic')!.textContent = isMuted() ? '🔇' : '🔈';
  muteBtn.setAttribute('aria-pressed', String(isMuted()));
};
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
$('btn-leave').addEventListener('click', askLeave);

// ---------- pause, full screen, leaving ----------
/** A race this browser is in right now (not the menu's background race, not a finished one). */
const racing = () => screen === 'play' && session.mode !== 'attract' && !resultShown && !session.ended;
const raceOnline = () => racing() && session.mode === 'online' && !!conn;

function openPause(kind: 'pause' | 'leave') {
  const leaveOnline = kind === 'leave';
  if (!leaveOnline) session.pause();
  $('pause-title').textContent = leaveOnline ? 'Leave the race?' : 'PAUSED';
  $('pause-text').textContent = leaveOnline
    ? `Your hamster keeps running without you, and if it tires first your rival wins${roomStake ? ' the pot' : ''}.`
    : 'The wheel stops while you\'re away.';
  $('btn-resume').textContent = leaveOnline ? 'KEEP RACING' : 'RESUME';
  $('pause-keys').hidden = leaveOnline || touchFirst;
  $('pause').hidden = false;
  $('btn-resume').focus();
}
function closePause() {
  $('pause').hidden = true;
  session.resume();
}
function askLeave() {
  if (raceOnline()) openPause('leave');
  else if (racing() && session.mode === 'practice') openPause('pause');
  else goHome();
}
$('btn-pause').addEventListener('click', () => openPause('pause'));
$('btn-resume').addEventListener('click', closePause);
$('btn-pause-leave').addEventListener('click', () => {
  $('pause').hidden = true;
  goHome();
});

// Practice stops when you switch tabs or windows, so you never come back to a race that ran on without you.
const autoPause = () => {
  if (racing() && session.mode === 'practice' && !session.paused && session.countdownMs() < 0) openPause('pause');
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) autoPause();
  else if (screen === 'play') keepAwake();
});
window.addEventListener('blur', autoPause);

// Full screen where the browser allows it (not on iPhone).
const fullBtn = $('btn-full');
const canFull = !!document.fullscreenEnabled;
const paintFull = () => (fullBtn.querySelector('.tx')!.textContent = document.fullscreenElement ? 'EXIT FULL SCREEN' : 'FULL SCREEN');
function toggleFull() {
  if (!canFull) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
fullBtn.addEventListener('click', toggleFull);
document.addEventListener('fullscreenchange', paintFull);

// Keep a phone's screen on during a race.
let wake: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (!wake && nav.wakeLock) wake = await nav.wakeLock.request('screen');
  } catch {
    /* not allowed here: fine */
  }
}
function letSleep() {
  wake?.release().catch(() => {});
  wake = null;
}

// Closing the tab mid-race forfeits it: ask first.
window.addEventListener('beforeunload', (e) => {
  if (raceOnline() || (roomStake > 0 && !$('stake').hidden)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// If the graphics card resets, say so instead of showing a frozen picture.
document.body.append($('gl-lost'));
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  $('gl-lost').hidden = false;
});
$('btn-reload').addEventListener('click', () => location.reload());
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
  if (!e.repeat && e.isTrusted && !(e.target as HTMLElement).closest?.('input, textarea')) {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (!$('pause').hidden) closePause();
      else if (e.code === 'Escape' || session.mode === 'practice') askLeave();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyF') return toggleFull();
    if (e.code === 'KeyM') return muteBtn.click();
  }
  if (!$('pause').hidden) return;
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
// Automatic quality: if frames keep coming slower than ~50 a second (a weaker GPU, or two game
// windows at once), render at a lower resolution. It only steps down, so it never flickers.
const perf = { last: 0, ema: 16.7, scale: 1, changedAt: 0 };
function watchFrameRate(now: number) {
  const dt = now - perf.last;
  perf.last = now;
  if (dt <= 0 || dt > 250 || document.hidden) return; // a tab switch, not a slow frame
  perf.ema = perf.ema * 0.95 + dt * 0.05;
  if (perf.ema > 20.5 && perf.scale > 0.55 && now - perf.changedAt > 2000) {
    perf.scale = Math.max(0.55, +(perf.scale - 0.15).toFixed(2));
    perf.changedAt = now;
    perf.ema = 16.7;
    (arena as { setQuality?: (s: number) => void }).setQuality?.(perf.scale);
  }
}

const touchFirst = matchMedia('(pointer: coarse)').matches;
const HOW_TO = touchFirst
  ? 'swipe ← → to change lane · ↑ to jump · ↓ to slide · every bump costs ⚡'
  : '← → change lane · ↑ jump · ↓ slide · every bump costs ⚡';

function frame(now: number) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  if (screen === 'landing' && !heroVisible) return;
  watchFrameRate(now);
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
  // Drawing uses the smooth forward-run rival; sounds and the HUD use the server-confirmed one, so a
  // guess about the last few milliseconds never shows a bump or a finish that didn't happen.
  const oppSure = session.mode === 'online' ? session.opp : opp;
  if (screen === 'play' && session.mode !== 'attract') {
    playEvents(session.me, oppSure);
    coach.update(session.me, session.course, session.countdownMs());
  }

  if (screen === 'play') {
    // While waiting for a rival or for both stakes, the wheel behind is only the menu's demo race:
    // don't label its hamsters as you and your rival.
    $('hud').hidden = session.mode === 'attract';
    $('btn-pause').hidden = !(session.mode === 'practice' && racing());
    hud.update(session.names, session.me, oppSure, arena.nights());
    const cd = session.countdownMs();
    const cdEl = $('countdown');
    if (cd > 0) {
      cdEl.hidden = false;
      const n = Math.ceil(cd / 1000);
      cdEl.innerHTML = n > 3 ? `<div>READY<small>${HOW_TO}</small></div>` : `<div>${n}</div>`;
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
// ---------- races for SQK ----------
let stakeEnabled = false;
let roomStake = 0;
let stakeMsg: { ticket: TicketJson; sig: `0x${string}`; escrow: `0x${string}`; token: `0x${string}` } | null = null;
let stakeTimer: ReturnType<typeof setInterval> | null = null;
let lastPayout: { result: ResultJson; sig: `0x${string}`; escrow: `0x${string}`; stake: string } | null = null;
let failedMatch: { matchId: `0x${string}`; escrow: `0x${string}`; deadline: number } | null = null;
let myPaid = false;
let rivalName = '';

const fmtSqk = (wei: bigint) => {
  const whole = wei / ONE_SQK;
  const frac = ((wei % ONE_SQK) * 100n) / ONE_SQK;
  return frac ? `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}` : String(whole);
};

/** The wallet that holds the signed-in account (finds it again after a page reload). */
async function walletProvider(): Promise<Eip1193> {
  if (activeWallet) return activeWallet.provider;
  const list = await listWallets();
  for (const w of list) {
    const accs = (await w.provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[];
    if (account && accs.some((a) => a.toLowerCase() === account!.toLowerCase())) {
      activeWallet = w;
      return w.provider;
    }
  }
  if (list[0]) return list[0].provider;
  throw new Error('No browser wallet found.');
}

async function refreshStakeConfig() {
  const r = await fetch('/api/stake/config', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  stakeEnabled = !!r?.enabled;
  $('sqk-off').hidden = stakeEnabled;
  $('tiers').hidden = !stakeEnabled;
  ($('sqk-box').querySelector('details') as HTMLElement).hidden = !stakeEnabled;
  const tiers = $('tiers');
  tiers.textContent = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.className = 'btn small tier';
    b.textContent = `${t} SQK`;
    b.addEventListener('click', () => quickMatch(t));
    tiers.append(b);
  }
  if (stakeEnabled) {
    refreshChallenges();
    refreshMySqk();
  }
}

async function refreshChallenges() {
  if (!stakeEnabled || screen !== 'landing') return;
  const r = await fetch('/api/challenges', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  const box = $('challenges');
  box.textContent = '';
  const rows = (r?.rows ?? []) as { code: string; stake: number; name: string; wallet: string }[];
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'No open challenges right now. Create one above.';
    box.append(p);
    return;
  }
  for (const c of rows) {
    const row = document.createElement('div');
    row.className = 'challenge';
    const who = document.createElement('span');
    who.textContent = `${c.name} (${c.wallet})`;
    const amt = document.createElement('b');
    amt.textContent = `${c.stake} SQK`;
    const go = document.createElement('button');
    go.className = 'btn small';
    go.textContent = 'ACCEPT';
    go.addEventListener('click', () => joinRoom(c.code, 'room'));
    row.append(who, amt, go);
    box.append(row);
  }
}

/** Your unfinished races for SQK: wins to claim, draws to settle, stakes to take back. */
async function refreshMySqk() {
  const box = $('my-sqk');
  box.hidden = true;
  if (!stakeEnabled || !account) return;
  const r = await fetch('/api/stakes', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const cfg = await fetch('/api/stake/config', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  if (!r?.rows?.length || !cfg?.escrow) return;
  let p: Eip1193 | null = null;
  try {
    p = await walletProvider();
  } catch {
    return;
  }
  box.textContent = '';
  const now = Math.floor(Date.now() / 1000);
  const me = account.toLowerCase();
  let n = 0;
  for (const row of r.rows as { matchId: `0x${string}`; a: string; b: string; stake: string; deadline: number; state: string; result: ResultJson | null; sig: `0x${string}` | null }[]) {
    const chain = await readMatch(p, cfg.escrow, row.matchId).catch(() => null);
    if (!chain || chain.status === STATUS.Settled || chain.status === STATUS.Refunded || chain.status === STATUS.None) continue;
    const iAmA = row.a === me;
    const stake = fmtSqk(BigInt(row.stake));
    let label = '';
    let act: (() => Promise<`0x${string}`>) | null = null;
    if (chain.status === STATUS.Active && row.result && row.sig) {
      const mine = row.result.outcome === 3 || row.result.outcome === (iAmA ? 1 : 2);
      if (!mine) continue;
      label = row.result.outcome === 3 ? `Draw: take your ${stake} SQK back` : `You won ${fmtSqk(payout(BigInt(row.stake)))} SQK`;
      const res = row.result;
      const sig = row.sig;
      act = () => claim(p!, cfg.escrow, res, sig);
    } else if (chain.status === STATUS.Open && (iAmA ? chain.paidA : chain.paidB) && now > Number(chain.joinDeadline)) {
      label = `Race never started: take your ${stake} SQK back`;
      act = () => takeBack(p!, cfg.escrow, row.matchId);
    } else if (chain.status === STATUS.Active && now > Number(chain.settleDeadline)) {
      label = `No result: refund both ${stake} SQK stakes`;
      act = () => refundBoth(p!, cfg.escrow, row.matchId);
    }
    if (!act) continue;
    const line = document.createElement('div');
    line.className = 'challenge';
    const t = document.createElement('span');
    t.textContent = label;
    const b = document.createElement('button');
    b.className = 'btn small primary';
    b.textContent = 'DO IT';
    const run = act;
    b.addEventListener('click', async () => {
      b.disabled = true;
      t.textContent = 'Confirm in your wallet…';
      try {
        await run();
        t.textContent = 'Done ✓';
      } catch (e) {
        t.textContent = e instanceof Error ? e.message : 'Failed.';
        b.disabled = false;
      }
    });
    line.append(t, b);
    box.append(line);
    n++;
  }
  box.hidden = n === 0;
}

function stakeTimerStop() {
  if (stakeTimer) clearInterval(stakeTimer);
  stakeTimer = null;
}

function showStake(m: { ticket: TicketJson; sig: `0x${string}`; escrow: `0x${string}`; token: `0x${string}` }) {
  stakeMsg = m;
  failedMatch = null;
  myPaid = false;
  const stake = BigInt(m.ticket.stake);
  $('wait').hidden = true;
  $('result').hidden = true;
  $('stake').hidden = false;
  $('stake-title').textContent = `Race for ${fmtSqk(stake)} SQK`;
  $('stake-sub').textContent = `You both put in ${fmtSqk(stake)} SQK. The winner gets ${fmtSqk(payout(stake))} SQK (5% fee); a draw gives both back. The race starts when both stakes are in.`;
  $('stake-rival-name').textContent = rivalName || 'Rival';
  $('stake-me').textContent = 'not yet';
  $('stake-rival').textContent = 'not yet';
  $('stake-error').textContent = '';
  $('stake-step').textContent = 'Needs a little Sepolia ETH for the network fee.';
  $('btn-stake-back').hidden = true;
  const btn = $<HTMLButtonElement>('btn-deposit');
  btn.hidden = false;
  btn.disabled = false;
  btn.textContent = `PUT IN ${fmtSqk(stake)} SQK`;
  stakeTimerStop();
  const tick = () => {
    const left = Math.max(0, m.ticket.joinDeadline - Math.floor(Date.now() / 1000));
    $('stake-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (left === 0) btn.disabled = true;
  };
  tick();
  stakeTimer = setInterval(tick, 500);
}

function paintStakeStatus(paid: [boolean, boolean]) {
  const mine = paid[you];
  const theirs = paid[you === 0 ? 1 : 0];
  if (mine) myPaid = true;
  $('stake-me').textContent = mine ? 'in ✓' : 'not yet';
  $('stake-rival').textContent = theirs ? 'in ✓' : 'not yet';
  if (mine) $<HTMLButtonElement>('btn-deposit').hidden = true;
  if (mine && theirs) $('stake-step').textContent = 'Both stakes are in. Starting…';
  else if (mine) $('stake-step').textContent = 'Your stake is in. Waiting for your rival…';
}

async function doDeposit() {
  if (!stakeMsg) return;
  const btn = $<HTMLButtonElement>('btn-deposit');
  btn.disabled = true;
  $('stake-error').textContent = '';
  try {
    const p = await walletProvider();
    await depositStake(p, stakeMsg, (s) => ($('stake-step').textContent = s));
    myPaid = true;
    $('stake-me').textContent = 'in ✓';
    btn.hidden = true;
    $('stake-step').textContent = 'Your stake is in. Waiting for your rival…';
    conn?.send({ type: 'paid' });
  } catch (e) {
    $('stake-error').textContent = e instanceof Error ? e.message : 'The deposit did not go through.';
    btn.disabled = false;
  }
}

function onStakeFailed(matchId: `0x${string}`, paid: [boolean, boolean]) {
  stakeTimerStop();
  const iPaid = paid[you] || myPaid;
  $('stake').hidden = false;
  $<HTMLButtonElement>('btn-deposit').hidden = true;
  $('stake-timer').textContent = '';
  $('stake-step').textContent = '';
  $('stake-error').textContent = '';
  $('stake-sub').textContent = iPaid
    ? "Your rival didn't put in their stake in time, so there is no race. Take your SQK back below (it needs a small network fee)."
    : 'Not both stakes went in on time, so there is no race. Nothing was taken from you.';
  if (iPaid && stakeMsg) {
    failedMatch = { matchId, escrow: stakeMsg.escrow, deadline: stakeMsg.ticket.joinDeadline };
    $('btn-stake-back').hidden = false;
  }
}

async function doTakeBack() {
  if (!failedMatch) return;
  const b = $<HTMLButtonElement>('btn-stake-back');
  b.disabled = true;
  $('stake-error').textContent = '';
  try {
    const p = await walletProvider();
    $('stake-step').textContent = 'Confirm in your wallet…';
    const hash = await takeBack(p, failedMatch.escrow, failedMatch.matchId);
    $('stake-step').innerHTML = '';
    const a = document.createElement('a');
    a.href = txLink(hash);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Your SQK is back ✓ (view on Etherscan)';
    $('stake-step').append(a);
    b.hidden = true;
  } catch (e) {
    $('stake-error').textContent = e instanceof Error ? e.message : 'Failed.';
    b.disabled = false;
  }
}

function paintPayout() {
  const box = $('res-payout');
  if (!lastPayout) {
    box.hidden = true;
    return;
  }
  const stake = BigInt(lastPayout.stake);
  const o = lastPayout.result.outcome;
  const iWon = o === (you === 0 ? 1 : 2);
  const btn = $<HTMLButtonElement>('btn-claim');
  box.hidden = false;
  btn.disabled = false;
  $('pay-step').textContent = '';
  if (o === 3) {
    $('pay-text').textContent = `Draw: you each get your ${fmtSqk(stake)} SQK back.`;
    btn.textContent = `TAKE BACK ${fmtSqk(stake)} SQK`;
    btn.hidden = false;
  } else if (iWon) {
    $('pay-text').textContent = `You won ${fmtSqk(payout(stake))} SQK! Claim it from the contract (small network fee). You can also claim later from the home screen.`;
    btn.textContent = `CLAIM ${fmtSqk(payout(stake))} SQK`;
    btn.hidden = false;
  } else {
    $('pay-text').textContent = `Your rival takes the pot this time.`;
    btn.hidden = true;
  }
}

async function doClaim() {
  if (!lastPayout) return;
  const btn = $<HTMLButtonElement>('btn-claim');
  btn.disabled = true;
  try {
    const p = await walletProvider();
    $('pay-step').textContent = 'Confirm in your wallet…';
    const hash = await claim(p, lastPayout.escrow, lastPayout.result, lastPayout.sig);
    $('pay-step').textContent = '';
    const a = document.createElement('a');
    a.href = txLink(hash);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Paid out ✓ (view on Etherscan)';
    $('pay-step').append(a);
    btn.hidden = true;
  } catch (e) {
    $('pay-step').textContent = e instanceof Error ? e.message : 'The claim did not go through.';
    btn.disabled = false;
  }
}

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
  refreshStakeConfig();
  setInterval(refreshLive, 20_000);
  setInterval(refreshChallenges, 15_000);
  setInterval(refreshTotals, 120_000);
  // Invite links: /?r=code
  // Invite links (/?r=code) fill in the JOIN box, so the friend can pick a name (and connect a wallet)
  // before the race, instead of joining as "Hamster".
  const invite = new URLSearchParams(location.search).get('r')?.toLowerCase();
  if (invite && ROOM_CODE.test(invite)) {
    $<HTMLInputElement>('join-code').value = invite;
    $('invite-note').hidden = false;
    $('join-form').classList.add('invited');
    nameInput.focus();
    nameInput.select();
  }
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
    /** A practice race against a bot of the given skill (for recording clips). */
    race(botSkill = 0.9) {
      enterPlay();
      startPractice();
      session = Session.practice('practice', botSkill, live);
    },
    /** One bot decision for your hamster, applied now: call once per frame when driving the clock by hand. */
    botStep(skill = 0.9) {
      const b = new Bot(randomHex(16), skill);
      return () => {
        for (const k of b.keys(session.me, session.course)) press(k);
      };
    },
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
