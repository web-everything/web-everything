/** PR #5975: a shared budget refusal must not spend main's one cancelled-run retry. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepMainCancelledRetrigger, rerunMainCancelledRun, mainRetriggerRecordPath } from '../../ci-red-recovery-watch.mjs';
import { DEFAULT_MAIN_WORKFLOW_NAME } from '../../main-red-recovery.mjs';
import { runGhSync, writeBudgetBlock } from '../../../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const SOURCE = 'scripts/conveyor/ci-red-recovery-watch.mjs';
const REPO = 'main-ci-fixture/example';

export default {
  id: 'main-ci-budget-refusal',
  title: 'main CI retries after a local budget refusal without duplicating a submitted rerun',
  card: 'PR #5975 red-team send-back x1b8hlo',
  fixedBy: { sha: 'HEAD', where: 'lane/main-ci-retrigger', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('function isMainRerunNotSubmitted(');
  },
  async run() {
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const root = mkdtempSync(join(tmpdir(), 'soak-main-budget-'));
    try {
      let clock = Date.parse('2026-10-26T12:00:00Z');
      const reset = clock + 60_000;
      const sha = 'a'.repeat(40);
      const recordPath = join(root, 'record.json');
      let reads = 0;
      let submissions = 0;
      const events = [];
      const options = { apply: true, repo: REPO, recordPath,
        emitEvent: event => { events.push(event); },
        readMainRuns: () => {
          // Simulate another watcher exhausting core after this history read succeeds.
          if (++reads === 1) writeBudgetBlock(root, 'app', 'core', { nowMs: clock, untilMs: reset });
          return [{ databaseId: 123, headSha: sha, workflowName: DEFAULT_MAIN_WORKFLOW_NAME,
            createdAt: '2026-10-26T11:00:00Z', status: 'completed', conclusion: 'cancelled' }];
        },
        rerun: (id, opts) => rerunMainCancelledRun(id, { ...opts,
          exec: (_bin, args, execOpts) => runGhSync(args, { ...execOpts, env: { GH_TOKEN: 'ghs_test_budget' },
            throttle: { lockRoot: root, env: {}, now: () => clock, sleep: () => {}, cap: 4,
              exec: actualArgs => {
                check(JSON.stringify(actualArgs) === JSON.stringify(['api', '-X', 'POST',
                  `repos/${REPO}/actions/runs/123/rerun`]), 'unexpected GitHub operation');
                submissions++;
                return '';
              } },
          }),
        }),
      };
      const refused = sweepMainCancelledRetrigger({ ...options, now: clock });
      check(refused.applied[0]?.ok === false && refused.applied[0]?.error.includes('call not sent'),
        'did not observe the local budget refusal');
      check(submissions === 0, 'budget refusal submitted a GitHub call');
      check(Object.keys(JSON.parse(readFileSync(recordPath, 'utf8'))).length === 0,
        'local budget refusal retained a reservation');
      check(events.length === 0, 'budget refusal emitted a successful retrigger event');
      // Fresh sweep objects retain only durable state between watcher ticks.
      sweepMainCancelledRetrigger({ ...options, now: clock });
      check(submissions === 0, 'active backoff allowed a submission');
      clock = reset + 1;
      const retried = sweepMainCancelledRetrigger({ ...options, now: clock });
      check(retried.applied[0]?.ok === true && submissions === 1, 'budget reset did not restore the retry');
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      check(record[sha]?.runId === 123 && !record[sha]?.reserved, 'successful retry was not durably confirmed');
      check(events.length === 1 && events[0].kind === 'main-ci-retriggered', 'retry event was missing or duplicated');
      sweepMainCancelledRetrigger({ ...options, now: clock });
      check(submissions === 1 && events.length === 1, 'a later sweep duplicated the submitted rerun');

      // WE's legacy filename and a mirror's new file share a home and a commit, but not a retry.
      const sharedHome = join(root, 'shared-head');
      const repos = [[CONSTELLATION_REPOS.we.slug, 321], ['main-ci-fixture/mirror', 654]];
      const sharedSubmissions = [];
      for (let tick = 0; tick < 3; tick++) {
        for (const [repo, runId] of repos) {
          const result = sweepMainCancelledRetrigger({ apply: true, repo, now: clock,
            recordPath: mainRetriggerRecordPath(repo, sharedHome), emitEvent: () => {},
            readMainRuns: () => [{ databaseId: runId, headSha: sha, workflowName: DEFAULT_MAIN_WORKFLOW_NAME,
              createdAt: '2026-10-26T11:00:00Z', status: 'completed', conclusion: 'cancelled',
              ...(tick > 0 ? { updatedAt: new Date(clock + 60_000).toISOString() } : {}),
            }],
            rerun: (id, opts) => { sharedSubmissions.push([opts.repo, id]); return { ok: true }; },
          });
          check(result.refusals.length === 0, `shared-head sweep refused ${repo}`);
          const action = tick === 0 ? 'main-ci-retriggered' : 'main-ci-stuck';
          check(tick === 2 ? result.applied.length === 0 : result.applied[0]?.action === action && result.applied[0]?.ok,
            `shared-head tick ${tick} did not preserve ${repo}'s retry lifecycle`);
        }
      }
      check(JSON.stringify(sharedSubmissions) === JSON.stringify(repos),
        'repositories sharing a SHA did not each submit exactly one rerun');
      for (const [repo, runId] of repos) {
        const sharedRecord = JSON.parse(readFileSync(mainRetriggerRecordPath(repo, sharedHome), 'utf8'));
        check(sharedRecord[sha]?.runId === runId && sharedRecord[sha]?.stuck === true,
          `shared-head record inherited another repository's attempt for ${repo}`);
      }
    } catch (error) {
      violations.push(`budget refusal replay failed: ${error.message}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
