import type { Obs } from './course';
import type { Key, PState } from './sim';
import type { HumanReport } from './stats';
import type { ResultJson, TicketJson } from './escrow';

export interface LiveInfo {
  active: boolean;
  rpm: number;
  speedMm: number;
  kmToday: number;
  blockHeight: string;
}

export type ClientMsg =
  | { type: 'hello'; name: string; seed: string; wd: boolean }
  | { type: 'in'; a: [number, Key][] }
  | { type: 'ping'; c: number }
  | { type: 'rematch'; seed: string }
  /** "I just sent my deposit": the server checks the contract right away instead of waiting. */
  | { type: 'paid' };

export interface EndInfo {
  winner: 0 | 1 | -1;
  reason: 'tired' | 'timeout' | 'forfeit' | 'abandoned';
  final: [PState, PState];
  reveal: { serverSeed: string; seeds: [string, string] };
  courseHash: string;
  inputHash: string;
  human: [HumanReport, HumanReport];
  ranked: boolean;
  nextCommit: string;
}

export type ServerMsg =
  | { type: 'welcome'; you: 0 | 1; commit: string; code: string; resumed?: boolean; stake: number }
  /** Staked room: both players put their stake in with this ticket before the race starts. */
  | { type: 'stake'; ticket: TicketJson; sig: `0x${string}`; escrow: `0x${string}`; token: `0x${string}` }
  | { type: 'stake_status'; paid: [boolean, boolean] }
  /** Somebody didn't pay in time: no race. Whoever did pay takes it back with cancel(). */
  | { type: 'stake_failed'; matchId: `0x${string}`; paid: [boolean, boolean] }
  /** The signed result for the contract. The winner (or either player, for a draw) submits it. */
  | { type: 'payout'; result: ResultJson; sig: `0x${string}`; escrow: `0x${string}`; stake: string }
  | { type: 'peer'; away: boolean }
  | { type: 'roster'; names: (string | null)[] }
  | { type: 'start'; t0: number; names: [string, string]; live: LiveInfo | null; commit: string }
  | { type: 'course'; obs: Obs[] }
  | { type: 'snap'; p: [PState, PState] }
  /** The rival's key presses as they arrive, for drawing them smoothly. Display only. */
  | { type: 'oin'; a: [number, Key][] }
  | ({ type: 'end' } & EndInfo)
  | { type: 'pong'; c: number; s: number }
  | { type: 'rematch_wait' }
  | { type: 'left' }
  | { type: 'matched'; code: string; stake: number }
  | { type: 'queue'; waiting: number }
  | { type: 'error'; msg: string };

export const ROOM_CODE = /^[a-z0-9]{6,12}$/;

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 16);
  return s || 'Hamster';
}
