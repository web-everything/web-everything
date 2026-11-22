/** PR #7190: live check evidence must distinguish verdicts from label gates. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExpectationPass } from '../../pass-daemons/pr-expectation-pass.mjs';
import { resolveExpectationSettings } from '../../pass-daemons/pr-expectations.mjs';

const sha = 'a'.repeat(40);
const at = minute => new Date(Date.UTC(2026, 10, 19) + minute * 60000).toISOString();

export default {
  id: 'expectation-check-verdicts',
  title: 'completed red-team verdicts are missed while label gates impersonate reviews',
  card: 'PR #7190',
  fixedBy: { sha: 'HEAD', where: 'lane/babysitter-s1', paths: [
    'scripts/conveyor/pass-daemons/pr-expectation-pass.mjs',
  ] },
  fixPresent(root) {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      import b from './scripts/conveyor/soak/breaks/expectation-check-verdicts.mjs';
      const report = await b.run();
      process.stdout.write(String(b.judge(report).length === 0));
    `], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim() === 'true';
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'expectation-checks-'));
    try {
      const eventsFile = join(root, 'events.jsonl'), stateFile = join(root, 'state.json');
      writeFileSync(eventsFile, JSON.stringify({ kind: 'worker-push', pr: 8, sha, at: at(0) }) + '\n');
      const table = JSON.parse(readFileSync(new URL('../../../settings/expectations.json', import.meta.url), 'utf8'));
      const settings = resolveExpectationSettings({ tool: { ...table, expectations: table.expectations.filter(
        row => ['red-team-no-verdict', 'push-no-review'].includes(row.id)) } });
      let completed = false;
      const delivered = [];
      const opts = { repo: 'example/widgets', settings, stateFile, env: { WE_DAEMON_EVENTS: eventsFile },
        log() {}, emitEvent(event) { delivered.push(event); return true; }, gh(args) {
          if (args[0] !== 'api' || args.includes('-X') || args.includes('--method')) throw Error('unexpected write');
          if (args[1].includes('/pulls?')) return [7, 8].map(number => ({ number, state: 'open' }));
          const pr = args[1] === 'graphql' ? Number(args[3].match(/number: (\d+)/)[1])
            : Number(args[1].match(/\/(?:issues|pulls)\/(\d+)/)?.[1]);
          if (args[1] === 'graphql') return { data: { repository: { pullRequest: {
            number: pr, state: 'OPEN', headRefOid: sha, headRef: { target: { committedDate: at(-1) } },
            mergedAt: null, mergeStateStatus: 'CLEAN', mergeQueueEntry: null,
            labels: { nodes: pr === 7 && !completed ? [{ name: 'red-team:pending' }] : [], pageInfo: { hasNextPage: false } },
          } } } };
          if (args[1].includes('/timeline?')) return pr === 7 ? [
            { event: 'labeled', label: { name: 'red-team:pending' }, created_at: at(0), id: 1 },
            ...(completed ? [{ event: 'unlabeled', label: { name: 'red-team:pending' }, created_at: at(5), id: 2 }] : []),
          ] : [];
          // Both PRs share a head, so the same head-bound checks apply to both.
          if (args[1].includes('/check-runs?')) {
            const names = completed ? ['unit', 'review-gate', 'red-team'] : ['unit', 'review-gate'];
            return { total_count: names.length, check_runs: names.map((name, id) => ({
              name, id, head_sha: sha, status: 'completed', conclusion: name === 'review-gate' ? 'failure' : 'success',
              started_at: at(1), completed_at: at(5),
            })) };
          }
          if (/\/pulls\/\d+$/.test(args[1])) return { state: 'open', head: { sha } };
          throw Error('unexpected read');
        } };
      const first = await runExpectationPass({ ...opts, now: at(0) });
      completed = true;
      const final = await runExpectationPass({ ...opts, now: at(61) });
      const verdict = final.results.find(r => r.pr === 7 && r.expectationId === 'red-team-no-verdict');
      const review = final.results.find(r => r.pr === 8 && r.expectationId === 'push-no-review');
      const violations = [];
      if (first.incomplete || final.incomplete) violations.push('check evidence became unknown');
      if (verdict?.status !== 'met' || verdict.reactionAt !== at(5)) violations.push('completed red-team check did not settle its verdict');
      if (review?.status !== 'missed') violations.push('label gate impersonated a review dispatch');
      if (delivered.length !== 1 || delivered[0]?.detail.expectationId !== 'push-no-review') violations.push('wrong miss receipt emitted');
      const report = { violations, verdict: verdict?.status, review: review?.status };
      log?.(JSON.stringify(report));
      return report;
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
