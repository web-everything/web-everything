/**
 * @file breaks/no-code-ruling-rearm-executes-once.mjs — LIVE incident, #7448 and #7451 (2026-11-24): the orchestrator's
 * `stand-down-answer --disposition=rearm-review --no-code-owed` ruling passed every CLI check, but nothing ran the rearm
 * afterward. The answered stand-down fell through to fix dispatch, the new fixer posted a fix-begin on the SAME head, and
 * rearm-review refused again (empty round) — a circle.
 *
 * Fix (STANDDOWN-EMPTY-ROUND D2): the reconcile planner emits exactly one `rearm-no-code` row for the ruling and never a
 * fixer; promote-draft-pr-dispatch executes it through rearm-review.mjs once. The judge demands EXACTLY ONE execution and
 * ZERO fix dispatches while the ruling is unspent (a count >= 1 judge would accept a retry loop).
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const HEAD = '93ff74ce966785fe5844fa63f2be9b8ed091aa52';
const BOT = { login: 'web-everything' };

export default {
  id: 'no-code-ruling-rearm-executes-once',
  title: 'an operator no-code rearm ruling was never executed and fell through to a fixer that could not change anything (#7448, #7451)',
  card: 'STANDDOWN-EMPTY-ROUND',
  fixedBy: { sha: '54eda3510dec77d9bb844af567674590ea214374', where: 'lane/standdown-s2-d2', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      try {
        const writer = await import(process.argv[1]);
        const reader = await import(process.argv[2]);
        process.exitCode = typeof writer.defaultRearmNoCode === 'function'
          && typeof reader.isNoCodeRearmExecuted === 'function' && typeof reader.noCodeRearmState === 'function' ? 0 : 1;
      } catch { process.exitCode = 1; }
    `, pathToFileURL(join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs')).href,
      pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer-core.mjs')).href],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !probe.error && probe.status === 0;
  },
  async run() {
    const root = REPO_ROOT;
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { buildOperatorAnswer } = await load('scripts/conveyor/stand-down-answer-core.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { runReconcilePromoteDraftDispatch, defaultRearmNoCode } = await load('scripts/operations/promote-draft-pr-dispatch.mjs');
    const comments = [
      { id: 'IC_99', author: BOT, body: `🔁 review — changes requested\n\nrequired check "merge-gate" FAILURE\n<!-- reviewed-sha: ${HEAD} -->` },
      { id: 'IC_105', author: BOT, body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-7448 -->` },
      { id: 'IC_106', author: BOT, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }) },
      { id: 'IC_200', author: { login: 'chalbert' }, body: buildOperatorAnswer({ standDownId: 'IC_106', reason: 'No code is owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true }) },
    ];
    // Offline reconstruction of the two incident paths; no captured GitHub rollup was supplied.
    const pr = { number: 7448, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: HEAD,
      rowsComplete: true, rowsHead: HEAD,
      labels: [{ name: 'review:changes' }, { name: 'review-round:1' }], comments, commits: [],
      statusCheckRollup: [{ name: 'merge-gate', status: 'completed', conclusion: 'failure' }], mergeStateStatus: 'CLEAN' };
    const violations = [];
    for (const { number, fails } of [7448, 7451].flatMap(number => [false, true].map(fails => ({ number, fails })))) {
      pr.number = number;
      const thread = [...comments];
      let executions = 0;
      let fixDispatches = 0;
      for (let tick = 0; tick < 2; tick += 1) {
        const plan = planReconcile({ prs: [{ ...pr, comments: [...thread] }], agents: [], durableCounts: {}, requiredChecks: ['merge-gate'], now: Date.parse('2026-11-24T22:00:00Z') });
        // A failed ruling waits for operator recovery on review:changes. Success must resume CI healing.
        fixDispatches += plan.dispatch.filter(d => d.kind === 'fix' || ((fails || tick === 0) && d.kind === 'ci-heal')).length;
        const expected = tick === 0 ? ['rearm-no-code'] : fails ? [] : ['ci-heal'];
        if (JSON.stringify(plan.dispatch.map(d => d.kind)) !== JSON.stringify(expected)) violations.push({
          invariant: 'complete-two-tick-dispatch', detail: `#${number} ${fails ? 'failure' : 'success'} tick ${tick + 1}: ${JSON.stringify(plan.dispatch.map(d => d.kind))}, want ${JSON.stringify(expected)}` });
        if ((tick === 0 || !fails) && plan.refusals.length) violations.push({
          invariant: 'no-refusals', detail: `#${number} tick ${tick + 1}: ${JSON.stringify(plan.refusals)}` });
        runReconcilePromoteDraftDispatch({
          root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }), clearAwaitingCi: () => {},
          readHeadCheckState: () => ({ state: 'green', why: '', counts: {} }), provider: { ready: () => {} },
          reconcile: () => plan,
          rearm: args => defaultRearmNoCode({ ...args,
            postComment: ({ comment }) => {
              thread.push({ id: `IC_post${thread.length}`, author: BOT, body: comment });
              if (comment.includes('state=confirm')) pr.labels = [{ name: 'review:pending' }];
            },
            // The child can fail WITHOUT writing a marker. Only the real wrapper persists the attempt.
            run: () => { executions++; if (fails) throw new Error('injected child failure, no marker'); return { status: 0 }; },
          }),
        });
      }
      if (executions !== 1) violations.push({ invariant: 'executed-exactly-once', detail: `${fails ? 'failure' : 'success'}: executed ${executions} time(s) over 2 ticks (want exactly 1)` });
      if (fixDispatches !== 0) violations.push({ invariant: 'no-fixer-for-a-no-code-ruling', detail: `${fixDispatches} fix dispatch(es) alongside a no-code ruling` });
      if (fails && !thread.some(c => c.body.includes('attempt=failed'))) violations.push({ invariant: 'durable-failure', detail: 'executor failed without recording the attempt' });
      pr.labels = [{ name: 'review:changes' }, { name: 'review-round:1' }];
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
