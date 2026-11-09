import { recoveryPushCredential } from './missing-run-push.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const skip = reason => ({ action: 'skip', reason });

/** Only an absent merge-gate context with no run or a latest startup failure is repairable here. */
export function decideRequiredContextRetrigger(input) {
  if (!input || !Array.isArray(input.requiredContexts) || !input.requiredContexts.every(text)
    || !Array.isArray(input.rollup) || !input.rollup.every(row => row && text(row.name ?? row.context))
    || !Array.isArray(input.workflowRuns) || typeof input.alreadyRetriggered !== 'boolean'
    || !input.workflowRuns.every(run => run && text(run.name) && text(run.event)
      && text(run.status) && Number.isFinite(Date.parse(run.created_at)) && Number.isSafeInteger(run.id)
      && (run.conclusion === null || text(run.conclusion)))) return skip('unreadable retrigger evidence; operator inspection required');
  if (input.alreadyRetriggered) return skip('retrigger already spent for this head');
  if (!input.requiredContexts.includes('merge-gate')) return skip('merge-gate is not required');
  if (input.rollup.some(row => (row.name ?? row.context) === 'merge-gate')) return skip('merge-gate context is already present');
  const runs = input.workflowRuns.filter(run => run.name === 'Merge gate' && run.event === 'pull_request_target');
  if (runs.some(run => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)))
    return skip('merge-gate workflow is live');
  runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  if (runs.length && !(runs[0].status === 'completed' && runs[0].conclusion === 'startup_failure'))
    return skip('latest merge-gate run is not a startup failure; operator inspection required');
  return { action: 'retrigger', context: 'merge-gate', reason: runs.length ? 'missing context after startup failure' : 'missing context and workflow run' };
}


/** Pure admission shared by label events and synchronize pushes. Unknown evidence holds. */
export function recoveryPreflight({ pr, head, headRefName, context, runs, rollup,
  token, env = {}, claimed, defaultBranch = 'main', kind = 'push',
  candidate = 1, attemptsForSha = 0, attemptsForPr = 0,
  maxRetriesPerSha = 1, maxRetriesPerPr = 1, labels = [], labelAttempted = false,
} = {}) {
  const refuse = reason => ({ allow: false, kind, reason });
  if (!['label', 'push'].includes(kind)) return refuse('unknown recovery kind; operator inspection required');
  if (claimed !== false) return refuse('head already claimed or claim unreadable; operator inspection required');
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 8)
    return refuse('recovery evidence candidate bound exceeded; operator inspection required');
  if (![attemptsForSha, attemptsForPr, maxRetriesPerSha, maxRetriesPerPr].every(n => Number.isSafeInteger(n) && n >= 0)
    || attemptsForSha >= maxRetriesPerSha || attemptsForPr >= maxRetriesPerPr)
    return refuse('missing-run retry cap exhausted; human/ci-heal inspection required');
  if (!recoveryPushCredential(token, env)) return refuse('recovery credential cannot trigger workflows; operator inspection required');
  if (!headRefName?.startsWith('lane/')) return refuse('recovery requires a lane branch');
  if (!/^[a-f0-9]{40}$/i.test(head ?? '') || pr?.state !== 'OPEN' || !text(defaultBranch)
    || pr.baseRefName !== defaultBranch || pr.isCrossRepository !== false
    || pr.mergeable !== 'MERGEABLE' || pr.headRefOid !== head || pr.headRefName !== headRefName)
    return refuse('live PR is ineligible or incomplete; operator inspection required');
  if (context === 'merge-gate') {
    if (!Array.isArray(labels) || !labels.every(text)) return refuse('unreadable PR labels; operator inspection required');
    if (labels.includes('review:merge-gate-retrigger')) return refuse('stale sentinel label present; operator inspection required');
    if (labelAttempted) return refuse('label attempt already owns this head; operator inspection required');
    const decision = decideRequiredContextRetrigger({ requiredContexts: [context], rollup,
      workflowRuns: runs, alreadyRetriggered: claimed });
    if (decision.action !== 'retrigger') return refuse(decision.reason);
  } else if (kind === 'label') return refuse('label recovery requires merge-gate evidence');
  return { allow: true, kind, reason: 'recovery preflight passed' };
}
