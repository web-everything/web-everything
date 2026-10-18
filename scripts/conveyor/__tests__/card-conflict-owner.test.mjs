// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { watchParkedPrConflicts, CONFLICT_LABEL, defaultAttemptCardConflictRebase } from '../parked-pr-conflict-watch.mjs';
import { filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';
import { UNOWNED_REBASE_ATTEMPT_MARKER, UNOWNED_REBASE_ATTEMPT_CAP } from '../unowned-rebase-attempt-count.mjs';
import { mintSessionSlug } from '../session-slug.mjs';

const cardPath = 'backlog/5360-parent.md';
function sweep(labels, files, action = 'rebased', extra = {}) {
  const pr = { number: 42, headRefName: 'lane/cards', baseRefName: 'main', mergeable: 'CONFLICTING', labels,
    files: files.map(path => ({ path })) };
  const attemptCardRebase = vi.fn(() => ({ action, newCommit: 'a'.repeat(40), resolvedRaisedBy: [cardPath], reason: 'not a list' }));
  const postFinding = vi.fn(); const postRearm = vi.fn();
  const deps = { repo: 'o/r', listPrs: () => [pr], listPrFiles: () => files, listPrComments: () => [],
    labelRemovedAtMs: () => null, computeConflictDisposition: () => 'real', computeConflictingPaths: () => files,
    listAgents: () => [], postFinding, postRearm, postStandDown: vi.fn(),
    provider: { ensureLabel: vi.fn(), setLabels: vi.fn(), postComment: vi.fn() },
    attemptCardRebase, cardConflictSettings: { value: { autoResolveRaisedBy: true }, sources: { autoResolveRaisedBy: 'standard' } },
    ...extra };
  const result = watchParkedPrConflicts(deps);
  return { result, attemptCardRebase, postFinding, postRearm, pr, provider: deps.provider };
}

describe('conflicts always have an owner, outside the fixer scope queue for mechanical cards', () => {
  it.each([[], ['review:pending'], ['review:changes', CONFLICT_LABEL], ['ready-to-merge', 'review:accepted']].map(labels => [labels]))
  ('tries the resolver this tick for unowned, parked, already bounced and queued cards: %j', labels => {
    const s = sweep(labels, [cardPath]);
    expect(s.attemptCardRebase).toHaveBeenCalledOnce();
    expect(s.postRearm).toHaveBeenCalledOnce();
    expect(s.postFinding).not.toHaveBeenCalled();
    expect(s.result[0]).toMatchObject({ routedTo: 'card-conflict-resolver', owner: 'review',
      cardConflictSetting: { value: true, source: 'standard' } });
  });
  it('does not claim resolution or rearm when the resolver refuses; routes to conflict fixer', () => {
    const s = sweep([], [cardPath], 'skip');
    expect(s.attemptCardRebase).toHaveBeenCalledOnce();
    expect(s.postFinding).toHaveBeenCalledOnce();
    expect(s.postRearm).not.toHaveBeenCalled();
  });
  it('non-card owed-elsewhere conflicts are sent to the existing conflict finding/fixer path', () => {
    const s = sweep([], ['scripts/code.mjs']);
    expect(s.attemptCardRebase).not.toHaveBeenCalled();
    expect(s.postFinding).toHaveBeenCalledOnce();
    expect(s.result[0].routedTo).toMatch(/reconcile-finding/);
  });
  it('setting off never calls the card resolver', () => {
    const s = sweep([], [cardPath], 'rebased', { cardConflictSettings: { value: { autoResolveRaisedBy: false }, sources: { autoResolveRaisedBy: 'tool' } } });
    expect(s.attemptCardRebase).not.toHaveBeenCalled();
    expect(s.postFinding).toHaveBeenCalledOnce();
  });
  it('mechanical card repair runs while its scope is queued; code PR still serializes', () => {
    const claims = [{ meta: { pr: 5612, scope: [`we:${cardPath}`, 'we:scripts/'] } }];
    const queued = filterFixesByInFlightScope([
      { pr: 42, scope: [`we:${cardPath}`] }, { pr: 43, scope: ['we:scripts/code.mjs'] },
    ], [], claims, { maxWaitMinutes: null, rebaseExempt: null });
    expect(queued.refusals.map(r => r.pr)).toEqual([42, 43]);
    const s = sweep(['review:changes', CONFLICT_LABEL], [cardPath]);
    expect(s.attemptCardRebase).toHaveBeenCalledOnce();
    expect(s.result[0].routedTo).toBe('card-conflict-resolver');
    expect(queued.refusals.find(r => r.pr === 43)).toMatchObject({ kind: 'scope-overlap' });
  });
  it('dry run makes no rebase or review writes', () => {
    const s = sweep([], [cardPath], 'rebased', { dryRun: true });
    expect(s.attemptCardRebase).not.toHaveBeenCalled();
    expect(s.postRearm).not.toHaveBeenCalled();
  });
  it('keeps the existing mechanical-attempt cap', () => {
    const capped = sweep([], [cardPath], 'rebased', { listPrComments: () => Array.from({ length: UNOWNED_REBASE_ATTEMPT_CAP },
      () => ({ body: UNOWNED_REBASE_ATTEMPT_MARKER, author: { login: 'chalbert' } })) });
    expect(capped.attemptCardRebase).not.toHaveBeenCalled();
    expect(capped.postFinding).toHaveBeenCalledOnce();
  });
  it('leaves a live fix agent as owner without rebasing or rearming underneath it', () => {
    const s = sweep([], [cardPath], 'rebased', { listAgents: () => [{ name: mintSessionSlug({ kind: 'fix', id: 42, repo: 'we' }),
      state: 'working', pid: 4242, pidAlive: true }] });
    expect(s.attemptCardRebase).not.toHaveBeenCalled();
    expect(s.postRearm).not.toHaveBeenCalled();
    expect(s.result[0].owner).toBe('fixer');
  });
  it('records a thrown rebase attempt under the existing bounded retry marker', () => {
    const s = sweep([], [cardPath], 'rebased', { attemptCardRebase: () => { throw new Error('git unavailable'); } });
    expect(s.provider.postComment).toHaveBeenCalledWith('o/r', 42, UNOWNED_REBASE_ATTEMPT_MARKER);
    expect(s.postFinding).toHaveBeenCalledOnce();
  });
  it('refuses the wrong constellation clone before fetching or touching its refs', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'https://github.com/frontier-ui/frontierui.git\n' }));
    const r = defaultAttemptCardConflictRebase({ pr: { headRefName: 'lane/cards' }, repo: 'web-everything/web-everything', run });
    expect(r).toMatchObject({ action: 'skip', reason: expect.stringMatching(/clone/) });
    expect(run.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
  });
  it('retries rearm after a resolver push and a failed review write', () => {
    const postRearm = vi.fn(() => { throw new Error('write unavailable'); });
    const s = sweep([], [cardPath], 'rebased', { postRearm });
    expect(s.result[0]).toMatchObject({ owner: 'conflict-watch', routedTo: 'card-conflict-rearm-pending' });
    const retry = sweep([CONFLICT_LABEL, 'review:accepted'], [cardPath], 'current', {
      listPrs: () => [{ ...s.pr, mergeable: 'MERGEABLE', labels: [CONFLICT_LABEL, 'review:accepted'] }],
    });
    expect(retry.postRearm).toHaveBeenCalledOnce();
  });
});
