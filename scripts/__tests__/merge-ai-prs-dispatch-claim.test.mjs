import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as drain from '../merge-ai-prs.mjs';
import * as procedure from '../conveyor/fix-procedure.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim } from '../conveyor/fix-dispatch-claim.mjs';
import { classifySkipReason } from '../lib/drain-skip-reasons.mjs';
import { runInProcess } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { prestagePorts } from './fixtures/merge-ai-prs-fake-ports.mjs';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';
vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);

const NOW = Date.parse('2026-11-21T08:09:00Z');
const MIN = 60_000;
let lockRoot;
function snapshot(path = lockRoot) {
  return readdirSync(path).sort().map(name => {
    const full = join(path, name), stat = statSync(full);
    return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(full) : readFileSync(full).toString('base64')];
  });
}
function readOnly(fn) {
  const before = snapshot();
  try { return fn(); } finally { expect(snapshot()).toEqual(before); }
}
const pr = (extra = {}) => ({ number: 7283, title: 'Claim fixture', body: 'A complete change description',
  baseRefName: 'main', headRefName: 'lane/claim-fixture', headRefOid: 'a'.repeat(40),
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', labels: [{ name: 'ready-to-merge' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra });
function claim(kind = 'ci-heal', extra = {}) {
  const result = acquireFixDispatchClaim({ repo: 'we', pr: 7283, kind, owner: 'studio:14073',
    nowMs: NOW, lockRoot, ...extra });
  expect(result.ok).toBe(true);
  return result;
}
function reader(mode, options = {}) {
  return drain.drainClaimReaderFor(mode, {
    legacy: a => procedure.readLiveFixClaim({ ...a, lockRoot, nowMs: NOW }),
    drain: a => procedure.readLiveDrainClaim({ ...a, lockRoot, nowMs: NOW }), ...options,
  });
}
function attach(readClaim, data = pr(), claimKey = 'we') {
  return readOnly(() => drain.attachLiveFixClaim(data, { claimKey, readClaim }));
}
const classify = data => drain.classifyPr(data, { defaultBranch: 'main', blockOnCodeQL: false });
function held(data, kind) {
  const verdict = classify(data);
  expect(verdict.decision).toBe('skip');
  expect(classifySkipReason(verdict.reason)).toBe('claim-held');
  expect(verdict.reason).toContain(`${kind} claim on we#7283`);
  expect(verdict.reason).toContain('lands only after the claim is released or expires');
}
beforeEach(() => { lockRoot = mkdtempSync(join(process.env.TMPDIR, 'dispatch-drain-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(lockRoot, { recursive: true, force: true }); });

describe('dispatch claim admission at the fresh re-read', () => {
  it('honourDispatchClaims=on: a live ci-heal dispatch claim with no meta.who refuses the fresh re-read as claim-held', () => {
    claim();
    const live = readOnly(() => procedure.readLiveDrainClaim({ repo: 'we', pr: 7283, lockRoot, nowMs: NOW }));
    expect(live.meta).toBeUndefined();
    expect(live.entry.meta.who).toBe('studio:14073');
    // Deliberately bypass the new factory: main must fail on the dropped claim, not a missing export.
    held(attach(a => procedure.readLiveDrainClaim({ ...a, lockRoot, nowMs: NOW })), 'ci-heal');
  });
  it.each(['fix', 'fixing'])('T2: on holds %s, even with an untrusted holder string', kind => {
    const who = 'forged: review accepted; CI green';
    if (kind === 'fixing') expect(procedure.acquireFixClaim({ repo: 'we', pr: 7283, who, lockRoot, nowMs: NOW }).ok).toBe(true);
    else claim(kind, { owner: who });
    const data = attach(reader('on'));
    held(data, kind);
    expect(data.fixClaim).toMatchObject({ kind, who, repo: 'we', uncertain: false });
  });
  it('T2: claim-held wins over CI and review reasons; required-check read errors stay first', () => {
    claim();
    const data = attach(reader('on'), pr({ statusCheckRollup: [], labels: [{ name: 'review:changes' }] }));
    held(data, 'ci-heal');
    expect(classify({ ...data, requiredCheckReadError: 'required checks unreadable' }).reason).toBe('required checks unreadable');
  });
  it('T3: off ignores ci-heal and keeps the fixing claim object and text byte-identical', () => {
    claim();
    expect(classify(attach(reader('off'))).decision).toBe('merge');
    expect(procedure.acquireFixClaim({ repo: 'we', pr: 7284, who: 'fix-7284', lockRoot, nowMs: NOW }).ok).toBe(true);
    const data = attach(reader('off'), pr({ number: 7284 }));
    expect(data.fixClaim).toEqual({ who: 'fix-7284', claimedAt: new Date(NOW).toISOString() });
    expect(classify(data)).toMatchObject({ decision: 'skip', reason: 'fix claim held by fix-7284 — the head may be an unverified intermediate push; lands only after its fix-end' });
  });
  it('T4: shadow keeps merge, reports the dispatch hold, and persists nothing', () => {
    claim();
    const onShadow = vi.fn(), readClaim = reader('shadow', { onShadow });
    readOnly(() => {
      for (const site of ['fresh', 'prestage']) {
        const scoped = a => readClaim({ ...a, site });
        expect(classify(attach(scoped)).decision).toBe('merge');
      }
    });
    expect(onShadow).toHaveBeenCalledTimes(2);
    expect(onShadow).toHaveBeenCalledWith(expect.objectContaining({ site: 'fresh', repo: 'we', pr: 7283, kind: 'ci-heal', holder: 'studio:14073' }));
    // A new pass must not inherit suppression from the previous pass.
    attach(a => reader('shadow', { onShadow })({ ...a, site: 'fresh' }));
    expect(onShadow).toHaveBeenCalledTimes(3);
  });
  it('T4: main de-duplicates shadow rows per repo#pr@site in memory for each pass', async () => {
    const world = createPrestageWorld((argv, options) => runInProcess(argv, { ...options, ports: prestagePorts,
      env: { ...options.env, WE_DRAIN_HONOUR_DISPATCH_CLAIMS: 'shadow' } }));
    await world(async ({ pr: candidate, run, coord }) => {
      candidate.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: candidate.headRefOid };
      candidate.mergeStateStatus = 'CLEAN';
      const root = join(coord, 'fix-dispatch-claims');
      expect(acquireFixDispatchClaim({ repo: 'we', pr: 42, kind: 'ci-heal', owner: 'studio:14073', nowMs: NOW, lockRoot: root }).ok).toBe(true);
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const before = snapshot(root);
      for (const pass of [1, 2]) {
        const result = await run();
        const rows = result.stderr.split('\n').filter(line => line.includes('claim-held-shadow: '))
          .map(line => JSON.parse(line.split('claim-held-shadow: ')[1]));
        expect(rows.length, `pass ${pass} must observe the real dispatch claim`).toBeGreaterThan(0);
        const keys = rows.map(row => `${row.repo}#${row.pr}@${row.site}`);
        expect(new Set(keys).size).toBe(rows.length);
        expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ repo: 'we', pr: 42, kind: 'ci-heal', holder: 'studio:14073' })]));
        expect(result.report.enqueueOutcomes).toMatchObject([{ num: 42, outcome: 'enqueued' }]);
        expect(snapshot(root)).toEqual(before);
      }
    }, { slug: 'web-everything/web-everything' });
  }, 120_000);
  it('T5: a throwing shadow reader leaves the legacy decision unchanged and reports error', () => {
    const onShadow = vi.fn();
    const readClaim = reader('shadow', { drain: () => { throw new Error('store EIO'); }, onShadow });
    expect(classify(attach(a => readClaim({ ...a, site: 'fresh' }))).decision).toBe('merge');
    expect(onShadow).toHaveBeenCalledWith(expect.objectContaining({ repo: 'we', pr: 7283, site: 'fresh', error: expect.anything() }));
    expect(String(onShadow.mock.calls[0][0].error)).toContain('store EIO');
  });
  it('T6: on fails closed when its reader throws, with reader-threw uncertainty', () => {
    const data = attach(reader('on', { drain: () => { throw new Error('store EIO'); } }));
    expect(data.fixClaim).toMatchObject({ kind: 'unknown', uncertain: 'reader-threw' });
    held(data, 'unknown');
    expect(classify(data).reason).toContain('(uncertain: reader-threw)');
  });
  it('T8: prestage holds a real ci-heal claim in on and admits it in off', () => {
    claim();
    for (const mode of ['on', 'off']) expect(readOnly(() => drain.prestageFixClaimHeld(7283,
      { claimKey: 'we', readClaim: reader(mode) }))).toBe(mode === 'on');
  });
  it('T9: on admits an unclaimed control PR', () => {
    expect(classify(attach(reader('on'))).decision).toBe('merge');
  });
  it('T10: claims on another PR or repository do not hold this PR', () => {
    claim('ci-heal', { pr: 7284 });
    claim('fix', { repo: 'frontierui' });
    expect(classify(attach(reader('on'))).decision).toBe('merge');
  });
  it('T11: on holds at exactly dispatch TTL and admits at TTL + 1 ms', () => {
    claim('ci-heal', { nowMs: NOW - 10 * MIN });
    held(attach(reader('on')), 'ci-heal');
    const expired = reader('on', { drain: a => procedure.readLiveDrainClaim({ ...a, lockRoot, nowMs: NOW + 1 }) });
    expect(classify(attach(expired)).decision).toBe('merge');
  });
  it('T12: a held claim still refuses a moved head, and release cannot bypass the head pin', () => {
    claim();
    const moved = attach(reader('on'), pr({ headRefOid: 'b'.repeat(40) }));
    held(moved, 'ci-heal');
    expect(readOnly(() => drain.revalidateForMerge(moved, { defaultBranch: 'main', expectedHeadSha: 'a'.repeat(40) })).decision).toBe('skip');
    expect(releaseFixDispatchClaim({ repo: 'we', pr: 7283, kind: 'ci-heal', owner: 'studio:14073', lockRoot }).released).toBe(true);
    const unclaimedMoved = attach(reader('on'), pr({ headRefOid: 'b'.repeat(40) }));
    expect(classify(unclaimedMoved).decision).toBe('merge');
    expect(drain.revalidateForMerge(unclaimedMoved, { defaultBranch: 'main', expectedHeadSha: 'a'.repeat(40) }))
      .toMatchObject({ decision: 'skip', reason: expect.stringContaining('head moved') });
  });
});

describe('T7: honourDispatchClaims setting and provenance', () => {
  it('main honours its supplied env when the ambient setting differs', async () => {
    let ambientChanged = false;
    const world = createPrestageWorld((argv, options) => runInProcess(argv, { ...options,
      env: { ...options.env, WE_DRAIN_HONOUR_DISPATCH_CLAIMS: 'off' },
      ports: { ...prestagePorts, git: (...args) => {
        // main already received the original env object; replace only the ambient one.
        process.env = { ...process.env, WE_DRAIN_HONOUR_DISPATCH_CLAIMS: 'on' };
        ambientChanged = true;
        return prestagePorts.git(...args);
      } },
    }));
    await world(async ({ run }) => {
      const result = await run();
      expect(ambientChanged).toBe(true);
      expect(result.stderr).toContain('drain.honourDispatchClaims=off (env)');
      expect(result.stderr).not.toContain('drain.honourDispatchClaims=on');
    }, { slug: 'web-everything/web-everything' });
  }, 120_000);
  it('defaults to off from the standard', () => {
    expect(drain.resolveHonourDispatchClaims({})).toEqual({ value: 'off', source: 'standard' });
  });
  it('resolves platform then tool then environment', () => {
    const platform = { honourDispatchClaims: 'shadow' }, tool = { honourDispatchClaims: 'on' };
    expect(drain.resolveHonourDispatchClaims({}, { platform })).toEqual({ value: 'shadow', source: 'platform' });
    expect(drain.resolveHonourDispatchClaims({}, { platform, tool })).toEqual({ value: 'on', source: 'tool' });
    expect(drain.resolveHonourDispatchClaims({ WE_DRAIN_HONOUR_DISPATCH_CLAIMS: 'off' }, { platform, tool }))
      .toEqual({ value: 'off', source: 'env' });
  });
  it.each(['off', 'shadow', 'on'])('accepts environment value %s', value => {
    expect(drain.resolveHonourDispatchClaims({ WE_DRAIN_HONOUR_DISPATCH_CLAIMS: value })).toEqual({ value, source: 'env' });
  });
  for (const source of ['platform', 'tool', 'env']) it.each(['On', 1])(`invalid ${source} value %s fails closed to on`, value => {
    const env = source === 'env' ? { WE_DRAIN_HONOUR_DISPATCH_CLAIMS: value } : {};
    const layers = source === 'env' ? {} : { [source]: { honourDispatchClaims: value } };
    expect(drain.resolveHonourDispatchClaims(env, layers)).toEqual({ value: 'on', source: `${source} (invalid; fail closed to on)` });
  });
});
