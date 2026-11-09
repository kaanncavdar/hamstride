import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { randomHex } from '../src/shared/hash';

/** Quick match: pairs the first two players in the queue and sends both to a fresh room. */
export class Lobby extends DurableObject<Env> {
  private waiting: WebSocket[] = [];
  private ids = new WeakMap<WebSocket, string>();

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const id = req.headers.get('X-Player-Id') ?? '';
    this.ids.set(ws, id);
    // Never pair a wallet with itself (two tabs): the newer tab replaces the older one in the queue.
    for (const w of this.waiting) if (this.ids.get(w) === id) w.close(4000, 'replaced');
    this.waiting = this.waiting.filter((w) => w.readyState === WebSocket.READY_STATE_OPEN && this.ids.get(w) !== id);
    const other = this.waiting.shift();
    if (other) {
      const code = randomHex(5);
      for (const w of [other, ws]) {
        w.send(JSON.stringify({ type: 'matched', code }));
        w.close(1000, 'matched');
      }
    } else {
      this.waiting.push(ws);
      ws.send(JSON.stringify({ type: 'queue', waiting: 1 }));
      const drop = () => (this.waiting = this.waiting.filter((w) => w !== ws));
      ws.addEventListener('close', drop);
      ws.addEventListener('error', drop);
      // Any message from a waiting client is ignored; the socket only waits.
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
