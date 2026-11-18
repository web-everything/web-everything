/** Pure rolling-window refusal history. Expiration never slides forward on a read. */
export function activePrepareRefusals(rows, { now = Date.now(), repeatRefusalWindowHours = 24 } = {}) {
  return rows.filter(r => now - Date.parse(r.at) < repeatRefusalWindowHours * 3_600_000);
}

export function repeatedPrepareRefusals(rows, { repeatRefusalMax = 2, ...options } = {}) {
  const cards = new Map();
  for (const row of activePrepareRefusals(rows, options)) {
    const num = String(row.num);
    const prior = cards.get(num);
    cards.set(num, { num, refusals: (prior?.refusals ?? 0) + 1,
      lastReason: !prior || Date.parse(row.at) >= prior.at ? row.reason : prior.lastReason,
      at: Math.max(prior?.at ?? -Infinity, Date.parse(row.at)) });
  }
  return [...cards.values()].filter(r => r.refusals >= repeatRefusalMax)
    .map(({ at, ...row }) => row);
}

export function appendPrepareRefusal(rows, { num, reason }, options = {}) {
  const now = options.now ?? Date.now();
  return [...activePrepareRefusals(rows, { ...options, now }), { num: String(num), reason, at: new Date(now).toISOString() }];
}
