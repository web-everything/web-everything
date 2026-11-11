/**
 * @file scripts/__tests__/lane-verify-deferred.test.mjs
 * @description R893 "verify deferred to CI": an infra-failed/unsettled verify records a distinct `deferred-to-ci`
 *   marker bound to the exact HEAD sha, in its OWN file so every existing marker reader sees it as not-green.
 *   Only pr-land's OPEN path (never `land`) accepts it, and ready-to-merge still needs a green CI `test` run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifyMarker, verifyGateDecision, VERIFY_FILENAME } from '../lib/lane-verify.mjs';
import {
  DEFERRED_FILENAME, buildDeferredRecord, recordTerminalVerifyOutcome, readDeferredMarker,
  deferredToCiDecision, appendDeferredDisclosure, ciTestGreenOnSha, readDeferredForSha,
} from '../lib/lane-verify-deferred.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const infra = { reason: 'verify-unsettled', detail: 'verification unsettled: shard INVENTORY-INCOMPLETE' };
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deferred-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const infraFinished = (sha = SHA) => ({ sha, status: 'infrastructure-failure', infrastructure: infra, exitCode: 75 });
const infraGate = { ok: false, status: 'infrastructure-failure', reason: 'verify-unsettled', detail: infra.detail };

describe('recording', () => {
  it('an infra-failed verify writes deferred-to-ci bound to the head sha with reason and evidence', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    const rec = readDeferredMarker(dir);
    expect(rec).toMatchObject({ status: 'deferred-to-ci', sha: SHA, reason: 'verify-unsettled', infrastructure: infra });
    expect(rec.detail).toContain('INVENTORY-INCOMPLETE');
  });
  it('a red verify never writes deferred, and clears a stale one', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    recordTerminalVerifyOutcome(dir, { sha: SHA, status: 'red', exitCode: 1 });
    expect(existsSync(join(dir, DEFERRED_FILENAME))).toBe(false);
  });
  it('a green verify clears a stale deferred marker', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    recordTerminalVerifyOutcome(dir, { sha: SHA, status: 'green', exitCode: 0 });
    expect(readDeferredMarker(dir)).toBeNull();
  });
  it('refuses to build a record without a sha or infra evidence', () => {
    expect(buildDeferredRecord({ sha: null, infrastructure: infra })).toBeNull();
    expect(buildDeferredRecord({ sha: SHA, infrastructure: null })).toBeNull();
  });
});

describe('every existing marker reader treats deferred as not green', () => {
  it('readVerifyMarker does not see it; the finish-guard stays unverified', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    expect(existsSync(join(dir, VERIFY_FILENAME))).toBe(false);
    expect(readVerifyMarker(dir)).toBeNull();
    expect(verifyGateDecision({ record: readVerifyMarker(dir), headSha: SHA }).ok).toBe(false);
  });
  it('a deferred-status record placed in the main marker file is never green', () => {
    expect(verifyGateDecision({ record: { sha: SHA, status: 'deferred-to-ci' }, headSha: SHA }).ok).toBe(false);
  });
  it('a torn deferred file reads as corrupt', () => {
    writeFileSync(join(dir, DEFERRED_FILENAME), '{nope');
    expect(readDeferredMarker(dir)).toEqual({ corrupt: true });
  });
});

describe('deferredToCiDecision (the open path only)', () => {
  const ok = (over = {}) => deferredToCiDecision({ gate: infraGate, deferred: buildDeferredRecord({ sha: SHA, infrastructure: infra, exitCode: 75 }), headSha: SHA, mode: 'park', ...over });
  it('accepts park, label-on-green and open-only, with a disclosure line', () => {
    for (const mode of ['park', 'label-on-green', 'open-only']) {
      const d = ok({ mode });
      expect(d.ok).toBe(true);
      expect(d.disclosure).toMatch(/^lane verify deferred to CI: verify-unsettled/);
    }
  });
  it('accepts an absent/unverified gate too', () => {
    expect(ok({ gate: { ok: false, status: 'unverified', reason: 'unverified' } }).ok).toBe(true);
  });
  it('refuses the land mode', () => { expect(ok({ mode: 'land' }).ok).toBe(false); });
  it('refuses red, corrupt and running gates', () => {
    for (const status of ['red', 'corrupt', 'running']) expect(ok({ gate: { ok: false, status } }).ok).toBe(false);
  });
  it('refuses a deferred marker for another sha, missing or corrupt', () => {
    expect(ok({ headSha: OTHER }).ok).toBe(false);
    expect(ok({ deferred: null }).ok).toBe(false);
    expect(ok({ deferred: { corrupt: true } }).ok).toBe(false);
    expect(ok({ deferred: { status: 'green', sha: SHA, reason: 'x', infrastructure: infra } }).ok).toBe(false);
  });
  it('rejects malformed or unknown infra evidence', () => {
    expect(buildDeferredRecord({ sha: SHA, infrastructure: true })).toBeNull();
    expect(buildDeferredRecord({ sha: SHA, infrastructure: { reason: 'anything', detail: 'x' } })).toBeNull();
    expect(ok({ deferred: { status: 'deferred-to-ci', sha: SHA, reason: 'x', infrastructure: true } }).ok).toBe(false);
    expect(ok({ deferred: { status: 'deferred-to-ci', sha: SHA, reason: 'verify-timeout', infrastructure: infra } }).ok).toBe(false);
  });
  it('is a no-op for an already-ok gate', () => { expect(ok({ gate: { ok: true, status: 'green' } }).ok).toBe(false); });
  it('disclosure is idempotent', () => {
    const once = appendDeferredDisclosure('Body', 'lane verify deferred to CI: r');
    expect(appendDeferredDisclosure(once, 'lane verify deferred to CI: r')).toBe(once);
  });
  it('appends the disclosure to a PR body', () => {
    expect(appendDeferredDisclosure('Body', 'lane verify deferred to CI: r')).toContain('lane verify deferred to CI: r');
  });
});

describe('ready-to-merge needs a green CI test check on the exact sha', () => {
  const view = (oid, rollup) => ({ headRefOid: oid, statusCheckRollup: rollup });
  it('green test on the exact sha passes', () => {
    expect(ciTestGreenOnSha(view(SHA, [{ name: 'test', conclusion: 'SUCCESS' }]), SHA)).toBe(true);
  });
  it.each([
    [view(SHA, [])],
    [view(SHA, [{ name: 'test', conclusion: 'FAILURE' }])],
    [view(SHA, [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }])],
    [view(SHA, [{ name: 'lint', conclusion: 'SUCCESS' }])],
    [view(SHA, [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'test', status: 'IN_PROGRESS', conclusion: '' }])],
    [view(OTHER, [{ name: 'test', conclusion: 'SUCCESS' }])],
    [null],
  ])('refuses %j', (v) => { expect(ciTestGreenOnSha(v, SHA)).toBe(false); });
});

describe('a dispatcher-killed verify still defers (PR #6674 red team)', () => {
  // The dispatcher kills verify-lane on a queue/gate ceiling and settles `.lane-verify` itself
  // (recordKilledVerification); the killed child never runs its terminal hook, so no deferred file exists.
  let lane; let gitDir;
  beforeEach(async () => {
    const { execFileSync } = await import('node:child_process');
    lane = mkdtempSync(join(tmpdir(), 'deferred-lane-'));
    execFileSync('git', ['init', '-q', lane]);
    gitDir = join(lane, '.git');
  });
  afterEach(() => { rmSync(lane, { recursive: true, force: true }); });
  const writeMain = (rec) => writeFileSync(join(gitDir, VERIFY_FILENAME), JSON.stringify(rec));
  const killed = async (timedOutPhase = 'queue') => {
    const { recordKilledVerification } = await import('../conveyor/verify-dispatch.mjs');
    writeMain({ sha: SHA, status: 'running', startedAt: null, finishedAt: null, suites: null, exitCode: null, treeHash: null, runId: 'run-1' });
    recordKilledVerification(lane, { sha: SHA, runId: 'run-1' }, { status: null, signal: 'SIGKILL', timedOutPhase }, 1000);
  };
  // The exact pr-land open path: the finish-guard (require-verified) then the deferred decision.
  const openDecision = (headSha = SHA, mode = 'park') => {
    const gate = verifyGateDecision({ record: readVerifyMarker(gitDir), headSha, requireVerified: true });
    return deferredToCiDecision({ gate, deferred: readDeferredForSha(gitDir, headSha), headSha, mode });
  };

  it.each(['queue', 'gate'])('a %s-ceiling kill opens with the timeout disclosure', async (phase) => {
    await killed(phase);
    expect(readVerifyMarker(gitDir).status).toBe('infrastructure-failure');
    expect(existsSync(join(gitDir, DEFERRED_FILENAME))).toBe(false);
    const d = openDecision();
    expect(d).toMatchObject({ ok: true, reason: 'deferred-to-ci' });
    expect(d.disclosure).toMatch(/verify-timeout/);
  });
  it('still refuses the land mode', async () => {
    await killed();
    expect(openDecision(SHA, 'land')).toMatchObject({ ok: false, reason: 'mode-land' });
  });
  it('never carries a main-marker infra failure to another sha', async () => {
    await killed();
    expect(readDeferredForSha(gitDir, OTHER)).toBeNull();
    expect(openDecision(OTHER).ok).toBe(false);
  });
  it.each([
    ['red', { sha: SHA, status: 'red', exitCode: 1 }],
    ['green', { sha: SHA, status: 'green', exitCode: 0 }],
    ['running', { sha: SHA, status: 'running' }],
    ['legacy red with a signal', { sha: SHA, status: 'red', exitCode: 137, signal: 'SIGKILL' }],
    ['infra with an unknown reason', { sha: SHA, status: 'infrastructure-failure', infrastructure: { reason: 'disk-full', detail: 'x' } }],
    ['infra with no evidence', { sha: SHA, status: 'infrastructure-failure' }],
  ])('a %s main marker yields no deferred record', (_, rec) => {
    writeMain(rec);
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
  it('a corrupt main marker yields no deferred record', () => {
    writeFileSync(join(gitDir, VERIFY_FILENAME), '{torn');
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
  it('the deferred file wins only for the exact sha; a stale one falls back to the main marker', async () => {
    recordTerminalVerifyOutcome(gitDir, infraFinished(OTHER));
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
    await killed();
    expect(readDeferredForSha(gitDir, SHA)).toMatchObject({ status: 'deferred-to-ci', sha: SHA, reason: 'verify-timeout' });
    recordTerminalVerifyOutcome(gitDir, infraFinished(SHA));
    expect(readDeferredForSha(gitDir, SHA)).toMatchObject({ sha: SHA, reason: 'verify-unsettled' });
  });
  it('an exact-sha deferred file is ignored once the main marker holds a red verdict for that sha', () => {
    recordTerminalVerifyOutcome(gitDir, infraFinished(SHA));
    writeMain({ sha: SHA, status: 'red', exitCode: 1 });
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
});

describe('wiring (source pins)', () => {
  const readFileSync = (p, e) => rf(p, e);
  it('only pr-land and verify-lane reference the deferred module; the open path refuses land mode', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['grep', '-l', 'lane-verify-deferred', '--', 'scripts', ':!scripts/__tests__'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(out).toEqual(['scripts/lib/lane-verify-deferred.mjs', 'scripts/pr-land.mjs', 'scripts/verify-lane.mjs'].sort());
    expect(readFileSync('scripts/pr-land.mjs', 'utf8')).toMatch(/mode: PLAN\.mode/);
    // PR #6674 red team — pr-land reads the deferred record through the main-marker fallback, never the bare file.
    expect(readFileSync('scripts/pr-land.mjs', 'utf8')).toMatch(/deferred: readDeferredForSha\(gitDir, refSha\)/);
  });
});
