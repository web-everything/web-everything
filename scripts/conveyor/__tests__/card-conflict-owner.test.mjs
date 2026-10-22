// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { watchParkedPrConflicts, CONFLICT_LABEL, defaultAttemptCardConflictRebase } from '../parked-pr-conflict-watch.mjs';
import { gitRun } from '../../lib/git-run.mjs';
import { filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';
import { UNOWNED_REBASE_ATTEMPT_MARKER, UNOWNED_REBASE_ATTEMPT_CAP } from '../unowned-rebase-attempt-count.mjs';
import { MISSING_RUN_CREDENTIAL_REFUSAL } from '../main-red-recovery.mjs';
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
    expect(s.provider.postComment).toHaveBeenCalledWith('o/r', 42, UNOWNED_REBASE_ATTEMPT_MARKER);
  });
  it('counts error results against the same cap', () => {
    const s = sweep([], [cardPath], 'error');
    expect(s.provider.postComment).toHaveBeenCalledWith('o/r', 42, UNOWNED_REBASE_ATTEMPT_MARKER);
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
  it.each([
    { headRefName: 'lane/cards' },
    { headRefName: 'lane/cards', baseRefName: 'main', headRefOid: 'a'.repeat(40) },
  ])('refuses the wrong constellation clone before fetching or touching its refs', (pr) => {
    const run = vi.fn(() => ({ status: 0, stdout: 'https://github.com/frontier-ui/frontierui.git\n' }));
    const r = defaultAttemptCardConflictRebase({ pr, repo: 'web-everything/web-everything', run });
    expect(r).toMatchObject({ action: 'skip', reason: expect.stringMatching(/clone/) });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], { cwd: expect.any(String) });
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

// The Also-raised-by watch uses this entry point.
describe('card recovery push credentials', () => {
  const pr = { headRefName: 'lane/cards', baseRefName: 'main', headRefOid: 'a'.repeat(40) };
  function runner() {
    return vi.fn((_cmd, args) => {
      if (args.includes('get-url')) return { status: 0, stdout: 'https://github.com/web-everything/web-everything.git' };
      const key = args[0];
      const stdout = key === 'rev-parse' ? pr.headRefOid : key === 'merge-tree' ? 'b'.repeat(40)
        : key === 'write-tree' ? 'c'.repeat(40) : key === 'commit-tree' ? 'd'.repeat(40) : '';
      return { status: 0, stdout, stderr: '' };
    });
  }
  it.each(['ghs_unknown', 'invalid'])('refuses untrusted %s before mutation', token => {
    const run = runner();
    const result = defaultAttemptCardConflictRebase({ pr, repo: 'web-everything/web-everything', run,
      env: { GH_TOKEN: token }, readCache: () => null });
    expect(result).toMatchObject({ ok: false, error: MISSING_RUN_CREDENTIAL_REFUSAL });
    expect(run.mock.calls.some(([, args]) => args.includes('push') || args.includes('commit-tree'))).toBe(false);
  });
  it('pins a validated credential and removes inherited Git configuration at push', () => {
    const run = runner();
    const result = defaultAttemptCardConflictRebase({ pr, repo: 'web-everything/web-everything', run,
      env: { GH_TOKEN: 'ghp_test', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'bad',
        GIT_DIR: '/bad', GIT_CONFIG_GLOBAL: '/bad', WE_CI_PUSH_TOKEN: 'bad' }, readCache: () => null });
    expect(result.action).toBe('rebased');
    const push = run.mock.calls.find(([, args]) => args.includes('push'));
    expect(push).toBeDefined();
    expect(push[1]).toEqual(expect.arrayContaining(['http.extraHeader=', 'credential.helper=']));
    expect(push[1].join(' ')).not.toContain('ghp_test');
    expect(push[1].some(a => a.startsWith('--force'))).toBe(false);
    expect(push[2]).toMatchObject({ inheritEnv: false, env: { WE_CI_PUSH_TOKEN: 'ghp_test', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(Object.keys(push[2].env).filter(k => k.startsWith('GIT_')).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
  });
});

it('the real Git runner cannot reintroduce inherited Git environment into a pinned child', () => {
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_DIR', '/untrusted');
  try {
    const result = gitRun(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      inheritEnv: false, env: { WE_CI_PUSH_TOKEN: 'test', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.GIT_CONFIG_COUNT).toBeUndefined(); expect(env.GIT_DIR).toBeUndefined();
    expect(env.WE_CI_PUSH_TOKEN).toBe('test');
  } finally { vi.unstubAllEnvs(); }
});
