import type { PState } from './sim';

export interface HumanReport {
  /** Average reaction to threats coming into view, milliseconds. */
  reactMs: number;
  /** How much the reactions vary (coefficient of variation). People wobble; scripts don't. */
  cv: number;
  verdict: 'human' | 'steady' | 'few';
}

/**
 * Humans need about 150–300 ms to react and are never the same twice. A run that reacts
 * faster than a human can, or with machine-like consistency, doesn't count for the leaderboard.
 */
export function humanReport(s: PState, cvMin = 0.12, minMs = 140): HumanReport {
  if (s.nR < 8) return { reactMs: 0, cv: 0, verdict: 'few' };
  const mean = s.sumR / s.nR;
  const variance = Math.max(0, s.sumR2 / s.nR - mean * mean);
  const cv = Math.sqrt(variance) / mean;
  const reactMs = (mean * 1000) / 60;
  return { reactMs, cv, verdict: reactMs < minMs || cv < cvMin ? 'steady' : 'human' };
}
