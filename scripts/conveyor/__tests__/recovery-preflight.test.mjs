import { describe, it, expect, vi } from 'vitest';
import { recoveryPreflight } from '../recovery-preflight.mjs';
import { retriggerRequiredContext } from '../merge-gate-retrigger.mjs';
import { pushMissingRunCommit } from '../missing-run-push.mjs';
import { buildMissingRunComment } from '../main-red-recovery.mjs';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

vi.mock('../../lib/gh-throttle.mjs', async original => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw Error('unexpected live IO'); }),
}));
const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const live = { state: 'OPEN', baseRefName: 'main', headRefOid: head,
  headRefName: 'lane/recovery', isCrossRepository: false, mergeable: 'MERGEABLE' };
const run = { name: 'Merge gate', event: 'pull_request_target', status: 'completed',
  conclusion: 'startup_failure', created_at: '2026-10-13T11:00:00Z', id: 101 };
const facts = { pr: live, head, headRefName: live.headRefName, context: 'merge-gate',
  runs: [run], rollup: [], token: 'ghp_fixture', env: {}, claimed: false, labels: [] };
const cases = [
  ...['FAILURE', 'CANCELLED', 'TIMED_OUT'].map(conclusion => [`present ${conclusion}`, { rollup: [{ name: 'merge-gate', status: 'COMPLETED', conclusion }] }]),
  ['latest run is not startup_failure', { runs: [run, { ...run, id: 102, conclusion: 'failure' }] }],
  ...['queued', 'in_progress', 'pending', 'waiting', 'requested'].map(status => [`live ${status} run`, { runs: [{ ...run, status, conclusion: null }] }]),
  ['unreadable run evidence', { runs: null }],
  ['malformed run evidence', { runs: [{}] }],
  ['unknown run status', { runs: [{ ...run, status: 'garbage' }] }],
  ['candidate bound >8', { candidate: 9 }],
  ['Actions GITHUB_TOKEN', { token: 'ghs_actions', env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'ghs_actions', GITHUB_REPOSITORY: repo } }],
  ['human branch', { headRefName: 'human/change', pr: { ...live, headRefName: 'human/change' } }],
  ['already claimed head', { claimed: true }],
  ['PR closed', { pr: { ...live, state: 'CLOSED' } }],
  ['base changed', { pr: { ...live, baseRefName: 'other' } }],
  ['fork', { pr: { ...live, isCrossRepository: true } }],
  ['conflicting', { pr: { ...live, mergeable: 'CONFLICTING' } }],
  ['unknown mergeability', { pr: { ...live, mergeable: 'UNKNOWN' } }],
  ['head moved', { pr: { ...live, headRefOid: 'b'.repeat(40) } }],
  ['label-attempt failure then push fall-through', { labelAttempted: true }],
  ['stale sentinel label already present', { labels: ['review:merge-gate-retrigger'] }],
  ['per-head retry cap', { attemptsForSha: 1 }],
  ['PR-wide retry cap', { attemptsForPr: 1 }],
];

describe('shared recovery preflight bypasses', () => {
  it.each(cases)('%s refuses both label and push mutations', (_name, overrides) => {
    const evidence = { ...facts, ...overrides };
    for (const kind of ['label', 'push']) expect(recoveryPreflight({ ...evidence, kind })).toMatchObject({ allow: false, kind, reason: expect.any(String) });
    const io = { readHead: () => head, readPr: () => evidence.pr, readLabels: () => evidence.labels,
      addLabel: vi.fn(), removeLabel: vi.fn() };
    const label = retriggerRequiredContext({ ...evidence, repo, pr: 1, io, checkClaim: () => null,
      ledger: { claim: () => !evidence.claimed } });
    expect(label.ok).toBe(false);
    expect(io.addLabel).not.toHaveBeenCalled();
    expect(io.removeLabel).not.toHaveBeenCalled();
    const p = evidence.pr;
    const exec = vi.fn(command => {
      if (command !== 'gh') throw Error('unexpected git mutation');
      return JSON.stringify({ state: p.state.toLowerCase(), mergeable: p.mergeable === 'MERGEABLE' ? true : p.mergeable === 'CONFLICTING' ? false : null,
        head: { sha: p.headRefOid, ref: p.headRefName, repo: { full_name: p.isCrossRepository ? 'other/repo' : repo } }, base: { ref: p.baseRefName } });
    });
    const push = pushMissingRunCommit({ prNumber: 1, headSha: head, headRefName: evidence.headRefName }, {
      repo, exec, env: { ...evidence.env, GH_TOKEN: evidence.token }, readCache: () => null,
      checkClaim: () => evidence.claimed ? { message: 'held' } : null, recoveryEvidence: evidence,
    });
    expect(push.ok).toBe(false);
    expect(exec.mock.calls.every(([command]) => command === 'gh')).toBe(true);
  });

  it.each(['label'])('allows complete eligible evidence for %s', kind => {
    expect(recoveryPreflight({ ...facts, kind }).allow).toBe(true);
    expect(recoveryPreflight({ ...facts, runs: [], kind }).allow).toBe(true);
  });

  it('push path refuses a merge-gate context', () => {
    for (const runs of [[], [run], null]) {
      expect(recoveryPreflight({ ...facts, runs, kind: 'push' })).toMatchObject({
        allow: false, reason: expect.stringMatching(/label/),
      });
      const exec = vi.fn(() => JSON.stringify({ state: 'open', mergeable: true,
        head: { sha: head, ref: live.headRefName, repo: { full_name: repo } }, base: { ref: 'main' } }));
      expect(pushMissingRunCommit({ prNumber: 1, headSha: head, headRefName: live.headRefName }, {
        repo, exec, env: { GH_TOKEN: facts.token }, readCache: () => null,
        checkClaim: () => null, recoveryEvidence: { context: 'merge-gate', runs },
      })).toMatchObject({ ok: false, deferred: true, error: expect.stringMatching(/label/) });
      expect(exec.mock.calls.every(([command]) => command === 'gh')).toBe(true);
    }
  });

  function sweep(overrides = {}) {
    const trigger = vi.fn();
    const io = { readHead: () => head, readPr: () => live, readLabels: () => [],
      addLabel: vi.fn(() => { throw Error('label rejected'); }), removeLabel: vi.fn() };
    const result = sweepMissingRunRecovery({ repo, apply: true, mainRuns: [], now: Date.parse('2026-10-13T12:00:00Z'),
      readOpenPrs: () => [{ ...live, number: 1, labels: [], statusCheckRollup: [] }],
      readRequiredContexts: () => ['test'], readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readComments: () => [], readPush: () => null, readHeadCommittedAt: () => '2026-10-12T00:00:00Z',
      readWorkflowRuns: () => [run], readRecoveryPr: () => live, recoveryToken: facts.token, checkClaim: () => null,
      labelRetrigger: options => retriggerRequiredContext({ ...options, io }), retriggerLedger: { claim: () => true },
      trigger, postComment: vi.fn(), clearLabel: vi.fn(), ...overrides });
    expect(trigger).not.toHaveBeenCalled();
    return { result, io };
  }
  it('ninth merge-gate candidate refuses labels and push with operator fallback', () => {
    const { result, io } = sweep({ readOpenPrs: () => Array.from({ length: 9 }, (_, i) => ({
      ...live, number: i + 1, labels: [], statusCheckRollup: [],
    })) });
    expect(io.addLabel).toHaveBeenCalledTimes(8);
    expect(result.applied.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('operator inspection required') });
  });
  it('actual failed label write cannot fall through to push', () => {
    const { result, io } = sweep();
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(result.applied[0].ok).toBe(false);
  });
  // Present contexts bypass merge-gate recovery entirely: the ordinary push contract is
  // covered for each conclusion in merge-gate-retrigger-safety.test.mjs. Explicit merge-gate
  // mutation requests still refuse those contexts in the shared-preflight cases above.
  it.each(cases.filter(([, value]) => !value.candidate && !value.rollup))('%s cannot fall through in the sweep', (_name, overrides) => {
    const evidence = { ...facts, ...overrides };
    const { io } = sweep({
      readWorkflowRuns: () => evidence.runs, readRecoveryPr: () => evidence.pr,
      recoveryToken: evidence.token, recoveryEnv: evidence.env,
      maxRetriesPerSha: 1, maxRetriesPerPr: 1,
      readComments: () => (overrides.attemptsForSha || overrides.attemptsForPr)
        ? [{ viewerDidAuthor: true, body: buildMissingRunComment({ headSha: overrides.attemptsForSha ? head : 'old-head' }) }] : [],
      readOpenPrs: () => [{ ...live, number: 1, labels: evidence.labels, headRefName: evidence.headRefName,
        statusCheckRollup: evidence.rollup }],
      // The shell claim is authoritative even if the listing was eligible.
      retriggerLedger: { claim: () => !evidence.claimed },
      ...(overrides.labelAttempted ? { labelRetrigger: () => ({ ok: false, error: 'prior label failure' }) } : {}),
    });
    expect(io.addLabel).not.toHaveBeenCalled();
  });
});
