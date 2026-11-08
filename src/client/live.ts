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
