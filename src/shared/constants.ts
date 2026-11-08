/** Shared game constants. The client and the server must use exactly the same values. */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const FINISH_M = 500;
/** Hard stop: 3 minutes. Whoever is further ahead wins. */
export const MAX_TICKS = TICK_HZ * 180;
export const COUNTDOWN_MS = 3500;
/** The server confirms a player's run this many ticks behind real time (400 ms) to absorb latency. */
export const CONFIRM_LAG_TICKS = 24;
/** Obstacles are sent to clients only when they are this close (metres) to the leading player. */
export const REVEAL_AHEAD_M = 40;
/** An input may claim to be at most this many ticks in the future. */
export const FUTURE_TOLERANCE_TICKS = 6;
/** Most inputs per player per second the server accepts. */
export const MAX_INPUTS_PER_SEC = 40;
/** Most Block Drops per match (real Squeekchain blocks completed during the race). */
export const MAX_BLOCK_DROPS = 3;
