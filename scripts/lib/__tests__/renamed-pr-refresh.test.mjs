import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHandPickedOnlyFailure, drainAssignedNumbers, classifyOwedMainRule, isEvidenceOnlyConflict,
  planRenamedPrRefresh, runRenamedPrRefresh, readOwedMainRule, enrichPrsWithOwedMainRule,
  resolveRefreshSettings, logRefreshSettings,
} from '../renamed-pr-refresh.mjs';
import { planReconcile, REFUSAL_KINDS, CI_HEAL_ROUND_CAP } from '../../conveyor/reconcile-core.mjs';
import { buildCiHealComment } from '../../conveyor/ci-heal-mark.mjs';
import { buildCiHealEscalationComment } from '../../conveyor/ci-heal-escalation-mark.mjs';
import { withOwedMainRuleSection } from '../../operations/ci-heal-pr-dispatch.mjs';

const error = 'Backlog item "5994-diagnose-unknown-prepare-result-failure-97b1d8c1d2e808d2" carries a hand-picked NNN id (#5994) that is not on origin/main — new items must be hash-keyed (xNNNNNN); the drain assigns the real number at land (#2288). Rename it with a hash id, or set WE_SKIP_HAND_NUMBERED_GATE=1 if this is the sanctioned collision-heal renumbering path (#2548).';
const tail = `2026-10-12T22:28:54.0617823Z \x1b[31m error\x1b[0m ${error}\n2026-10-12T22:28:54.0617839Z \n2026-10-12T22:28:54.0618663Z \x1b[31m1 error(s)\x1b[0m, 6093 warning(s) \x1b[2m(checked 81 blocks, ...)\x1b[0m\n2026-10-12T22:28:54.0628539Z ##[error]Process completed with exit code 1.`;
const subject = 'drain: JIT-number xyxojh9→#5994 at land (#2288)';
const author = { name: 'Trusted', email: 'drain@example.test' };
const authors = new Set([`${author.name}\0${author.email}`]);
const commit = subject => ({ subject, author });
const pr = (over = {}) => ({ number: 5050, state: 'OPEN', headRefName: 'lane/example', headRefOid: 'abc123', labels: [], comments: [], mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/1/job/42' }], ...over });
const settings = resolveRefreshSettings({ env: {}, read: () => ({}) });
const owedPr = (over = {}) => pr({ owedMainRule: { head: 'abc123', owed: true, ownsRepair: true, nums: [5994] }, ...over });
const plan = (over = {}) => planRenamedPrRefresh({ prs: [owedPr()], mainAccepts: true, settings, state: {}, evidenceVerdicts: {}, ...over });
const temporary = async (fn) => { const root = mkdtempSync(join(tmpdir(), 'renamed-refresh-')); try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); } };

describe('hand-picked failure proof', () => {
  it('recognizes the observed ANSI/timestamped log', () => expect(parseHandPickedOnlyFailure(tail)).toMatchObject({ only: true, nums: [5994] }));
  it('refuses another standards error', () => expect(parseHandPickedOnlyFailure(`${tail}\n error something else`).only).toBe(false));
  it('ignores warnings mentioning hand-picked', () => expect(parseHandPickedOnlyFailure(`\x1b[33m  warn\x1b[0m hand-picked NNN id (#123)\n${tail}`).nums).toEqual([5994]));
  it('requires a matching summary', () => expect(parseHandPickedOnlyFailure(tail.replace('1 error(s)', '2 error(s)')).only).toBe(false));
  it('refuses a vitest workflow error', () => expect(parseHandPickedOnlyFailure(`${tail}\n##[error]AssertionError: expected 1 to be 2`).only).toBe(false));
  it('refuses empty or summary-less logs', () => { expect(parseHandPickedOnlyFailure('').only).toBe(false); expect(parseHandPickedOnlyFailure(` error ${error}`).only).toBe(false); });
  it('requires a drain assignment for every number', () => {
    expect(classifyOwedMainRule({ logText: tail, commits: [commit(subject)], authors })).toMatchObject({ owed: true, nums: [5994] });
    expect(classifyOwedMainRule({ logText: tail, commits: [], authors }).owed).toBe(false);
    expect(classifyOwedMainRule({ logText: tail, commits: [{ subject, author: { name: 'Attacker', email: 'attacker@example.test' } }], authors }).owed).toBe(false);
    expect(drainAssignedNumbers([commit('drain: JIT-number xyxojh9→#5994, xabcdef→#5995 at land (#2288)'), commit('unrelated #5996')], authors)).toEqual(new Set([5994, 5995]));
  });
  it('extracts drain assignments while skipping duplicate-drop clauses', () => {
    expect(drainAssignedNumbers([commit('drain: JIT-number x49hott→#5985, xz73kbf duplicate dropped (already 5937-fix-run-detect-unmerged-binary-paths-by-status-not-numstat.md) at land (#2288)')], authors)).toEqual(new Set([5985]));
  });
  it('ignores collision-heal subjects', () => {
    expect(drainAssignedNumbers(['backlog: heal new-item id collision(s) pre-check (#5976→#5321) (#2222)'])).toEqual(new Set());
  });
});

describe('root-only scratch conflict proof', () => {
  it.each(['.fix-evidence.md', '.fix-4958-evidence.md'])('accepts %s', p => expect(isEvidenceOnlyConflict({ clean: false, conflictPaths: [p] })).toBe(true));
  it.each([{ clean: false, conflictPaths: ['.fix-evidence.md', 'src/real.js'] }, { clean: true, conflictPaths: ['.fix-evidence.md'] }, { clean: false, conflictPaths: [] }, { clean: false, conflictPaths: ['nested/.fix-evidence.md'] }])('refuses %j', parsed => expect(isEvidenceOnlyConflict(parsed)).toBe(false));
});

describe('settings and planning', () => {
  it('cascades settings then environment and logs invalid values', () => {
    const s = resolveRefreshSettings({ read: () => ({ mergeQueue: { refreshWhenMainAcceptsDrainNumbers: false } }), env: { WE_MQ_REFRESH_WHEN_MAIN_ACCEPTS_DRAIN_NUMBERS: 'on', WE_MQ_REFRESH_EVIDENCE_ONLY_CONFLICTS: 'invalid' } });
    expect(s.refreshWhenMainAcceptsDrainNumbers).toEqual({ value: true, source: 'WE_MQ_REFRESH_WHEN_MAIN_ACCEPTS_DRAIN_NUMBERS' });
    expect(s.refreshEvidenceOnlyConflicts.value).toBe(true);
    expect(s.invalid).toHaveLength(1);
    const log = { write: vi.fn() }; logRefreshSettings(s, log); expect(log.write.mock.calls.flat().join('')).toContain('refreshWhenMainAcceptsDrainNumbers=on (WE_MQ_REFRESH_WHEN_MAIN_ACCEPTS_DRAIN_NUMBERS)');
  });
  it('waits for the contract on main', () => expect(plan({ mainAccepts: false })).toMatchObject({ refresh: [], waiting: [{ num: 5050, nums: [5994] }] }));
  it('refreshes once per head, permits a new head', () => {
    expect(plan().refresh).toEqual([{ num: 5050, headRefName: 'lane/example', head: 'abc123', trigger: 'main-rule' }]);
    expect(plan({ state: { refreshed: { '5050@abc123': true } } }).refresh).toEqual([]);
    expect(plan({ prs: [owedPr({ headRefOid: 'def456', owedMainRule: { head: 'def456', owed: true, nums: [5994] } })], state: { refreshed: { '5050@abc123': true } } }).refresh).toHaveLength(1);
  });
  it('refreshes evidence-only conflicts on draft/not-ready PRs, even before main accepts', () => expect(plan({ prs: [pr({ isDraft: true })], mainAccepts: false, evidenceVerdicts: { '5050@abc123': true } }).refresh[0].trigger).toBe('evidence-only'));
  it('honors both off switches', () => expect(plan({ settings: { refreshWhenMainAcceptsDrainNumbers: false, refreshEvidenceOnlyConflicts: false }, evidenceVerdicts: { '5050@abc123': true } }).refresh).toEqual([]));
  it.each([{ isCrossRepository: true }, { headRefName: 'feature/example' }, { owedMainRule: { head: 'old', owed: true } }])('rejects ineligible or stale proof %j', over => expect(plan({ prs: [owedPr(over)] }).refresh).toEqual([]));
});

describe('IO replay', () => {
  it('reclassifies a changed test job on the same head', () => temporary(root => {
    const exec = vi.fn((_cmd, args) => args.includes('--paginate') ? JSON.stringify(commit(subject)) : args.some(a => a.includes('/43/')) ? '##[error]vitest failed' : tail);
    const opts = { slug: 'we/we', exec, authors, cache: join(root, 'state.json') };
    expect(readOwedMainRule(pr(), opts).owed).toBe(true);
    const changed = pr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/we/we/actions/runs/1/job/43' }] });
    expect(readOwedMainRule(changed, opts).reason).toBe('no standards error lines');
  }));
  const exec = vi.fn((_cmd, args) => args.includes('--paginate') ? JSON.stringify(commit(subject)) : tail);
  it('caches a verdict durably and only reads commits after a matching log', () => temporary(root => {
    const cache = join(root, 'state.json'); exec.mockClear();
    expect(readOwedMainRule(pr(), { slug: 'we/we', exec, cache, authors }).owed).toBe(true);
    expect(readOwedMainRule(pr(), { slug: 'we/we', exec, cache, authors }).owed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    const other = vi.fn(() => '##[error]vitest failed');
    expect(readOwedMainRule(pr({ headRefOid: 'other' }), { slug: 'we/we', exec: other, cache, authors }).owed).toBe(false);
    expect(other).toHaveBeenCalledTimes(1);
  }));
  it('does not cache read failures', () => temporary(root => {
    const broken = vi.fn(() => { throw new Error('offline'); });
    for (let i = 0; i < 2; i++) expect(readOwedMainRule(pr(), { slug: 'we/we', exec: broken, authors, cache: join(root, 'state.json') }).reason).toMatch(/^unreadable:/);
    expect(broken).toHaveBeenCalledTimes(2);
  }));
  it('enriches only WE red test PRs', () => {
    const read = vi.fn(() => ({ owed: true, nums: [5994], reason: 'assigned' }));
    const rows = [pr(), pr({ statusCheckRollup: [] })];
    enrichPrsWithOwedMainRule(rows, { repo: 'web-everything/web-everything', read, mainAccepts: () => false });
    expect(rows[0].owedMainRule).toMatchObject({ head: 'abc123', owed: true }); expect(rows[1].owedMainRule).toBeUndefined();
    enrichPrsWithOwedMainRule([pr()], { repo: 'frontierui/frontierui', read, mainAccepts: () => false }); expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('replays twice with main contract=%s', mainAccepts => temporary(async root => {
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const accepts = vi.fn(() => mainAccepts);
    const logs = []; const run = vi.fn((_cmd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'abc123' : 'tree\n' }));
    const opts = { prs: [pr()], slug: 'web-everything/web-everything', root, statePath: join(root, 'state.json'), settings, exec, authors, run, refresh, mainAccepts: accepts, log: line => logs.push(line) };
    const first = await runRenamedPrRefresh(opts); await runRenamedPrRefresh(opts);
    expect(accepts).toHaveBeenCalledWith({ cwd: root });
    expect(refresh).toHaveBeenCalledTimes(mainAccepts ? 1 : 0);
    if (mainAccepts) expect(refresh).toHaveBeenCalledWith('lane/example', { root, base: 'origin/main', prNumber: 5050, repo: opts.slug });
    else { expect(first.waiting).toEqual([{ num: 5050, nums: [5994] }]); expect(logs.join('\n')).toContain('waiting for main to accept drain numbers: drain-branch-numbering-ci-v1 absent'); }
  }));
  it('keeps a current head eligible until a rebase is recorded', () => temporary(async root => {
    const refresh = vi.fn().mockResolvedValueOnce({ ok: true, action: 'current' }).mockResolvedValue({ ok: true, action: 'rebased' });
    const run = vi.fn((_cmd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'abc123' : 'tree\n' }));
    const logs = [];
    const statePath = join(root, 'state.json');
    const opts = { prs: [pr()], slug: 'web-everything/web-everything', root, statePath, settings, exec, authors, run, refresh, mainAccepts: () => true, log: line => logs.push(line) };

    expect((await runRenamedPrRefresh(opts)).refreshed).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).refreshed?.['5050@abc123']).toBeUndefined();
    expect(logs.join('\n')).toContain('refresh result (main-rule, current)');

    expect((await runRenamedPrRefresh(opts)).refreshed).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).refreshed['5050@abc123']).toMatchObject({ trigger: 'main-rule' });

    expect((await runRenamedPrRefresh(opts)).refreshed).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
  }));
});

describe('reconcile ownership', () => {
  it.each([
    { settings: { refreshWhenMainAcceptsDrainNumbers: false } },
    { over: { headRefName: 'feature/example' } },
    { over: { isCrossRepository: true } },
    { mainAccepts: true },
    { over: { mergeStateStatus: 'DIRTY' } },
  ])('retains repair ownership for excluded or no-progress paths %j', options => {
    const rows = [pr(options.over)];
    enrichPrsWithOwedMainRule(rows, { repo: 'web-everything/web-everything', settings, mainAccepts: () => false, read: () => ({ owed: true, nums: [5994] }), ...options, mainAccepts: () => options.mainAccepts ?? false });
    const result = planReconcile({ prs: rows, agents: [], durableCounts: {}, requiredChecks: ['test'], now: Date.parse('2026-10-12T23:00:00Z') });
    expect(result.refusals.some(r => r.kind === 'owed-main-rule')).toBe(false);
    expect(result.dispatch.length).toBeGreaterThan(0);
  });
  it('refuses ci-heal only for evidence on the current head', () => {
    const reconcile = p => planReconcile({ prs: [p], agents: [], durableCounts: {}, requiredChecks: ['test'], now: Date.parse('2026-10-12T23:00:00Z') });
    expect(REFUSAL_KINDS).toContain('owed-main-rule');
    const current = reconcile(owedPr());
    expect(current.dispatch).toEqual([]);
    expect(current.refusals).toEqual([expect.objectContaining({ kind: 'owed-main-rule' })]);
    expect(reconcile(owedPr({ owedMainRule: { head: 'old', owed: true } })).dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal' })]);
  });
  // PR #5082 red team: the hold proves only the `test` job; any other failing required check keeps ci-heal.
  const otherRed = { name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'FAILURE' };
  it.each([
    { name: 'a second required check', requiredChecks: ['test', 'soak-replay-gate'], extra: [otherRed] },
    { name: 'a check under the default required set', requiredChecks: null, extra: [{ ...otherRed, name: 'smoke' }], other: 'smoke' },
    { name: 'a red check listed before test', requiredChecks: ['soak-replay-gate', 'test'], extra: [otherRed], first: true },
  ])('keeps ci-heal when $name also fails', ({ requiredChecks, extra, first, other = 'soak-replay-gate' }) => {
    const rollup = first ? [...extra, ...pr().statusCheckRollup] : [...pr().statusCheckRollup, ...extra];
    const result = planReconcile({ prs: [owedPr({ statusCheckRollup: rollup })], agents: [], durableCounts: {}, requiredChecks, now: Date.parse('2026-10-12T23:00:00Z') });
    expect(result.refusals.some(r => r.kind === 'owed-main-rule')).toBe(false);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', failingRequiredChecks: expect.arrayContaining(['test', other]), owedMainRule: { check: 'test', nums: [5994] } })]);
    // The healer's brief carries the hold, and the probation worker (which drops the brief) is not used.
    const brief = withOwedMainRuleSection('BASE', { owedMainRule: result.dispatch[0].owedMainRule });
    expect(brief).toMatch(/^BASE\n\n## Leave the drain-assigned card numbers alone/);
    expect(brief).toContain('#5994');
    expect(brief).toMatch(/Do NOT rename, renumber or re-key/);
  });
  it('carries no hold into a ci-heal that has no proven drain-number failure', () => {
    const rollup = [...pr().statusCheckRollup, otherRed];
    const result = planReconcile({ prs: [pr({ statusCheckRollup: rollup })], agents: [], durableCounts: {}, requiredChecks: ['test', 'soak-replay-gate'], now: Date.parse('2026-10-12T23:00:00Z') });
    expect(result.dispatch[0]).not.toHaveProperty('owedMainRule');
    expect(withOwedMainRuleSection('BASE', {})).toBe('BASE');
  });
  // Self-review variant: a superseded red `test` run must not prove a hold over the latest run.
  const run = (id, conclusion) => ({ __typename: 'CheckRun', id, name: 'test', status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/web-everything/web-everything/actions/runs/1/job/${id}` });
  it.each([
    { name: 'newer red run, older listed first', rollup: [run(111, 'FAILURE'), run(222, 'FAILURE')], job: '222' },
    { name: 'newer red run, newer listed first', rollup: [run(222, 'FAILURE'), run(111, 'FAILURE')], job: '222' },
    { name: 'latest run timed out', rollup: [run(111, 'FAILURE'), run(222, 'TIMED_OUT')], job: null },
    { name: 'latest run green', rollup: [run(111, 'FAILURE'), run(222, 'SUCCESS')], job: null },
  ])('proves the hold from the latest test run only: $name', ({ rollup, job }) => temporary(root => {
    const calls = [];
    const exec = (_command, args) => { calls.push(args[1]); throw new Error('stop after the log path'); };
    readOwedMainRule(pr({ statusCheckRollup: rollup }), { slug: 'web-everything/web-everything', exec, cache: join(root, 'state.json'), authors });
    expect(calls).toEqual(job ? [`repos/web-everything/web-everything/actions/jobs/${job}/logs`] : []);
    const rows = [pr({ statusCheckRollup: rollup })];
    enrichPrsWithOwedMainRule(rows, { repo: 'web-everything/web-everything', settings, mainAccepts: () => false, read: () => ({ owed: true, nums: [5994] }) });
    expect(rows[0].owedMainRule === undefined).toBe(!job);
  }));
  it('still holds when only test fails, and a non-required red does not lift the hold', () => {
    const nonRequired = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE' };
    const rerun = { ...pr().statusCheckRollup[0] };
    for (const rollup of [[...pr().statusCheckRollup, rerun], [...pr().statusCheckRollup, nonRequired]]) {
      const result = planReconcile({ prs: [owedPr({ statusCheckRollup: rollup })], agents: [], durableCounts: {}, requiredChecks: ['test'], now: Date.parse('2026-10-12T23:00:00Z') });
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'owed-main-rule' })]);
    }
  });
  // Red-team break on 97f4877fd: the drain enforces CodeQL though branch protection does not require it.
  const codeqlRed = { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' };
  const codeqlFailure = { checkRunId: 7, headSha: 'abc123', alerts: [{ rule: 'js/sql-injection', path: 'scripts/x.mjs', line: 3, message: 'new alert' }] };
  const reconcileCodeql = (over = {}) => planReconcile({ prs: [owedPr({ statusCheckRollup: [...pr().statusCheckRollup, codeqlRed], codeqlFailure, ...over })], agents: [], durableCounts: {}, requiredChecks: ['test'], now: Date.parse('2026-10-12T23:00:00Z') });
  it('keeps the CodeQL ci-heal the drain enforces, told to leave the drain numbers alone', () => {
    const result = reconcileCodeql();
    expect(result.refusals.some(r => r.kind === 'owed-main-rule')).toBe(false);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', reason: 'codeql', codeql: codeqlFailure, owedMainRule: { check: 'test', nums: [5994] } })]);
    expect(result.dispatch[0].why).toMatch(/must be left alone/);
  });
  it('keeps the CodeQL heal under its own escalation and cap', () => {
    const author = { login: 'web-everything' };
    const escalated = reconcileCodeql({ comments: [{ body: buildCiHealEscalationComment({ headSha: 'abc123', outcome: 'needs-human', reason: 'cannot fix' }), author }] });
    expect(escalated.dispatch).toEqual([]);
    expect(escalated.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated' })]);
    const spent = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'codeql' }), author }));
    const capped = reconcileCodeql({ comments: spent });
    expect(capped.dispatch).toEqual([]);
    expect(capped.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted' })]);
  });
});

describe('conflict refresh IO boundaries', () => {
  const conflict = paths => `abcdef\n${paths.map(p => `100644 abcdef 2\t${p}`).join('\n')}\n\nCONFLICT\n`;
  it('fetches stale lane refs in one batch and refreshes only same-repo evidence-only heads', () => temporary(async root => {
    let fetched = false;
    const rows = [pr({ statusCheckRollup: [], isDraft: true }), pr({ number: 5051, headRefName: 'lane/second', statusCheckRollup: [] }), pr({ number: 5052, headRefName: 'lane/fork', isCrossRepository: true, statusCheckRollup: [] })];
    const run = vi.fn((_cmd, args) => {
      if (args[0] === 'fetch' && args.some(a => a.includes('lane/'))) fetched = true;
      if (args[0] === 'rev-parse') return { status: 0, stdout: fetched ? 'abc123' : 'old' };
      if (args[0] === 'merge-tree') return { status: 1, stdout: conflict(args.at(-1) === 'origin/lane/second' ? ['.fix-evidence.md', 'src/real.js'] : ['.fix-4958-evidence.md']) };
      return { status: 0, stdout: '' };
    });
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const exec = vi.fn(() => { throw new Error('unexpected GitHub read'); });
    const result = await runRenamedPrRefresh({ prs: rows, slug: 'web-everything/web-everything', root, settings, exec, run, refresh, mainAccepts: () => false, statePath: join(root, 'state.json'), log() {} });
    expect(exec).not.toHaveBeenCalled();
    expect(run.mock.calls.filter(([, args]) => args[0] === 'fetch').map(([, args]) => args)).toEqual([
      ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['fetch', '--quiet', 'origin', '+refs/heads/lane/example:refs/remotes/origin/lane/example', '+refs/heads/lane/second:refs/remotes/origin/lane/second'],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1); expect(result.evidenceOnly).toEqual([5050]); expect(result.errors).toEqual([]);
  }));
  it('does not refresh or stamp dry runs, and failed refreshes can retry', () => temporary(async root => {
    const refresh = vi.fn().mockReturnValueOnce({ ok: false, error: 'not yet supported' }).mockResolvedValue({ ok: true, action: 'rebased' });
    const run = (_cmd, args) => ({ status: args[0] === 'merge-tree' ? 1 : 0, stdout: args[0] === 'rev-parse' ? 'abc123' : conflict(['.fix-evidence.md']) });
    const opts = { prs: [pr({ statusCheckRollup: [] })], root, settings, run, refresh, mainAccepts: () => false, statePath: join(root, 'state.json'), log() {} };
    expect((await runRenamedPrRefresh({ ...opts, dryRun: true })).refreshed).toEqual([]); expect(refresh).not.toHaveBeenCalled();
    expect((await runRenamedPrRefresh(opts)).errors).toEqual([{ num: 5050, reason: 'not yet supported' }]);
    expect((await runRenamedPrRefresh(opts)).refreshed).toHaveLength(1);
    expect((await runRenamedPrRefresh(opts)).refreshed).toEqual([]); expect(refresh).toHaveBeenCalledTimes(2);
  }));
  it('never guesses from failed probes or a head that moved during fetch', () => temporary(async root => {
    const refresh = vi.fn();
    const result = await runRenamedPrRefresh({ prs: [pr({ statusCheckRollup: [] })], root, settings,
      run: (_cmd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'moved' : '' }), refresh,
      mainAccepts: () => true, statePath: join(root, 'state.json'), log() {} });
    expect(refresh).not.toHaveBeenCalled(); expect(result.errors[0].reason).toContain('head moved');
  }));
});
