import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostSaturation, ciOnlyDecision, recordCiOnly } from '../verify-ci-only.mjs';
import { hasGreenLedger } from '../lane-verify.mjs';
import { appendDeferredDisclosure, syncDeferredBody, deferredLabelRefusal } from '../lane-verify-deferred.mjs';
import { resolveFinishGuardVerdict } from '../../pr-land.mjs';

const sha = 'a'.repeat(40);
const reading = (idlePct, threshold = 15) => ({ mac: { idlePct }, thresholds: { cpuIdleLowPct: threshold } });
const host = (idle, verdict = { admitted: true }, threshold = 15) => hostSaturation({
  collect: () => reading(idle, threshold), admission: () => verdict,
});
const decide = (over = {}) => ciOnlyDecision({ verify: 'ci-only', mode: 'park', saturation: () => host(10), ...over });
let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = null; });

describe('R1086 measured host saturation', () => {
  it('accepts CPU idle strictly below the shared configured threshold', () => {
    expect(host(14).saturated).toBe(true);
    expect(host(15).saturated).toBe(false);
    expect(host(19, { admitted: true }, 20).reason).toContain('cpuIdleLowPct=20%');
  });
  it('accepts measured host-load admission refusal, without an interactive bypass', () => {
    const admission = vi.fn(() => ({ admitted: false, reason: 'host load 40.00/8=5.00; host.maxLoadPerCore=2 (standard)' }));
    expect(hostSaturation({ collect: () => reading(80), admission }).saturated).toBe(true);
    expect(admission).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }));
  });
  it('refuses unknown, invalid, thrown, memory-only and capacity-unknown evidence', () => {
    for (const idle of [null, undefined, NaN, -1, 101, '10']) expect(host(idle).saturated).toBe(false);
    for (const reason of ['host load unknown: denied', 'host memory headroom 10MB', 'host capacity: unknown mac reading']) {
      expect(host(80, { admitted: false, reason }).saturated).toBe(false);
    }
    expect(hostSaturation({ collect: () => { throw Error('denied'); }, admission: () => { throw Error('denied'); } }).saturated).toBe(false);
    expect(decide({ saturation: () => { throw Error('denied'); } })).toMatchObject({ ok: false, reason: 'ci-only-not-saturated' });
  });
  it('refuses an unsaturated host with measured idle and an operator fallback', () => {
    expect(decide({ saturation: () => host(80) })).toMatchObject({ ok: false, reason: 'ci-only-not-saturated', detail: expect.stringMatching(/CPU idle 80%.*retry local verification/) });
  });
  it('refuses land and every bad value before sampling, while omission leaves the guard alone', () => {
    const saturation = vi.fn();
    expect(decide({ mode: 'land', saturation })).toMatchObject({ ok: false, reason: 'bad-verify' });
    for (const verify of ['', true, null, 'local', 'ci-only ']) expect(decide({ verify, saturation }).reason).toBe('bad-verify');
    expect(decide({ verify: undefined, saturation })).toBeNull();
    expect(saturation).not.toHaveBeenCalled();
  });
  it('allows every open mode and ignores an in-flight running marker', () => {
    for (const mode of ['park', 'label-on-green', 'open-only']) {
      const ciOnly = decide({ mode });
      const readMarker = vi.fn(() => ({ sha, status: 'running', startedAt: new Date().toISOString() }));
      expect(resolveFinishGuardVerdict({ headSha: sha, ciOnly, readMarker, runGit: vi.fn() })).toBe(ciOnly);
    }
  });
  it('still refuses a red or corrupt marker for the sha', () => {
    const ciOnly = decide();
    for (const marker of [{ sha, status: 'red', exitCode: 1, finishedAt: new Date().toISOString() }, { corrupt: true }]) {
      const v = resolveFinishGuardVerdict({ headSha: sha, ciOnly, readMarker: () => marker, runGit: vi.fn() });
      expect(v.ok).toBe(false);
    }
  });
  it('discloses sanitized bounded reasons on create and rerun, idempotently', () => {
    const deferred = decide({ saturation: () => ({ saturated: true, reason: 'busy\n<script>`' + 'x'.repeat(1000) }) });
    expect(deferred.hostReason.length).toBeLessThanOrEqual(300);
    expect(deferred.disclosure).not.toMatch(/[\n<>`]/);
    const body = appendDeferredDisclosure('Body', deferred.disclosure);
    expect(body).toContain('verify: ci-only (host saturated: busy ‹script›');
    expect(appendDeferredDisclosure(body, deferred.disclosure)).toBe(body);
    const forge = { editBody: vi.fn() };
    expect(syncDeferredBody({ forge, prNum: 1, liveBody: 'Old', composed: 'Body', deferred })).toBe(body);
    syncDeferredBody({ forge, prNum: 1, liveBody: body, composed: body, deferred });
    expect(forge.editBody).toHaveBeenCalledTimes(1);
  });
  it('requires green CI test on this exact sha; pending, other-sha and unreadable checks refuse', () => {
    const deferred = decide();
    const check = (view) => deferredLabelRefusal({ forge: { viewPr: () => view }, prNum: 1, sha, deferred });
    for (const view of [null, { headRefOid: sha, statusCheckRollup: [] }, { headRefOid: 'b'.repeat(40), statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }]) expect(check(view)?.reason).toBe('deferred-ci-not-green');
    expect(check({ headRefOid: sha, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })).toBeNull();
  });
  it('records only real lanes or explicit overrides, best-effort, and never counts as green', () => {
    scratch = mkdtempSync(join(tmpdir(), 'verify-ci-only-'));
    const args = { repo: scratch, coordinationRoot: scratch, sha, reason: 'busy\nnow', env: {} };
    expect(recordCiOnly(args)).toBe(false);
    expect(recordCiOnly({ ...args, repo: join(scratch, '.lanes', 'we', 'lane-1') })).toBe(true);
    const dir = join(scratch, 'verify-ci-only');
    expect(JSON.parse(readFileSync(join(dir, `${sha}.json`), 'utf8'))).toMatchObject({ sha, mode: 'ci-only', reason: 'busy now', recordedAt: expect.any(String) });
    expect(hasGreenLedger({ dir, sha })).toBe(false);
    expect(recordCiOnly({ ...args, env: { WE_VERIFY_CI_ONLY_LEDGER_DIR: join(scratch, 'explicit') } })).toBe(true);
    expect(recordCiOnly({ ...args, sha: '../invalid', env: { WE_VERIFY_CI_ONLY_LEDGER_DIR: dir } })).toBe(false);
    expect(recordCiOnly({ ...args, env: { WE_VERIFY_CI_ONLY_LEDGER_DIR: join(dir, `${sha}.json`, 'blocked') } })).toBe(false);
  });
});
