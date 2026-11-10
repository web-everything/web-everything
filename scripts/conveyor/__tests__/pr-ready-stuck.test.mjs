// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runReadyStuck, isUnretryable, readReadyLabelTime, readMainCheckEvidence, checkDate, readChecksOnly } from '../pass-daemons/pr-ready-stuck.mjs';
import { redTeamGateMarker } from '../../lib/red-team-gate.mjs';
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
    readRequiredChecks: vi.fn(() => ['test']),
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
    ['unanswered red-team send-back comment', (_e, f) => {
      f.pr.number = 17;
      f.pr.comments = [{ author: { login: 'web-everything' }, createdAt: '2026-11-10T10:00:00Z',
        body: redTeamGateMarker(17, f.pr.headRefOid, 'sent-back') }];
    }],
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

  it.each([undefined, null, 'x', {}])('fails closed before any read when comment evidence is %j', async comments => {
    const { f } = authorizedFixture();
    if (comments === undefined) delete f.pr.comments; else f.pr.comments = comments;
    await runReadyStuck(f);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.receipt.refreshed).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
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

const SENTINEL = '0001-01-01T00:00:00Z';

describe('ready-stuck check classification (GitHub unfinished-run sentinel)', () => {
  it('checkDate skips the year-1 sentinel and implausible dates, falling through to the next field', () => {
    expect(checkDate({ completedAt: SENTINEL, startedAt: date(30) })).toBe(date(30));
    expect(checkDate({ completedAt: SENTINEL, startedAt: SENTINEL })).toBeNull();
    expect(checkDate({ completedAt: '0001-01-01T00:00:00.000Z' })).toBeNull();
    expect(checkDate({ completed_at: 'garbage' })).toBeNull();
    expect(checkDate({ completedAt: date(5) })).toBe(date(5));
    expect(checkDate({})).toBeNull();
  });
  it.each([
    ['in-progress with sentinel completedAt and an old start', { status: 'IN_PROGRESS', conclusion: '', completedAt: SENTINEL, startedAt: date(30) }],
    ['queued with sentinel completedAt and no start', { status: 'QUEUED', conclusion: '', completedAt: SENTINEL }],
    ['queued with sentinel in both date fields', { status: 'QUEUED', conclusion: '', completedAt: SENTINEL, startedAt: SENTINEL }],
    ['sentinel with millis', { status: 'IN_PROGRESS', conclusion: '', completedAt: '0001-01-01T00:00:00.000Z' }],
    ['pending commit status with an old date', { state: 'PENDING', startedAt: date(30) }],
    ['an old in-progress check without a sentinel', { status: 'IN_PROGRESS', conclusion: '', startedAt: date(30) }],
    ['an unfinished check that also carries an unretryable error', { status: 'QUEUED', conclusion: '', completedAt: SENTINEL,
      rerunError: { status: 403, message: 'This check cannot be retried' } }],
  ])('does not refresh in-progress checks: %s', async (_name, check) => {
    const f = fixture(); f.pr.statusCheckRollup = [{ name: 'test', ...check }];
    await runReadyStuck(f);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.receipt.refreshed).toBeUndefined();
    expect(f.onlyChecksBlock).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1); // the needs-you alert is unaffected
  });
  it('does not refresh when one finished stale check sits beside a queued one', async () => {
    const f = fixture(); f.pr.statusCheckRollup.push({ name: 'lint', status: 'QUEUED', conclusion: '', completedAt: SENTINEL });
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('the alert cause never reports the sentinel as a check date', async () => {
    const f = fixture(); f.pr.statusCheckRollup = [{ name: 'test', status: 'QUEUED', conclusion: '', completedAt: SENTINEL }];
    await runReadyStuck(f);
    expect(f.send.mock.calls[0][0].detail.cause.nonSuccessChecks).toEqual([{ name: 'test', conclusion: 'QUEUED', date: null }]);
  });
});

describe('ready-stuck refresh ordering and threshold', () => {
  it('does not refresh before the ready-stuck threshold passes', async () => {
    const f = fixture(); f.config.readyStuckMinutes = 1000; // label age is 180 minutes
    await runReadyStuck(f);
    expect(f.send).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
    expect(f.onlyChecksBlock).not.toHaveBeenCalled();
    f.config.readyStuckMinutes = 120; await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('does not refresh while the alert delivery is failing', async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(Error('sink'));
    await expect(runReadyStuck(f)).rejects.toThrow('sink');
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('persists the refresh attempt before the mutation runs', async () => {
    const snapshots = []; let savedBeforeRefresh;
    const f = fixture();
    f.save = vi.fn(() => { snapshots.push(structuredClone(f.receipt)); });
    f.refresh = vi.fn(() => { savedBeforeRefresh = snapshots.at(-1)?.refreshed; return { action: 'rebased' }; });
    await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(savedBeforeRefresh).toBe(true);
  });
});

describe('ready-stuck label-history reads', () => {
  it('reads label history once before the alert and never again after it', async () => {
    const f = fixture(); f.config.readyStuckMinutes = 1000;
    await runReadyStuck(f); await runReadyStuck(f);
    expect(f.readLabelTime).toHaveBeenCalledTimes(1); // cached on the receipt
    expect(f.receipt.readyLabelAt).toBe(Date.parse(date(3)));
    f.config.readyStuckMinutes = 120; await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    await runReadyStuck(f); await runReadyStuck(f);
    expect(f.readLabelTime).toHaveBeenCalledTimes(1); // no reads once alerted
  });
  it('clears the cached label time when the label goes away', async () => {
    const f = fixture(); f.config.readyStuckMinutes = 1000; await runReadyStuck(f);
    f.pr.labels = []; await runReadyStuck(f);
    expect(f.receipt.readyLabelAt).toBeUndefined(); expect(f.receipt.readyStuckSince).toBeUndefined();
  });
  it('caps label history at ten pages and falls back to observed-since', async () => {
    const full = Array.from({ length: 100 }, () => ({ event: 'commented' }));
    const f = fixture({ readLabelTime: undefined });
    f.read = vi.fn(() => full);
    await runReadyStuck(f);
    expect(f.read).toHaveBeenCalledTimes(10);
    expect(f.read.mock.calls.at(-1)[0][1]).toContain('page=10');
    expect(f.read.mock.calls.some(([a]) => a[1].includes('page=11'))).toBe(false);
    expect(f.send).not.toHaveBeenCalled(); // timing comes from observation, not label history
    expect(f.log).toHaveBeenCalledWith('pr-merge-watch: ready-stuck label history unavailable; using observed-since');
    f.now += 30 * 60000; await runReadyStuck(f); // inside the cooldown: the failure is remembered
    expect(f.read).toHaveBeenCalledTimes(10);
    f.now += 91 * 60000; await runReadyStuck(f);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('readReadyLabelTime returns the latest ready-to-merge label and refuses unreadable pages', () => {
    const pr = { number: 17 };
    const rows = [{ event: 'labeled', label: { name: 'ready-to-merge' }, created_at: date(9) },
      { event: 'labeled', label: { name: 'other' }, created_at: date(1) },
      { event: 'labeled', label: { name: 'ready-to-merge' }, created_at: date(4) }];
    expect(readReadyLabelTime({ repo: 'example/widgets', pr, read: () => rows })).toBe(Date.parse(date(4)));
    expect(() => readReadyLabelTime({ repo: 'example/widgets', pr, read: () => null })).toThrow('unreadable');
    expect(() => readReadyLabelTime({ repo: 'example/widgets', pr,
      read: () => [{ event: 'labeled', label: { name: 'ready-to-merge' }, created_at: 'nope' }] })).toThrow('unreadable');
  });
});

describe('ready-stuck production main-check evidence', () => {
  const sha = 'c'.repeat(40);
  const run = { name: 'test', conclusion: 'SUCCESS' };
  const reader = ({ commit = { sha }, runs = { total_count: 1, check_runs: [run] },
    statuses = { total_count: 0, statuses: [] } } = {}) => args => {
    if (args[1].endsWith('/commits/main')) return commit;
    if (args[1].includes('/check-runs')) return runs;
    if (args[1].includes('/status')) return statuses;
    throw Error('unexpected read');
  };
  it('returns the examined sha with run and status checks when complete', () => {
    expect(readMainCheckEvidence({ repo: 'example/widgets', read: reader({
      statuses: { total_count: 1, statuses: [{ context: 'ci/x', state: 'success' }] } }) }))
      .toEqual({ sha, checks: [run, { context: 'ci/x', state: 'success' }] });
  });
  it.each([
    ['check-run count mismatch', { runs: { total_count: 2, check_runs: [run] } }, 'incomplete main checks'],
    ['status count mismatch', { statuses: { total_count: 3, statuses: [] } }, 'incomplete main checks'],
    ['check-run page cap', { runs: { total_count: 100, check_runs: Array.from({ length: 100 }, () => run) } }, 'incomplete main checks'],
    ['status page cap', { statuses: { total_count: 100, statuses: Array.from({ length: 100 }, () => ({})) } }, 'incomplete main checks'],
    ['malformed check-run collection', { runs: { total_count: 0 } }, 'incomplete main checks'],
    ['malformed status collection', { statuses: null }, 'incomplete main checks'],
    ['invalid main sha', { commit: { sha: 'zzz' } }, 'unknown main tip'],
  ])('refuses refresh for incomplete production main evidence: %s', async (_name, evidence, message) => {
    expect(() => readMainCheckEvidence({ repo: 'example/widgets', read: reader(evidence) })).toThrow(message);
    const f = fixture({ readMainChecks: undefined }); f.read = vi.fn(reader(evidence));
    await runReadyStuck(f);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.receipt.refreshed).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1); // the alert stays available
  });
});

describe('ready-stuck refused-refresh evidence cooldown', () => {
  it('a refused refresh re-reads its evidence at most once per cooldown, then retries', async () => {
    const f = fixture({ onlyChecksBlock: vi.fn(() => false) });
    await runReadyStuck(f); await runReadyStuck(f); await runReadyStuck(f);
    expect(f.onlyChecksBlock).toHaveBeenCalledTimes(1);
    f.now += 59 * 60000; await runReadyStuck(f);
    expect(f.onlyChecksBlock).toHaveBeenCalledTimes(1);
    f.now += 2 * 60000; await runReadyStuck(f);
    expect(f.onlyChecksBlock).toHaveBeenCalledTimes(2);
    f.onlyChecksBlock.mockReturnValue(true); f.now += 61 * 60000; await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('an unreadable main-check refusal is remembered too', async () => {
    const f = fixture({ readMainChecks: vi.fn(() => { throw Error('unknown'); }) });
    await runReadyStuck(f); await runReadyStuck(f);
    expect(f.readMainChecks).toHaveBeenCalledTimes(1);
  });
  it('production reads for a refused refresh are bounded across many ticks', async () => {
    const { f, evidence } = (() => {
      const f = fixture({ onlyChecksBlock: undefined }); f.pr.reviewDecision = 'APPROVED'; f.pr.comments = [];
      const evidence = { pull: { head: { sha: f.pr.headRefOid, repo: { full_name: f.repo } }, base: { ref: 'main' },
        mergeable: true, draft: false, state: 'open' }, rules: [{ enforcement: 'active' }] };
      f.read = vi.fn(args => args[1].endsWith('/pulls/17') ? evidence.pull : evidence.rules);
      return { f, evidence };
    })();
    expect(evidence.rules).toHaveLength(1);
    for (let i = 0; i < 50; i++) { f.now += 60000; await runReadyStuck(f); }
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(2); // one attempt inside the 60-minute window
  });
  it('clears the remembered attempts when the label goes away', async () => {
    const f = fixture({ onlyChecksBlock: vi.fn(() => false) }); await runReadyStuck(f);
    expect(f.receipt.refreshTriedAt).toBe(now);
    f.pr.labels = []; await runReadyStuck(f);
    expect(f.receipt.refreshTriedAt).toBeUndefined();
  });
});

describe('ready-stuck production refresh ref validation', () => {
  it('accepts a lane branch with underscore, dot and dash and refuses non-lane branches', async () => {
    for (const [name, expected] of [['lane/foo-bar_1.2', 'rebased'], ['feature/x', 'skip'], ['main', 'skip']]) {
      refreshIo.gitRunner.mockReset().mockImplementation((_c, args) => {
        const a = args.join(' ');
        if (a.startsWith('fetch')) return { status: 0, stdout: '' };
        return { status: 0, stdout: `${a === 'rev-parse origin/main' ? 'c'.repeat(40) : 'a'.repeat(40)}\n` };
      });
      refreshIo.rebaseDropManifest.mockReset().mockReturnValue({ action: 'rebased' });
      const f = fixture({ refresh: undefined, readMainChecks: () => ({ sha: 'c'.repeat(40), checks: [{ name: 'test', conclusion: 'SUCCESS' }] }) });
      f.pr.headRefName = name;
      await runReadyStuck(f);
      expect(f.log.mock.calls).toEqual([[`pr-merge-watch: ready-stuck self-heal #17 ${expected}`]]);
    }
  });
  it.each(['--upload-pack=touch x', '-x', 'a..b', 'has space', 'semi;colon', '', undefined])(
    'refuses refresh for headRefName %j without invoking git', async headRefName => {
      refreshIo.gitRunner.mockReset(); refreshIo.rebaseDropManifest.mockReset();
      const f = fixture({ refresh: undefined, readMainChecks: () => ({ sha: 'c'.repeat(40), checks: [{ name: 'test', conclusion: 'SUCCESS' }] }) });
      f.pr.headRefName = headRefName;
      await runReadyStuck(f);
      expect(refreshIo.gitRunner).not.toHaveBeenCalled();
      expect(refreshIo.rebaseDropManifest).not.toHaveBeenCalled();
      expect(f.log.mock.calls).toEqual([['pr-merge-watch: ready-stuck self-heal #17 skip']]);
    });
});


describe('missing required checks and checks-only rulesets', () => {
  function missingFixture() {
    const f = fixture({ readRequiredChecks: vi.fn(() => ['merge-gate']),
      readMainChecks: vi.fn(() => [{ name: 'merge-gate', conclusion: 'SUCCESS' }]) });
    f.pr.statusCheckRollup = [];
    f.readLabelTime.mockReturnValue(date(25));
    return f;
  }
  it('refreshes a missing merge-gate once after the alert', async () => {
    const f = missingFixture(); await runReadyStuck(f); await runReadyStuck(f);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it.each([3, 24])('does not refresh an absent required check after %sh with a 24h stale threshold', async hours => {
    const f = missingFixture(); f.readLabelTime.mockReturnValue(date(hours));
    await runReadyStuck(f);
    expect(f.receipt.readyStuckAlerted).toBe(true);
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('uses observed-since for missing-check staleness when label history is unavailable', async () => {
    const f = missingFixture(); f.readLabelTime.mockImplementation(() => { throw Error('unreadable'); });
    f.receipt = { readyStuckAlerted: true, readyStuckSince: now - 3 * 3600000 };
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
    f.now += 22 * 3600000;
    await runReadyStuck(f); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('holds when the missing name is not green on main', async () => {
    const f = missingFixture(); f.readMainChecks.mockReturnValue([{ name: 'other', conclusion: 'SUCCESS' }]);
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('holds and cools down an unreadable required-check read', async () => {
    const f = missingFixture(); f.readRequiredChecks.mockImplementation(() => { throw Error('unreadable'); });
    await runReadyStuck(f); await runReadyStuck(f);
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.readRequiredChecks).toHaveBeenCalledTimes(1);
  });
  const workflow = { path: '.github/workflows/ci.yml', ref: 'refs/heads/main', repository_id: 42 };
  function rulesFixture(types) {
    const f = fixture(); f.pr.comments = []; f.pr.reviewDecision = 'APPROVED';
    f.read = vi.fn(([, path]) => {
      if (path.endsWith('/pulls/17')) return { head: { sha: f.pr.headRefOid, repo: { full_name: f.repo } },
        base: { ref: 'main', repo: { id: 42 } }, mergeable: true, draft: false, state: 'open' };
      if (path.includes('rulesets?')) return [{ id: 1, enforcement: 'active' }, { id: 2, enforcement: 'active' }];
      if (path.endsWith('/rulesets/1')) return { rules: types.map(type => type === 'workflows'
        ? { type, parameters: { workflows: [{ ...workflow }] } } : { type }) };
      if (path.endsWith('/rulesets/2')) return { rules: [{ type: 'required_status_checks', parameters: {
        required_status_checks: [{ context: 'merge-gate' }, { context: 'test' }] } }, { type: 'merge_queue' }] };
      if (path.endsWith('/protection')) return { required_status_checks: { contexts: ['test'] } };
      throw Error('unexpected read');
    });
    return f;
  }
  it.each(['FAILURE', 'NEUTRAL', 'MISSING', 'SUCCESS'])(
    'workflow rule requires successful main evidence for an already-green rollup check: %s', async result => {
      const f = rulesFixture(['workflows']);
      f.onlyChecksBlock = undefined; f.readRequiredChecks = undefined;
      f.readLabelTime.mockReturnValue(date(25));
      f.pr.statusCheckRollup.push({ name: 'workflow-job', conclusion: 'SUCCESS' });
      f.readMainChecks.mockReturnValue([
        { name: 'test', conclusion: 'SUCCESS' }, { name: 'merge-gate', conclusion: 'SUCCESS' },
        ...(result === 'MISSING' ? [] : [{ name: 'workflow-job', conclusion: result }]),
      ]);
      await runReadyStuck(f);
      expect(f.refresh).toHaveBeenCalledTimes(result === 'SUCCESS' ? 1 : 0);
    });
  it.each(['NEUTRAL', 'SKIPPED'])(
    'workflow rule holds for a PR check beyond the refresh with %s conclusion', async conclusion => {
      const f = rulesFixture(['workflows']);
      f.onlyChecksBlock = undefined; f.readRequiredChecks = undefined;
      f.readLabelTime.mockReturnValue(date(25));
      f.pr.statusCheckRollup.push({ name: 'workflow-job', conclusion });
      f.readMainChecks.mockReturnValue(['test', 'merge-gate', 'workflow-job'].map(name => ({ name, conclusion: 'SUCCESS' })));
      await runReadyStuck(f);
      expect(f.refresh).not.toHaveBeenCalled();
    });
  it.each([['protection', 88, false], ['protection', null, false], ['protection', 99, true],
    ['ruleset', 88, false], ['ruleset', null, false], ['ruleset', 99, true]])(
    'matches %s requirement for app 99 against main producer %s: refresh=%s', async (source, app, allowed) => {
        const f = rulesFixture([]); const original = f.read;
        f.readRequiredChecks = undefined;
        f.readLabelTime.mockReturnValue(date(25));
        f.read = args => {
          if (source === 'protection' && args[1].endsWith('/protection')) return {
            required_status_checks: { contexts: ['test'], checks: [{ context: 'test', app_id: 99 }] },
          };
          if (source === 'ruleset' && args[1].endsWith('/rulesets/2')) return { rules: [
            { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: 99 }] } },
          ] };
          return original(args);
        };
        f.readMainChecks.mockReturnValue([
          app === null ? { context: 'test', state: 'success' } : { name: 'test', conclusion: 'SUCCESS', app: { id: app } },
          { name: 'merge-gate', conclusion: 'SUCCESS' },
        ]);
        await runReadyStuck(f);
        expect(f.refresh).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });

  it('allows the two active checks/workflow rulesets', () => {
    expect(readChecksOnly(rulesFixture(['deletion', 'non_fast_forward', 'workflows']))).toBe(true);
  });
  it.each([
    ['foreign repository', { ...workflow, repository_id: 99 }],
    ['non-main ref', { ...workflow, ref: 'refs/heads/dev' }],
    ['outside workflow directory', { ...workflow, path: 'ci.yml' }],
    ['parent traversal', { ...workflow, path: '.github/workflows/../../ci.yml' }],
    ['missing workflow path', { ref: workflow.ref, repository_id: 42 }],
  ])('holds refresh for a workflow with %s', async (_name, entry) => {
    const f = rulesFixture(['workflows']); const original = f.read;
    f.read = args => args[1].endsWith('/rulesets/1')
      ? { rules: [{ type: 'workflows', parameters: { workflows: [entry] } }] } : original(args);
    f.onlyChecksBlock = undefined;
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'workflows' },
    { type: 'workflows', parameters: { workflows: [null] } },
    { type: 'required_status_checks' },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 42 }] } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{}] } },
  ])('holds refresh for malformed rule parameters: %j', async rule => {
    const f = rulesFixture([]); const original = f.read;
    f.read = args => args[1].endsWith('/rulesets/1') ? { rules: [rule] } : original(args);
    f.onlyChecksBlock = undefined;
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('holds refresh for an unknown active rule type', async () => {
    const f = rulesFixture(['unknown']); f.onlyChecksBlock = undefined;
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('unions branch and active ruleset required contexts', async () => {
    const { readRequiredChecks } = await import('../pass-daemons/pr-ready-stuck.mjs');
    expect(readRequiredChecks(rulesFixture(['workflows']))).toEqual({
      checks: [{ name: 'test', appId: null }, { name: 'merge-gate', appId: null }], hasWorkflows: true,
    });
  });
  it.each(['ruleset detail', 'required parameters', 'branch contexts'])(
    'holds for unreadable %s in the production required-check reader', async kind => {
      const { readRequiredChecks } = await import('../pass-daemons/pr-ready-stuck.mjs');
      const f = rulesFixture(['workflows']); const original = f.read;
      f.read = args => {
        if (kind === 'ruleset detail' && args[1].endsWith('/rulesets/2')) throw Error('unreadable');
        if (kind === 'required parameters' && args[1].endsWith('/rulesets/2')) return { rules: [{ type: 'required_status_checks' }] };
        if (kind === 'branch contexts' && args[1].endsWith('/protection')) return { required_status_checks: {} };
        return original(args);
      };
      expect(() => readRequiredChecks(f)).toThrow();
    });
  it('ignores disabled ruleset contexts', async () => {
    const { readRequiredChecks } = await import('../pass-daemons/pr-ready-stuck.mjs');
    const f = rulesFixture([]); const original = f.read;
    f.read = args => args[1].includes('rulesets?') ? [{ enforcement: 'disabled' }] : original(args);
    expect(readRequiredChecks(f)).toEqual({ checks: [{ name: 'test', appId: null }], hasWorkflows: false });
  });
  it('keeps unfinished checks blocking even when a required name is missing', async () => {
    const f = missingFixture(); f.pr.statusCheckRollup.push({ name: 'test', status: 'IN_PROGRESS' });
    await runReadyStuck(f); expect(f.refresh).not.toHaveBeenCalled();
    expect(f.readRequiredChecks).not.toHaveBeenCalled();
  });
  it('does not read missing checks before the alert threshold', async () => {
    const f = missingFixture(); f.readLabelTime.mockReturnValue(date(3)); f.config.readyStuckMinutes = 240;
    await runReadyStuck(f); expect(f.readRequiredChecks).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('fails closed at the ruleset list cap with operator escalation', async () => {
    const { readRequiredChecks } = await import('../pass-daemons/pr-ready-stuck.mjs');
    const f = rulesFixture([]); f.read = () => Array.from({ length: 100 }, () => ({ enforcement: 'disabled' }));
    expect(readChecksOnly(f)).toBe(false);
    expect(() => readRequiredChecks(f)).toThrow(/operator/);
  });
});
