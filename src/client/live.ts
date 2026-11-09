import type { LiveInfo } from '../shared/protocol';

/** Squeektoshi's live wheel, read straight from the public Squeekchain API. */
export async function readLive(): Promise<LiveInfo | null> {
  try {
    const res = await fetch('https://api.squeekchain.com/v1/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j?.measurement;
    const proj = j?.builder?.status === 'available' ? j.builder.projected : null;
    return {
      active: m?.freshness === 'online' && m?.coreStatus === 'ACTIVE',
      rpm: Math.round((Number(m?.rpmMilli) || 0) / 1000),
      speedMm: Number(m?.speedMmPerSecond) || 0,
      kmToday: Math.round((Number(m?.distanceMm) || 0) / 10_000) / 100,
      blockHeight: String(proj?.blockHeight ?? j?.builder?.anchor?.blockHeight ?? '–'),
    };
  } catch {
    return null;
  }
}

export interface Totals {
  km: number;
  since: Date | null;
  activeDays: number;
}

/** Lifetime distance from the measurement statistics (cached by the API for 60 s). */
export async function readTotals(): Promise<Totals | null> {
  try {
    const res = await fetch('https://api.squeekchain.com/v1/measurement/stats?range=7d');
    if (!res.ok) return null;
    const j = await res.json();
    const l = j?.lifetime;
    if (!l) return null;
    return {
      km: Number(l.observedDistanceMm ?? 0) / 1_000_000,
      since: l.firstObservedAt ? new Date(l.firstObservedAt) : null,
      activeDays: Number(l.activeDayCount ?? 0),
    };
  } catch {
    return null;
  }
}
