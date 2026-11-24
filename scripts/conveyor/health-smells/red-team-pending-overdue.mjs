import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'red-team-pending-overdue',
  scope: 'repo',
  cadence: 'gh',
  probes: ['prs'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  // Incomplete inventories (including an empty throttle deferral) cannot clear missing subjects.
  // Close only on explicit readable evidence, as review-label-missing does.
  missingSubjectsUnknown: true,
  evaluate({ prs }, { now, config } = {}) {
    const out = [];
    for (const pr of prs || []) {
      const labels = (pr.labels || []).map(label => typeof label === 'string' ? label : label?.name);
      const subject = `${pr.repo}#${pr.number}@${String(pr.headRefOid || '').slice(0, 7)}`;
      if (pr.isDraft === true || (pr.labelsValid !== false
        && !labels.includes('red-team:pending'))) {
        if (!pr.cachedLabels) out.push({ subject, breach: false });
        continue;
      }
      const since = Date.parse(pr.redTeamPendingSince || '');
      const maxMin = config?.drain?.redTeamPendingMaxMin ?? pr.redTeamPendingMaxMin;
      const known = pr.labelsValid !== false && pr.redTeamPendingPartial !== true && Number.isFinite(since) && since <= now;
      const age = known ? now - since : Infinity;
      const thresholdKnown = typeof maxMin === 'number' && Number.isFinite(maxMin) && maxMin > 0;
      const breach = !known || !thresholdKnown || age >= 2 * maxMin * MINUTE;
      // Missing subjects are unknown to the episode core. A cached recent label (or
      // cached draft/clear above) cannot close an episode without fresh evidence.
      if (!breach && pr.cachedLabels) continue;
      out.push({
        subject,
        breach,
        measure: { pendingForMin: known ? Math.round(age / MINUTE) : null, head: pr.headRefOid, title: String(pr.title || '').slice(0, 80) },
        summary: `${subject} has red-team:pending ${known ? `for ${fmtAge(age)} since the label was added` : 'with unknown label evidence or pending age'}.`,
        recommendation: 'Investigate the red-team queue and review worker; obtain a result for this head before clearing pending.',
      });
    }
    return out;
  },
};
