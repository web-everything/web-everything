/** Pure one-line renderer for the delivery-capacity readout (no imports: safe for read-only op modules). */
export function renderCapacityLine(readout) {
  try {
    const detail = ['cards', 'S', 'M', 'L', 'accepted'].map(kind =>
      `${kind} ${readout.breakdown[kind].n}=${readout.breakdown[kind].units.toFixed(1)}`).join(' ');
    return `capacity ${readout.used.toFixed(1)}/${readout.cap}u${readout.mode === 'count' ? ` [mode count: ${readout.openCount}/${readout.cap} PRs]` : ''} · ${detail} · ${readout.why.join(' · ')} · cap ${readout.cap} = fixed (${readout.sources[readout.mode === 'count' ? 'openPrCap' : 'unitCap'] ?? 'standard'}) → ${readout.verdict} ${readout.slots}`
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  } catch { return 'capacity unknown · count-mode fallback · gate closed → hold 0'; }
}
