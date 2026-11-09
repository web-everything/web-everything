import { classifyMqFailureEvidence } from './mq-failure-evidence.mjs';
import { buildMqFailureRoute } from './mq-failure-route.mjs';

export async function drainMqFailureRecovery({ removal, hold, ledger, io, dryRun = false }) {
  const skip = note => ({ action: 'skip', note });
  if (dryRun || hold?.reason !== 'mq-same-head-failed' || hold.historyComplete !== true
    || hold.mergeState !== 'CLEAN' || hold.retriesExhausted !== false) return skip('Safety hold retained; operator inspection required');
  let evidence, labels;
  try {
    evidence = await io.collectEvidence({ removal });
    labels = await io.readLabels({ repo: removal.repo, pr: removal.pr });
  } catch { return skip('Unreadable evidence or labels; operator inspection required'); }
  if (classifyMqFailureEvidence(evidence) !== 'real' || labels?.complete !== true || !Array.isArray(labels.labels))
    return skip('Incomplete or non-defect evidence; hold retained for operator inspection');
  let body;
  try { body = buildMqFailureRoute({ ...removal, ...evidence }); }
  catch { return skip('Invalid or oversized evidence; operator inspection required'); }
  try {
    if (!(await ledger.claim({ ...removal, kind: 'route' })).claimed) return skip('Already routed this head');
  } catch { return skip('Ledger unreadable; operator inspection required'); }
  try {
    await io.postComment({ repo: removal.repo, pr: removal.pr, body });
    if (!labels.labels.includes('mq-failure-recovery')) await io.addLabel({ repo: removal.repo, pr: removal.pr, label: 'mq-failure-recovery' });
    return { action: 'routed' };
  } catch { return skip('Route publication incomplete; attempt consumed, operator inspection required'); }
}
