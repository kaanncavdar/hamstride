import { CLASSIC, RAMP, type Rules } from '../shared/sim';
import { MAX_TICKS } from '../shared/constants';

/**
 * Two versions of the game live side by side while Kaan picks one:
 * - classic: each hamster in its own big wheel seen at 45°, speed levels off, 3-minute cap.
 * - wide (VITE_VARIANT=wide, dev port 5174): one 6-lane wheel split down the middle, seen from
 *   behind, and the speed never stops rising, so somebody always runs out of energy.
 * The wide version is practice-only for now; online races use the classic rules on the server.
 */
export const WIDE = import.meta.env.VITE_VARIANT === 'wide';
export const RULES: Rules = WIDE ? RAMP : CLASSIC;
/** Safety cap only: at the wide version's speeds nobody lasts this long. */
export const TICK_CAP = WIDE ? 60 * 600 : MAX_TICKS;
/** Enough track for the longest possible run. */
export const COURSE_LEN = WIDE ? 20000 : undefined;
