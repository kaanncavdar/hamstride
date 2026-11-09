import type { Obs } from './course';
import type { Key, PState } from './sim';
import type { HumanReport } from './stats';

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
  | { type: 'rematch'; seed: string };

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
  | { type: 'welcome'; you: 0 | 1; commit: string; code: string; resumed?: boolean }
  | { type: 'peer'; away: boolean }
  | { type: 'roster'; names: (string | null)[] }
  | { type: 'start'; t0: number; names: [string, string]; live: LiveInfo | null; commit: string }
  | { type: 'course'; obs: Obs[] }
  | { type: 'snap'; p: [PState, PState] }
  | ({ type: 'end' } & EndInfo)
  | { type: 'pong'; c: number; s: number }
  | { type: 'rematch_wait' }
  | { type: 'left' }
  | { type: 'matched'; code: string }
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
