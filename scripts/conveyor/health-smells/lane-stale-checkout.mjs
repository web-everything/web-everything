/**
 * Pool lanes running an old Forge telemetry parser or trailing local origin/main for too long.
 * Alerts only; lane refresh/reclaim remains owned by the product lifecycle.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'lane-stale-checkout',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['laneCheckouts'],
  openAfter: 2,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  maxBehindCommits: 200,
  maxBehindMs: 24 * 60 * MINUTE,
  recommendationHint: 'Refresh stale pool lanes through lane-pool refresh/reclaim.',
  evaluate({ laneCheckouts }, { now }) {
    return (laneCheckouts || []).map((c) => {
      const age = Number.isFinite(c.behindSinceMs) ? now - c.behindSinceMs : 0;
      const staleForge = c.forgeExecHasPrune === false;
      const staleLag = Number.isFinite(c.behind) && c.behind > this.maxBehindCommits && age > this.maxBehindMs;
      const reasons = [];
      if (c.forgeExecHasPrune == null) reasons.push('cannot verify forge telemetry parser');
      if (!c.head) reasons.push('lane checkout unreadable');
      if (Number.isFinite(c.headLagMs) && c.headLagMs > this.maxBehindMs) reasons.push(`lane HEAD trails main tip by ${fmtAge(c.headLagMs)}`);
      if (staleForge) reasons.push('Forge parseTelemetry lacks prune/diskUsedPct handling');
      if (staleLag) reasons.push(`${c.behind} commits behind origin/main, oldest unapplied ${fmtAge(age)} old`);
      return {
        subject: `lane-checkout:${c.pool}/lane-${c.lane}`,
        breach: reasons.length > 0,
        measure: { head: c.head, headLagMs: c.headLagMs, behind: c.behind, behindMin: Math.round(age / MINUTE), forgeExecHasPrune: c.forgeExecHasPrune },
        summary: `pool lane ${c.pool}/lane-${c.lane}: ${reasons.join('; ') || 'no known stale-checkout evidence'}.`,
        recommendation: `Refresh ${c.pool}/lane-${c.lane} through the product lane-pool refresh/reclaim path, never by hand.`,
      };
    });
  },
};
