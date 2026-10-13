// Card 272 part 2 (live #5045, 2026-10-13): refresh once before paying for a fixer.
import { describe, it, expect, vi } from 'vitest';
import { extractFailingTestFiles, decideStaleBaseRefresh, staleBaseBudgetSpent, buildStaleBaseComment,
  resolveStaleBaseSetting, createStaleBaseGate, readStaleBaseFacts } from '../stale-base-refresh.mjs';
const file = 'scripts/conveyor/soak/__tests__/shard-files.test.mjs';
const sha = 'a'.repeat(40);
const log = `2026-10-13T13:30:00.1234567Z \u001b[31m FAIL \u001b[0m${file} > shard timings > the stored timings cover most break files\nAssertionError: expected 0.796875 to be greater than 0.8`;
const facts = () => ({ setting: { value: 'on', source: 'tool' }, baseRefName: 'main', defaultBranch: 'main',
  mergeStateStatus: 'BLOCKED', headRefName: 'lane/5045', headRefOid: 'b'.repeat(40),
  failingChecks: [{ name: 'test-shard (3)', conclusion: 'FAILURE', log },
    { name: 'test', conclusion: 'FAILURE', log: 'One or more test shards did not succeed' }],
  behindBy: 576, mergeBase: sha, budgetSpent: false, headContainsMainGreenSha: false,
  mainLatestCheckRuns: ['test-shard (3)', 'test'].map(name => ({ name, conclusion: 'success', status: 'completed',
    completed_at: '2026-10-13T13:00:00Z', head_sha: 'c'.repeat(40) })),
  prFiles: ['backlog/272.md'], mainChangedFailingFiles: [] });
const env = { WE_CI_HEAL_STALE_BASE_REFRESH_FIRST: 'on', WE_PLATFORM_PREFERENCES_FILE: '/does-not-exist' };
describe('stale base pure rules', () => {
  it('extracts the real timestamped ANSI shard failure and removes duplicates', () => {
    expect(extractFailingTestFiles(`${log}\n${log}`)).toEqual([file]);
  });
  it('owes the #5045 refresh via main-green', () => {
    expect(decideStaleBaseRefresh(facts())).toMatchObject({ owed: true, via: 'main-green', failingTestFiles: [file] });
  });
  it.each([
    ['setting off', { setting: { value: 'off', source: 'env' } }, /off.*env/],
    ['conflict', { mergeStateStatus: 'DIRTY' }, /DIRTY/],
    ['timeout', { failingChecks: [{ name: 'test', conclusion: 'TIMED_OUT', log }] }, /TIMED_OUT/],
    ['lint', { failingChecks: [{ name: 'lint', conclusion: 'FAILURE', log: 'lint failed' }] }, /lint/],
    ['unreadable shard', { failingChecks: [{ name: 'shard', conclusion: 'FAILURE', log: '' }] }, /shard/],
    ['current', { behindBy: 0 }, /behindBy/],
    ['spent', { budgetSpent: true }, /already refreshed once/],
    ['PR changes test', { prFiles: [file] }, /prFiles/],
    ['unknown files', { prFiles: null }, /prFiles/],
    ['unknown budget', { budgetSpent: null }, /budgetSpent/],
    ['unknown merge state', { mergeStateStatus: null }, /mergeStateStatus/],
    ['wrong base', { baseRefName: 'release' }, /default/],
  ])('does not owe when %s', (_name, change, why) => {
    expect(decideStaleBaseRefresh({ ...facts(), ...change })).toMatchObject({ owed: false, why: expect.stringMatching(why) });
  });
  it.each(['setting', 'baseRefName', 'defaultBranch', 'mergeStateStatus', 'failingChecks', 'behindBy', 'mergeBase', 'budgetSpent'])('fails closed on missing %s', key => {
    const f = facts(); delete f[key];
    expect(decideStaleBaseRefresh(f)).toMatchObject({ owed: false, why: expect.stringContaining(key) });
  });
  it('requires at least one test file even if every job is an aggregator', () => {
    expect(decideStaleBaseRefresh({ ...facts(), failingChecks: [facts().failingChecks[1]] }).why).toMatch(/no failing test files/);
  });
  it('main changed the failing test even without main-green facts', () => {
    expect(decideStaleBaseRefresh({ ...facts(), mainLatestCheckRuns: null, headContainsMainGreenSha: null,
      prFiles: null, mainChangedFailingFiles: [file] })).toMatchObject({ owed: true, via: 'test-changed-on-main' });
  });
  it('trusts the exact base or onto line only from marker authors', () => {
    const body = buildStaleBaseComment({ head: 'b'.repeat(40), mergeBase: 'd'.repeat(40), onto: sha,
      via: 'main-green', failingTestFiles: [file], outcome: 'error' });
    expect(staleBaseBudgetSpent({ comments: [{ body, viewerDidAuthor: true }], mergeBase: sha })).toBe(true);
    expect(staleBaseBudgetSpent({ comments: [{ body, author: { login: 'stranger' } }], mergeBase: sha })).toBe(false);
    expect(staleBaseBudgetSpent({ comments: [{ body: body.replace(`onto: ${sha}`, `onto: ${sha}123`), viewerDidAuthor: true }], mergeBase: sha })).toBe(false);
  });
  it('resolves standard, tool and env sources', () => {
    const cleanEnv = { WE_PLATFORM_PREFERENCES_FILE: '/does-not-exist' };
    expect(resolveStaleBaseSetting({ env: cleanEnv, settings: {} })).toEqual({ value: 'off', source: 'standard' });
    expect(resolveStaleBaseSetting({ env: cleanEnv, settings: { ciHeal: { staleBaseRefreshFirst: 'on' } } })).toEqual({ value: 'on', source: 'tool' });
    expect(resolveStaleBaseSetting({ env: { ...cleanEnv, WE_CI_HEAL_STALE_BASE_REFRESH_FIRST: 'off' }, settings: { ciHeal: { staleBaseRefreshFirst: 'on' } } })).toEqual({ value: 'off', source: 'env' });
  });
});
describe('stale base gate', () => {
  const setup = (overrides = {}) => {
    const f = facts();
    const deps = { env, readFacts: vi.fn(() => ({ facts: f, decision: decideStaleBaseRefresh(f) })),
      refresh: vi.fn(() => ({ action: 'rebased', newCommit: sha })), checkClaim: vi.fn(() => null),
      postComment: vi.fn(), reconcileAcceptance: vi.fn(), readOriginTip: vi.fn(() => sha), log: vi.fn(), ...overrides };
    return { ...deps, run: () => createStaleBaseGate(deps)({ planned: { pr: 5045 }, repo: 'we', root: '/repo' }) };
  };
  it('refreshes once, posts the marker and carries acceptance forward before holding', async () => {
    const d = setup();
    expect(await d.run()).toMatchObject({ held: true });
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith('lane/5045', { base: 'origin/main', root: '/repo', prNumber: 5045, repo: 'web-everything/web-everything' });
    expect(d.postComment).toHaveBeenCalledWith(5045, expect.objectContaining({ body: expect.stringContaining('outcome: rebased') }));
    expect(d.reconcileAcceptance).toHaveBeenCalledWith({ prNumber: 5045, newHead: sha, repo: 'web-everything/web-everything', root: '/repo' });
  });
  it.each([() => ({ action: 'error', error: 'conflict' }), () => { throw new Error('failed'); },
    () => ({ action: 'current' }), () => ({ action: 'skip' })])('spends the budget even when refresh does not rebase', async refresh => {
    const d = setup({ refresh });
    expect(await d.run()).toBeNull();
    expect(d.postComment).toHaveBeenCalledOnce();
    expect(d.reconcileAcceptance).not.toHaveBeenCalled();
  });
  it('defers a live claim without spending the budget', async () => {
    const d = setup({ checkClaim: () => ({ refused: true, message: 'held by fixer' }) });
    expect(await d.run()).toEqual({ held: true, reason: 'stale-base refresh deferred: held by fixer' });
    expect(d.refresh).not.toHaveBeenCalled(); expect(d.postComment).not.toHaveBeenCalled();
  });
  it('reads nothing with setting off', async () => {
    const d = setup({ env: { ...env, WE_CI_HEAL_STALE_BASE_REFRESH_FIRST: 'off' } });
    expect(await d.run()).toBeNull(); expect(d.readFacts).not.toHaveBeenCalled();
  });
});

describe('stale base fact reader', () => {
  const fixture = (changes = {}) => {
    const f = facts();
    const view = { headRefOid: f.headRefOid, headRefName: f.headRefName, baseRefName: 'main',
      mergeStateStatus: 'BLOCKED', isCrossRepository: false, comments: [],
      statusCheckRollup: f.failingChecks.map((c, i) => ({ name: c.name, conclusion: c.conclusion, workflowName: 'CI',
        detailsUrl: `https://github.com/repo/actions/runs/1/job/${i + 10}` })), ...changes };
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'git') return '';
      if (args[0] === 'pr') return JSON.stringify(view);
      if (args[1].endsWith('/jobs/10/logs')) return log;
      if (args[1].endsWith('/jobs/11/logs')) return f.failingChecks[1].log;
      if (args[1].includes('/compare/main...')) return JSON.stringify({ behind_by: 576, merge_base: sha });
      if (args[1].includes('/compare/')) return '576';
      if (args[1].endsWith('/files')) return 'backlog/272.md\n';
      throw new Error(`unexpected read ${cmd} ${args.join(' ')}`);
    });
    const readMainRuns = vi.fn(() => []);
    const readMainLatestCheckRuns = vi.fn(() => f.mainLatestCheckRuns);
    const input = { repo: 'web-everything/web-everything', pr: 5045, root: '/repo', setting: f.setting,
      exec, readMainRuns, readMainLatestCheckRuns };
    return { input, exec, readMainRuns, readMainLatestCheckRuns };
  };
  it('ignores non-CI workflows (review-gate) and cancelled CI jobs', () => {
    const f = facts();
    const d = fixture({ statusCheckRollup: [
      ...f.failingChecks.map((c, i) => ({ name: c.name, conclusion: c.conclusion, workflowName: 'CI',
        detailsUrl: `https://github.com/repo/actions/runs/1/job/${i + 10}` })),
      { name: 'review-gate', conclusion: 'FAILURE', workflowName: 'Review gate' },
      { name: 'visual', conclusion: 'CANCELLED', workflowName: 'CI' },
    ] });
    expect(readStaleBaseFacts(d.input).decision).toMatchObject({ owed: true, via: 'main-green' });
  });
  it('a failing CI job that is not a test failure still fails closed', () => {
    const d = fixture({ statusCheckRollup: [{ name: 'lint', conclusion: 'failure', workflowName: 'CI',
      detailsUrl: 'https://github.com/repo/actions/runs/1/job/12' }] });
    d.exec.mockImplementation((cmd, args) => (args[0] === 'pr' ? JSON.stringify({ headRefOid: sha, headRefName: 'lane/x',
      baseRefName: 'main', mergeStateStatus: 'BLOCKED', isCrossRepository: false, comments: [],
      statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE', workflowName: 'CI', detailsUrl: 'https://github.com/repo/actions/runs/1/job/12' }] }) : 'eslint: 3 problems'));
    expect(readStaleBaseFacts(d.input).decision.owed).toBe(false);
  });
  it('reads job logs, the correct compare direction, main evidence and literal file paths', () => {
    const d = fixture();
    const result = readStaleBaseFacts(d.input);
    expect(result.decision).toMatchObject({ owed: true, via: 'main-green' });
    expect(d.exec.mock.calls.map(([cmd, args]) => [cmd, ...args.slice(0, 2)])).toEqual([
      ['gh', 'pr', 'view'], ['gh', 'api', 'repos/web-everything/web-everything/actions/jobs/10/logs'],
      ['gh', 'api', 'repos/web-everything/web-everything/actions/jobs/11/logs'],
      ['gh', 'api', `repos/web-everything/web-everything/compare/main...${facts().headRefOid}`],
      ['gh', 'api', `repos/web-everything/web-everything/compare/${'c'.repeat(40)}...${facts().headRefOid}`],
      ['gh', 'api', 'repos/web-everything/web-everything/pulls/5045/files'], ['git', '--literal-pathspecs', '-C'],
    ]);
    expect(d.exec.mock.calls.at(-1)[1]).toEqual(['--literal-pathspecs', '-C', '/repo', 'diff', '--name-only', sha, 'origin/main', '--', file]);
    expect(d.readMainLatestCheckRuns).toHaveBeenCalledWith(expect.objectContaining({ mainRuns: [], exec: d.exec }));
  });
  it('makes no IO calls when off', () => {
    const d = fixture();
    expect(readStaleBaseFacts({ ...d.input, setting: { value: 'off', source: 'env' } }).decision.owed).toBe(false);
    expect(d.exec).not.toHaveBeenCalled();
  });
  it.each([
    ['DIRTY', { mergeStateStatus: 'DIRTY' }], ['fork', { isCrossRepository: true }],
    ['unknown fork', { isCrossRepository: null }], ['no failing checks', { statusCheckRollup: [] }],
    ['timeout', { statusCheckRollup: [{ name: 'test', conclusion: 'TIMED_OUT', workflowName: 'CI' }] }],
  ])('stops after PR read on %s', (_name, changes) => {
    const d = fixture(changes);
    expect(readStaleBaseFacts(d.input).decision.owed).toBe(false);
    expect(d.exec).toHaveBeenCalledTimes(1); expect(d.readMainRuns).not.toHaveBeenCalled();
  });
  it('stops before compare on unreadable logs', () => {
    const d = fixture(); const original = d.exec.getMockImplementation();
    d.exec.mockImplementation((cmd, args, opts) => {
      if (args[1]?.endsWith('/logs')) throw new Error('404');
      return original(cmd, args, opts);
    });
    expect(readStaleBaseFacts(d.input).decision.why).toMatch(/unreadable/);
    expect(d.exec).toHaveBeenCalledTimes(2); expect(d.readMainRuns).not.toHaveBeenCalled();
  });
  it('stops before main reads when a trusted onto marker spends the budget', () => {
    const body = buildStaleBaseComment({ head: sha, mergeBase: 'd'.repeat(40), onto: sha, via: 'main-green', outcome: 'error' });
    const d = fixture({ comments: [{ body, viewerDidAuthor: true }] });
    expect(readStaleBaseFacts(d.input).decision.why).toMatch(/already refreshed once/);
    expect(d.exec).toHaveBeenCalledTimes(4); expect(d.readMainRuns).not.toHaveBeenCalled();
  });
  it('uses the newest green SHA when checks completed at different commits', () => {
    const d = fixture();
    const runs = facts().mainLatestCheckRuns;
    runs[1] = { ...runs[1], head_sha: 'e'.repeat(40), completed_at: '2026-10-13T14:00:00Z' };
    d.readMainLatestCheckRuns.mockReturnValue(runs);
    expect(readStaleBaseFacts(d.input).facts.mainGreenSha).toBe('e'.repeat(40));
    expect(d.exec.mock.calls[4][1][1]).toContain(`/compare/${'e'.repeat(40)}...`);
  });
  it('unknown containment and files fail closed but changed tests still allow path B', () => {
    const d = fixture(); const original = d.exec.getMockImplementation();
    d.exec.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git') return `${file}\n`;
      if (args[1]?.includes(`/compare/${'c'.repeat(40)}`)) return '';
      if (args[1]?.endsWith('/files')) throw new Error('unreadable');
      return original(cmd, args, opts);
    });
    const result = readStaleBaseFacts(d.input);
    expect(result.facts.headContainsMainGreenSha).toBeNull(); expect(result.facts.prFiles).toBeNull();
    expect(result.decision).toMatchObject({ owed: true, via: 'test-changed-on-main' });
  });
  it('a deferred PR file read cannot establish the main-green path', () => {
    const d = fixture(); const original = d.exec.getMockImplementation();
    d.exec.mockImplementation((cmd, args, opts) => {
      if (args[1]?.endsWith('/files')) return JSON.stringify({ outcome: 'deferred-low-budget', deferred: true });
      return original(cmd, args, opts);
    });
    const result = readStaleBaseFacts(d.input);
    expect(result.facts.prFiles).toBeNull(); expect(result.decision.owed).toBe(false);
  });

});
