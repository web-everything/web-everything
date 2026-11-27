/** Pending-freeze summaries caused only by cancelled needs permit a bounded MQ retry. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

function probe(mqSameHeadGuard) {
  const repo = 'fixture/drain', pr = 7496, head = 'a'.repeat(40), commit = 'b'.repeat(40);
  const mainId = 45625379144, group = 45637335054, summaryId = 139288907316;
  const ts = '2026-11-16T02:19:19.9Z';
  const rows = ['required-check-read', 'candidate-label', 'producer-certified', 'default-base', 'required-check-green',
    'codeql', 'mergeable', 'landable-state', 'non-empty-body', 'red-team', 'review-hold-labels', 'review-acceptance',
    'manifest-baseline', 'test-gaming', 'head-pin', 'freshness', 'red-main-freeze', 'duplicate-id-on-main', 'couple-whole',
    'blocked-by', 'overlap-yield', 'card-group', 'pass-cap', 'ledger'];
  const gateLog = [`${ts} #${pr}: HOLD`, ...rows.map(name => name === 'red-main-freeze'
    ? `${ts}   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run ${mainId} is being re-run (attempt 2) — verdict pending`
    : `${ts}   pass              ${name.padEnd(22)} ok`), `${ts} merge-gate: HOLD — held: #${pr}`].join('\n');
  const mainRun = (id, created_at, updated_at) => ({ id, conclusion: 'success', created_at, updated_at,
    status: 'completed', head_sha: 'c'.repeat(40), path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' });
  const latest = { ...mainRun(mainId, '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 3 };
  const earlier = mainRun(1, '2026-11-11T20:50:00Z', '2026-11-11T21:05:00Z');
  const response = pullRequest => JSON.stringify({ data: { repository: { pullRequest } } });
  const violations = [];
  for (const failingMember of [false, true]) {
    // Compact copy of the Tier-1 #7496 fixture: 35 checks, 27 cancellations, failed integration summary.
    const bound = { run_id: group, run_attempt: 1, head_sha: commit, status: 'completed' };
    const summary = { ...bound, id: summaryId, name: 'integration', conclusion: 'failure',
      steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Gate on integration results', conclusion: 'failure' },
        { name: 'Complete job', conclusion: 'success' }] };
    const parts = ['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel'];
    const cancelled = Array.from({ length: 27 }, (_, i) => ({ ...bound, id: 200 + i,
      name: i < 5 ? `integration-part (${parts[i]})` : `cancelled-${i}`, conclusion: 'cancelled' }));
    const checks = [{ id: 139286224799, name: 'ci / merge-gate', status: 'completed', conclusion: 'failure',
      output: { title: null, summary: null }, details_url: `https://github.com/${repo}/actions/runs/1/job/50` },
    { ...summary, details_url: `https://github.com/${repo}/actions/runs/${group}/job/${summaryId}` }, ...cancelled,
    ...Array.from({ length: 6 }, (_, i) => ({ id: 300 + i, name: `passing-${i}`, status: 'completed', conclusion: 'success' }))];
    const jobs = [summary, { ...bound, id: 199, name: 'changes', conclusion: 'success' }, ...cancelled];
    if (failingMember) jobs.find(job => job.name === 'integration-part (parallel)').conclusion = 'failure';
    const lines = [];
    const exec = (command, args) => {
      if (command !== 'gh') throw new Error('unexpected IO');
      if (args.some(arg => arg.includes('isInMergeQueue'))) return response({ isInMergeQueue: false, headRefOid: head });
      if (args.some(arg => arg.includes('timelineItems'))) return response({ timelineItems: { nodes: [{
        __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-11T21:11:00Z',
        beforeCommit: { oid: commit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } },
      }], pageInfo: { hasPreviousPage: false } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
      if (endpoint?.includes('/check-runs?')) return JSON.stringify({ total_count: checks.length, check_runs: checks });
      if (endpoint === `repos/${repo}/actions/jobs/50/logs`) return gateLog;
      if (endpoint === `repos/${repo}/actions/jobs/50`) return JSON.stringify({ id: 50, run_id: 1, name: 'merge-gate',
        workflow_name: 'Merge gate', head_sha: commit, status: 'completed', conclusion: 'failure' });
      if (endpoint === `repos/${repo}/actions/runs/1`) return JSON.stringify({ id: 1,
        path: '.github/workflows/merge-gate.yml', event: 'merge_group', head_sha: commit });
      if (endpoint?.includes('/workflows/ci.yml/runs?')) {
        const items = endpoint.includes('created=<') ? [earlier] : [latest, earlier];
        return JSON.stringify({ total_count: items.length, workflow_runs: items });
      }
      if (endpoint === `repos/${repo}/actions/runs/${mainId}/attempts/2`)
        return JSON.stringify({ ...latest, run_attempt: 2, conclusion: 'failure' });
      if (endpoint === `repos/${repo}/actions/runs/${mainId}`) return JSON.stringify(latest);
      if (endpoint === `repos/${repo}/actions/runs/${group}`) return JSON.stringify({ id: group,
        path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: commit });
      if (endpoint?.includes(`/runs/${group}/attempts/1/jobs?`)) return JSON.stringify({ total_count: jobs.length, jobs });
      const job = jobs.find(job => endpoint === `repos/${repo}/actions/jobs/${job.id}`);
      if (job) return JSON.stringify(job);
      throw new Error('unexpected evidence read');
    };
    const decision = mqSameHeadGuard({ repo, pr, head, exec, log: line => lines.push(String(line)),
      now: Date.parse('2026-11-11T22:00:00Z'), quarantine: { readList: null }, readFreeze: () => ({ frozen: false }) });
    if (failingMember) {
      if (decision.hold !== true) violations.push('failed integration-part member must hold');
    } else {
      if (decision.hold !== false) violations.push('#7496 cancelled-needs summary must retry');
      if (!lines.some(line => /infra retry 1\/2/.test(line))) violations.push('#7496 retry must log infra retry 1/2');
    }
  }
  return violations;
}

export default {
  id: 'mq-freeze-summary-cancelled-needs-retry',
  title: 'MQ pending-freeze cancelled-needs summary retries while a failed integration-part member holds',
  card: '#7496 pending-freeze summary retry',
  fixedBy: { sha: 'pending', where: 'pending-freeze summary proof', paths: [SOURCE] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { mqSameHeadGuard } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(mqSameHeadGuard)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
        env: { ...process.env, WE_UNDER_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { mqSameHeadGuard } = await import('../../../lib/drain-queue-safety.mjs');
    const violations = probe(mqSameHeadGuard);
    log?.(`mq freeze summary cancelled needs retry: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
