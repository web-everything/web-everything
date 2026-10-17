import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrestageCache, resolvePrestageSettings, prestageCi, labelSignature, enqueuePrestage } from '../drain-prestage.mjs';
import { classifyPr, buildDrainVerdicts } from '../../merge-ai-prs.mjs';
import { aiPr } from '../../__tests__/fixtures/merge-ai-prs-fixtures.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const repo = 'owner/repo', head = 'a'.repeat(40);
const pending = () => aiPr({ number: 42, headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false,
  labels: [{ name: 'review:accepted' }], mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE',
  statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null, head_sha: head }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drain-prestage-')); roots.push(root);
  let clock = 1000;
  const cache = createPrestageCache({ root, now: () => clock });
  const pr = pending();
  cache.put(repo, 42, { headSha: head, labels: labelSignature(pr.labels), body: pr.body, baseRefName: 'main', requiredChecks: ['test'],
    eligible: true, candidate: { num: 42, repo, listedHeadSha: head }, queueAdmission: { allowed: true } });
  const enqueue = vi.fn(() => ({ enqueued: true }));
  const settings = resolvePrestageSettings({ env: {}, tool: {}, platform: {} });
  const readPr = vi.fn(async () => pr);
  const run = () => enqueuePrestage({ cache, repo, num: 42, settings, readPr, enqueue, withLock: fn => ({ ran: true, result: fn() }) });
  return { cache, pr, enqueue, settings, run, readPr, advance: ms => { clock += ms; } };
}

describe('CI pre-stage', () => {
  it('computes the non-CI verdict while pending, without changing ordinary classification', () => {
    const p = pending();
    expect(classifyPr(p).decision).toBe('skip');
    const verdicts = buildDrainVerdicts({ prsByRepo: new Map([[repo, [p]]]), repos: [repo],
      preparePendingCi: true, isLocalRepo: () => true, queueRequiredChecksOf: () => ['test'], readOf: () => ({ commits: [] }) });
    expect(verdicts[0]).toMatchObject({ decision: 'merge', prestagePendingCi: true, testGreen: false, mergeable: 'MERGEABLE', listedHeadSha: head });
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
  it('red drops the cache and never enqueues', async () => {
    const f = fixture();
    f.pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' };
    expect(await f.run()).toMatchObject({ enqueued: false, reason: 'required checks red' });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.cache.get(repo, 42, 30)).toBeNull();
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
  it('missing requirements, wrong-head rows and conflicts cannot grant a shortcut', () => {
    const p = pending();
    expect(prestageCi(p, ['test', 'integration'])).toBe('unknown');
    p.statusCheckRollup[0].head_sha = 'other';
    expect(prestageCi(p, ['test'])).toBe('red');
    p.statusCheckRollup[0].head_sha = head; p.mergeable = 'CONFLICTING';
    expect(classifyPr(p, { preparePendingCi: true, queueRequiredChecks: ['test'] }).decision).toBe('skip');
  });
});
