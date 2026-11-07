/**
 * R497 — forge-share-below-target. The share of countable heavy runs that ran on Forge (remote ÷ (remote + local −
 * expected-local), `we:scripts/lib/forge-share.mjs`) stayed below the settings target (`scripts/settings/forge-share.json`,
 * 0.9 over 60 min) for the settings alert duration: it is below target now AND was below target one alert-duration
 * ago. FAILS CLOSED: an unknown share (missing/unreadable data, no remote success record) alarms as UNKNOWN —
 * it is never read as a pass. High severity + NOTIFY_EVEN_IN_SHADOW, so it uses the real high-severity reminder path.
 */
const pct = (x) => `${Math.round(x * 100)}%`;
const known = (r) => r && typeof r === 'object' && r.status === 'ok' && Number.isFinite(r.share) && typeof r.belowTarget === 'boolean';

export default {
  id: 'forge-share-below-target',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['forgeShare'],
  openAfter: 2,
  closeAfter: 3,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'Too many heavy runs fall back to local; the summary names the fallback reasons to fix first.',
  evaluate({ forgeShare } = {}) {
    const current = forgeShare?.current, earlier = forgeShare?.earlier;
    if (!known(current) || !known(earlier)) {
      const why = (!known(current) ? current : earlier)?.unknownReason ?? 'no forge-share data';
      return [{
        subject: 'forge-share', breach: true,
        measure: { status: 'unknown', unknownReason: why },
        summary: `Forge share is UNKNOWN (${why}) - it cannot be shown to be on target.`,
        recommendation: 'Restore the measurement (remote-runs.jsonl, durations.jsonl, remote-fallbacks.jsonl under the heavy-admission lock root); unknown is never treated as on target.',
      }];
    }
    const breach = current.belowTarget && earlier.belowTarget;
    const top = Object.entries(current.byReason ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(', ');
    return [{
      subject: 'forge-share', breach,
      measure: { status: 'ok', share: current.share, earlierShare: earlier.share, target: current.target, windowMs: current.windowMs, runs: current.runs, byReason: current.byReason, expectedLocalByReason: current.expectedLocalByReason },
      summary: `Forge share ${pct(current.share)} (target ${pct(current.target)}), was ${pct(earlier.share)} an alert-window ago; ${current.runs.remote} of ${current.runs.counted} countable heavy runs on Forge; fallbacks: ${top || 'none'}.`,
      recommendation: `Fix the biggest fallback reason first (${top.split(',')[0] || 'see byReason'}); expected-local reasons are already excluded.`,
    }];
  },
};
