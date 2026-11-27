import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../lib/under-test.mjs', () => ({ isUnderTest: () => false }));
vi.mock('../../lib/fix-review-floor.mjs', () => ({ postRequiresReviewMark: post }));
vi.mock('../../lib/settings-files.mjs', async original => ({ ...await original(),
  readSettings: () => ({}), readDeclaredSettings: () => ({ settings: {}, sources: {} }),
}));
vi.mock('../fix-scope-policy.mjs', async original => ({ ...await original(),
  createRegionReader: () => null, createHolderStateReader: () => ({ landingPrs: () => [], stateFor: () => null }),
}));
const mod = await import('../reconcile-fix-dispatch.mjs').catch(() => ({}));
const borrow = await import('../../lib/fix-slot-borrow.mjs').catch(() => ({}));

describe('default stampExecutor and resume postMark post the mark', () => {
  let root;
  const decision = { executor: 'codex', mode: 'direct', rung: 'codex', requiresReview: true };
  const planned = { pr: 42, itemNum: '42', lane: 7, laneRef: 'lane/42-fixture', scope: ['we:src/ordinary.js'] };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-mark-defaults-')); post.mockReset();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
  const before = launch => {
    expect(post).toHaveBeenCalledOnce(); expect(launch).toHaveBeenCalledOnce();
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]);
  };
  it('dispatchFix default stamp posts before spawnBorrowed', () => {
    expect(typeof mod.dispatchFix).toBe('function');
    const launch = vi.fn(() => 'pid:123');
    mod.dispatchFix(planned, { root, repo: 'we', home: root, checkoutExists: () => true, readPackageJson: () => '{}',
      claimRoot: join(root, 'claims'), claimOwner: 'fixture', readFixClaim: () => null,
      acquireClaim: () => ({ ok: true }), releaseClaim: vi.fn(), stampRunner: vi.fn(), executorDecision: decision,
      readBrief: () => 'Fix {{PR_NUM}} {{LANE_REF}} {{LANE}} {{SCOPE}} {{SESSION_SLUG}}',
      readPushHold: () => null, readHistoryInputs: () => null, fixSettings: {}, loadLadder: () => ({ rungs: [] }),
      postNotice: vi.fn(), wrapFix: false, spawnBorrowed: launch, writeBorrowedPrompt: () => join(root, 'prompt.md'),
    });
    before(launch); expect(post).toHaveBeenCalledWith({ repo: 'we', pr: 42, kind: 'fix', rung: 'codex' });
  });
  it('ci-heal default stamp posts before launchCodex', async () => {
    expect(typeof borrow.createRoutedCiHealDispatch).toBe('function');
    const launch = vi.fn(() => 'pid:123');
    await borrow.createRoutedCiHealDispatch({ route: () => decision,
      dispatch: (_p, { sinks }) => sinks.launch({ claimOwner: 'fixture', claimRoot: join(root, 'claims'), sessionSlug: 'ci-42', prompt: 'fixture' }),
      createSinks: ({ provider }) => ({ launch: provider }), launchCodex: launch,
      writePrompt: () => join(root, 'prompt.md'), removePrompt: vi.fn(), profileFor: () => ({ slug: 'o/r', lanePoolRepo: root }),
    })(planned, { repo: 'we', root });
    before(launch); expect(post).toHaveBeenCalledWith({ repo: 'we', pr: 42, kind: 'ci-heal', rung: 'codex' });
  });
  it('reconcile default postMark posts before tryResume', () => {
    expect(typeof mod.runReconcileFixDispatch).toBe('function');
    const resume = vi.fn(() => ({ resumed: true, result: { pr: 42 } }));
    const cold = vi.fn();
    const out = mod.runReconcileFixDispatch({ root, repo: 'we', dryRun: false, now: Date.now(), clock: () => Date.now(),
      stepNow: () => Date.now(), stepLog: vi.fn(), checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefName: planned.laneRef, attempts: 1,
        labels: ['merge-status:conflicting'], files: ['src/ordinary.js'] }], refusals: [], notes: [] }),
      findItemFn: () => ({ num: '42', scope: planned.scope, specPath: 'backlog/42-fixture.md' }), loadItems: () => [],
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
      unsupportedPath: join(root, 'unsupported.json'), readPrView: vi.fn(), resolveFallbackScope: () => planned.scope,
      fetchItemlessDiffPaths: () => ['src/ordinary.js'], resolveCardScopeAtRef: () => planned.scope,
      pickFreeLanes: () => [7], listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null,
      netScope: null, prStack: null, landingBlockedState: { read: () => new Map(), write: () => {} }, notesDryRun: true,
      readPushHold: () => null, readMainRedPriorityRecord: () => null, readLaneTips: () => new Map(),
      fixSettings: {}, loadLadder: () => ({ rungs: [] }), shadowDeps: {},
      fixExecutorRoute: () => ({ ...decision, executor: 'claude' }),
      tryResume: resume, tryResumeRound: vi.fn(), dispatch: cold,
    });
    expect(out.dispatched).toHaveLength(1); before(resume); expect(cold).not.toHaveBeenCalled();
  });
});
