import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrestageCache, resolvePrestageSettings, prestageCi, labelSignature, enqueuePrestage, prestageRequiredChecks } from '../drain-prestage.mjs';
import { classifyPr, buildDrainVerdicts, needsManifestStripBeforeMerge, attachLiveFixClaim } from '../../merge-ai-prs.mjs';
import { aiPr } from '../../__tests__/fixtures/merge-ai-prs-fixtures.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const repo = 'owner/repo', head = 'a'.repeat(40);
const pending = () => aiPr({ number: 42, headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false,
  labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }], mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE',
  statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null, head_sha: head }] });
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drain-prestage-')); roots.push(root);
  let clock = 1000;
  const cache = createPrestageCache({ root, now: () => clock });
  const pr = pending();
  cache.put(repo, 42, { headSha: head, labels: labelSignature(pr.labels), body: pr.body, baseRefName: 'main', requiredChecks: ['test'],
    eligible: true, candidate: { num: 42, repo, listedHeadSha: head }, queueAdmission: { allowed: true } });
  const enqueue = vi.fn(() => ({ enqueued: true }));
  const recordLanded = vi.fn();
  const beforeEnqueue = vi.fn();
  const settings = resolvePrestageSettings({ env: {}, tool: {}, platform: {} });
  const readPr = vi.fn(async () => pr);
  const run = () => enqueuePrestage({ cache, repo, num: 42, settings, readPr, enqueue, recordLanded, beforeEnqueue, fixClaimHeld: () => false,
    withLock: fn => ({ ran: true, result: fn() }), ...options });
  return { cache, pr, enqueue, recordLanded, beforeEnqueue, settings, run, readPr, advance: ms => { clock += ms; } };
}
const green = f => { f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head }; };

describe('CI pre-stage', () => {
  it.each([{hasManifest:true}, {coupleCarrier:{num:43}}])('invalidates older unsafe cache entries (%j)', async candidate => {
    const f = fixture();
    const entry = f.cache.get(repo, 42, 30);
    f.cache.put(repo, 42, { ...entry, candidate:{...entry.candidate,...candidate} });
    expect(await f.run()).toEqual({ fallback:true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each(['REQUIRED_WORKFLOWS_UNSATISFIED', 'CONFLICT', 'UNREADABLE'])('drops cached admission and falls back when enqueue throws %s', async code => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head };
    f.enqueue.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it('drops admission after an asynchronously rejected enqueue', async () => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head };
    f.enqueue.mockRejectedValue(new Error('enqueue failed'));
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it('drops admission when the async lock propagates an enqueue refusal', async () => {
    const f = fixture({ withLock: async fn => ({ ran: true, result: await fn() }) });
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head };
    f.enqueue.mockRejectedValue(Object.assign(new Error('required workflows refused'), { code: 'REQUIRED_WORKFLOWS_UNSATISFIED' }));
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it('computes the non-CI verdict while pending, without changing ordinary classification', () => {
    const p = pending();
    expect(classifyPr(p).decision).toBe('skip');
    const verdicts = buildDrainVerdicts({ prsByRepo: new Map([[repo, [p]]]), repos: [repo],
      preparePendingCi: true, isLocalRepo: () => true, queueRequiredChecksOf: () => ['test'], readOf: () => ({ commits: [] }) });
    expect(verdicts[0]).toMatchObject({ decision: 'merge', prestagePendingCi: true, testGreen: false, mergeable: 'MERGEABLE', listedHeadSha: head });
    expect(needsManifestStripBeforeMerge({ ...verdicts[0], hasManifest: true })).toBe(false);
  });
  it('never enqueues a pending head, then green enqueues with one targeted read and no listing', async () => {
    const f = fixture();
    expect(f.cache.get(repo, '42', 30)).toMatchObject({ num: 42, headSha: head });
    expect(await f.run()).toMatchObject({ enqueued: false, reason: 'required checks pending' });
    expect(f.enqueue).not.toHaveBeenCalled();
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head };
    expect(await f.run()).toEqual({ enqueued: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.readPr).toHaveBeenCalledTimes(2);
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each(['head', 'labels', 'body', 'base', 'closed', 'draft'])('%s changed falls back to the full drain', async field => {
    const f = fixture();
    if (field === 'head') f.pr.headRefOid = 'b'.repeat(40);
    if (field === 'labels') f.pr.labels.push({ name: 'review:changes' });
    if (field === 'body') f.pr.body += ' edited';
    if (field === 'base') f.pr.baseRefName = 'lane/base';
    if (field === 'closed') f.pr.state = 'CLOSED';
    if (field === 'draft') f.pr.isDraft = true;
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  // Every non-success GitHub check-run conclusion and failing status-context state, at the enqueue boundary.
  it.each([
    ...['FAILURE', 'CANCELLED', 'TIMED_OUT', 'SKIPPED', 'NEUTRAL', 'STALE', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
      .map(conclusion => ({ name: 'test', status: 'COMPLETED', conclusion, head_sha: head })),
    ...['FAILURE', 'ERROR'].map(state => ({ context: 'test', state })),
  ])('red drops the cache and never enqueues (%j)', async row => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = row;
    expect(await f.run()).toMatchObject({ enqueued: false, reason: 'required checks red' });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordLanded).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each([
    ...['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'].map(status => ({ name: 'test', status, conclusion: null, head_sha: head })),
    ...['PENDING', 'EXPECTED'].map(state => ({ context: 'test', state })),
  ])('pending keeps the cache and never enqueues (%j)', async row => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = row;
    expect(await f.run()).toMatchObject({ enqueued: false, reason: 'required checks pending' });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).not.toBeNull();
  });
  it('a missing required context never authorizes enqueue', async () => {
    const f = fixture();
    f.pr.statusCheckRollup = [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head }];
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  // The full classifier reads these live fields; none of them moves the cache signature (head, labels, body, base).
  it.each([
    ['reviewDecision', 'CHANGES_REQUESTED'], ['reviewDecision', 'REVIEW_REQUIRED'], ['reviewDecision', 'changes_requested'],
    ['mergeable', 'CONFLICTING'], ['mergeable', 'UNKNOWN'], ['mergeable', undefined],
    ['mergeStateStatus', 'DIRTY'], ['mergeStateStatus', 'BEHIND'], ['mergeStateStatus', 'UNKNOWN'], ['mergeStateStatus', 'HAS_HOOKS'],
  ])('a live %s=%s at green time falls back to the full drain', async (field, value) => {
    const f = fixture();
    green(f);
    f.pr[field] = value;
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each([['APPROVED', 'CLEAN'], ['', 'BLOCKED'], [null, 'UNSTABLE']])('reviewDecision=%s with merge state %s still enqueues', async (reviewDecision, mergeStateStatus) => {
    const f = fixture();
    green(f);
    Object.assign(f.pr, { reviewDecision, mergeStateStatus });
    expect(await f.run()).toEqual({ enqueued: true });
  });
  it('a fix claim acquired while waiting for the enqueue lock prevents cached enqueue', async () => {
    let claimed = false;
    const f = fixture({ fixClaimHeld: () => claimed, withLock: fn => { claimed = true; return { ran: true, result: fn() }; } });
    green(f);
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordLanded).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it('runs the pre-landing steps once, after every check and before the enqueue', async () => {
    const f = fixture();
    f.beforeEnqueue.mockImplementation(() => expect(f.enqueue).not.toHaveBeenCalled());
    expect(await f.run()).toMatchObject({ enqueued: false });
    expect(f.beforeEnqueue).not.toHaveBeenCalled();
    green(f);
    expect(await f.run()).toEqual({ enqueued: true });
    expect(f.beforeEnqueue).toHaveBeenCalledTimes(1);
    expect(f.beforeEnqueue).toHaveBeenCalledWith(expect.objectContaining({ num: 42 }), head, expect.objectContaining({ baseRefName: 'main' }));
  });
  it('a throwing pre-landing step drops admission and falls back without enqueuing', async () => {
    const f = fixture();
    green(f);
    f.beforeEnqueue.mockRejectedValue(new Error('gh unreachable'));
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each(['beforeEnqueue', 'fixClaimHeld', 'recordLanded'])('refuses the shortcut when %s is not wired', async hook => {
    const f = fixture({ [hook]: undefined });
    green(f);
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('records the landed ledger facts for the cached candidate after a confirmed enqueue', async () => {
    const f = fixture();
    green(f);
    expect(await f.run()).toEqual({ enqueued: true });
    expect(f.recordLanded).toHaveBeenCalledTimes(1);
    expect(f.recordLanded).toHaveBeenCalledWith(expect.objectContaining({ num: 42, repo }), head);
  });
  it.each([{ enqueued: false, reason: 'batching' }, { fallback: true }])('records no ledger facts without a confirmed enqueue (%j)', async result => {
    const f = fixture();
    green(f);
    f.enqueue.mockReturnValue(result);
    await f.run();
    expect(f.recordLanded).not.toHaveBeenCalled();
  });
  it('a failing ledger write never undoes a confirmed enqueue', async () => {
    const f = fixture();
    green(f);
    f.recordLanded.mockRejectedValue(new Error('ledger unreadable'));
    expect(await f.run()).toEqual({ enqueued: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('rejects a newly failed optional CodeQL check on cached admission', async () => {
    const f = fixture();
    f.pr.statusCheckRollup.push({ name: 'CodeQL', status: 'IN_PROGRESS', conclusion: null });
    expect(await f.run()).toMatchObject({ enqueued: false });
    f.pr.statusCheckRollup[0].status = 'COMPLETED';
    f.pr.statusCheckRollup[0].conclusion = 'SUCCESS';
    f.pr.statusCheckRollup[1] = { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' };
    expect(await f.run()).toMatchObject({ enqueued: false, reason: 'CodeQL check failed' });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it('honors the CodeQL gate setting on cached admission', async () => {
    const f = fixture({ blockOnCodeQL: false });
    f.pr.statusCheckRollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(await f.run()).toEqual({ enqueued: true });
  });
  it.each(['held', 'unreadable'])('rejects cached admission when the live fix claim is %s', async variant => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head };
    attachLiveFixClaim(f.pr, { claimKey: 'we', readClaim: () => {
      if (variant === 'unreadable') throw new Error('claim store unreadable');
      return { meta: { who: 'fix-42' } };
    } });
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
  });
  it.each([{ labels: [] }, { labels: [{ name: 'checking' }] }])('never consumes cached admission without the release label ($labels)', async ({ labels }) => {
    const f = fixture();
    f.pr.labels = [{ name: 'review:accepted' }, ...labels];
    const entry = f.cache.get(repo, 42, 30);
    f.cache.put(repo, 42, { ...entry, labels: labelSignature(f.pr.labels) });
    f.pr.statusCheckRollup[0].conclusion = 'SUCCESS';
    f.pr.statusCheckRollup[0].status = 'COMPLETED';
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('expires at the configured TTL and respects disabling', async () => {
    const f = fixture(); f.advance(30 * 60_000);
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.readPr).not.toHaveBeenCalled();
    f.settings.value.prestageWhileCiRuns = false;
    expect(await f.run()).toEqual({ fallback: true });
  });
  it('logs defaults and independently resolves tool/platform sources', () => {
    const log = vi.fn();
    const r = resolvePrestageSettings({ env: {}, tool: { prestageTtlMin: 12 }, platform: { prestageWhileCiRuns: false }, log });
    expect(r.value).toMatchObject({ prestageWhileCiRuns: false, prestageTtlMin: 12 });
    expect(r.sources).toMatchObject({ prestageWhileCiRuns: 'platform', prestageTtlMin: 'tool' });
    expect(log.mock.calls[0][0]).toContain('prestageTtlMin');
  });
  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT'])('does not prepare %s', conclusion => {
    const p = pending(); p.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion };
    expect(classifyPr(p, { preparePendingCi: true, queueRequiredChecks: ['test'] }).decision).toBe('skip');
  });
  // The drain's own `--check` gates the full drain too, so it must gate preparation and the cached enqueue.
  it.each([
    ['FAILURE', 'skip'], ['CANCELLED', 'skip'], ['SKIPPED', 'skip'], [null, 'skip'],
    ['SUCCESS', 'merge'], ['PENDING', 'merge'],
  ])('preparation honours an explicitly selected check (smoke=%s → %s)', (state, decision) => {
    const p = pending();
    if (state === 'PENDING') p.statusCheckRollup.push({ name: 'smoke', status: 'IN_PROGRESS', conclusion: null, head_sha: head });
    else if (state) p.statusCheckRollup.push({ name: 'smoke', status: 'COMPLETED', conclusion: state, head_sha: head });
    const v = classifyPr(p, { preparePendingCi: true, queueRequiredChecks: ['test'], requiredCheck: 'smoke' });
    expect(v.decision).toBe(decision);
    expect(!!v.prestagePendingCi).toBe(decision === 'merge');
  });
  it('the prepared check set includes the drain check once, and never invents one without queue checks', () => {
    expect(prestageRequiredChecks(['test'], 'smoke')).toEqual(['test', 'smoke']);
    expect(prestageRequiredChecks(['test'], 'test')).toEqual(['test']);
    expect(prestageRequiredChecks(['test'], undefined)).toEqual(['test']);
    expect(prestageRequiredChecks(['test'], '')).toEqual(['test', '']);
    expect(prestageRequiredChecks([], 'smoke')).toEqual([]);
    expect(prestageRequiredChecks(null, 'smoke')).toBeNull();
  });
  it.each([
    [{ name: 'smoke', status: 'COMPLETED', conclusion: 'FAILURE', head_sha: head }, { enqueued: false, reason: 'required checks red' }],
    [{ name: 'smoke', status: 'IN_PROGRESS', conclusion: null, head_sha: head }, { enqueued: false, reason: 'required checks pending' }],
    [null, { fallback: true }],
  ])('a cached enqueue re-checks the drain check it was invoked with (%j)', async (row, expected) => {
    const f = fixture({ requiredCheck: 'smoke' });
    green(f);
    if (row) f.pr.statusCheckRollup.push(row);
    expect(await f.run()).toMatchObject(expected);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('an empty --check never prepares, as the full drain never lands', () => {
    expect(classifyPr(pending(), { preparePendingCi: true, queueRequiredChecks: ['test'], requiredCheck: '' }).decision).toBe('skip');
  });
  it('an unread --check (failed full read past the rollup cap) falls back without enqueuing', async () => {
    const f = fixture({ requiredCheck: 'test' });
    green(f);
    f.pr.requiredCheckReadError = 'required check "test" direct read failed; deferred this pass: boom';
    expect(await f.run()).toEqual({ fallback: true });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('a cached enqueue with a green drain check still enqueues', async () => {
    const f = fixture({ requiredCheck: 'smoke' });
    green(f);
    f.pr.statusCheckRollup.push({ name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: head });
    expect(await f.run()).toEqual({ enqueued: true });
  });
  it('missing requirements, wrong-head rows and conflicts cannot grant a shortcut', () => {
    const p = pending();
    expect(prestageCi(p, ['test', 'integration'])).toBe('unknown');
    p.statusCheckRollup[0].head_sha = 'other';
    expect(prestageCi(p, ['test'])).toBe('red');
    p.statusCheckRollup[0].head_sha = head; p.mergeable = 'CONFLICTING';
    expect(classifyPr(p, { preparePendingCi: true, queueRequiredChecks: ['test'] }).decision).toBe('skip');
  });
});
