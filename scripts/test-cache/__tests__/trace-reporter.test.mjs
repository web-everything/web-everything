/**
 * @file scripts/test-cache/__tests__/trace-reporter.test.mjs
 * @description prepare-124 S3 — traces folded into the shadow decisions: auto-deny, the traced input list as a manifest
 * (a changed listed input is a key-miss, not a hit), and K-clean-runs admission. Uses synthetic trace files.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeGitOverlay } from '../../lib/hermetic-git-overlay.mjs';
import { DEFAULT_REPO_ROOT } from '../../lib/hermetic-tests.mjs';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideShadow, summarizeFile } from '../../lib/test-cache-shadow.mjs';
import { atomicWrite, readAdmission } from '../../lib/test-result-store.mjs';
import { traceFileBase } from '../../lib/test-cache-trace.mjs';
import { latestPerFile, summarize } from '../trace-report.mjs';
import ShadowReporter from '../shadow-reporter.mjs';

// Hermetic (card xcu4cqf): the reporter records `git merge-base HEAD origin/main` of the checkout it runs in. That
// read goes through a git overlay of this checkout whose `origin/main` is pinned to HEAD (no live remote ref).
let overlay;
beforeAll(() => { overlay = makeGitOverlay(DEFAULT_REPO_ROOT); });
afterAll(() => overlay?.cleanup());
beforeEach(() => { Object.assign(process.env, overlay.env); }); // restored after each test by vitest.setup.ts

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'trr-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const pass = { type: 'suite', result: { state: 'pass', duration: 40 }, tasks: [{ type: 'test', mode: 'run', result: { state: 'pass' } }] };
const row = { file: 'b.test.mjs', key: 'ab'.repeat(32), cacheable: true, tier: 'tierB', reason: null, needsTrace: true };
const run = { runId: 'r1', lane: 'lane-9', baseSha: 'abc', storeAllowed: true, now: '2026-10-07T00:00:00Z' };
const trace = (over = {}) => ({ denies: [], tracedMap: { 'file:scripts/x.mjs': 'h1' }, traced: 1, admitted: true, cleanRuns: 3, ...over });
const stored = { outcome: 'pass', passed: 1, skipped: 0, durationMs: 40, traced: { 'file:scripts/x.mjs': 'h1' } };

describe('prepare-124 S3 — decideShadow with a trace', () => {
  const decide = (over) => decideShadow({ row, summary: summarizeFile(pass), stored, quarantined: false, run, trace: trace(), ...over });

  it('a tier B file is a would-skip only when admitted and its traced inputs are unchanged', () => {
    expect(decide().record).toMatchObject({ wouldSkip: true, reason: 'hit', keyMiss: false });
    expect(decide({ trace: trace({ admitted: false, cleanRuns: 2 }) }).record).toMatchObject({ wouldSkip: false, reason: 'not-admitted' });
    expect(decide({ trace: null }).record).toMatchObject({ wouldSkip: false, reason: 'no-trace' });
  });

  it('a changed traced input is a key-miss (caught before it can be a false-skip) and is not a hit', () => {
    const d = decide({ trace: trace({ tracedMap: { 'file:scripts/x.mjs': 'CHANGED' } }) });
    expect(d.record).toMatchObject({ wouldSkip: false, reason: 'traced-changed', keyMiss: true, falseSkip: null });
    expect(d.store.traced).toEqual({ 'file:scripts/x.mjs': 'CHANGED' });
  });

  it('a deny reason blocks the hit and the store', () => {
    const d = decide({ trace: trace({ denies: ['checkout-cwd: git'] }) });
    expect(d.record).toMatchObject({ wouldSkip: false, reason: 'traced-deny: checkout-cwd: git' });
    expect(d.store).toBeNull();
  });

  it('an older entry with no traced list is re-recorded, not a hit', () => {
    expect(decide({ stored: { ...stored, traced: undefined } }).record.reason).toBe('no-entry');
  });
});

describe('prepare-124 S3 — reporter folds traces in', () => {
  it('writes admission counts, denies, and removes the run trace dir; CI writes nothing', () => {
    const dir = tmp();
    const root = process.cwd();
    const name = 'scripts/test-cache/__tests__/seeded-unkeyed-input.test.mjs';
    const finish = (env, events) => {
      const r = new ShadowReporter({ env, dir });
      r.onInit({ config: { root } });
      r.onPathsCollected([join(root, name)]);
      if (events) atomicWrite(`${traceFileBase(dir, r.runId, name)}.json`, JSON.stringify({ file: name, root, events }));
      r.onFinished([{ ...pass, filepath: join(root, name) }], []);
      return r;
    };
    const clean = [{ k: 'read', p: join(root, 'package.json') }];
    for (let i = 0; i < 3; i += 1) finish({}, clean);
    expect(readAdmission(dir, name)).toMatchObject({ cleanRuns: 3, status: 'clean', admitted: true });
    const denied = finish({}, [{ k: 'spawn', kind: 'spawnSync', cmd: 'git', args: ['status'], cwd: root }]);
    expect(readAdmission(dir, name)).toMatchObject({ cleanRuns: 0, status: 'denied', admitted: false, reasons: ['checkout-cwd: git'] });
    expect(existsSync(join(dir, 'traces', denied.runId))).toBe(false);
    const ci = tmp();
    const r = new ShadowReporter({ env: { CI: '1' }, dir: ci });
    r.onInit({ config: { root } });
    r.onFinished([{ ...pass, filepath: join(root, name) }], []);
    expect(readdirSync(ci)).toEqual([]);
  });

  it('summarize() reports tier A and tier B hit rates separately', () => {
    const recs = [
      { file: 'a', tier: 'pure', reason: 'hit', wouldSkip: true, needsTrace: false, durationMs: 10, trace: null },
      { file: 'b', tier: 'pure', reason: 'no-entry', wouldSkip: false, needsTrace: false, durationMs: 10, trace: null },
      { file: 'c', tier: 'tierB', reason: 'hit', wouldSkip: true, needsTrace: true, durationMs: 90, trace: { denies: [], admitted: true } },
      { file: 'd', tier: 'tierB', reason: 'traced-deny: network: x.com', wouldSkip: false, needsTrace: true, durationMs: 10, trace: { denies: ['network: x.com'], admitted: false } },
      { file: 'e', tier: 'checkout', reason: 'not-cacheable: x', wouldSkip: false, needsTrace: false, durationMs: 5, trace: { denies: ['checkout-cwd: node'], admitted: false } },
    ];
    const s = summarize(latestPerFile(recs));
    expect(s.tierA).toMatchObject({ files: 3, wouldSkip: 1, cacheable: 2, hitRatePct: 50 });
    expect(s.tierBHit).toMatchObject({ files: 2, wouldSkip: 1, hitRatePct: 50, hitTimeSharePct: 90 });
    expect(s).toMatchObject({ subprocessFiles: 3, traced: 3, tracedClean: 1, tracedDenied: 2, deniedByReason: { network: 1, 'checkout-cwd': 1 } });
  });
});
