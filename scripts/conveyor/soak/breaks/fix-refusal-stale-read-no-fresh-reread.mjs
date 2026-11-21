/**
 * PR #7312: a bounced PR's pass-start thread was empty, so the fix pass kept
 * refusing no-findings after a red-team send-back arrived. Re-read the complete
 * thread and re-plan before leaving the bounced PR without a fixer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runReconcileFixDispatch } from '../../reconcile-fix-dispatch.mjs';
import { planReconcile } from '../../reconcile-core.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HEAD = '0ffddadbcfebba5deed89f65feee20dfdb4a04fd';
const NOW = Date.parse('2026-11-21T20:07:50Z');

export default {
  id: 'fix-refusal-stale-read-no-fresh-reread',
  title: 'a bounced no-findings PR dispatches a fix when a fresh thread contains the red-team send-back',
  card: 'PR #7312 stale no-findings refusal strands a red-team send-back',
  fixedBy: {
    sha: '2459ba009735febe6ef16326aa03f76ead6c8461',
    where: 'lane/fix-refusal-fresh-reread',
    paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'],
  },
  fixPresent() { return this.judge(this.run()).length === 0; },
  run() {
    const sendBack = JSON.parse(readFileSync(new URL('../../__tests__/fixtures/pr7312-red-team-send-back.json', import.meta.url), 'utf8'));
    const pr = { number: 7312, state: 'OPEN', isDraft: false,
      headRefName: 'lane/3438-wire-reconcile-pass', headRefOid: HEAD, baseRefName: 'main',
      labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      rowsComplete: true, rowsHead: HEAD, comments: [] };
    const initial = planReconcile({ prs: [pr], agents: [], now: NOW });
    const dispatched = [];
    let freshReads = 0;
    let replans = 0;
    runReconcileFixDispatch({
      root: ROOT, repo: 'we', dryRun: false,
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      now: NOW, clock: () => NOW, stepLog: () => {},
      reconcile: () => initial,
      readFreshPr: number => {
        freshReads++;
        if (number !== pr.number) throw new Error('unexpected fresh PR read');
        return { ...pr, comments: [sendBack], commentsComplete: true };
      },
      replanFreshPr: ({ readPrs }) => {
        replans++;
        return planReconcile({ prs: readPrs(), agents: [], now: NOW });
      },
      findItemFn: key => key === '3438' ? { num: '3438', slug: 'wire-reconcile-pass',
        specPath: 'backlog/3438-wire-reconcile-pass.md', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'] } : null,
      loadItems: () => [], fetchItemlessDiffPaths: () => [], pickFreeLanes: () => [2],
      listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null,
      tryResumeRound: null, tryResume: () => null,
      dispatch: entry => {
        dispatched.push(entry.pr);
        return { pr: entry.pr, lane: entry.lane, sessionId: 'soak-fresh-fix', unknownTokens: [] };
      },
    });
    const violations = [];
    if (!initial.refusals.some(r => r.prNumber === pr.number && r.kind === 'no-findings' && r.phase === 'bounced')) {
      violations.push('pass-start empty thread did not produce the bounced no-findings refusal');
    }
    if (freshReads !== 1 || replans !== 1) violations.push('the bounced refusal was not re-read and re-planned exactly once');
    if (dispatched.length !== 1 || dispatched[0] !== pr.number) violations.push('no single fix was dispatched for the fresh red-team send-back');
    return { violations };
  },
  judge(report) { return report.violations; },
};
