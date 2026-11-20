import { readRequiredStatusChecksDetailed } from '../required-status-checks.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshStaleBlockedGates, unlandableStateReason } from '../../merge-ai-prs.mjs';
import { planStaleGateUpdateBranch as plan, updateStaleGateBranches as run, resolveStaleGateUpdateBranchMax as setting, readStaleGateUpdateBranchMax, readStaleGateRequiredAppId } from '../stale-gate-update-branch.mjs';

const CHECK_APP = 1, CLASSIC_APP = 42;
const head = 'a'.repeat(40), repo = 'example/widgets';
const gate = { id: 10, name: 'merge-gate', head_sha: head, status: 'completed', conclusion: 'failure', app: { id: CHECK_APP } };
const pr = () => ({ number: 1, headRefOid: head, baseRefName: 'main', isCrossRepository: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED',
  labels: ['ready-to-merge', 'review:accepted', 'red-team:clear'].map(name => ({ name })),
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
const input = () => ({ pr: pr(), head, defaultBranch: 'main', checkRuns: [gate, { ...testRun }],
  requiredAppId: CHECK_APP, fixClaimHeld: false });
const testRun = { id: 20, name: 'test', head_sha: head, app: { id: 1 }, status: 'completed', conclusion: 'success' };
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extra = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stale-gate-')); roots.push(stateRoot);
  const gh = vi.fn((_bin, args) => args[0] === 'pr' ? JSON.stringify({ ...pr(), number: Number(args[2]) })
    : args[1] === '-X' ? '{}' : JSON.stringify({ total_count: 2, check_runs: [gate, testRun] }));
  return { candidates: [{ repo, num: 1, head }], defaultBranchOf: () => 'main', requiredAppIdOf: () => CHECK_APP,
    fixClaimHeld: () => false, humanSurfaceGuardAllows: () => true, stateRoot, gh, log: vi.fn(), ...extra };
}

describe('stale gate planner — fail closed', () => {
  it('accepts the eligible current head', () => expect(plan(input())).toEqual({ head }));
  it.each(['ready-to-merge', 'review:accepted', 'red-team:clear'])('refuses missing label %s', label => {
    const x = input(); x.pr.labels = x.pr.labels.filter(l => l.name !== label); expect(plan(x)).toBeNull();
  });
  it.each(['review:pending', 'review:changes', 'review:human', 'review:held-mechanical'])('refuses hold %s', name => {
    const x = input(); x.pr.labels.push({ name }); expect(plan(x)).toBeNull();
  });
  it.each([{ conclusion: 'success' }, { status: 'in_progress' }, { head_sha: 'b'.repeat(40) }, { id: undefined }])('refuses newest gate %j', change => {
    const x = input(); x.checkRuns.push({ ...gate, id: 11, ...change }); expect(plan(x)).toBeNull();
  });
  it.each([
    ['stale head', x => { x.pr.headRefOid = 'b'.repeat(40); }],
    ['fork', x => { x.pr.isCrossRepository = true; }],
    ['unknown fork', x => { delete x.pr.isCrossRepository; }],
    ['wrong base', x => { x.pr.baseRefName = 'release'; }],
    ['unknown default', x => { x.defaultBranch = null; }],
    ['malformed default branch', x => { x.defaultBranch = 1; x.pr.baseRefName = 1; }],
    ['malformed head', x => { x.head = [head]; x.pr.headRefOid = x.head; }],
    ['conflict', x => { x.pr.mergeable = 'CONFLICTING'; }],
    ['unknown mergeability', x => { x.pr.mergeable = 'UNKNOWN'; }],
    ['other merge state', x => { x.pr.mergeStateStatus = 'BEHIND'; }],
    ['live claim', x => { x.fixClaimHeld = true; }],
    ['unknown claim', x => { delete x.fixClaimHeld; }],
    ['attempted head', x => { x.attempted = true; }],
    ['unreadable labels', x => { x.pr.labels = null; }],
    ['unreadable gate', x => { x.checkRuns = null; }],
    ['missing gate', x => { x.checkRuns = []; }],
  ])('refuses %s', (_name, change) => { const x = input(); change(x); expect(plan(x)).toBeNull(); });
});

describe('stale gate app and review evidence', () => {
  it.each(['success', null, 'in_progress'])('ignores another app newer failure when required gate is %j', state => {
    const x = input();
    x.checkRuns = [ ...(state === null ? [] : [{ ...gate, status: state === 'in_progress' ? state : 'completed', conclusion: state }]),
      { ...gate, id: 99, app: { id: 2 } } ];
    expect(plan(x)).toBeNull();
  });
  it('ignores another app newer success when the required app failed', () => {
    const x = input(); x.checkRuns.push({ ...gate, id: 99, app: { id: 2 }, conclusion: 'success' });
    expect(plan(x)).toEqual({ head });
  });
  it.each([undefined, null, {}, { id: 2 }])('no required-app run %j skips', app => {
    const x = input(); x.checkRuns = [{ ...gate, app }]; expect(plan(x)).toBeNull();
  });
  it.each([undefined, null, -1, 0, '1', {}])('unreadable required app id %j skips', requiredAppId => {
    expect(plan({ ...input(), requiredAppId })).toBeNull();
  });
  it('other required check evidence does not affect eligibility', () => {
    const x = input(); x.checkRuns = [gate];
    x.pr.statusCheckRollup = [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }];
    expect(plan(x)).toEqual({ head });
  });
  it.each(['CHANGES_REQUESTED', 'REVIEW_REQUIRED', undefined, {}])('fresh review %j refuses writes', reviewDecision => {
    const x = fixture(); const read = x.gh.getMockImplementation();
    x.gh.mockImplementation((bin, args) => args[0] === 'pr'
      ? JSON.stringify({ ...pr(), reviewDecision }) : read(bin, args));
    run(x); expect(x.gh.mock.calls.some(c => c[1][1] === '-X')).toBe(false);
  });
  it('fresh read explicitly requests reviewDecision', () => {
    const x = fixture(); run(x);
    expect(x.gh.mock.calls[0][1].at(-1).split(',')).toContain('reviewDecision');
  });
  it.each([null, '', 'APPROVED'])('allows known review decision %j', reviewDecision => {
    const x = input(); x.pr.reviewDecision = reviewDecision; expect(plan(x)).toEqual({ head });
  });
});

describe('stale gate IO', () => {
  it('drain hook only repairs exact BLOCKED skip verdicts and leaves decisions unchanged', () => {
    const x = fixture();
    const base = { repo, num: 1, headSha: head, decision: 'skip', reason: unlandableStateReason('BLOCKED') };
    const verdicts = [base, { ...base, num: 2, decision: 'merge' }, { ...base, num: 3, reason: unlandableStateReason('BEHIND') },
      { ...base, num: 4, reason: `${base.reason} extra hold` }];
    const before = structuredClone(verdicts);
    expect(refreshStaleBlockedGates(verdicts, x)).toHaveLength(1);
    expect(x.gh.mock.calls.filter(c => c[1][1] === '-X')).toHaveLength(1);
    expect(verdicts).toEqual(before);
  });
  it('bounds oversized candidate scans and names the operator fallback', () => {
    const x = fixture({ candidates: Array.from({ length: 101 }, (_, i) => ({ repo, num: i + 1, head })), fixClaimHeld: () => true });
    expect(run(x)).toEqual([]); expect(x.gh).toHaveBeenCalledTimes(200);
    expect(x.log.mock.calls[0][0]).toContain('update branches manually');
  });
  it('uses exact pinned PUT argv and bounded throttled IO options', () => {
    const x = fixture(); expect(run(x)).toHaveLength(1);
    expect(x.gh.mock.calls.at(-1)).toEqual(['gh', ['api', '-X', 'PUT', `repos/${repo}/pulls/1/update-branch`, '-f', `expected_head_sha=${head}`],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }]);
    expect(x.log).toHaveBeenCalledTimes(1);
    const calls = x.gh.mock.calls.length; expect(run(x)).toEqual([]); expect(x.gh).toHaveBeenCalledTimes(calls);
  });
  it('caps a pass at two attempts; zero disables without reading', () => {
    const x = fixture({ candidates: [1, 2, 3, 4].map(num => ({ repo, num, head })) });
    expect(run({ ...x, max: 0 })).toEqual([]); expect(x.gh).not.toHaveBeenCalled();
    expect(run(x)).toHaveLength(2); expect(x.gh.mock.calls.filter(c => c[1][1] === '-X')).toHaveLength(2);
  });
  it('422 is a logged skip, never throws, persists reservation and continues the pass', () => {
    const x = fixture({ candidates: [1, 2].map(num => ({ repo, num, head })) });
    const read = x.gh.getMockImplementation(); x.gh.mockImplementation((...args) => {
      if (args[1][1] === '-X') throw new Error('422\nmerge conflict\u001b'); return read(...args);
    });
    expect(() => run(x)).not.toThrow(); expect(x.log).toHaveBeenCalledTimes(2);
    expect(x.log.mock.calls[0][0]).toContain('stale-gate-update-branch failed:');
    expect(x.log.mock.calls[0][0]).not.toMatch(/[\n\u001b]/);
    expect(run(x)).toEqual([]);
  });
  it.each(['broken', 'oversized'])('unreadable %s state blocks writes with operator fallback', kind => {
    const x = fixture(); run(x); const path = join(x.stateRoot, readdirSync(x.stateRoot)[0]);
    writeFileSync(path, kind === 'broken' ? '{' : 'x'.repeat(4097)); x.gh.mockClear();
    expect(run(x)[0].ok).toBe(false); expect(x.gh).not.toHaveBeenCalled();
    expect(x.log.mock.calls.at(-1)[0]).toContain('inspect and update branch manually');
  });
  it('unknown live claim store prevents writes', () => {
    const x = fixture({ fixClaimHeld: () => { throw new Error('unreadable'); } });
    run(x); expect(x.gh.mock.calls.some(c => c[1][1] === '-X')).toBe(false);
  });
  it.each([
    ['denied', () => false],
    ['unknown', () => undefined],
    ['missing', undefined],
    ['unreadable', () => { throw new Error('approval proof unreadable'); }],
  ])('human-surface guard %s prevents PUT and leaves the head unattempted', (_name, guard) => {
    const humanSurfaceGuardAllows = guard && vi.fn(guard);
    const x = fixture({ humanSurfaceGuardAllows });
    expect(run(x)).toMatchObject([{ ok: false, attempted: false }]);
    if (guard) expect(humanSurfaceGuardAllows).toHaveBeenCalledWith(repo, 1, head);
    expect(x.gh.mock.calls.some(c => c[1][1] === '-X')).toBe(false);
    expect(readdirSync(x.stateRoot)).toEqual([]);
    expect(x.log.mock.calls.at(-1)[0]).toMatch(/approval proof (unknown|unreadable)/);
    expect(x.log.mock.calls.at(-1)[0]).toContain('skipped; inspect and update branch manually');
    expect(run({ ...x, humanSurfaceGuardAllows: () => true })).toMatchObject([{ ok: true }]);
  });
  it('claim acquired just before reservation prevents writes', () => {
    const x = fixture({ fixClaimHeld: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) });
    expect(run(x)).toEqual([]); expect(readdirSync(x.stateRoot)).toEqual([]);
  });
  it.each(['offline', 'oversized', 'incomplete', 'stale-head', 'fork'])('refuses %s fresh evidence', kind => {
    const x = fixture(); const read = x.gh.getMockImplementation();
    x.gh.mockImplementation((bin, args) => {
      if (kind === 'offline') throw new Error('offline');
      if (args[0] === 'pr') return JSON.stringify({ ...pr(), ...(kind === 'stale-head' ? { headRefOid: 'b'.repeat(40) }
        : kind === 'fork' ? { isCrossRepository: true } : {}) });
      if (args[1] !== '-X') return JSON.stringify({ total_count: kind === 'oversized' ? 101 : 2, check_runs: kind === 'oversized' ? Array(101).fill(gate) : [gate] });
      return read(bin, args);
    });
    run(x); expect(x.gh.mock.calls.some(c => c[1][1] === '-X')).toBe(false);
    if (kind === 'oversized') expect(x.log.mock.calls.at(-1)[0]).toContain('inspect and update branch manually');
  });
  it('allows the next changed head while retaining old attempted heads', () => {
    const x = fixture(); run(x); const next = 'b'.repeat(40);
    x.candidates[0].head = next;
    x.gh.mockImplementation((_bin, args) => JSON.stringify(args[0] === 'pr' ? { ...pr(), headRefOid: next }
      : { total_count: 2, check_runs: [{ ...gate, head_sha: next }, { ...testRun, head_sha: next }] }));
    expect(run(x)[0].ok).toBe(true); expect(readdirSync(x.stateRoot)).toHaveLength(2);
  });
});

describe('setting cascade', () => {
  it('unreadable tool or platform settings disable repairs with operator fallback', () => {
    for (const [taint, errors] of [[['offline'], []], [[], ['offline']]]) {
      expect(readStaleGateUpdateBranchMax({ env: {}, readTool: () => ({ value: 2, taint }),
        readPlatform: () => ({ prefs: {}, errors }) })).toMatchObject({ value: 0, source: expect.stringContaining('manually') });
    }
  });
  it('defaults to two, resolves each layer and records provenance', () => {
    expect(setting()).toEqual({ value: 2, source: 'standard' });
    expect(setting({ platform: { staleGateUpdateBranchMax: 3 } })).toEqual({ value: 3, source: 'platform' });
    expect(setting({ platform: { staleGateUpdateBranchMax: 3 }, tool: { staleGateUpdateBranchMax: 1 } })).toEqual({ value: 1, source: 'tool' });
    expect(setting({ tool: { staleGateUpdateBranchMax: 1 }, env: { WE_DRAIN_STALE_GATE_UPDATE_BRANCH_MAX: '0' } })).toEqual({ value: 0, source: 'env' });
  });
  it.each([null, {}, -1, 101, 'unknown', 1.5])('invalid/oversized setting %s disables with operator fallback', value => {
    expect(setting({ tool: { staleGateUpdateBranchMax: value } })).toMatchObject({ value: 0, source: expect.stringContaining('manually') });
  });
});

describe('live required merge-gate app identity', () => {
  it.each(['ruleset', 'classic'])('reads the required gate app id from %s', source => {
    const gh = argv => argv.at(-1).includes('/rules/')
      ? JSON.stringify([[{ type: 'required_status_checks', parameters: { required_status_checks:
        source === 'ruleset' ? [{ context: 'merge-gate', integration_id: CHECK_APP }] : [] } }]])
      : JSON.stringify({ protected: true, protection: { required_status_checks: { contexts: ['test'], checks:
        source === 'classic' ? [{ context: 'merge-gate', app_id: CLASSIC_APP }] : [] } } });
    expect(readStaleGateRequiredAppId({ repo, branch: 'main',
      readRequired: args => readRequiredStatusChecksDetailed({ ...args, gh }) }))
      .toBe(source === 'ruleset' ? CHECK_APP : CLASSIC_APP);
  });
  it.each([null, {}, { requiredCheckApps: [] }, { requiredCheckApps: [{ context: 'test', appId: CHECK_APP }] },
    ...[undefined, null, -1, '1'].map(appId => ({ requiredCheckApps: [{ context: 'merge-gate', appId }] })),
    { requiredCheckApps: [{ context: 'merge-gate', appId: CHECK_APP }, { context: 'merge-gate', appId: CLASSIC_APP }] },
  ])('refuses missing, unreadable or ambiguous identity %j', result => {
    expect(readStaleGateRequiredAppId({ repo, branch: 'main', readRequired: () => result })).toBeNull();
  });
  it('refuses unreadable branch policy', () => {
    expect(readStaleGateRequiredAppId({ repo, branch: 'main', readRequired: () => { throw new Error('offline'); } })).toBeNull();
  });
  it('unreadable required app id prevents writes', () => {
    const x = fixture({ requiredAppIdOf: () => null }); run(x); expect(x.gh).not.toHaveBeenCalled();
  });
});
