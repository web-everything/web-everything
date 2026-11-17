import { describe, expect, it, vi } from 'vitest';
import { demoteConflictRebase, dispatchFix, runReconcileFixDispatch, tryResumeFix } from '../reconcile-fix-dispatch.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40);
const planned = { pr: 1764, itemNum: '3438', lane: 9, laneRef: 'lane/3438-fixture', scope: ['we:scripts/x.mjs'],
  headRefOid: head, isConflict: true, mode: 'conflict-rebase', labels: ['review:accepted'],
  conflictRebase: { oldHead: head, mainSha: target, receipt: `accepted-conflict-rebase:${head}@${target}` } };
const proof = () => ({ ok: true, pr: planned.pr, round: 'conflict-start', labels: ['review:pending'] });
const template = '{{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}';
function deps(events, demote = () => { events.push('demote'); return proof(); }) {
  return { root: '/repo', demote, wrapFix: false, executorDecision: { executor: 'claude' },
    readFixClaim: () => null, acquireClaim: () => { events.push('claim'); return { ok: true }; },
    releaseClaim: vi.fn(() => events.push('release')), readBrief: () => template,
    mintSessionId: () => 'session', sessionCwdFor: () => '/scratch/session', ensureSessionCwd: x => x,
    grantConflictHelper: () => ({ ok: true }), isolateSession: () => ({}), resolveSettingsEnv: () => ({}),
    postNotice: () => {}, advisorFor: () => null, readHistoryInputs: () => null,
    spawnAgent: vi.fn(() => { events.push('launch'); return ''; }) };
}
function pass(options) {
  return runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
    reconcile: () => ({ dispatch: [{ ...planned, kind: 'fix', prNumber: planned.pr, headRefName: planned.laneRef }], refusals: [] }),
    findItemFn: () => ({ num: '3438', slug: 'fixture', scope: planned.scope }), loadItems: () => [],
    fetchItemlessDiffPaths: () => ['scripts/x.mjs'], pickFreeLanes: () => [9],
    listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null, tryResumeRound: null,
    ...options });
}

describe('conflict-rebase dispatch demotion', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])('runs conflict-start pinned to dispatched head for %s', label => {
    const exec = vi.fn(() => JSON.stringify(proof()));
    expect(demoteConflictRebase({ ...planned, labels: [label] }, { root: '/repo', exec })).toEqual(proof());
    expect(exec.mock.calls[0][1]).toEqual(['/repo/scripts/conveyor/rearm-review.mjs', '1764',
      '--repo=web-everything/web-everything', '--round=conflict-start',
      `--only-if=${label === 'review:accepted' ? 'accepted' : 'missing'}`, `--expect-head=${head}`,
      `--actor=accepted-conflict-rebase:${head}@${target}`]);
    expect(exec.mock.calls[0][2].maxBuffer).toBe(1024 * 1024);
  });
  it('rejects mismatched head evidence before calling the CLI', () => {
    const exec = vi.fn();
    expect(() => demoteConflictRebase({ ...planned, headRefOid: target }, { exec })).toThrow('mismatched');
    expect(exec).not.toHaveBeenCalled();
  });
  it('launches only after claimed demotion succeeds', () => {
    const events = [], options = deps(events);
    const result = pass({ tryResume: () => ({ resumed: false }), demote: options.demote,
      dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    expect(result.refusals).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    expect(events).toEqual(['claim', 'demote', 'launch']);
  });
  it.each([
    ['failed', () => { throw new Error('write failed'); }, 'write failed'],
    ['refused', () => ({ ok: false, reason: 'head moved' }), 'head moved'],
    ['unconfirmed', () => ({ ...proof(), labels: ['review:accepted', 'review:pending'] }), 'could not be confirmed'],
    ['missing pending', () => ({ ...proof(), labels: [] }), 'could not be confirmed'],
    ['unreadable', () => undefined, 'could not be confirmed'],
    ['wrong PR', () => ({ ...proof(), pr: 99 }), 'could not be confirmed'],
    ['malformed labels', () => ({ ...proof(), labels: [null, 'review:pending'] }), 'could not be confirmed'],
    ['oversized CLI output', entry => demoteConflictRebase(entry, { exec: () => { throw new Error('stdout maxBuffer length exceeded'); } }), 'maxBuffer'],
    ['unreadable CLI output', entry => demoteConflictRebase(entry, { exec: () => 'unreadable' }), 'JSON'],
  ])('%s demotion releases claim and records refusal without launching', (_name, demote, why) => {
    const events = [], options = deps(events, demote);
    const result = pass({ tryResume: () => ({ resumed: false }), demote,
      dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed', why: expect.stringContaining(why) }]);
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.releaseClaim).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'ordinary', 'stale-base'])('leaves mode %s unaffected', mode => {
    const events = [], demote = vi.fn(), options = deps(events, demote);
    dispatchFix({ ...planned, mode }, options);
    expect(demote).not.toHaveBeenCalled();
    expect(options.spawnAgent).toHaveBeenCalledOnce();
  });
  it.each(['resumed', 'fallback', 'failed'])('demotes before resume with one receipt (outcome=%s)', outcome => {
    const success = outcome !== 'failed';
    const events = [], candidate = 'cand-0000-0000-0000-000000000000';
    const demote = () => { events.push('demote'); if (!success) throw new Error('write refused'); return proof(); };
    const options = deps(events, demote);
    const resume = (entry, io) => tryResumeFix({ ...entry, body: buildAuthorActorMarker(candidate) }, {
      ...options, demote: io.demote, readCompletion: () => null, resolveHead: () => head,
      listAgentsAll: () => [{ sessionId: candidate, id: 'candxxxx', name: 'fix-1764', cwd: '/lanes/lane-4', state: 'running', kind: 'background' }],
      spawnAgent: () => { events.push('resume'); return `backgrounded · ${outcome === 'fallback' ? 'forkedid' : 'candxxxx'}`; }, wait: () => {}, stop: () => {},
    });
    const result = pass({ tryResume: resume, demote, dispatch: (entry, io) => dispatchFix(entry, { ...options, demote: io.demote }) });
    if (success) {
      expect(events.indexOf('demote')).toBeLessThan(events.indexOf('resume'));
      expect(events.filter(e => e === 'demote')).toHaveLength(1);
      expect(result.dispatched).toHaveLength(1);
      if (outcome === 'resumed') {
        expect(result.dispatched[0].resumed).toBe(true);
        expect(events).toEqual(['claim', 'demote', 'resume', 'release']);
      } else {
        expect(events).toEqual(['claim', 'demote', 'resume', 'release', 'claim', 'launch']);
      }
    } else {
      expect(events).toEqual(['claim', 'demote', 'release']);
      expect(result.refusals).toMatchObject([{ kind: 'conflict-rebase-demotion-failed' }]);
      expect(result.dispatched).toEqual([]);
    }
  });
});
