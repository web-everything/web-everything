import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'red-team-pending-overdue',
  scope: 'repo',
  cadence: 'gh',
  probes: ['prs'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'investigate',
  maxPendingMs: 45 * MINUTE,
  evaluate({ prs }, { now }) {
    const out = [];
    for (const pr of prs || []) {
      const labels = (pr.labels || []).map(label => typeof label === 'string' ? label : label?.name);
      if (pr.isDraft === true || !labels.includes('red-team:pending')
        || labels.includes('red-team:blocked')) continue;
      // An unreadable timestamp is unknown age, which must alert rather than read as clean.
      const updated = Date.parse(pr.updatedAt || '');
      const known = Number.isFinite(updated);
      const age = known ? Math.max(0, now - updated) : Infinity;
      const subject = `${pr.repo}#${pr.number}@${String(pr.headRefOid || '').slice(0, 7)}`;
      out.push({
        subject,
        breach: age >= 2 * this.maxPendingMs,
        measure: { pendingForMin: known ? Math.round(age / MINUTE) : null, head: pr.headRefOid, title: String(pr.title || '').slice(0, 80) },
        summary: `${subject} has red-team:pending ${known ? `after ${fmtAge(age)} without a PR update` : 'with an unreadable update time'}.`,
        recommendation: 'Investigate the red-team queue and review worker; obtain a result for this head before clearing pending.',
      });
    }
    return out;
  },
};
