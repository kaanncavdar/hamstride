import type { PState } from './sim';

export interface HumanReport {
  /** Presses per second while running. */
  rate: number;
  /** Coefficient of variation of the time between presses. Humans wobble; scripts don't. */
  cv: number;
  verdict: 'human' | 'steady' | 'few';
}

export function humanReport(s: PState, cvMin = 0.06): HumanReport {
  if (s.nIv < 40) return { rate: 0, cv: 0, verdict: 'few' };
  const mean = s.sumIv / s.nIv;
  const variance = Math.max(0, s.sumIv2 / s.nIv - mean * mean);
  const cv = Math.sqrt(variance) / mean;
  return { rate: 60 / mean, cv, verdict: cv < cvMin ? 'steady' : 'human' };
}
