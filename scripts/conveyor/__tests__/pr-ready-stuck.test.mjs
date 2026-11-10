// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runReadyStuck, isUnretryable } from '../pass-daemons/pr-ready-stuck.mjs';
import { runMergeWatch, resolveMergeWatchSettings } from '../pass-daemons/pr-merge-watch-pass.mjs';

// Keep the production refresh boundary: mock only its external git/merge IO.
// Unexpected git invocations fail locally rather than touching a remote.
const refreshIo = vi.hoisted(() => ({ gitRunner: vi.fn(), rebaseDropManifest: vi.fn() }));
vi.mock('../../lib/rebase-drop-manifest.mjs', async importOriginal => ({
  ...await importOriginal(), ...refreshIo,
}));
vi.mock('../../lib/repo-profile.mjs', async importOriginal => ({
  ...await importOriginal(),
  repoProfile: repo => repo === 'example/widgets' ? { checkoutPath: process.cwd() } : null,
}));

const now = Date.parse('2026-11-10T12:00:00Z');
const date = hours => new Date(now - hours * 3600000).toISOString();
function fixture(overrides = {}) {
  return { repo: 'example/widgets', now,
    pr: { number: 17, state: 'OPEN', isDraft: false, labels: [{ name: 'ready-to-merge' }],
      headRefOid: 'a'.repeat(40), mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', completedAt: date(25) }] },
    receipt: {}, config: { readyStuckMinutes: 120, selfHealStaleHours: 24 },
    readLabelTime: vi.fn(() => date(3)), readSkipReason: () => 'checks failed',
    onlyChecksBlock: vi.fn(() => true), readMainChecks: vi.fn(() => [{ name: 'test', conclusion: 'SUCCESS' }]),
    refresh: vi.fn(() => ({ action: 'rebased' })), send: vi.fn(), save: vi.fn(), log: vi.fn(), ...overrides };
}

describe('ready-stuck', () => {
  it('alerts past threshold with the drain/check cause and needs-you convention', async () => {
    const f = fixture(); await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledWith({ kind: 'ready-stuck', repo: f.repo, pr: 17,
      detail: { minutes: 180, head: f.pr.headRefOid, threshold: 120, needsYou: true,
        cause: { skipReason: 'checks failed', nonSuccessChecks: [{ name: 'test', conclusion: 'FAILURE', date: date(25) }], mergeStateStatus: 'BLOCKED' } } });
  });
  it('does not alert before or at threshold and respects a custom threshold', async () => {
    const f = fixture(); f.config.readyStuckMinutes = 180; await runReadyStuck(f);
    expect(f.send).not.toHaveBeenCalled(); f.config.readyStuckMinutes = 179; await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('rejects an explicit 1441 minute threshold; cascade rejects the oversized environment value', async () => {
    await expect(runMergeWatch({ settings: { readyStuckMinutes: 1441 } })).rejects.toThrow('invalid');
    expect(resolveMergeWatchSettings({ env: { WE_PR_MERGE_WATCH_READY_STUCK_MINUTES: '1441' }, log: () => {} }).readyStuckMinutes).toBeLessThanOrEqual(1440);
  });
  it('dedupes per head and fires for a new head receipt', async () => {
    const f = fixture(); await runReadyStuck(f); await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.pr.headRefOid = 'b'.repeat(40); f.receipt = {}; await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('does not mark failed delivery and retries it', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(Error('sink'));
    await expect(runReadyStuck(f)).rejects.toThrow('sink');
    expect(f.receipt.readyStuckAlerted).not.toBe(true); await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('falls back to durable observed-since when label events are unreadable', async () => {
    const f = fixture({ readLabelTime: () => { throw Error('unreadable'); } });
    await runReadyStuck(f); expect(f.send).not.toHaveBeenCalled();
    f.now += 121 * 60000; await runReadyStuck(f); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('refreshes stale-only checks once with one log line', async () => {
    const f = fixture(); await runReadyStuck(f); await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.log.mock.calls).toEqual([['pr-merge-watch: ready-stuck self-heal #17 rebased']]);
  });
  it('does not refresh a fresh failure among stale checks', async () => {
    const f = fixture(); f.pr.statusCheckRollup.push({ name: 'lint', conclusion: 'FAILURE', completedAt: date(1) });
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('does not refresh real red checks without main-green evidence', async () => {
    const f = fixture({ readMainChecks: () => [] }); await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('does not refresh unknown check dates or unreadable main or non-check blockers', async () => {
    for (const change of [f => { delete f.pr.statusCheckRollup[0].completedAt; },
      f => { f.readMainChecks = () => { throw Error('unknown'); }; }, f => { f.onlyChecksBlock = () => false; }]) {
      const f = fixture(); change(f); await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
    }
  });
  it('respects stale-hours setting', async () => {
    const f = fixture(); f.config.selfHealStaleHours = 26; await runReadyStuck(f);
    expect(f.refresh).not.toHaveBeenCalled(); f.config.selfHealStaleHours = 24; await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('qualifies a check with a prior unretryable HTTP 403 but refuses unknown errors', async () => {
    const f = fixture(); f.pr.statusCheckRollup[0].completedAt = date(1);
    f.pr.statusCheckRollup[0].rerunError = { status: 403, message: 'This check cannot be retried' };
    expect(isUnretryable({ rerunError: { status: 500, message: 'cannot be retried' } })).toBe(false);
    await runReadyStuck(f); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('records refused or throwing refresh attempts without crashing or repeating', async () => {
    for (const refresh of [vi.fn(() => ({ action: 'skip' })), vi.fn(() => { throw Error('refused'); })]) {
      const f = fixture({ refresh }); await runReadyStuck(f); await runReadyStuck(f);
      expect(refresh).toHaveBeenCalledTimes(1); expect(f.log).toHaveBeenCalledTimes(1);
    }
  });
  it('does no extra work for drafts or PRs without the label', async () => {
    for (const change of [f => { f.pr.isDraft = true; }, f => { f.pr.labels = []; }]) {
      const f = fixture(); change(f); await runReadyStuck(f); expect(f.readLabelTime).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
    }
  });
});


describe('ready-stuck production refresh SHA guards', () => {
  const mainSha = 'c'.repeat(40);
  const advancedSha = 'd'.repeat(40);
  let mainRef, prRef;

  beforeEach(() => {
    mainRef = mainSha;
    prRef = 'a'.repeat(40);
    refreshIo.gitRunner.mockReset().mockImplementation((cmd, args) => {
      expect(cmd).toBe('git');
      if (args.join(' ') === 'fetch origin main lane/ready-stuck') return { status: 0, stdout: '' };
      if (args.join(' ') === 'rev-parse origin/main') return { status: 0, stdout: `${mainRef}\n` };
      if (args.join(' ') === 'rev-parse origin/lane/ready-stuck') return { status: 0, stdout: `${prRef}\n` };
      throw Error('unexpected git invocation');
    });
    refreshIo.rebaseDropManifest.mockReset().mockReturnValue({ action: 'rebased' });
  });

  function productionFixture() {
    const f = fixture({ refresh: undefined, readMainChecks: () => ({
      sha: mainSha, checks: [{ name: 'test', conclusion: 'SUCCESS' }],
    }) });
    f.pr.headRefName = 'lane/ready-stuck';
    return f;
  }

  it('refuses production refresh when origin/main advances beyond the examined main SHA', async () => {
    mainRef = advancedSha;
    const f = productionFixture();
    await runReadyStuck(f);
    expect(refreshIo.gitRunner).toHaveBeenCalledWith('git', ['rev-parse', 'origin/main'], { cwd: process.cwd() });
    expect(refreshIo.rebaseDropManifest).not.toHaveBeenCalled();
    expect(f.log.mock.calls).toEqual([['pr-merge-watch: ready-stuck self-heal #17 skip']]);
  });

  it('refuses production refresh when the PR ref advances beyond the examined head SHA', async () => {
    prRef = advancedSha;
    const f = productionFixture();
    await runReadyStuck(f);
    expect(refreshIo.gitRunner).toHaveBeenCalledWith('git', ['rev-parse', 'origin/lane/ready-stuck'], { cwd: process.cwd() });
    expect(refreshIo.rebaseDropManifest).not.toHaveBeenCalled();
    expect(f.log.mock.calls).toEqual([['pr-merge-watch: ready-stuck self-heal #17 skip']]);
  });

  it('matching main and PR SHAs reach the existing merge helper through production refresh', async () => {
    const f = productionFixture();
    await runReadyStuck(f);
    expect(refreshIo.gitRunner.mock.calls.map(([, args]) => args)).toEqual([
      ['fetch', 'origin', 'main', 'lane/ready-stuck'],
      ['rev-parse', 'origin/main'], ['rev-parse', 'origin/lane/ready-stuck'],
    ]);
    expect(refreshIo.rebaseDropManifest).toHaveBeenCalledTimes(1);
    expect(refreshIo.rebaseDropManifest).toHaveBeenCalledWith({
      laneRef: 'lane/ready-stuck', base: 'origin/main', fetch: false, cwd: process.cwd(),
    });
    expect(f.log.mock.calls).toEqual([['pr-merge-watch: ready-stuck self-heal #17 rebased']]);
  });
});


describe('ready-stuck production refresh authorization', () => {
  function authorizedFixture() {
    const f = fixture({ onlyChecksBlock: undefined });
    f.pr.reviewDecision = 'APPROVED';
    f.pr.comments = [];
    const evidence = {
      pull: { head: { sha: f.pr.headRefOid, repo: { full_name: f.repo } },
        base: { ref: 'main' }, mergeable: true, draft: false, state: 'open' },
      rules: [],
      protection: { required_status_checks: { contexts: ['test'] },
        required_pull_request_reviews: { required_approving_review_count: 1 } },
    };
    f.read = vi.fn(args => {
      expect(args[0]).toBe('api');
      if (args[1] === `repos/${f.repo}/pulls/17`) return evidence.pull;
      if (args[1] === `repos/${f.repo}/rulesets?includes_parents=true&per_page=100`) return evidence.rules;
      if (args[1] === `repos/${f.repo}/branches/main/protection`) return evidence.protection;
      throw Error('unexpected authorization evidence read');
    });
    return { f, evidence };
  }

  it('permits refresh through production authorization with same-repo main-base mergeable PR and clear protection', async () => {
    const { f } = authorizedFixture();
    await runReadyStuck(f);
    expect(f.read.mock.calls.map(([args]) => args)).toEqual([
      ['api', `repos/${f.repo}/pulls/17`],
      ['api', `repos/${f.repo}/rulesets?includes_parents=true&per_page=100`],
      ['api', `repos/${f.repo}/branches/main/protection`],
    ]);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['changed PR head', e => { e.pull.head.sha = 'b'.repeat(40); }],
    ['fork head from a different repository', e => { e.pull.head.repo.full_name = 'other/widgets'; }],
    ['unknown head repository', e => { delete e.pull.head.repo; }],
    ['base other than main', e => { e.pull.base.ref = 'release'; }],
    ['unknown base', e => { delete e.pull.base; }],
    ['unmergeable PR', e => { e.pull.mergeable = false; }],
    ['unknown mergeability', e => { e.pull.mergeable = null; }],
    ['PR becoming draft after evidence collection', e => { e.pull.draft = true; }],
    ['unknown draft evidence', e => { delete e.pull.draft; }],
    ['PR closing after evidence collection', e => { e.pull.state = 'closed'; }],
    ['human review changes hold', (_e, f) => { f.pr.labels.push({ name: 'review:changes' }); }],
    ['red-team review hold', (_e, f) => { f.pr.labels.push({ name: 'red-team:pending' }); }],
    ['active ruleset', e => { e.rules = [{ enforcement: 'active' }]; }],
    ['unknown ruleset enforcement', e => { e.rules = [{}]; }],
    ['unreadable ruleset list', e => { e.rules = null; }],
    ['ruleset page cap with potentially omitted rules', e => { e.rules = Array.from({ length: 100 }, () => ({ enforcement: 'disabled' })); }],
    ['unreadable branch protection', e => { e.protection = null; }],
    ['missing required status-check evidence', e => { delete e.protection.required_status_checks; }],
    ['branch push restrictions', e => { e.protection.restrictions = { users: [], teams: [] }; }],
    ['unresolved conversation requirement', e => { e.protection.required_conversation_resolution = { enabled: true }; }],
    ['locked branch', e => { e.protection.lock_branch = { enabled: true }; }],
    ['required review not approved', (_e, f) => { f.pr.reviewDecision = 'REVIEW_REQUIRED'; }],
    ['required review with unknown decision', (_e, f) => { delete f.pr.reviewDecision; }],
  ])('refuses refresh through production authorization for %s', async (_name, change) => {
    const { f, evidence } = authorizedFixture();
    change(evidence, f);
    await runReadyStuck(f);
    expect(f.read).toHaveBeenCalledWith(['api', `repos/${f.repo}/pulls/17`]);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.readMainChecks).not.toHaveBeenCalled();
    expect(f.receipt.refreshed).toBeUndefined();
    // The needs-you alert remains available when authorization holds mutation.
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready-stuck',
      detail: expect.objectContaining({ needsYou: true }) }));
  });

  it.each([
    ['PR', '/pulls/17'], ['ruleset', '/rulesets?includes_parents=true&per_page=100'],
    ['branch-protection', '/branches/main/protection'],
  ])('refuses refresh when production %s authorization evidence read throws', async (_name, suffix) => {
    const { f } = authorizedFixture();
    const read = f.read.getMockImplementation();
    f.read.mockImplementation(args => {
      if (args[1].endsWith(suffix)) throw Error('unavailable authorization evidence');
      return read(args);
    });
    await runReadyStuck(f);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.readMainChecks).not.toHaveBeenCalled();
    expect(f.receipt.refreshed).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
