/** PR liveness guard: existing gh probes only; recovery stays with the operator. */
import { loadSettings, normalizePr } from '../liveness-sweep.mjs';
import { sweep } from '../liveness-sweep-core.mjs';
const { settings } = loadSettings();
const kinds = new Set(['pr-no-movement', 'pr-red-unowned', 'pr-past-cap-fix-waiting']);
export default {
  id: 'pr-no-movement', scope: 'repo', cadence: 'gh', probes: ['prs', 'agents'],
  openAfter: 1, closeAfter: 1, severity: 'medium', action: 'alert',
  recommendationHint: 'Run the liveness sweep and use its operator op; gates and human review remain enforced.',
  evaluate({ prs = [], agents = [] }, { now }) {
    const rows = sweep({ prs: prs.map(p => normalizePr({ ...p, state: 'OPEN' })), agents }, { settings, now: new Date(now).toISOString() });
    const bySubject = new Map(rows.filter(r => kinds.has(r.finding.kind)).map(r => [r.finding.subject, r]));
    return prs.map(pr => {
      const subject = `${pr.repo}#${pr.number}`, row = bySubject.get(subject);
      const f = row?.finding, p = row?.plan;
      return { subject, breach: !!row,
        measure: { kind: f?.kind ?? null, since: f?.since ?? null, ageMinutes: f?.ageMinutes ?? null, rung: p?.rung ?? null, op: p?.op ?? null },
        summary: f ? `${subject}: ${f.kind} for ${Math.round(f.ageMinutes)} minutes` : `${subject}: no liveness breach`,
        recommendation: p?.op ?? 'No operator action required.' };
    });
  },
};
