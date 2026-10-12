import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequiredStatusChecks, defaultReadRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { classifyPr, revalidateForMerge, buildDrainVerdicts, prepareDrainVerdicts, unlandableStateReason } from '../merge-ai-prs.mjs';
import * as strategy from '../lib/drain-merge-strategy.mjs';

const required = ['test', 'smoke'];
const green = name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const pr = (extra = {}) => ({ number: 42, title: 'Fix queue admission', body: 'Allow checked PRs into the required queue.', headRefOid: 'abc', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', labels: [{ name: 'ready-to-merge' }], reviewDecision: '', statusCheckRollup: required.map(green), ...extra });
const opts = { queueRequiredChecks: required };

describe('required merge queue BLOCKED relief', () => {
  it.each(['', null, 'APPROVED'])('admits green uppercase CheckRuns with reviewDecision %s', reviewDecision => {
    expect(classifyPr(pr({ reviewDecision }), opts)).toMatchObject({ decision: 'merge', queueBlockedRelief: true, reason: expect.stringMatching(/BLOCKED only by the required merge queue.*all 2 required checks green.*enqueue/) });
  });
  it.each([
    ['pending', { ...green('smoke'), status: 'IN_PROGRESS', conclusion: null }],
    ['failure', { ...green('smoke'), conclusion: 'FAILURE' }],
    ['missing', null],
  ])('refuses a %s required check and names it', (reason, row) => {
    expect(classifyPr(pr({ statusCheckRollup: [green('test'), ...(row ? [row] : [])] }), opts)).toMatchObject({ decision: 'skip', reason: expect.stringContaining(`smoke (${reason})`) });
  });
  it.each(['CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'changes_requested'])('refuses reviewDecision %s', reviewDecision => {
    expect(classifyPr(pr({ reviewDecision }), opts)).toMatchObject({ decision: 'skip', reason: expect.stringContaining(reviewDecision.toUpperCase()) });
  });
  it.each([null, []])('preserves direct-mode verdict with %s', queueRequiredChecks => {
    const verdict = classifyPr(pr(), { queueRequiredChecks });
    expect(verdict).toEqual(classifyPr(pr()));
    expect(verdict.reason).toBe(unlandableStateReason('BLOCKED'));
    expect(verdict).not.toHaveProperty('queueBlockedRelief');
  });
  it('leaves CLEAN unchanged and refuses DIRTY/BEHIND', () => {
    expect(classifyPr(pr({ mergeStateStatus: 'CLEAN' }), opts)).toEqual(classifyPr(pr({ mergeStateStatus: 'CLEAN' })));
    for (const mergeStateStatus of ['DIRTY', 'BEHIND']) expect(classifyPr(pr({ mergeStateStatus }), opts).decision).toBe('skip');
  });
  it('retains earlier and later safety gates', () => {
    for (const extra of [{ fixClaim: { who: 'fixer' } }, { mergeable: 'CONFLICTING' }, { body: '' }, { labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }] }]) {
      expect(classifyPr(pr(extra), opts).decision).toBe('skip');
      expect(classifyPr(pr(extra), opts)).not.toHaveProperty('queueBlockedRelief');
    }
  });
  it('never lets a green aggregate stand in for a required check with no row of its own', () => {
    const verdict = classifyPr(pr({ statusCheckRollup: [green('test')] }), { queueRequiredChecks: ['test', 'integration'] });
    expect(verdict).toMatchObject({ decision: 'skip', reason: expect.stringContaining('integration (missing)') });
    expect(verdict).not.toHaveProperty('queueBlockedRelief');
  });
  it('accepts legacy StatusContext rows', () => {
    expect(classifyPr(pr({ statusCheckRollup: [green('test'), { __typename: 'StatusContext', context: 'smoke', state: 'SUCCESS' }] }), opts).decision).toBe('merge');
  });
  it('uses the latest CheckRun per name', () => {
    const old = { ...green('smoke'), conclusion: 'FAILURE', completedAt: '2026-10-11T00:00:00Z' };
    const latest = { ...green('smoke'), completedAt: '2026-10-12T00:00:00Z' };
    expect(classifyPr(pr({ statusCheckRollup: [green('test'), latest, old] }), opts).decision).toBe('merge');
    expect(classifyPr(pr({ statusCheckRollup: [green('test'), { ...latest, conclusion: 'FAILURE' }, { ...old, conclusion: 'SUCCESS' }] }), opts).decision).toBe('skip');
  });
  it('threads relief into fresh revalidation while retaining the head pin', () => {
    expect(revalidateForMerge(pr(), { ...opts, expectedHeadSha: 'abc' })).toMatchObject({ decision: 'merge', queueBlockedRelief: true, headSha: 'abc' });
    expect(revalidateForMerge(pr(), { ...opts, expectedHeadSha: 'old' }).decision).toBe('skip');
  });
  it('reads requirements per repo when building verdicts', () => {
    const queueRequiredChecksOf = vi.fn(repo => repo === 'owner/local' ? required : null);
    const verdicts = buildDrainVerdicts({ prsByRepo: new Map([['owner/local', [pr()]], ['owner/sibling', [pr()]]]), repos: ['owner/local', 'owner/sibling'], queueRequiredChecksOf });
    expect(verdicts.map(v => v.decision)).toEqual(['merge', 'skip']);
    expect(queueRequiredChecksOf.mock.calls).toEqual([['owner/local'], ['owner/sibling']]);
  });
  it('threads requirements through preparation', () => {
    const result = prepareDrainVerdicts({ listings: [{ repo: 'owner/local', prs: [pr()] }], repos: ['owner/local'], queueRequiredChecksOf: () => required });
    expect(result.verdicts[0]).toMatchObject({ decision: 'merge', queueBlockedRelief: true });
  });
});

describe('readQueueRequiredChecks', () => {
  const readOf = (checks, source) => vi.fn(() => ({ checks, source }));
  const read = (readRequired, extra = {}) => strategy.readQueueRequiredChecks({ repo: 'owner/repo', branch: 'release', readRequired, ...extra });
  it.each(['cache', 'declared', 'unavailable', 'fallback', 'stale-cache', undefined])('refuses non-live source %s (it may miss a ruleset check)', source => {
    expect(read(readOf(['test', 'smoke'], source))).toBeNull();
  });
  it.each([undefined, null, '', '   '])('requires an explicit resolved branch: %j', branch => {
    const readRequired = readOf(['test'], 'live');
    expect(read(readRequired, { branch })).toBeNull();
    expect(readRequired).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', '   ', 42, {}])('returns null without reading checks for missing or invalid repo: %j', repo => {
    const readRequired = readOf(['test'], 'live');
    expect(read(readRequired, { repo })).toBeNull();
    expect(readRequired).not.toHaveBeenCalled();
  });
  it('returns the sorted, de-duplicated set from a forced live read', () => {
    const readRequired = readOf(['test', 'smoke', 'test', 'daemon-soak'], 'live');
    expect(read(readRequired)).toEqual(['daemon-soak', 'smoke', 'test']);
    expect(readRequired).toHaveBeenCalledWith({ repo: 'owner/repo', branch: 'release', ttlMs: 0 });
  });
  it.each([[null], [{}], [{ checks: 'test', source: 'live' }], [{ checks: [], source: 'live' }], [{ checks: ['test', ''], source: 'live' }], [{ checks: ['test', 7], source: 'live' }]])('fails closed on a malformed read: %j', result => {
    expect(read(() => result)).toBeNull();
  });
  it('fails closed when the shared reader throws', () => {
    expect(read(() => { throw new Error('denied'); })).toBeNull();
  });
  it('issues no rules read of its own: the shared reader is the only GitHub IO', () => {
    expect(readFileSync('scripts/lib/drain-merge-strategy.mjs', 'utf8')).not.toMatch(/rules\/branches/);
    expect(String(strategy.readQueueRequiredChecks)).not.toMatch(/\bexec\b/);
  });
  describe('through the real shared reader', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-required-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'pull_request', parameters: { i } }));
    const pagedGh = () => vi.fn(args => args.includes('--paginate')
      ? JSON.stringify([filler, [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'smoke' }] } }]])
      : JSON.stringify({ protected: true, protection: { enabled: true, required_status_checks: { contexts: ['test'] } } }));
    const shared = (cachePath, gh) => o => getRequiredStatusChecks({ ...o, cachePath, readChecks: a => defaultReadRequiredStatusChecks({ ...a, gh }) });
    // A partial entry an older reader wrote (first rules page only, or classic only), stamped `live`.
    const legacyCache = fetchedAtMs => {
      const cachePath = join(dir, 'cache.json');
      writeFileSync(cachePath, JSON.stringify({ entries: { 'owner/repo@release': { checks: ['test'], source: 'live', fetchedAtMs } } }));
      return cachePath;
    };
    it('keeps a ruleset check that GitHub returns on a later page', () => {
      const gh = pagedGh();
      expect(read(shared(join(dir, 'cache.json'), gh))).toEqual(['smoke', 'test']);
      expect(gh.mock.calls[0][0]).toEqual(['api', '--paginate', '--slurp', 'repos/owner/repo/rules/branches/release?per_page=100']);
    });
    it('re-reads live past a fresh partial cache entry instead of trusting it', () => {
      const gh = pagedGh();
      expect(read(shared(legacyCache(Date.now() - 1_000), gh))).toEqual(['smoke', 'test']);
      expect(gh).toHaveBeenCalled();
    });
    it('grants no relief from a future-dated cache entry', () => {
      expect(read(shared(legacyCache(Date.now() + 3_600_000), pagedGh()))).toBeNull();
    });
  });
});

describe('production queue requirements wiring', () => {
  const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
  it('reads queue requirements for the resolved default branch', () => {
    const readChecks = vi.fn(({ repo, branch }) => strategy.readQueueRequiredChecks({
      repo, branch, readRequired: () => ({ checks: ['test', 'smoke'], source: 'live' }),
    }));
    const defaultBranchOf = vi.fn(() => 'release');
    const queueRequiredChecksOf = strategy.createQueueRequiredChecksOf({ queueEnqueueMode: true, isLocalRepo: () => true, localSlug: 'owner/local', defaultBranchOf, readChecks });
    const result = prepareDrainVerdicts({ listings: [{ repo: null, prs: [pr({ baseRefName: 'release' })] }], repos: [null], defaultBranchOf, queueRequiredChecksOf });
    expect(result.verdicts[0]).toMatchObject({ decision: 'merge', queueBlockedRelief: true });
    expect(readChecks).toHaveBeenCalledWith({ repo: 'owner/local', branch: 'release' });
    queueRequiredChecksOf(null);
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(source).toMatch(/const queueRequiredChecksOf = createQueueRequiredChecksOf\(\{\s*queueEnqueueMode, isLocalRepo, localSlug, defaultBranchOf,/);
  });
  it.each([[false, true, 'release'], [true, false, 'release'], [true, true, null]])('refuses relief for mode=%s local=%s branch=%s', (queueEnqueueMode, local, branch) => {
    const readChecks = vi.fn(() => required);
    const checksOf = strategy.createQueueRequiredChecksOf({ queueEnqueueMode, isLocalRepo: () => local, localSlug: 'owner/local', defaultBranchOf: () => branch, readChecks });
    expect(checksOf('owner/local')).toBeNull();
    expect(readChecks).not.toHaveBeenCalled();
  });
  it('refuses unresolved slugs and caches failures only for the same branch', () => {
    const readChecks = vi.fn(() => null);
    let branch = 'release';
    const args = { queueEnqueueMode: true, isLocalRepo: () => true, defaultBranchOf: () => branch, readChecks };
    expect(strategy.createQueueRequiredChecksOf(args)(null)).toBeNull();
    expect(readChecks).not.toHaveBeenCalled();
    const checksOf = strategy.createQueueRequiredChecksOf({ ...args, localSlug: 'owner/local' });
    expect(checksOf(null)).toBeNull();
    expect(checksOf('owner/local')).toBeNull();
    expect(readChecks).toHaveBeenCalledTimes(1);
    branch = 'next';
    expect(checksOf(null)).toBeNull();
    expect(readChecks).toHaveBeenLastCalledWith({ repo: 'owner/local', branch: 'next' });
    expect(readChecks).toHaveBeenCalledTimes(2);
  });
  it('threads requirements through every fresh revalidation call', () => {
    const calls = [...source.matchAll(/\brevalidateFresh\((\w+)\.repo,\s*\1\.num,\s*\{([\s\S]*?)\}\)/g)];
    expect(calls).toHaveLength(3);
    for (const [, candidate, options] of calls) expect(options).toContain(`queueRequiredChecks: queueRequiredChecksOf(${candidate}.repo)`);
  });
  it('requests reviewDecision in candidate and fresh GitHub fields', () => {
    expect(source.match(/const CANDIDATE_ONLY_FIELDS = '([^']+)'/)[1].split(',')).toContain('reviewDecision');
    const freshRead = source.slice(source.indexOf('const fetchFreshPrForRevalidation ='), source.indexOf('const UNKNOWN_RETRY ='));
    expect(freshRead.match(/'--json',\s*'([^']+)'/)[1].split(',')).toContain('reviewDecision');
  });
});
