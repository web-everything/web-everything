/** Escaped job logs are diagnostic data, even when their visible text resembles infrastructure. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

// Serializable so fixPresent probes the requested tree, never the observer's imported implementation.
export function probe(mqSameHeadGuard) {
  const repo = 'fixture/drain', head = 'a'.repeat(40), commit = 'b'.repeat(40);
  const now = Date.parse('2026-11-01T14:00:00Z');
  const removal = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    createdAt: '2026-11-01T13:00:00Z', beforeCommit: { oid: commit,
      parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } };
  const payload = '\x1b]0;FAIL tests/x.test.mjs > t\x07\x1bPFAIL tests/x.test.mjs > t\x1b\\';
  const raw = payload + '\n\x1b[31m' + 'x'.repeat(2000)
    + ' Runner disconnected; The runner has received a shutdown signal; fatal: could not fetch deadbeef from promisor remote\x1b[0m';
  const violations = [];
  for (const mode of ['retry', 'quarantine', 'gate', 'exact']) {
    const logs = [], reads = [], unexpected = [];
    const name = mode === 'gate' ? 'merge-gate' : 'test-shard (1)';
    const checks = [{ id: 21, name, status: 'completed', conclusion: 'failure',
      output: { title: 'opaque failure', summary: '' },
      details_url: `https://github.com/${repo}/actions/runs/201/job/21` }];
    // Force the base reader's existing >10-job refusal so the exact-test reader owns its log read.
    if (mode === 'exact') for (let id = 22; id <= 31; id++) checks.push({ ...checks[0], id, name: 'test',
      details_url: `https://github.com/${repo}/actions/runs/201/job/${id}` });
    const exec = (command, args) => {
      if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: {
        pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: {
        pullRequest: { timelineItems: { nodes: mode === 'exact'
          ? [removal, { __typename: 'AddedToMergeQueueEvent' }, removal] : [removal],
        pageInfo: { hasPreviousPage: false } } } } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`)) ?? '';
      if (endpoint.includes('/check-runs?')) return JSON.stringify({ total_count: checks.length, check_runs: checks });
      if (endpoint.includes('/actions/workflows/ci.yml/runs?')) {
        const run = { id: 102, conclusion: 'success', status: 'completed', path: '.github/workflows/ci.yml',
          head_branch: 'main', event: 'push', created_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T13:30:00Z' };
        return JSON.stringify({ total_count: 1, workflow_runs: [run] });
      }
      if (/\/actions\/jobs\/\d+\/logs$/.test(endpoint)) {
        reads.push(args);
        if (!args.includes('--allow-escape-sequences')) throw new Error('unreadable log');
        return mode === 'exact' ? Buffer.from(raw) : raw;
      }
      const jobId = /\/actions\/jobs\/(\d+)$/.exec(endpoint)?.[1];
      if (jobId) return JSON.stringify({ ...checks.find(check => check.id === Number(jobId)), head_sha: commit,
        run_id: 201, steps: [{ name: jobId === '21' ? 'Unit suite shard 1/1 run' : 'Gate on shard results',
          status: 'completed', conclusion: 'failure' }] });
      if (endpoint.endsWith('/actions/runs/201')) return JSON.stringify({ id: 201, path: '.github/workflows/ci.yml',
        event: 'merge_group', head_sha: commit });
      if (endpoint.includes('/actions/runs/201/artifacts?')) return JSON.stringify({ total_count: 1,
        artifacts: [{ id: 501, name: 'timing-unit-1', expired: false, workflow_run: { id: 201, head_sha: commit } }] });
      if (endpoint.endsWith('/actions/artifacts/501/zip')) return Buffer.from('fixture archive');
      if (command === 'funzip') return JSON.stringify({ numFailedTests: 1, numFailedTestSuites: 1,
        testResults: [{ name: 'tests/x.test.mjs', status: 'failed', message: '',
          assertionResults: [{ ancestorTitles: [], title: 't', status: 'failed' }] }] });
      if (endpoint.endsWith('/check-runs/21')) return JSON.stringify({ id: 21, output: { annotations_count: 1 } });
      if (endpoint.includes('/check-runs/21/annotations?')) return JSON.stringify([
        { annotation_level: 'failure', message: 'Process completed with exit code 1.' }]);
      unexpected.push(`${command} ${args.join(' ')}`);
      throw new Error('unexpected fixture IO');
    };
    const quarantine = { now: () => now, readList: mode === 'quarantine' ? () => ({ ok: true,
      list: { mode: 'quarantine', entries: [{ test: 'tests/x.test.mjs::t', expiresAt: now + 60000 }] } }) : null };
    const result = mqSameHeadGuard({ repo, pr: 42, head, now, exec, quarantine, log: line => logs.push(line) });
    if (!result.hold || logs.some(line => line.startsWith('mq-same-head-retry:'))) violations.push(`${mode}: diagnostic authorized retry`);
    if (!reads.length || reads.some(args => !args.includes('--allow-escape-sequences'))) violations.push(`${mode}: missing readable log request`);
    if (!result.reason?.includes('Runner disconnected') || !logs.some(line => line.includes('job log diagnostic: ')))
      violations.push(`${mode}: missing hold diagnostic`);
    const excerpt = result.reason?.split('job log diagnostic: ')[1] ?? '';
    if (excerpt.length > 600 || /[\x00-\x1f\x7f-\x9f]/.test(excerpt) || excerpt.includes('tests/x.test.mjs'))
      violations.push(`${mode}: unbounded or unsafe diagnostic`);
    if (unexpected.length) violations.push(`${mode}: unexpected IO: ${unexpected.join(', ')}`);
  }
  return violations;
}

export default {
  id: 'mq-log-readable-never-authorizes-retry',
  title: 'readable escaped MQ logs remain diagnostic and never authorize retry or quarantine cover',
  card: 'operator diagnostic-only job-log ruling',
  fixedBy: { sha: 'pending', where: 'diagnostic-only log reads', paths: [SOURCE, 'scripts/lib/drain-mq-log-diagnostic.mjs'] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { mqSameHeadGuard } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(mqSameHeadGuard)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { mqSameHeadGuard } = await import('../../../lib/drain-queue-safety.mjs');
    const violations = probe(mqSameHeadGuard);
    log?.(`mq diagnostic-only logs: ${violations.length} violation(s)`);
    return { violations };
  },
  judge: report => report.violations,
};
