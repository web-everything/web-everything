import { planReconcile } from './reconcile-core.mjs';

export const DECIDE_VERSION = 'decide/1';
export const ACTION_PRIORITY = Object.freeze(['ci-heal', 'fix', 'review']);

/** Pure arbitration over one hydrated PR and its event-log projection. */
export function decide({ pr, agents = [], agentsIncomplete = false, now, projection, plannerRepo = 'we', repoSlug,
  maxStaleMs = 300000, recheckMs = 60000, plannerOptions = {} }) {
  const result = { version: DECIDE_VERSION, repo: repoSlug, number: pr?.number ?? null,
    head: pr?.headRefOid ?? null, seq: projection?.seq ?? null,
    action: null, considered: [], reasons: [], recheckAt: null };
  const closed = reason => ({ ...result, reasons: [reason], recheckAt: now + recheckMs });
  if (agentsIncomplete === true) return { ...closed('agents-incomplete'), incomplete: true };
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return closed('snapshot-missing');
  if (pr.truncated === true || pr.discoveryIncomplete === true) return closed('snapshot-truncated');
  if (typeof pr.headRefOid !== 'string' || !pr.headRefOid) return closed('head-missing');
  if (!projection || typeof projection !== 'object') return closed('projection-missing');
  if (projection.head !== pr.headRefOid) return closed('head-mismatch');
  if (projection.state != null && projection.state !== 'OPEN') return closed('projection-not-open');
  if (projection.draft === true) return closed('projection-draft');
  if (!Number.isFinite(now) || !Number.isFinite(projection.observedAt)
    || now - projection.observedAt > maxStaleMs) return closed('projection-stale');
  try {
    const plan = planReconcile({ ...plannerOptions, repo: plannerRepo, prs: [pr], agents, now,
      // The planner journals eligibility evidence to a shared file by default; a decision must write nothing.
      shadowDeps: { ...plannerOptions.shadowDeps, mode: 'off', appendLine: () => {}, readLocals: () => undefined } });
    result.considered = [...new Set(plan.dispatch.filter(entry => entry.prNumber === pr.number
      && ACTION_PRIORITY.includes(entry.kind)).map(entry => entry.kind))];
    const kind = ACTION_PRIORITY.find(kind => result.considered.includes(kind));
    if (kind) result.action = { kind, key: `${repoSlug}#${pr.number}@${pr.headRefOid}:${kind}` };
    const times = [];
    for (const refusal of plan.refusals) {
      if (refusal.prNumber !== pr.number) continue;
      for (const code of [refusal.kind, refusal.why]) {
        if (typeof code === 'string') {
          const bounded = code.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
          if (bounded) result.reasons.push(bounded);
        }
      }
      for (const field of ['deadline', 'recheckAt', 'retryAt', 'until']) {
        const value = refusal[field];
        const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
        if (Number.isFinite(time)) times.push(time);
      }
    }
    result.recheckAt = times.length ? Math.min(...times) : null;
    return result;
  } catch {
    return { ...closed('planner-error'), action: null, considered: [] };
  }
}
