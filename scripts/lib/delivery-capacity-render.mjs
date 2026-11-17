/** Pure one-line renderer for the delivery-capacity readout (no imports: safe for read-only op modules). */
export function renderCapacityLine(readout) {
  try {
    const detail = ['cards', 'S', 'M', 'L', 'accepted'].map(kind =>
      `${kind} ${readout.breakdown[kind].n}=${readout.breakdown[kind].units.toFixed(1)}`).join(' ');
    return `capacity ${readout.used.toFixed(1)}/${readout.cap}u${readout.mode === 'count' ? ` [mode count: ${readout.openCount}/${readout.cap} PRs]` : ''} · ${detail} · ${readout.why.join(' · ')} · cap ${readout.cap} = fixed (${readout.sources[readout.mode === 'count' ? 'openPrCap' : 'unitCap'] ?? 'standard'}) → ${readout.verdict} ${readout.slots}`
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  } catch { return 'capacity unknown · count-mode fallback · gate closed → hold 0'; }
}

/** Effective values and their cascade provenance, in operator-facing order. */
export function renderCapacitySources(readout) {
  return `policy-cascade · deliveryCapacity: ${Object.entries(readout.policy)
    .map(([key, value]) => `${key}=${value} (${readout.sources[key] ?? 'standard'})`).join(', ')}`
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

/** Compatibility output for capacity-gate consumers; unreadable evidence stays explicit. */
export function renderLegacyCapacityLine(readout) {
  const { host, policy: p, openCount: open, verdict, slots } = readout;
  const idle = host.idlePct;
  const memGb = host.memGb;
  let why;
  if (readout.fallbackReason) why = readout.fallbackReason;
  else if (idle === null || memGb === null) why = 'gate closed: host evidence unreadable; inspect top/vm_stat';
  else if (verdict === 'hold') why = `gate closed: ${[
    ...(idle < p.idleMinPct ? [`idle ${idle}% < ${p.idleMinPct}%`] : []),
    ...(memGb < p.memMinGb ? [`mem ${memGb.toFixed(1)} GB < ${p.memMinGb}`] : []),
  ].join(', ')}`;
  else if (readout.override || readout.mode !== 'count') why = readout.why.join(' · ');
  else if (verdict === 'deliver') why = `O ${open} ≥ cap ${p.openPrCap}: no new builds; delivery + review/fix perf only`;
  else if (open >= p.openPrCap && p.openPrCapMode === 'soft') {
    why = `O ${open} ≥ soft cap ${p.openPrCap} — host gate open, START up to ${slots} new PR-producing items (soft cap, operator 2026-11-16), minus running build workers (R785)`;
  } else {
    why = `open-PR cap ${p.openPrCap} (R927) — START up to ${slots} new PR-producing items now, minus running build workers (R785), quiet hours included`;
  }
  return `O=${open} M=${readout.mergedCount2h ?? '?'} idle=${idle ?? '?'}% mem=${memGb === null ? '?' : memGb.toFixed(1)}GB L=${host.load1 ?? '?'} → ${verdict} (${why}) · load-reducer slot ${readout.loadReducerSlot ? 'open' : 'closed'} (R761)`
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}
