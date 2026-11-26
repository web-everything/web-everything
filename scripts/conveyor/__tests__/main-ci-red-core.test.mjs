/**
 * mainCiRed.pushBeforeGate — the main-fix owner pushes as soon as the failing tests pass (operator 2026-10-10 ~15:20 ET:
 * "make sure the worker that fixes main pushes as soon as possible for the CI to start running").
 *
 * LIVE 2026-10-10: main-fix-2cb94418d's brief ordered the full `run.mjs verify` gate BEFORE `open-pr`, so the owner sat
 * in the heavy queue while main was red and CI had not started on its fix. While main is red nothing lands, so the
 * full local gate before the push only delays CI.
 */
import { describe, it, expect } from 'vitest';
import {
  MAIN_CI_RED_DEFAULTS, mainCiRedSettings, buildOwnerBrief, resolveMainFixPushPolicy, formatMainFixPushPolicyLine,
  MAIN_FIX_PUSH_BEFORE_GATE_ENV,
} from '../main-ci-red-core.mjs';

const state = {
  firstRed: { sha: '2cb94418d3d95e9d64ca59ce6de789a319a6718c', runId: 38077022020 },
  lastGreen: { sha: 'c3c3ba71d389e04b3c883ddf584243c37a9c3e73' },
  latestRed: { sha: '2cb94418d3d95e9d64ca59ce6de789a319a6718c', runId: 38077022020 },
};
const brief = (o = {}) => buildOwnerBrief({ state, failing: { jobs: ['test-shard (3)', 'test'] }, weRoot: '/we', repoSlug: 'o/r', ...o });
const at = (text, needle) => { const i = text.indexOf(needle); expect(i, `missing: ${needle}`).toBeGreaterThan(-1); return i; };

describe('main-fix owner brief — push before the full gate (mainCiRed.pushBeforeGate)', () => {
  it('default: failing tests → commit + open the READY PR → THEN the full verify (CI starts first)', () => {
    const b = brief();
    const tests = at(b, 'npm run test:unit -- <files>');
    const open = at(b, 'run.mjs open-pr --ref=lane/main-fix-2cb94418d');
    const verify = at(b, 'run.mjs verify --checkout=<lane>');
    expect(tests).toBeLessThan(open);
    expect(open).toBeLessThan(verify);
  });

  it('default: the open takes the sanctioned CI-gated opt-out (no marker exists yet) and never starts verify first', () => {
    const b = brief();
    expect(b).toContain('WE_REQUIRE_VERIFIED=0 node scripts/operations/run.mjs open-pr --ref=lane/main-fix-2cb94418d');
    expect(b).toMatch(/do not start .*verify.* before the PR is open/i);
  });

  it('default: follow-up fixes are NEW commits pushed to the same branch, never forced', () => {
    const b = brief();
    const verify = at(b, 'run.mjs verify --checkout=<lane>');
    const push = at(b, 'git push origin HEAD:refs/heads/lane/main-fix-2cb94418d');
    expect(push).toBeGreaterThan(verify);
    const cmd = b.slice(push, b.indexOf('`', push));
    expect(cmd).toBe('git push origin HEAD:refs/heads/lane/main-fix-2cb94418d');
  });

  it('the brief names the setting and the layer that set it', () => {
    expect(brief()).toContain('mainCiRed.pushBeforeGate=on (standard)');
    expect(brief({ pushPolicy: { pushBeforeGate: true, source: 'env', invalid: [] } })).toContain('mainCiRed.pushBeforeGate=on (env)');
  });

  it('off: today\'s order exactly — the full verify BEFORE the open, and no opt-out', () => {
    const b = brief({ pushPolicy: { pushBeforeGate: false, source: 'tool', invalid: [] } });
    expect(at(b, 'run.mjs verify --checkout=<lane>')).toBeLessThan(at(b, 'run.mjs open-pr --ref=lane/main-fix-2cb94418d'));
    expect(b).not.toContain('WE_REQUIRE_VERIFIED=0');
    expect(b).not.toContain('git push origin HEAD:');
  });

  it('the health config layer reaches the brief through mainCiRedSettings (the IO passes only settings today)', () => {
    const off = mainCiRedSettings({ mainCiRedPushBeforeGate: false });
    const b = brief({ settings: off });
    expect(b).toContain('mainCiRed.pushBeforeGate=off (health)');
    expect(at(b, 'run.mjs verify --checkout=<lane>')).toBeLessThan(at(b, 'run.mjs open-pr'));
    // Not set: the settings carry no value, so the standard default (on) answers.
    expect('mainCiRedPushBeforeGate' in mainCiRedSettings({})).toBe(false);
    expect('mainCiRedPushBeforeGate' in MAIN_CI_RED_DEFAULTS).toBe(false);
  });
});

describe('resolveMainFixPushPolicy — the policy cascade (same semantics as fix.pushBeforeGate)', () => {
  it('standard default is ON', () => {
    expect(resolveMainFixPushPolicy()).toEqual({ pushBeforeGate: true, source: 'standard', invalid: [] });
  });
  it('each layer overrides the one below it: standard < platform < tool < health < env', () => {
    expect(resolveMainFixPushPolicy({ platform: { pushBeforeGate: false } })).toMatchObject({ pushBeforeGate: false, source: 'platform' });
    expect(resolveMainFixPushPolicy({ platform: { pushBeforeGate: false }, tool: { pushBeforeGate: 'on' } })).toMatchObject({ pushBeforeGate: true, source: 'tool' });
    expect(resolveMainFixPushPolicy({ tool: { pushBeforeGate: true }, health: false })).toMatchObject({ pushBeforeGate: false, source: 'health' });
    expect(resolveMainFixPushPolicy({ health: false, env: { [MAIN_FIX_PUSH_BEFORE_GATE_ENV]: '1' } })).toMatchObject({ pushBeforeGate: true, source: 'env' });
  });
  it('an invalid value never answers; it is named', () => {
    const p = resolveMainFixPushPolicy({ tool: { pushBeforeGate: 'maybe' }, env: { [MAIN_FIX_PUSH_BEFORE_GATE_ENV]: '' } });
    expect(p).toMatchObject({ pushBeforeGate: true, source: 'standard' });
    expect(p.invalid).toEqual(['tool.pushBeforeGate="maybe"']);
  });
  it('one log line names the value and the source', () => {
    expect(formatMainFixPushPolicyLine(resolveMainFixPushPolicy({ health: 'off' }))).toBe('main-fix-push-policy: mainCiRed.pushBeforeGate=off (health)');
  });
});


describe('main-red rerun and repair declaration settings', () => {
  it('preserves array settings and each rerun off value', () => {
    const config = { mainCiRedFlakeRerun: false, mainCiRedFlakeSignaturePattern: '', mainCiRedKnownFlakyTests: ['a.test.mjs'],
      mainCiRedRerunUnrelatedChange: false, mainCiRedNonCodePaths: ['notes/'], mainCiRedRerunCancelledTip: false,
      mainCiRedOwnerLabels: [], mainCiRedOwnerSupersedeMarker: false };
    expect(mainCiRedSettings(config)).toMatchObject(config);
    expect(mainCiRedSettings({ mainCiRedFlakeRerun: 'false' }).mainCiRedFlakeRerun).toBe(true);
  });
});


describe('red metrics evidence', () => {
  it('keeps queued-but-not-started and missing timestamps unknown, separate from service time', async () => {
    const { measureMainQueue } = await import('../main-ci-red-core.mjs');
    expect(measureMainQueue({ enqueuedAt: 1000 })).toEqual({ waitMs: null, admissionWaitMs: null, serviceMs: null });
    expect(measureMainQueue({ startedAt: 4000, completedAt: 9000 })).toEqual({ waitMs: null, admissionWaitMs: null, serviceMs: 5000 });
    expect(measureMainQueue({ enqueuedAt: 1000, admittedAt: 3000, startedAt: 4000, completedAt: 9000 }))
      .toEqual({ waitMs: 3000, admissionWaitMs: 1000, serviceMs: 5000 });
    expect(measureMainQueue({ enqueuedAt: 5000, startedAt: 4000 }).waitMs).toBeNull();
  });

  it('versions stable signatures from structured identifiers and refuses secret or oversized text', async () => {
    const { mainFailureSignature } = await import('../main-ci-red-core.mjs');
    const ids = { job: 'test-shard (3)', file: 'scripts/a.test.mjs', test: 'rejects routes' };
    expect(mainFailureSignature(ids)).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(mainFailureSignature({ ...ids, error: 'token=secret', log: '\u001b[31mboom' })).toBe(mainFailureSignature(ids));
    expect(mainFailureSignature({ job: 'test\u0000' })).toBeNull();
    expect(mainFailureSignature({ job: 'token=supersecret' })).toBeNull();
    expect(mainFailureSignature({ job: 'a'.repeat(1025) })).toBeNull();
    expect(mainFailureSignature({})).toBeNull();
  });
});


describe('red metrics replay audit regressions', () => {
  const event = (changes = {}) => ({ v: 1, key: 'event', repo: 'fixture/repo', head: 'a'.repeat(40),
    seq: 1, runId: 1, kind: 'red', at: 1000, since: 0, signature: null,
    queue: { waitMs: 100, admissionWaitMs: null, serviceMs: null }, ...changes });
  const options = { from: 0, to: 10000, now: 10000 };

  it.each([
    ['ISO observation', { kind: 'unknown', at: '2026-11-26T00:00:00Z' }],
    ['ISO origin', { since: '2026-11-25T00:00:00Z' }],
    ['out-of-range observation', { at: 8640000000000001 }],
    ['out-of-range origin', { at: 1e20, since: 1e20 }],
  ])('rejects %s with an incomplete-evidence warning', async (_label, changes) => {
    const { validMainRedMetric, reportMainRedMetrics } = await import('../main-ci-red-core.mjs');
    expect(validMainRedMetric(event(changes))).toBe(false);
    expect(reportMainRedMetrics([event(changes)], options).warnings.join(' ')).toMatch(/incomplete.*malformed/i);
  });

  it('refuses unrepresentable query timestamps without crashing daily replay', async () => {
    const { reportMainRedMetrics } = await import('../main-ci-red-core.mjs');
    const report = reportMainRedMetrics([event({ at: 1e20, since: 1e20 })], { from: 1e20, to: 1e20 + 1e6, now: 1e20 + 1e6 });
    expect(report.warnings.join(' ')).toMatch(/incomplete range/i);
  });

  it('does not count future-only observations as coverage of the requested range', async () => {
    const { reportMainRedMetrics } = await import('../main-ci-red-core.mjs');
    const report = reportMainRedMetrics([event({ at: 20000 })], options);
    expect(report.days).toEqual({});
    expect(report.warnings.join(' ')).toMatch(/history does not cover.*recover/i);
  });

  it('warns when a queue observation survives without its red episode start', async () => {
    const { reportMainRedMetrics } = await import('../main-ci-red-core.mjs');
    const report = reportMainRedMetrics([event({ kind: 'queue', at: 0 })], options);
    expect(report.warnings.join(' ')).toMatch(/queue.*no episode start.*recover/i);
  });
});
