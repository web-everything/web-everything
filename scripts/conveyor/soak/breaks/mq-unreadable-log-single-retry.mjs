/**
 * Live break 2026-11-21: #7284's only merge-queue run failed `soak-shard (1)` and its job log was unreadable.
 * The drain held it as "job log evidence unreadable or incomplete" forever; no retry was ever attempted.
 * Fix: a non-gate failure with an unreadable log gets exactly ONE recorded retry per head (main green, PR CLEAN);
 * a second failure parks. Fix presence is decided by executing this tree's decideMqSameHead.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

function probe(decideMqSameHead, positiveOnly = false) {
  const head = '7284'.padEnd(40, 'a'), prior = 'b'.repeat(40), merge = 'c'.repeat(40);
  const removed = () => ({ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-21T11:34:00Z',
    beforeCommit: { oid: merge, parents: { nodes: [{ oid: prior }, { oid: head }] } } });
  const added = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-21T12:00:00Z' };
  const evidence = { infra: 'unreadable-log', mainGreen: true, mergeState: 'CLEAN', failedNames: ['soak-shard (1)'] };
  const decide = (nodes, retryEvidence) => decideMqSameHead({ pr: 7284, head, mergeState: 'CLEAN', retryEvidence,
    timeline: { nodes, hasPreviousPage: false } });
  const violations = [];
  const first = decide([removed()], evidence);
  if (first.hold !== false || !/unreadable-log retry 1\/1/.test(first.line)) violations.push('first unreadable-log failure got no single retry');
  if (positiveOnly) return violations;
  if (decide([removed(), added, removed()], evidence).hold !== true) violations.push('a second failure on the same head did not park');
  if (decide([removed(), added], evidence).hold !== true) violations.push('a re-queue after the failure was granted another retry');
  if (decide([removed()], { ...evidence, mainGreen: false }).hold !== true) violations.push('retry granted without green main');
  if (decide([removed()], { ...evidence, infra: null }).hold !== true) violations.push('no evidence still retried');
  return violations;
}

export default {
  id: 'mq-unreadable-log-single-retry',
  title: 'an MQ failure whose job log is unreadable gets exactly one bounded retry, then parks',
  card: 'delivery blocker #7284 (unreadable MQ job log held forever)',
  fixedBy: { sha: 'pending', where: 'lane/mq-unreadable-log-retry', paths: [SOURCE] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { decideMqSameHead } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(decideMqSameHead, true)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { decideMqSameHead } = await import('../../../lib/drain-queue-safety.mjs');
    const violations = probe(decideMqSameHead);
    log?.(`mq unreadable-log retry: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
