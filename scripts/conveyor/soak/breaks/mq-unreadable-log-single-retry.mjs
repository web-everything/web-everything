/**
 * Live break 2026-11-21: #7284's only merge-queue run failed `soak-shard (1)` and its job log was unreadable.
 * The drain held it as "job log evidence unreadable or incomplete" forever; no retry was ever attempted.
 * Coordinator ruling: an unreadable log never blocks the single update-branch refresh.
 * Admission stays held; the shared head-bound ledger prevents a second refresh.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

function probe(mqSameHeadGuard, positiveOnly = false) {
  const repo = 'fixture/drain', pr = 7284, head = '7284'.padEnd(40, 'a'), merge = 'c'.repeat(40);
  const removed = () => ({ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    beforeCommit: { oid: merge, parents: { nodes: [{ oid: 'b'.repeat(40) }, { oid: head }] } } });
  const nodes = [removed()], spent = new Set(), violations = [];
  let updates = 0, logReads = 0;
  const exec = (_file, args) => {
    if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, isInMergeQueue: false } } } });
    if (args.some(a => a.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: {
      timelineItems: { nodes, pageInfo: { hasPreviousPage: false } } } } } });
    if (args.includes('PUT')) { updates++; return '{}'; }
    if (args[0] === 'pr') return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels: ['ready-to-merge'] });
    const endpoint = args.find(a => a.startsWith('repos/'));
    if (endpoint?.includes('/check-runs')) return JSON.stringify({ total_count: 1, check_runs: [{ id: 1,
      head_sha: merge, name: 'soak-shard (1)', status: 'completed', conclusion: 'failure',
      details_url: `https://github.com/${repo}/actions/runs/10/job/20` }] });
    if (endpoint?.endsWith('/logs')) {
      logReads++;
      if (!args.includes('--allow-escape-sequences')) violations.push('log reader omitted --allow-escape-sequences');
      throw new Error('HTTP 404');
    }
    throw new Error('unexpected probe IO');
  };
  const refresh = { allow: () => true, store: {
    has: key => spent.has(key), claim(key) { if (spent.has(key)) return false; spent.add(key); return true; },
  } };
  const run = () => mqSameHeadGuard({ repo, pr, head, exec, refresh });
  const first = run();
  if (first.hold !== true || updates !== 1 || logReads !== 1) violations.push('unreadable log did not get one refresh while admission held');
  if (positiveOnly) return violations;
  run();
  if (updates !== 1) violations.push('ledger allowed a repeated refresh');
  nodes.push({ __typename: 'AddedToMergeQueueEvent' }, removed());
  const second = run();
  if (second.hold !== true || second.recoveryAction !== 'fixer' || updates !== 1)
    violations.push('second same-head failure did not hold for fixer');
  return violations;
}

export default {
  id: 'mq-unreadable-log-single-retry',
  title: 'an MQ failure whose job log is unreadable gets exactly one bounded refresh, then holds for fixer',
  card: 'delivery blocker #7284 (unreadable MQ job log held forever)',
  fixedBy: { sha: 'pending', where: 'lane/mq-unreadable-log-retry', paths: [SOURCE] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { mqSameHeadGuard } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(mqSameHeadGuard, true)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { mqSameHeadGuard } = await import('../../../lib/drain-queue-safety.mjs');
    const violations = probe(mqSameHeadGuard);
    log?.(`mq unreadable-log retry: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
