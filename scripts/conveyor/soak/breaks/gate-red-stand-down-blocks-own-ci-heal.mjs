/**
 * @file breaks/gate-red-stand-down-blocks-own-ci-heal.mjs — live break, 2026-10-21 (PR #5768, head 3a062c359).
 *
 * LIVE INCIDENT: the fix agent stood down at 18:01Z with `<!-- stand-down reason=gate-red -->` — its gate stayed red
 * only on an out-of-diff test (`daemon-live-smoke.test.mjs` "runLiveSmokeWithRetry forwards changedFiles"), and it
 * never checked whether that test is red on main (it is green there). From then on every fix-dispatch pass logged
 * "own-failure, owed a ci-heal" and refused it `stood-down` — "a fix agent already stopped here to ask a question …
 * terminal on this head" — for ~4h. A gate-red stand-down is a failed gate, not a question for a person.
 *
 * FIX — `reconcile-core.mjs#gateRedRetryState` + `fix.standDown.gateRedRetries` (standard 1): ONE own-failure
 * ci-heal per head, whose brief checks each failing test against main first; a second gate-red (or a spent retry)
 * stays terminal and raises needs-you; a real question stays terminal.
 *
 * SCENARIO: both the human-only and live #5768 label sets through `planReconcile` over four same-head ticks.
 * Feed the dispatcher's retry record or the session's fix-begin back after the first heal. Standard 1 must
 * plan EXACTLY one ci-heal per head; the 0 kill switch must plan none. RED = either count drifts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const NOW = Date.parse('2026-10-21T22:00:00Z');
const REQUIRED = ['test', 'smoke'];
const HEAD = '3a062c359'.padEnd(40, '0');
const run = (name, conclusion, completedAt) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });

export default {
  id: 'gate-red-stand-down-blocks-own-ci-heal',
  title: 'a gate-red stand-down was read as a question for a person and blocked the PR\'s own owed ci-heal forever',
  card: 'gate-red stand-down terminal — live PR #5768, 2026-10-21',
  fixedBy: { sha: '4da8f6869', where: 'lane/gate-red-standdown', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/reconcile-core.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('gateRedRetryState');
  },
  async run({ log, sourceRoot = ROOT } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { buildStandDownComment, buildGateRedRetryRecordComment } = await load('scripts/conveyor/stand-down.mjs');
    const { buildFixBeginComment } = await load('scripts/conveyor/fix-procedure.mjs');
    const { AUTOMATION_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
    const author = { login: AUTOMATION_LOGINS[0] };
    const pr = {
      number: 5768, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED', headRefOid: HEAD,
      headRefName: 'lane/verify-admission-heartbeat-timeout-memory',
      commits: [{ oid: HEAD, committedDate: '2026-10-21T17:40:00Z' }],
      statusCheckRollup: [run('test', 'FAILURE', '2026-10-21T18:20:00Z'), run('smoke', 'SUCCESS', '2026-10-21T18:10:00Z')],
      comments: [{ author, createdAt: '2026-10-21T17:00:00Z', body: '## changes requested\nfinding' },
        { author, createdAt: '2026-10-21T18:01:26Z', body: buildStandDownComment({ reason: 'gate-red',
        detail: "attempt 3 @ 3a062c359: only red is daemon-live-smoke.test.mjs 'runLiveSmokeWithRetry forwards changedFiles'" }) }],
    };
    const violations = [];
    for (const labels of [['review:human'], ['review:changes', 'review:human', 'status:ci-red']]) {
      for (const setting of [{ value: 1, source: 'standard' }, { value: 0, source: 'tool' }]) {
        // Exercise each durable trace independently: a launch can die before posting its fix-begin.
        for (const feedback of ['retry-record', 'fix-begin']) {
          const row = { ...pr, labels: labels.map(name => ({ name })), comments: [...pr.comments] };
          const healsPerTick = [];
          const refused = [];
          let fedBack = false;
          for (let tick = 0; tick < 4; tick++) {
            const now = NOW + tick * 60_000;
            const plan = planReconcile({ prs: [row], agents: [], now, requiredChecks: REQUIRED, gateRedRetries: setting });
            const heals = (plan.dispatch || []).filter(d => d.prNumber === 5768 && d.kind === 'ci-heal');
            healsPerTick.push(heals.length);
            refused.push((plan.refusals || []).filter(r => r.prNumber === 5768)
              .map(r => `${r.kind}: ${String(r.why || '').slice(0, 120)}`).join(' | ') || 'no refusal');
            if (heals.length && !fedBack) {
              row.comments.push({ author, createdAt: new Date(now + 1_000).toISOString(), body: feedback === 'retry-record'
                ? buildGateRedRetryRecordComment({ head: HEAD, allowance: setting.value, source: setting.source })
                : buildFixBeginComment({ who: 'ci-heal-5768', why: 'conveyor ci-heal: red-ci',
                  branch: row.headRefName, headSha: HEAD }) });
              fedBack = true;
            }
          }
          const totalHeals = healsPerTick.reduce((sum, count) => sum + count, 0);
          const expected = [setting.value, 0, 0, 0];
          const mismatch = healsPerTick.findIndex((count, tick) => count !== expected[tick]);
          log?.(JSON.stringify({ labels, gateRedRetries: setting, feedback, healsPerTick, totalHeals }));
          if (totalHeals !== setting.value || mismatch !== -1) {
            violations.push({ invariant: 'one-per-head', detail: `PR #5768 head ${HEAD.slice(0, 9)}, ${labels.join('+')}, `
              + `fix.standDown.gateRedRetries=${setting.value}, ${feedback}: expected ci-heals ${JSON.stringify(expected)} `
              + `(total ${setting.value}), got ${JSON.stringify(healsPerTick)} (total ${totalHeals}); tick ${mismatch}: ${refused[mismatch]}` });
          }
        }
      }
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
