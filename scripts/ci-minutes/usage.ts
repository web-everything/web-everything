type FeedState = 'fresh' | 'stale' | 'error';
type Summary = {
  state: 'fresh';
  org: string;
  cycle: string;
  usedMinutes: number;
  includedMinutes: number;
  pct: number;
};
type ParseError = { state: 'error'; pct: null };
type Reading = {
  org?: string;
  cycle?: string;
  includedMinutes?: number;
  pct: number | null;
  state?: FeedState;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const error = (): ParseError => ({ state: 'error', pct: null });
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Parse decoded JSON only; all IO and feed timestamps belong to the caller. */
export function parseUsageSummary(
  json: unknown, { includedMinutes }: { includedMinutes: number },
): Summary | ParseError {
  if (!record(json) || !Array.isArray(json.usageItems)
    || typeof json.organization !== 'string' || !json.organization.trim()
    || !record(json.timePeriod) || !nonnegative(includedMinutes) || includedMinutes === 0) {
    return error();
  }
  const { year, month } = json.timePeriod;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 1000 || year > 9999
    || typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) {
    return error();
  }
  let usedMinutes = 0;
  for (const item of json.usageItems) {
    if (!record(item) || typeof item.product !== 'string'
      || typeof item.unitType !== 'string') return error();
    if (item.product !== 'actions' || item.unitType.toLowerCase() !== 'minutes') continue;
    const discount = item.discountQuantity;
    const net = item.netQuantity;
    if (!nonnegative(discount) || !nonnegative(net)) return error();
    // Multiplier (2x Windows, 10x macOS) is UNCONFIRMED. The fixture is synthetic;
    // a live check against one real response is owed in S2.1. Do not multiply here.
    usedMinutes += discount + net;
  }
  const pct = (usedMinutes / includedMinutes) * 100;
  if (!Number.isFinite(usedMinutes) || !Number.isFinite(pct)) return error();
  return {
    state: 'fresh',
    org: json.organization, cycle: `${year}-${String(month).padStart(2, '0')}`,
    usedMinutes, includedMinutes, pct,
  };
}

/** A caller composing a Reading must use pct: null for stale/error feeds. */
export function feedState({ fetchedAtMs, nowMs, ok, staleAfterMs = SIX_HOURS_MS }: {
  fetchedAtMs: number; nowMs: number; ok: boolean; staleAfterMs?: number;
}): FeedState {
  if (!ok || !nonnegative(fetchedAtMs) || !nonnegative(nowMs)
    || !nonnegative(staleAfterMs) || fetchedAtMs > nowMs) return 'error';
  return nowMs - fetchedAtMs > staleAfterMs ? 'stale' : 'fresh';
}

/** Return new deduplication state; the caller owns persistence and notification IO. */
export function evaluateThresholds(reading: Reading, firedKeys: string[]): {
  lines: string[]; firedKeys: string[];
} {
  const keys = [...firedKeys];
  const lines: string[] = [];
  const { org, cycle, pct, includedMinutes, state } = reading;
  // Without identity there is no safe per-org/per-cycle deduplication key.
  if (!org || !cycle || !/^\d{4}-(0[1-9]|1[0-2])$/.test(cycle)) {
    return { lines, firedKeys: keys };
  }
  const emit = (threshold: string | number, line: string) => {
    const key = `ci-min:${org}:${threshold}:${cycle}`;
    if (keys.includes(key)) return;
    keys.push(key);
    lines.push(line);
  };
  // Feed state takes precedence even if a caller accidentally supplies cached pct.
  if (state !== 'fresh' || !nonnegative(pct)
    || !nonnegative(includedMinutes) || includedMinutes === 0) {
    emit('stale', 'CI minutes feed stale >6h');
  } else {
    for (const threshold of [80, 95]) {
      if (pct >= threshold) {
        emit(threshold,
          `CI minutes ${org} at ${Math.round(pct)}% of ${includedMinutes} private min (cycle ${cycle})`);
      }
    }
  }
  return { lines, firedKeys: keys };
}
