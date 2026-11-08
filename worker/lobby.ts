import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { randomHex } from '../src/shared/hash';

/** Quick match: pairs the first two players in the queue and sends both to a fresh room. */
export class Lobby extends DurableObject<Env> {
  private waiting: WebSocket[] = [];

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    this.waiting = this.waiting.filter((w) => w.readyState === WebSocket.READY_STATE_OPEN);
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
