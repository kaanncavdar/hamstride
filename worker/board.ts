import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface BoardRow {
  name: string;
  /** Shortened wallet address, e.g. 0x12ab…9f3c, or null for guests. */
  wallet: string | null;
  elo: number;
  wins: number;
  losses: number;
  /** Longest winning run, metres. */
  bestM: number | null;
}

export interface MatchRecord {
  a: { key: string; name: string };
  b: { key: string; name: string };
  /** 0 = a won, 1 = b won. */
  winner: 0 | 1;
  /** The winner's distance, metres. */
  best: number;
}

/** Leaderboard in Durable Object SQLite storage. Player keys are hashes of a browser-held secret. */
export class Board extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, elo INTEGER NOT NULL DEFAULT 1000,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, best_ms INTEGER, updated INTEGER NOT NULL)`);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nonces (n TEXT PRIMARY KEY, exp INTEGER NOT NULL)');
  }

  private get(key: string, name: string) {
    const row = this.ctx.storage.sql.exec<{ elo: number }>('SELECT elo FROM players WHERE key = ?', key).toArray()[0];
    if (row) return row.elo;
    this.ctx.storage.sql.exec('INSERT INTO players (key, name, updated) VALUES (?, ?, ?)', key, name, Date.now());
    return 1000;
  }

  async record(m: MatchRecord): Promise<void> {
    if (m.a.key === m.b.key) return;
    const ea = this.get(m.a.key, m.a.name);
    const eb = this.get(m.b.key, m.b.name);
    const expA = 1 / (1 + 10 ** ((eb - ea) / 400));
    const scoreA = m.winner === 0 ? 1 : 0;
    const k = 32;
    const na = Math.round(ea + k * (scoreA - expA));
    const nb = Math.round(eb + k * (1 - scoreA - (1 - expA)));
    const now = Date.now();
    const w = m.winner === 0 ? m.a : m.b;
    const l = m.winner === 0 ? m.b : m.a;
    const sql = this.ctx.storage.sql;
    sql.exec('UPDATE players SET elo = ?, name = ?, updated = ? WHERE key = ?', na, m.a.name, now, m.a.key);
    sql.exec('UPDATE players SET elo = ?, name = ?, updated = ? WHERE key = ?', nb, m.b.name, now, m.b.key);
    sql.exec(
      // best_ms now holds the longest winning run in metres (column kept to avoid a migration).
      'UPDATE players SET wins = wins + 1, best_ms = CASE WHEN best_ms IS NULL OR ? > best_ms THEN ? ELSE best_ms END WHERE key = ?',
      m.best, m.best, w.key,
    );
    sql.exec('UPDATE players SET losses = losses + 1 WHERE key = ?', l.key);
  }

  /** Marks a sign-in nonce as used. Returns false if it was already used. */
  async consumeNonce(n: string, exp: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM nonces WHERE exp < ?', Math.floor(Date.now() / 1000));
    if (sql.exec('SELECT n FROM nonces WHERE n = ?', n).toArray().length) return false;
    sql.exec('INSERT INTO nonces (n, exp) VALUES (?, ?)', n, exp);
    return true;
  }

  async top(limit = 25): Promise<BoardRow[]> {
    return this.ctx.storage.sql
      .exec<{ key: string; name: string; elo: number; wins: number; losses: number; best_ms: number | null }>(
        'SELECT key, name, elo, wins, losses, best_ms FROM players WHERE wins + losses > 0 ORDER BY elo DESC, wins DESC LIMIT ?',
        Math.min(100, limit),
      )
      .toArray()
      .map((r) => ({
        name: r.name,
        wallet: r.key.startsWith('0x') ? `${r.key.slice(0, 6)}…${r.key.slice(-4)}` : null,
        elo: r.elo,
        wins: r.wins,
        losses: r.losses,
        bestM: r.best_ms,
      }));
  }
}
