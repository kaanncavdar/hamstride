import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface BoardRow {
  name: string;
  elo: number;
  wins: number;
  losses: number;
  bestMs: number | null;
}

export interface MatchRecord {
  a: { key: string; name: string };
  b: { key: string; name: string };
  /** 0 = a won, 1 = b won. */
  winner: 0 | 1;
  winnerMs: number | null;
}

/** Leaderboard in Durable Object SQLite storage. Player keys are hashes of a browser-held secret. */
export class Board extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, elo INTEGER NOT NULL DEFAULT 1000,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, best_ms INTEGER, updated INTEGER NOT NULL)`);
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
      'UPDATE players SET wins = wins + 1, best_ms = CASE WHEN ? IS NULL THEN best_ms WHEN best_ms IS NULL OR ? < best_ms THEN ? ELSE best_ms END WHERE key = ?',
      m.winnerMs, m.winnerMs, m.winnerMs, w.key,
    );
    sql.exec('UPDATE players SET losses = losses + 1 WHERE key = ?', l.key);
  }

  async top(limit = 25): Promise<BoardRow[]> {
    return this.ctx.storage.sql
      .exec<{ name: string; elo: number; wins: number; losses: number; best_ms: number | null }>(
        'SELECT name, elo, wins, losses, best_ms FROM players WHERE wins + losses > 0 ORDER BY elo DESC, wins DESC LIMIT ?',
        Math.min(100, limit),
      )
      .toArray()
      .map((r) => ({ name: r.name, elo: r.elo, wins: r.wins, losses: r.losses, bestMs: r.best_ms }));
  }
}
