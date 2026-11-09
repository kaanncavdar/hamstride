import { CLASSIC, GAME_RULES, type Rules } from '../shared/sim';
import { MAX_TICKS } from '../shared/constants';

/**
 * The game is the six-lane split wheel seen from behind (scene-wide.ts), with speed that never
 * stops rising. The older 45° two-wheel version is kept for reference behind VITE_VARIANT=classic
 * (npm run dev:classic, port 5174); it is practice-only and uses its old levelling-off speed.
 */
export const WIDE = import.meta.env.VITE_VARIANT !== 'classic';
export const RULES: Rules = WIDE ? GAME_RULES : CLASSIC;
export const TICK_CAP = WIDE ? MAX_TICKS : 60 * 180;
