/** Failed-check summaries and printed infrastructure signatures never authorize MQ retries. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/drain-queue-safety.mjs';

function probe(mqSameHeadGuard) {
  const repo = 'fixture/drain', head = 'a'.repeat(40), commit = 'b'.repeat(40);
  const violations = [];
  const cases = [
    ['runner title with assertions', { title: 'Runner disconnected' }, 'AssertionError: expected 1 to be 2\n'],
    ['runner summary with assertions', { summary: 'Runner disconnected' }, 'AssertionError: expected 1 to be 2\n'],
    ['summary-only runner loss', { summary: 'Runner disconnected' }, 'Process exited with code 1\n'],
    ['TAP failure with printed signature', {}, 'not ok 1 - assertion\nfatal: could not fetch X from promisor remote\n'],
    ['printed signature alone', {}, 'fatal: could not fetch X from promisor remote\n'],
  ];
  for (const [name, output, text] of cases) {
    let logReads = 0;
    const response = pullRequest => JSON.stringify({ data: { repository: { pullRequest } } });
    const exec = (command, args) => {
      if (command !== 'gh') throw new Error('unexpected IO');
      if (args.some(arg => arg.includes('isInMergeQueue'))) return response({ isInMergeQueue: false, headRefOid: head });
      if (args.some(arg => arg.includes('timelineItems'))) return response({ timelineItems: {
        nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
          createdAt: '2026-11-01T13:45:00Z', beforeCommit: { oid: commit,
            parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }],
        pageInfo: { hasPreviousPage: false },
      } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
      if (endpoint?.includes('/check-runs?')) return JSON.stringify({ total_count: 1, check_runs: [{
        id: 21, name: 'test-shard (1)', status: 'completed', conclusion: 'failure', output,
        details_url: `https://github.com/${repo}/actions/runs/201/job/9021`,
      }] });
      if (endpoint === `repos/${repo}/actions/jobs/9021/logs`) { logReads++; return text; }
      if (endpoint?.includes('/actions/workflows/ci.yml/runs?')) return JSON.stringify({ total_count: 1, workflow_runs: [{
        id: 102, conclusion: 'success', status: 'completed', created_at: '2026-11-01T13:20:00Z',
        updated_at: '2026-11-01T13:20:00Z', path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
      }] });
      throw new Error('unexpected evidence read');
    };
    const decision = mqSameHeadGuard({ repo, pr: 6215, head, exec, now: Date.parse('2026-11-01T14:00:00Z'),
      quarantine: { readList: null } });
    if (decision.hold !== true) violations.push(`${name}: text authorized retry`);
    if (logReads !== 1 || decision.mainRunId !== 102 || !/non-infrastructure/.test(decision.reason ?? ''))
      violations.push(`${name}: missing readable-log, green-main non-infrastructure hold evidence`);
  }
  return violations;
}

export default {
  id: 'mq-summary-text-never-infra',
  title: 'MQ summary text and printed signatures never authorize infrastructure retries',
  card: 'same-head MQ text authorization removal',
  fixedBy: { sha: 'pending', where: 'slice B', paths: [SOURCE] },
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
    log?.(`mq text never infra: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
