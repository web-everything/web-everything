import { redTeamForHead } from './red-team-gate.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';

/** Repair derived labels for trusted results on already-reviewed, unchanged heads. */
export function syncResultOnHeadLabels({ repo, refusals = [], rawPrs = [],
  env = process.env, log = () => {}, sync = syncRedTeamStatusLabels } = {}) {
  let updated = rawPrs;
  const applied = [], errors = [];
  const labelName = label => typeof label === 'string' ? label : label?.name;
  for (const refusal of refusals) {
    if (refusal?.kind !== 'already-reviewed-head') continue;
    const pr = Number(refusal.prNumber);
    const head = refusal.headSha;
    if (!Number.isSafeInteger(pr) || pr <= 0 || typeof head !== 'string'
      || !/^[0-9a-fA-F]{40}$/.test(head)) continue;
    const index = updated.findIndex(row => Number(row?.number) === pr);
    const row = updated[index];
    if (!row || row.headRefOid !== head || !Array.isArray(row.labels)) continue;
    const names = row.labels.map(labelName);
    if (!names.includes('red-team:pending')
      && (names.includes('red-team:clear') || names.includes('red-team:blocked'))) continue;
    try {
      if (!redTeamForHead(row.comments, pr, head)) continue;
      const plan = sync({ repo, pr, head, env, log });
      if (plan.skipped || (!plan.add && !plan.remove.length)) continue;
      const labels = row.labels.filter(label => !plan.remove.includes(labelName(label)));
      if (plan.add && !labels.some(label => labelName(label) === plan.add)) labels.push(plan.add);
      if (updated === rawPrs) updated = rawPrs.slice();
      updated[index] = { ...row, labels };
      applied.push({ pr, head, ...plan });
    } catch (error) {
      errors.push({ pr, head, error });
      log(`red-team result label sync failed for PR #${pr}; retry next tick`);
    }
  }
  return { rawPrs: updated, applied, errors };
}
