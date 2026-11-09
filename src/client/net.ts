import { leadingZeroBits, sha256Hex } from '../shared/hash';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

/** Fetches a signed join ticket and solves its small proof-of-work. */
async function ticketQuery(): Promise<string> {
  const res = await fetch('/api/ticket', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not get a join ticket (${res.status}).`);
  const t: { c: string; s: string; bits: number } = await res.json();
  const batch = 256;
  for (let base = 0; base < 50_000_000; base += batch) {
    const hashes = await Promise.all(Array.from({ length: batch }, (_, i) => sha256Hex(`${t.c}:${base + i}`)));
    const hit = hashes.findIndex((h) => leadingZeroBits(h) >= t.bits);
    if (hit >= 0) return `c=${encodeURIComponent(t.c)}&s=${t.s}&n=${base + hit}`;
  }
  throw new Error('Could not solve the join ticket.');
}

export class Conn {
  private ws!: WebSocket;
  private handlers = new Set<(m: ServerMsg) => void>();
  private closeHandlers = new Set<() => void>();
  /** serverTime ≈ Date.now() + offset */
  offset = 0;
  rtt = 0;
  private bestRtt = Infinity;
  private pinger: ReturnType<typeof setInterval> | null = null;

  static async open(path: string, extra = ''): Promise<Conn> {
    const c = new Conn();
    const q = await ticketQuery();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    c.ws = new WebSocket(`${proto}://${location.host}${path}?${q}${extra ? `&${extra}` : ''}`);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener('open', () => resolve(), { once: true });
      c.ws.addEventListener('error', () => reject(new Error('Could not connect to the game server.')), { once: true });
    });
    c.ws.addEventListener('message', (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'pong') c.onPong(m.c, m.s);
      for (const h of c.handlers) h(m);
    });
    c.ws.addEventListener('close', () => {
      if (c.pinger) clearInterval(c.pinger);
      for (const h of c.closeHandlers) h();
    });
    return c;
  }

  /** Clock sync: a burst of pings, then one every 2 s. Keeps the sample with the lowest round trip. */
  startClock() {
    let n = 0;
    const burst = setInterval(() => {
      this.send({ type: 'ping', c: Date.now() });
      if (++n >= 6) clearInterval(burst);
    }, 120);
    this.pinger = setInterval(() => this.send({ type: 'ping', c: Date.now() }), 2000);
  }

  private onPong(c: number, s: number) {
    const now = Date.now();
    const rtt = now - c;
    this.rtt = rtt;
    if (rtt <= this.bestRtt * 1.2 || rtt < 40) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.offset = s - (c + rtt / 2);
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  on(h: (m: ServerMsg) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onClose(h: () => void) {
    this.closeHandlers.add(h);
  }

  send(m: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    if (this.pinger) clearInterval(this.pinger);
    this.handlers.clear();
    this.closeHandlers.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
