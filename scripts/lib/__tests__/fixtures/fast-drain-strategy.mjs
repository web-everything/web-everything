import { createDrainMergeStrategy, buildClearanceComment } from '../../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../../merge-delivery-policy.mjs';
import { redTeamMarker } from '../../red-team-gate.mjs';
process.env.WE_UNDER_TEST = '1';
process.env.WE_DRAIN_READS_SOURCE = 'git';

export const HEAD = 'a'.repeat(40), REPO = 'fixture/repo';
export function strategyFixture({ labels = ['ready-to-merge'], onLive, mutation, membership, evidence,
  initial = null, source = 'drain-scan', wait = false, comments, ...extra } = {}) {
  let state = initial, mutated = false, liveReads = 0;
  const calls = [], writes = [], logs = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git') return args[0] === 'diff' ? 'scripts/example.mjs\0' : args[0] === 'rev-parse' ? 'b'.repeat(40) : '';
    if (args.includes('--slurp')) return JSON.stringify([comments ?? [{ author: { login: 'web-everything' }, body: `${redTeamMarker(7, HEAD)}\nRed team not required on this head: card-only diff.` }]]);
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args.at(-1) === 'headRefOid,labels,reviews') return JSON.stringify(onLive?.(++liveReads) ?? { headRefOid: HEAD, labels });
      return JSON.stringify({ id: 'PR7', headRefOid: HEAD, baseRefName: 'main', labels });
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (args.some(a => a.includes('isInMergeQueue'))) {
        if (membership) return membership(mutated);
        return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: mutated, headRefOid: HEAD } } } });
      }
      if (args.some(a => a.includes('enqueuePullRequest'))) {
        writes.push('enqueue');
        if (mutation) return mutation();
        mutated = true;
        return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E7' } } } });
      }
    }
    if (args[0] === 'api' && args[1] === 'user') return 'drain-bot';
    if (args[0] === 'pr' && args[1] === 'comment') { writes.push(args.at(-1) === buildClearanceComment(HEAD) ? 'stamp' : 'hold-comment'); return ''; }
    if (args[0] === 'pr' && args[1] === 'edit') { writes.push('labels'); return ''; }
    throw new Error(`unexpected fixture IO: ${file} ${args.join(' ')}`);
  };
  const helpers = { cancelObsoleteRuns: () => writes.push('cancel-runs'),
    postConflictFinding: () => writes.push('post-conflict-finding'),
    requestRedTeam: () => { writes.push('red-team-request'); return { requested: true }; },
    labelProvider: { ensureLabel: () => writes.push('ensure-label'), setLabels: (_r, _n, plan) => writes.push(plan),
      readPrState: () => ({ headRefOid: HEAD, labels }), readPrFiles: () => ['scripts/example.mjs'] } };
  const strategy = createDrainMergeStrategy({ localSlug: REPO, isLocalRepo: r => !r || r === REPO, exec,
    env: { WE_UNDER_TEST: '1', WE_RED_TEAM_GATE_SOURCE: source }, writeScope: 'enqueue-only', targetPr: 7,
    statePath: '/fixture/queue.json', readFile: () => {
      if (state == null) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return JSON.stringify(state);
    }, writeState: (_p, value) => { state = structuredClone(value); },
    log: { write: line => logs.push(line) }, resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
    queueSafety: { value: { waitForRedTeamBeforeEnqueue: wait, dequeueOnSendBack: true, redTeamPendingMaxMin: 1, redTeamPendingBackoffSec: 1 } },
    readRedTeamEvidence: () => evidence ?? { scheduled: false, recorded: false, inFlight: false }, readGrantScope: () => null,
    batching: { gate: () => ({ admit: true }), observe: () => writes.push('observe') }, cardGroupHold: () => null,
    ...helpers, ...extra });
  return { strategy, calls, writes, logs, state: () => state, liveReads: () => liveReads, exec };
}
