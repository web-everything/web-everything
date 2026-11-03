import { describe, expect, it } from 'vitest';
import { classifySmokeStep, infraOnlyFailure, infraDegradedDecision } from '../daemon-rebuild/smoke-classify/infra-degraded.mjs';

const ok = (name, extra = {}) => ({ name, ok: true, ...extra });
const bad = (name, detail, extra = {}) => ({ name, ok: false, detail, ...extra });
const smoke = (...results) => ({ verdict: 'code', smoke: { results } });

describe('classifySmokeStep', () => {
  it('classifies timeouts, gh 5xx, gh throttle no-slot and lane-acquire timeouts as infra', () => {
    expect(classifySmokeStep(bad('reconcile-dry-run', 'gh pr list: HTTP 504 Gateway Timeout', { mayBeTransient: true }))).toBe('infra');
    expect(classifySmokeStep(bad('x', 'HTTP 502', { mayBeTransient: true }))).toBe('infra');
    expect(classifySmokeStep(bad('dispatch-dry-run', 'gh-throttle: no slot available', { mayBeTransient: true }))).toBe('infra');
    expect(classifySmokeStep(bad('lane-acquire-release', 'lane acquire timed out after 300s', { mayBeTransient: true }))).toBe('infra');
    expect(classifySmokeStep(bad('y', 'timed out after 120s', { mayBeTransient: true }))).toBe('infra');
  });
  it('defaults to code: unknown text, or a check that runs code from the tree', () => {
    expect(classifySmokeStep(bad('z', 'TypeError: x is not a function', { mayBeTransient: true }))).toBe('code');
    expect(classifySmokeStep(bad('daemon-entries-boot', 'timed out after 120s', { mayBeTransient: false }))).toBe('code');
    expect(classifySmokeStep(bad('q', 'HTTP 504'))).toBe('code');
  });
});

describe('infraOnlyFailure', () => {
  it('true only when every failure is infra and every code-path step passed (not skipped)', () => {
    const r = smoke(ok('daemon-entries-boot', { mayBeTransient: false }), bad('reconcile-dry-run', 'HTTP 504', { mayBeTransient: true }));
    expect(infraOnlyFailure(r)).toBe(true);
  });
  it('false when a code step failed', () => {
    const r = smoke(bad('daemon-entries-boot', 'boom', { mayBeTransient: false }), bad('reconcile-dry-run', 'HTTP 504', { mayBeTransient: true }));
    expect(infraOnlyFailure(r)).toBe(false);
  });
  it('false when a code step was skipped (never proven)', () => {
    const r = smoke(ok('daemon-entries-boot', { mayBeTransient: false, skipReason: 'busy-pool' }), bad('a', 'HTTP 503', { mayBeTransient: true }));
    expect(infraOnlyFailure(r)).toBe(false);
  });
  it('false for a mixed infra + unclassified failure, and for no failures', () => {
    expect(infraOnlyFailure(smoke(bad('a', 'HTTP 503', { mayBeTransient: true }), bad('b', 'weird', { mayBeTransient: true })))).toBe(false);
    expect(infraOnlyFailure(smoke(ok('a')))).toBe(false);
  });
});

describe('infraDegradedDecision', () => {
  const r = smoke(ok('daemon-entries-boot', { mayBeTransient: false }), bad('reconcile-dry-run', 'HTTP 504', { mayBeTransient: true }));
  const env = { WE_DAEMON_REJECT_RETRY_BASE_MS: '1000' };
  it('blocks on a code failure and clears any counter', () => {
    const code = smoke(bad('daemon-entries-boot', 'boom', { mayBeTransient: false }));
    expect(infraDegradedDecision({ smokeResult: code, prior: { inputsKey: 'k', attempts: 2 }, inputsKey: 'k', nowMs: 0, env })).toMatchObject({ action: 'block', next: null });
  });
  it('retries with backoff on the first infra-only failure', () => {
    expect(infraDegradedDecision({ smokeResult: r, prior: null, inputsKey: 'k', nowMs: 0, env }))
      .toMatchObject({ action: 'retry', next: { inputsKey: 'k', attempts: 1, retryAt: 1000 } });
  });
  it('does not count another attempt inside the backoff window', () => {
    expect(infraDegradedDecision({ smokeResult: r, prior: { inputsKey: 'k', attempts: 1, retryAt: 1000 }, inputsKey: 'k', nowMs: 500, env }))
      .toMatchObject({ action: 'retry', next: { attempts: 1 } });
  });
  it('adopts as degraded after repeated infra-only failure', () => {
    const d = infraDegradedDecision({ smokeResult: r, prior: { inputsKey: 'k', attempts: 2, retryAt: 10 }, inputsKey: 'k', nowMs: 5000, env });
    expect(d).toMatchObject({ action: 'adopt', attempts: 3, failed: ['reconcile-dry-run'] });
  });
  it('resets the count when the inputs changed', () => {
    expect(infraDegradedDecision({ smokeResult: r, prior: { inputsKey: 'old', attempts: 2, retryAt: 0 }, inputsKey: 'k', nowMs: 5000, env }))
      .toMatchObject({ action: 'retry', next: { attempts: 1 } });
  });
});
