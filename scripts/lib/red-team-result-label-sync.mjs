import { redTeamForHead } from './red-team-gate.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { readSealedStatus } from './red-team-sealed-status.mjs';
import { publishStoredRedTeamResult } from './red-team-withheld-publish.mjs';

/** Re-read the live head right before the write: a head that moved after the writer's own check must not be labelled. */
export function headGuardedProvider(provider, head) {
  return { ...provider,
    readPrState: (...a) => provider.readPrState(...a), readComments: (...a) => provider.readComments(...a),
    ensureLabel: (...a) => provider.ensureLabel(...a),
    setLabels: (repo, pr, change) => {
      if (provider.readPrState(repo, pr)?.headRefOid !== head) throw Error('head moved before label write');
      return provider.setLabels(repo, pr, change);
    } };
}

/** Repair derived labels for trusted results on already-reviewed, unchanged heads. */
export function syncResultOnHeadLabels({ repo, refusals = [], rawPrs = [],
  env = process.env, log = () => {}, provider = null, sync = syncRedTeamStatusLabels,
  readSeal = readSealedStatus, sealStored = publishStoredRedTeamResult } = {}) {
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
      if (readSeal({ repo, pr, head, env })?.unsealed === true) {
        const sealed = sealStored({ status: { repo, pr, head }, sealOnly: true,
          listComments: () => row.comments,
          postComment: () => { throw Error('seal-only never posts'); } });
        if (!['sealed', 'skipped'].includes(sealed?.status)) throw Error('red-team seal failed; retry next tick');
      }
      const plan = sync({ repo, pr, head, env, log, provider: headGuardedProvider(provider ?? createGhProvider(), head) });
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
