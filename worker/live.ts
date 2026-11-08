import type { LiveInfo } from '../src/shared/protocol';

/** Reads Squeektoshi's live state from the public Squeekchain API. Returns null if it can't be read. */
export async function fetchLive(): Promise<LiveInfo | null> {
  try {
    const res = await fetch('https://api.squeekchain.com/v1/status', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const m = j?.measurement;
    const proj = j?.builder?.status === 'available' ? j.builder.projected : null;
    return {
      active: m?.freshness === 'online' && m?.coreStatus === 'ACTIVE',
      rpm: Math.round((Number(m?.rpmMilli) || 0) / 1000),
      speedMm: Number(m?.speedMmPerSecond) || 0,
      kmToday: Math.round((Number(m?.distanceMm) || 0) / 10_000) / 100,
      blockHeight: String(proj?.blockHeight ?? j?.builder?.anchor?.blockHeight ?? '0'),
    };
  } catch {
    return null;
  }
}
