/**
 * A stale hung check survives after GitHub completes its run. At the retry cap, cancellation returns
 * HTTP 409: record the completed run as handled, then refuse it on the next sweep rather than loop.
 * Exercises the real cancel helper, comment builder and sweep with hermetic GitHub IO.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const REPO = 'fixture/repo';
const RUN = 43093913029;
const HEAD = 'deadbeef2636';
const JOB = 'test-shard (1)';
const NOW = Date.parse('2026-09-25T20:10:00Z');

export default {
  id: 'hung-ci-completed-run-reselect',
  title: 'a completed hung run is recorded as handled and refused on the next sweep',
  card: 'we:backlog/4075 (hung-CI completed-run cancellation loop)',
  fixedBy: { sha: 'HEAD', where: 'main', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) {
    const path = join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs');
    if (!existsSync(path)) return false;
    const source = readFileSync(path, 'utf8');
    return source.includes("reason = 'run-already-completed'")
      && source.includes("kind: 'run-already-completed'");
  },
  async run() {
    const { sweepHungCiRecovery, cancelHungRun, buildHungCiComment } =
      await import(join(REPO_ROOT, 'scripts/conveyor/ci-red-recovery-watch.mjs'));
    const pr = {
      number: 2636, headRefName: 'lane/completed-run', headRefOid: HEAD,
      statusCheckRollup: [{
        __typename: 'CheckRun', name: JOB, workflowName: 'CI', status: 'IN_PROGRESS',
        conclusion: '', startedAt: '2026-09-25T16:34:28Z',
        detailsUrl: `https://github.com/${REPO}/actions/runs/${RUN}/job/108159093983`,
      }],
    };
    // Historical retry markers force cancel-only escalation, the live path that used to loop.
    const prior = buildHungCiComment({ runId: RUN, headSha: HEAD, jobName: JOB });
    const comments = [prior, prior].map(body => ({ body, author: { login: 'web-everything' } }));
    const calls = [];
    const unexpectedWrites = [];
    const options = {
      apply: true, repo: REPO, now: NOW, maxRetriesPerSha: 2,
      readOpenPrs: () => [pr],
      readComments: () => [...comments],
      cancelOnly: (id, o) => cancelHungRun(id, {
        ...o,
        exec: (cmd, args) => {
          calls.push({ cmd, args: [...args] });
          if (cmd !== 'gh' || JSON.stringify(args) !== JSON.stringify([
            'api', '-X', 'POST', `repos/${REPO}/actions/runs/${RUN}/cancel`,
          ])) throw new Error(`Unexpected cancel invocation: ${cmd} ${JSON.stringify(args)}`);
          const error = new Error('Command failed: gh api');
          error.stderr = Buffer.from('gh: Cannot cancel a workflow run that is completed (HTTP 409)');
          throw error;
        },
      }),
      cancelAndRerun: () => {
        unexpectedWrites.push('cancel-and-rerun');
        return { ok: false, action: 'unexpected-rerun' };
      },
      trigger: () => {
        unexpectedWrites.push('trigger');
        return { ok: false, action: 'unexpected-trigger' };
      },
      postComment: (number, o) => {
        if (number !== pr.number) unexpectedWrites.push(`comment on PR ${number}`);
        comments.push({ body: buildHungCiComment(o), author: { login: 'web-everything' } });
      },
    };
    const first = sweepHungCiRecovery(options);
    const marker = comments[2]?.body ?? '';
    // Keep the stale IN_PROGRESS check intact; only durable comment evidence may stop selection.
    const second = sweepHungCiRecovery({ ...options, now: NOW + 60_000 });
    const violations = [];
    const check = (ok, invariant, detail) => {
      if (!ok) violations.push({ invariant, detail });
    };
    check(first.dispatch.length === 1 && first.dispatch[0].kind === 'hung-cap-escalate',
      'escalation-selected', 'The exhausted head did not reach cancel-only escalation');
    check(first.applied.length === 1 && first.applied[0].ok === true
      && first.applied[0].action === 'already-completed',
    'completed-refusal-handled', 'HTTP 409 was not treated as an already-completed run');
    check([`reason: run-already-completed`, `run: ${RUN}`, `sha: ${HEAD}`]
      .every(line => marker.split('\n').includes(line)),
    'durable-completed-marker', 'The production comment omitted exact reason, run or sha evidence');
    check(second.dispatch.length === 0 && second.applied.length === 0,
      'no-reselection', 'The stale hung run was selected again on the next sweep');
    check(second.refusals.length === 1 && second.refusals[0].kind === 'run-already-completed'
      && second.refusals[0].runId === RUN && second.refusals[0].headSha === HEAD,
    'completed-refusal-reported', 'The next sweep did not report this run and head as already completed');
    check(calls.length === 1 && comments.length === 3 && unexpectedWrites.length === 0,
      'no-repeat-writes', `Expected one cancel and one new marker; calls=${calls.length}, comments=${comments.length}, unexpected=${JSON.stringify(unexpectedWrites)}`);
    return { violations };
  },
  judge(report) {
    return report.violations.map(v => `[${v.invariant}] ${v.detail}`);
  },
};
