/**
 * @file breaks/no-code-ruling-rearm-executes-once.mjs — LIVE incident, #7448 and #7451 (2026-11-24): the orchestrator's
 * `stand-down-answer --disposition=rearm-review --no-code-owed` ruling passed every CLI check, but nothing ran the rearm
 * afterward. The answered stand-down fell through to fix dispatch, the new fixer posted a fix-begin on the SAME head, and
 * rearm-review refused again (empty round) — a circle.
 *
 * Fix (STANDDOWN-EMPTY-ROUND D2): the reconcile planner emits exactly one `rearm-no-code` row for the ruling and never a
 * fixer; promote-draft-pr-dispatch executes it through rearm-review.mjs once. The judge demands EXACTLY ONE execution and
 * ZERO fix dispatches over two ticks (a count >= 1 judge would accept a retry loop).
 */
import { existsSync, readFileSync } from 'node:fs';
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
    const p = join(root, 'scripts/conveyor/reconcile-core.mjs');
    return existsSync(p) && /rearm-no-code/.test(readFileSync(p, 'utf8'));
  },
  async run() {
    const root = REPO_ROOT;
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { buildOperatorAnswer } = await load('scripts/conveyor/stand-down-answer-core.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { runReconcilePromoteDraftDispatch } = await load('scripts/operations/promote-draft-pr-dispatch.mjs');
    const { buildNoChangeComment } = await load('scripts/conveyor/rearm-review.mjs');
    const comments = [
      { id: 'IC_99', author: BOT, body: `🔁 review — changes requested\n\nrequired check "merge-gate" FAILURE\n<!-- reviewed-sha: ${HEAD} -->` },
      { id: 'IC_105', author: BOT, body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-7448 -->` },
      { id: 'IC_106', author: BOT, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }) },
      { id: 'IC_200', author: { login: 'chalbert' }, body: buildOperatorAnswer({ standDownId: 'IC_106', reason: 'No code is owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true }) },
    ];
    const pr = { number: 7448, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: HEAD,
      labels: [{ name: 'review:changes' }, { name: 'review-round:1' }], comments, commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN' };
    let executions = 0;
    let fixDispatches = 0;
    const violations = [];
    for (let tick = 0; tick < 2; tick += 1) {
      const plan = planReconcile({ prs: [{ ...pr, comments: [...comments] }], agents: [], durableCounts: {}, now: Date.parse('2026-11-24T22:00:00Z') });
      fixDispatches += plan.dispatch.filter((d) => ['fix', 'ci-heal'].includes(d.kind)).length;
      runReconcilePromoteDraftDispatch({
        root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }), clearAwaitingCi: () => {},
        readHeadCheckState: () => ({ state: 'green', why: '', counts: {} }), provider: { ready: () => {} },
        reconcile: () => plan,
        // The real rearm-review posts a marker on success or an empty-round note on refusal: either spends the ruling.
        rearm: () => { executions += 1; comments.push({ id: `IC_x${tick}`, author: BOT, body: buildNoChangeComment({ actor: 'conveyor', since: HEAD }) }); },
      });
    }
    if (executions !== 1) violations.push({ invariant: 'executed-exactly-once', detail: `the ruling was executed ${executions} time(s) over 2 ticks (want exactly 1)` });
    if (fixDispatches !== 0) violations.push({ invariant: 'no-fixer-for-a-no-code-ruling', detail: `${fixDispatches} fix dispatch(es) were planned for a no-code ruling` });
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
