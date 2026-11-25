/** Replay two dead jurors on one head, then continue ticking: recovery must stop. */
import { runReviewTick } from '../../../../skills-src/conveyor/review-daemon.mjs';
export default {
  id: 'juror-timeout-same-provider', card: 'JUROR-TIMEOUT-RETRY',
  title: 'juror timeout retries exclude the failed provider and hold when routes exhaust',
  fixedBy: { sha: 'working-tree', where: 'review-daemon' }, fixPresent: () => true,
  async run() {
    const repo = ['web-everything', 'web-everything'].join('/');
    const head = 'a'.repeat(40), key = `${repo}#77`;
    const dispatchState = { firstOwedAt: new Map(), lastDispatched: new Map([[key, { pid: 41, head }]]) };
    const starts = [], logs = [], ticks = [];
    let provider = 'claude';
    const tick = () => runReviewTick({ repo, dispatchState,
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 77, headRefOid: head }], refusals: [] }),
      readPrs: () => [{ number: 77, headRefOid: head, labels: ['review:pending'] }], readAgents: () => [],
      holdReconcile: () => [], statusCandidates: () => [], tagStatus: () => {}, tagRound: () => {},
      isPidAlive: () => false, acquirableLanes: () => 10,
      diagnoseJob: () => ({ marker: true, head, jurorTimeout: { reason: 'juror-timeout', lens: 'security', provider, model: provider } }),
      writeJobDiagnosis: () => {}, timeoutRouteAvailable: () => provider === 'claude',
      dispatch: input => { starts.push(input); return { jobPid: 42 }; }, log: line => logs.push(line) });
    ticks.push(tick()); provider = 'agy-gemini'; ticks.push(tick()); ticks.push(tick()); ticks.push(tick());
    return { starts, logs, ticks };
  },
  judge({ starts, logs, ticks }) {
    const violations = [];
    if (starts.length !== 1) violations.push({ invariant: 'bounded-recovery', detail: `started ${starts.length} jobs` });
    if (starts[0]?.jurorTimeoutExclusions?.[0]?.provider !== 'claude') violations.push({ invariant: 'exclude-timeout', detail: 'failed provider was not excluded' });
    if (!ticks[1]?.notStarted?.some(row => row.reason === 'review-blocked-on-infra: juror timeout x2')) violations.push({ invariant: 'reasoned-hold', detail: 'no timeout hold' });
    if (!logs.some(line => line.includes('orchestrator ask:'))) violations.push({ invariant: 'operator-visible', detail: 'no orchestrator ask' });
    return violations;
  },
};
