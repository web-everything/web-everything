/**
 * @file scripts/lib/__tests__/gh-throttle.test.mjs
 * @description Unit proof of the #3621 `gh`-call throttle wrapper: env-tuning resolution, the rate-limit
 *   classifier (mirrors `infra-blocked.mjs`'s already-incident-grounded regex), bounded exponential backoff,
 *   the concurrency semaphore (against a REAL temp lock root, mirroring `heavy-admission.test.mjs`'s own
 *   discipline of proving the atomic fs layer for real), and `runGhSync`'s retry/pass-through logic with a
 *   MOCKED `gh` exec (no real subprocess, no real `gh` binary needed) — the real, unmocked, side-by-side
 *   fidelity proof against the actual `gh` binary lives in `scripts/lib/__tests__/gh-throttle.fidelity.test.mjs`.
 *   Also proves #3670's addition: the per-minute points budget (a REAL temp lock root, same discipline as the
 *   concurrency semaphore) and the sidecar call/exhausted-retry log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  DEFAULT_GH_CONCURRENCY_CAP, DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS, DEFAULT_RETRY_CAP_MS,
  DEFAULT_GH_POINTS_BUDGET_PER_MIN, GH_POINTS_WINDOW_MS, DEFAULT_HEADER_WAIT_CAP_MS,
  DEFAULT_GH_WRITE_BUDGET_PER_MIN,
  resolveGhCap, resolveAcquireTimeoutMs, resolveRetryMaxAttempts, resolveGhPointsBudgetPerMin, resolveHeaderWaitCapMs,
  resolveGhWriteBudgetPerMin,
  isRateLimitShaped, retryBackoffMs,
  parseGhDebugResponseHeaders, parseGraphQLRateLimit, classifyRateLimitSignal, calibratedBackoffMs,
  acquireGhSlotSync, releaseGhSlotSync, ghThrottleStatus,
  decideGhPointsSpend, acquireGhPointsSync, ghThrottleLogPath, recordGhCallLogEntry,
  acquireGhWriteBudgetSync, classifyGhWrite, deriveGhCaller,
  runGhSync, execFileSyncThrottled, runGhCliPassthrough, stripGhDebug, scanGhApiFlags,
} from '../gh-throttle.mjs';

function readJsonl(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── env tuning ───────────────────────────────────────────────────────────────────────────────────────────
describe('resolveGhCap / resolveAcquireTimeoutMs / resolveRetryMaxAttempts — env override, clamped sane', () => {
  it('defaults when unset', () => {
    expect(resolveGhCap({})).toBe(DEFAULT_GH_CONCURRENCY_CAP);
    expect(resolveAcquireTimeoutMs({})).toBe(DEFAULT_ACQUIRE_TIMEOUT_MS);
    expect(resolveRetryMaxAttempts({})).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
  });
  it('reads the WE_GH_THROTTLE_* env vars', () => {
    expect(resolveGhCap({ WE_GH_THROTTLE_CAP: '3' })).toBe(3);
    expect(resolveAcquireTimeoutMs({ WE_GH_THROTTLE_ACQUIRE_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(resolveRetryMaxAttempts({ WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '2' })).toBe(2);
  });
  it('falls back on a non-finite or invalid value', () => {
    expect(resolveGhCap({ WE_GH_THROTTLE_CAP: 'nope' })).toBe(DEFAULT_GH_CONCURRENCY_CAP);
    expect(resolveGhCap({ WE_GH_THROTTLE_CAP: '0' })).toBe(DEFAULT_GH_CONCURRENCY_CAP);
    expect(resolveRetryMaxAttempts({ WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '0' })).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
  });
});

describe('resolveGhPointsBudgetPerMin — env override, clamped sane (#3670)', () => {
  it('defaults when unset', () => {
    expect(resolveGhPointsBudgetPerMin({})).toBe(DEFAULT_GH_POINTS_BUDGET_PER_MIN);
  });
  it('reads WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN', () => {
    expect(resolveGhPointsBudgetPerMin({ WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN: '50' })).toBe(50);
  });
  it('falls back on a non-finite or invalid value', () => {
    expect(resolveGhPointsBudgetPerMin({ WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN: 'nope' })).toBe(DEFAULT_GH_POINTS_BUDGET_PER_MIN);
    expect(resolveGhPointsBudgetPerMin({ WE_GH_THROTTLE_POINTS_BUDGET_PER_MIN: '0' })).toBe(DEFAULT_GH_POINTS_BUDGET_PER_MIN);
  });
});

// ── rate-limit classification — reused from infra-blocked.mjs, not re-guessed ──────────────────────────────
describe('isRateLimitShaped — real GitHub secondary/primary rate-limit phrasing', () => {
  it('matches the documented secondary-rate-limit phrasing', () => {
    expect(isRateLimitShaped('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)')).toBe(true);
  });
  it('matches the documented primary-rate-limit phrasing', () => {
    expect(isRateLimitShaped('API rate limit exceeded for installation ID 123.')).toBe(true);
  });
  it('matches the abuse-detection phrasing (GitHub’s older secondary-limit wording)', () => {
    expect(isRateLimitShaped('You have triggered an abuse detection mechanism.')).toBe(true);
  });
  it('does NOT match an unrelated gh failure (a genuine error must fail open, not loop a doomed retry)', () => {
    expect(isRateLimitShaped('gh: pull request #123 already exists')).toBe(false);
    expect(isRateLimitShaped('gh: HTTP 404: Not Found')).toBe(false);
    expect(isRateLimitShaped('')).toBe(false);
    expect(isRateLimitShaped(null)).toBe(false);
    expect(isRateLimitShaped(undefined)).toBe(false);
  });
});

describe('retryBackoffMs — bounded exponential, never instant and never unbounded', () => {
  it('doubles per attempt from the base', () => {
    expect(retryBackoffMs(1, { baseMs: 1000, factor: 2, capMs: 60000 })).toBe(1000);
    expect(retryBackoffMs(2, { baseMs: 1000, factor: 2, capMs: 60000 })).toBe(2000);
    expect(retryBackoffMs(3, { baseMs: 1000, factor: 2, capMs: 60000 })).toBe(4000);
  });
  it('never exceeds the cap however large the attempt', () => {
    expect(retryBackoffMs(20, { baseMs: 1000, factor: 2, capMs: 60000 })).toBe(60000);
  });
  it('is never zero — a rate-limit retry is never instant', () => {
    expect(retryBackoffMs(1)).toBe(DEFAULT_RETRY_BASE_MS);
    expect(retryBackoffMs(1)).toBeGreaterThan(0);
  });
  it('clamps a sub-1 attempt to attempt 1 (defensive — never a negative exponent)', () => {
    expect(retryBackoffMs(0)).toBe(DEFAULT_RETRY_BASE_MS);
    expect(retryBackoffMs(-5)).toBe(DEFAULT_RETRY_BASE_MS);
  });
  it('honors an explicit cap smaller than the default', () => {
    expect(retryBackoffMs(10, { capMs: 5000 })).toBeLessThanOrEqual(5000);
  });
});

// ── self-calibration against GitHub's REAL rate-limit signals ──────────────────────────────────────────────
const SECONDARY_TRACE = [
  '* Request to https://api.github.com/repos/o/n/pulls',
  '> POST /repos/o/n/pulls HTTP/1.1',
  '< HTTP/2.0 403 Forbidden',
  '< Content-Type: application/json; charset=utf-8',
  '< Retry-After: 42',
  '< X-Ratelimit-Limit: 5000',
  '< X-Ratelimit-Remaining: 4999',
  '< X-Ratelimit-Reset: 1789343473',
  '',
  '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
  '',
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
].join('\n');

const PRIMARY_EXHAUSTED_TRACE = [
  '* Request to https://api.github.com/repos/o/n/pulls',
  '> POST /repos/o/n/pulls HTTP/1.1',
  '< HTTP/2.0 403 Forbidden',
  '< X-Ratelimit-Limit: 5000',
  '< X-Ratelimit-Remaining: 0',
  '< X-Ratelimit-Reset: 2000000000',
  '',
  '{"message":"API rate limit exceeded for installation ID 123."}',
  '',
  'gh: API rate limit exceeded for installation ID 123. (HTTP 403)',
].join('\n');

describe('parseGhDebugResponseHeaders — GH_DEBUG=api trace parsing', () => {
  it('extracts the LAST response block\'s headers, lowercased', () => {
    const headers = parseGhDebugResponseHeaders(SECONDARY_TRACE);
    expect(headers['retry-after']).toBe('42');
    expect(headers['x-ratelimit-remaining']).toBe('4999');
    expect(headers['x-ratelimit-reset']).toBe('1789343473');
  });

  it('returns {} on text with no HTTP response block (e.g. no GH_DEBUG was set)', () => {
    expect(parseGhDebugResponseHeaders('gh: pull request #9 already exists')).toEqual({});
    expect(parseGhDebugResponseHeaders('')).toEqual({});
    expect(parseGhDebugResponseHeaders(null)).toEqual({});
  });

  it('takes the LAST of multiple response blocks (an internal gh retry before the final failure)', () => {
    const twoBlocks = [
      '< HTTP/2.0 500 Internal Server Error',
      '< X-Ratelimit-Remaining: 10',
      '',
      '< HTTP/2.0 403 Forbidden',
      '< Retry-After: 7',
      '',
    ].join('\n');
    expect(parseGhDebugResponseHeaders(twoBlocks)).toEqual({ 'retry-after': '7' });
  });
});

describe('parseGraphQLRateLimit — the in-band `rateLimit` field, when a query asks for one', () => {
  it('reads limit/remaining/resetAt/cost when present', () => {
    const body = JSON.stringify({ data: { rateLimit: { limit: 5000, cost: 1, remaining: 4998, resetAt: '2026-09-13T23:00:00Z' } } });
    const rl = parseGraphQLRateLimit(body);
    expect(rl.limit).toBe(5000);
    expect(rl.remaining).toBe(4998);
    expect(rl.cost).toBe(1);
    expect(rl.resetEpochSec).toBe(Math.floor(Date.parse('2026-09-13T23:00:00Z') / 1000));
  });
  it('returns null when absent/unparseable (no query requested it)', () => {
    expect(parseGraphQLRateLimit('{"data":{}}')).toBeNull();
    expect(parseGraphQLRateLimit('not json')).toBeNull();
    expect(parseGraphQLRateLimit(null)).toBeNull();
  });
});

describe('classifyRateLimitSignal — primary vs secondary, NEVER conflated', () => {
  it('a Retry-After header is UNCONDITIONALLY secondary, even alongside primary headroom', () => {
    const signal = classifyRateLimitSignal({ 'retry-after': '42', 'x-ratelimit-remaining': '4999' });
    expect(signal.kind).toBe('secondary');
    expect(signal.retryAfterRaw).toBe('42');
  });
  it('x-ratelimit-remaining:0 with a reset, and NO retry-after, is primary', () => {
    const signal = classifyRateLimitSignal({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' });
    expect(signal.kind).toBe('primary');
    expect(signal.resetEpochSec).toBe(2000000000);
  });
  it('remaining > 0 with no retry-after is neither — "none" (nothing to calibrate from)', () => {
    expect(classifyRateLimitSignal({ 'x-ratelimit-remaining': '10' }).kind).toBe('none');
    expect(classifyRateLimitSignal({}).kind).toBe('none');
  });
});

describe('calibratedBackoffMs — GitHub\'s own told wait beats a guess; falls back when there is no real signal', () => {
  it('secondary: honors Retry-After (seconds → ms), capped by headerCapMs', () => {
    const headers = parseGhDebugResponseHeaders(SECONDARY_TRACE);
    const r = calibratedBackoffMs({ headers, attempt: 1, nowMs: 0, headerCapMs: 60_000 });
    expect(r.source).toBe('secondary-retry-after');
    expect(r.ms).toBe(42_000);
  });
  it('primary: waits until the reset epoch, capped by headerCapMs', () => {
    const headers = parseGhDebugResponseHeaders(PRIMARY_EXHAUSTED_TRACE);
    const nowMs = 2_000_000_000_000 - 5_000; // 5s before the reset
    const r = calibratedBackoffMs({ headers, attempt: 1, nowMs, headerCapMs: 10 * 60_000 });
    expect(r.source).toBe('primary-reset');
    expect(r.ms).toBe(5_000);
  });
  it('falls back to the GUESSED exponential backoff when no header signal is present (calibration off, or no trace)', () => {
    const r = calibratedBackoffMs({ headers: {}, attempt: 2, tuning: { baseMs: 100, factor: 2, capMs: 10_000 } });
    expect(r.source).toBe('guessed-backoff');
    expect(r.ms).toBe(retryBackoffMs(2, { baseMs: 100, factor: 2, capMs: 10_000 }));
  });
  it('a header-derived wait is capped by headerCapMs even when GitHub asks for longer', () => {
    const headers = { 'retry-after': '9999' };
    const r = calibratedBackoffMs({ headers, attempt: 1, nowMs: 0, headerCapMs: 5_000 });
    expect(r.ms).toBe(5_000);
  });
});

describe('resolveHeaderWaitCapMs — env override, clamped sane', () => {
  it('defaults when unset', () => {
    expect(resolveHeaderWaitCapMs({})).toBe(DEFAULT_HEADER_WAIT_CAP_MS);
  });
  it('reads WE_GH_THROTTLE_HEADER_WAIT_CAP_MS', () => {
    expect(resolveHeaderWaitCapMs({ WE_GH_THROTTLE_HEADER_WAIT_CAP_MS: '1000' })).toBe(1000);
  });
});

describe('runGhSync — calibrateHeaders opt-in: a real Retry-After beats the guessed backoff', () => {
  it('is OFF by default — a plain rate-limit-shaped failure with no GH_DEBUG trace still uses the guessed backoff', () => {
    const exec = vi.fn(() => { const e = new Error('fail'); e.stderr = 'secondary rate limit hit'; throw e; });
    const sleepCalls = [];
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    try {
      runGhSync(['pr', 'create'], { throttle: { lockRoot, cap: 2, sleep: (ms) => sleepCalls.push(ms), exec, maxAttempts: 2, retryBaseMs: 100 } });
    } catch { /* exhausts after 2 attempts — expected */ }
    expect(sleepCalls).toEqual([100]); // the plain guessed backoff, unaffected by calibration machinery
  });

  it('ON: a rate-limit failure whose stderr carries a real Retry-After (via the injected exec) backs off by THAT wait', () => {
    let calls = 0;
    const exec = vi.fn((args, opts) => {
      calls += 1;
      if (calls === 1) { const e = new Error('fail'); e.stderr = SECONDARY_TRACE; throw e; }
      return 'https://github.com/o/n/pull/1';
    });
    const sleepCalls = [];
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const out = runGhSync(['pr', 'create'], {
      throttle: { lockRoot, cap: 2, sleep: (ms) => sleepCalls.push(ms), exec, maxAttempts: 3, calibrateHeaders: true, op: 'pr-create' },
    });
    expect(out).toBe('https://github.com/o/n/pull/1');
    expect(sleepCalls).toEqual([42_000]); // Retry-After: 42, taken verbatim — not the guessed 2000ms default
  });

  it('ON: adds GH_DEBUG=api to the exec env, unless the caller already set one', () => {
    const seenOpts = [];
    const exec = vi.fn((args, opts) => { seenOpts.push(opts); return 'ok'; });
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    runGhSync(['pr', 'create'], { encoding: 'utf8', throttle: { lockRoot, cap: 2, sleep: () => {}, exec, calibrateHeaders: true } });
    expect(seenOpts[0].env.GH_DEBUG).toBe('api');

    const seenOpts2 = [];
    const exec2 = vi.fn((args, opts) => { seenOpts2.push(opts); return 'ok'; });
    runGhSync(['pr', 'create'], {
      env: { GH_DEBUG: 'oauth' }, throttle: { lockRoot: mkdtempSync(join(tmpdir(), 'gh-t-')), cap: 2, sleep: () => {}, exec: exec2, calibrateHeaders: true },
    });
    expect(seenOpts2[0].env.GH_DEBUG).toBe('oauth'); // never overridden once the caller set its own
  });

  it('OFF by default: does NOT add GH_DEBUG (the fidelity contract for existing adopters stays untouched)', () => {
    const seenOpts = [];
    const exec = vi.fn((args, opts) => { seenOpts.push(opts); return 'ok'; });
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    runGhSync(['pr', 'view', '1'], { encoding: 'utf8', throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    expect(seenOpts[0]).toEqual({ encoding: 'utf8' }); // exactly what was passed in, no env added at all
  });
});

// ── the concurrency semaphore — REAL temp lock root, mirrors heavy-admission.test.mjs ──────────────────────
describe('acquireGhSlotSync / releaseGhSlotSync — cap-independent slots over a real lock root', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'gh-throttle-test-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('admits up to cap concurrent owners synchronously, then times out (fail OPEN) on a (cap+1)th', () => {
    const cap = 2;
    let clock = 0;
    const now = () => clock;
    const sleep = (ms) => { clock += ms; };
    const a = acquireGhSlotSync({ lockRoot, cap, reservedBackgroundSlots: 0, owner: 'A', now, sleep, timeoutMs: 10 });
    const b = acquireGhSlotSync({ lockRoot, cap, reservedBackgroundSlots: 0, owner: 'B', now, sleep, timeoutMs: 10 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(new Set([a.slot, b.slot]).size).toBe(2);

    const c = acquireGhSlotSync({ lockRoot, cap, reservedBackgroundSlots: 0, owner: 'C', now, sleep, pollMs: 5, timeoutMs: 20 });
    expect(c.ok).toBe(false);
    expect(c.timedOut).toBe(true);
    expect(ghThrottleStatus({ lockRoot, cap }).heldCount).toBe(2);
  });

  it('release frees the slot for a new owner', () => {
    const cap = 1;
    const now = () => 0;
    const sleep = () => {};
    const a = acquireGhSlotSync({ lockRoot, cap, owner: 'A', now, sleep, timeoutMs: 10 });
    expect(a.ok).toBe(true);
    releaseGhSlotSync({ lockRoot, cap, owner: 'A' });
    expect(ghThrottleStatus({ lockRoot, cap }).heldCount).toBe(0);
    const b = acquireGhSlotSync({ lockRoot, cap, owner: 'B', now, sleep, timeoutMs: 10 });
    expect(b.ok).toBe(true);
  });

  it('the gh-throttle lock root is a SIBLING of, never inside, heavy-admission’s own root', async () => {
    const { admissionLockRoot } = await import('../../readiness/heavy-admission.mjs');
    const { ghThrottleLockRoot } = await import('../gh-throttle.mjs');
    const heavy = admissionLockRoot('/some/checkout', {});
    const gh = ghThrottleLockRoot('/some/checkout', {});
    expect(gh).not.toBe(heavy);
    expect(gh.endsWith(join('.admission', 'gh'))).toBe(true);
    expect(heavy.endsWith(join('.admission', 'heavy'))).toBe(true);
  });
});

// ── runGhSync — the importable, transparent, mocked-exec retry/pass-through proof ──────────────────────────
function ghError({ status = 1, stderr = '', message = '' } = {}) {
  const e = new Error(message || `Command failed: gh (exit ${status})`);
  e.status = status;
  e.stderr = stderr;
  return e;
}

describe('runGhSync — transparent success pass-through', () => {
  it('returns exactly what exec returns, no retry, on a clean success', () => {
    const exec = vi.fn(() => 'hello stdout');
    const out = runGhSync(['pr', 'view', '1'], { throttle: { lockRoot: mkdtempSync(join(tmpdir(), 'gh-t-')), cap: 2, sleep: () => {}, exec } });
    expect(out).toBe('hello stdout');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('passes `args` and the real execOpts through to exec UNCHANGED, with `throttle` stripped', () => {
    const exec = vi.fn(() => 'ok');
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    runGhSync(['api', 'rate_limit'], { encoding: 'utf8', maxBuffer: 123, throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    expect(exec).toHaveBeenCalledWith(['api', 'rate_limit'], { encoding: 'utf8', maxBuffer: 123 });
  });
});

describe('runGhSync — a NON-rate-limit failure is never retried, and re-thrown byte-identical', () => {
  it('throws the exact original error object after exactly one attempt', () => {
    const original = ghError({ status: 1, stderr: 'gh: pull request #9 already exists' });
    const exec = vi.fn(() => { throw original; });
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    let caught = null;
    try {
      runGhSync(['pr', 'create'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    } catch (e) { caught = e; }
    expect(caught).toBe(original);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('runGhSync — a rate-limit-shaped failure backs off and retries, bounded', () => {
  it('retries with a real, bounded exponential backoff and eventually succeeds', () => {
    let calls = 0;
    const exec = vi.fn(() => {
      calls += 1;
      if (calls < 3) throw ghError({ status: 1, stderr: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' });
      return 'succeeded on attempt 3';
    });
    const sleepCalls = [];
    const sleep = (ms) => sleepCalls.push(ms);
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const out = runGhSync(['pr', 'list'], {
      throttle: { lockRoot, cap: 2, sleep, exec, maxAttempts: 5, retryBaseMs: 100, retryCapMs: 10000 },
    });
    expect(out).toBe('succeeded on attempt 3');
    expect(exec).toHaveBeenCalledTimes(3);
    // Two backoff sleeps (before attempt 2 and attempt 3), STRICTLY increasing (never instant, doubling).
    expect(sleepCalls.length).toBe(2);
    expect(sleepCalls[0]).toBe(100);
    expect(sleepCalls[1]).toBe(200);
  });

  it('gives up after maxAttempts and re-throws the LAST real failure unchanged', () => {
    const errors = [
      ghError({ status: 1, stderr: 'secondary rate limit hit #1' }),
      ghError({ status: 1, stderr: 'secondary rate limit hit #2' }),
      ghError({ status: 1, stderr: 'secondary rate limit hit #3 — the final, re-thrown one' }),
    ];
    let calls = 0;
    const exec = vi.fn(() => { const e = errors[calls]; calls += 1; throw e; });
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    let caught = null;
    try {
      runGhSync(['pr', 'list'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec, maxAttempts: 3, retryBaseMs: 1 } });
    } catch (e) { caught = e; }
    expect(caught).toBe(errors[2]);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('releases its concurrency slot BEFORE sleeping between retries — a backoff never idles a scarce slot', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const cap = 1;
    let calls = 0;
    const exec = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw ghError({ status: 1, stderr: 'secondary rate limit' });
      return 'ok';
    });
    const sleep = vi.fn((_ms) => {
      // While "sleeping" (mid-retry, between attempt 1 and 2), the slot must be FREE for another owner.
      const status = ghThrottleStatus({ lockRoot, cap });
      expect(status.heldCount).toBe(0);
    });
    const out = runGhSync(['pr', 'list'], { throttle: { lockRoot, cap, sleep, exec, maxAttempts: 3, retryBaseMs: 1 } });
    expect(out).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

// ── execFileSyncThrottled — the execFileSync(file, args, opts)-shaped adapter ───────────────────────────────
describe('execFileSyncThrottled', () => {
  it('delegates to runGhSync (and therefore the throttle) when file === "gh"', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'throttled-out');
    const out = execFileSyncThrottled('gh', ['run', 'list'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    expect(out).toBe('throttled-out');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('falls through to the REAL execFileSync for any other binary (defensive — never used by a real caller)', () => {
    const out = execFileSyncThrottled('node', ['-e', 'process.stdout.write("plain")'], { encoding: 'utf8' });
    expect(out).toBe('plain');
  });
});

// ── runGhCliPassthrough — the process-level transparency contract, with an INJECTED spawn ────────────────────
describe('runGhCliPassthrough — full-process transparency, injected spawn', () => {
  it('relays a successful child’s stdout, stderr, and exit status untouched', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('out-bytes'), stderr: Buffer.from('warn-bytes'), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const r = runGhCliPassthrough(['pr', 'view', '1'], { throttle: { lockRoot, cap: 2, sleep: () => {} }, spawn });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('out-bytes');
    expect(r.stderr.toString()).toBe('warn-bytes'); // stderr survives a SUCCESSFUL call — the execFileSync gap this mode exists to avoid
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limit-shaped nonzero exit, then relays the eventual success', () => {
    let calls = 0;
    const spawn = vi.fn(() => {
      calls += 1;
      if (calls < 2) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('You have exceeded a secondary rate limit.'), error: null };
      return { status: 0, stdout: Buffer.from('finally'), stderr: Buffer.alloc(0), error: null };
    });
    const sleep = vi.fn();
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const r = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, cap: 2, sleep, maxAttempts: 3, retryBaseMs: 1 }, spawn });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('finally');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('relays a NON-rate-limit nonzero exit immediately, with no retry', () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('gh: pull request #9 already exists'), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const r = runGhCliPassthrough(['pr', 'create'], { throttle: { lockRoot, cap: 2, sleep: () => {} }, spawn });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toBe('gh: pull request #9 already exists');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('re-throws a spawn-level error (e.g. gh not on PATH) rather than misreading it as a gh-level failure', () => {
    const spawnErr = new Error('ENOENT');
    const spawn = vi.fn(() => ({ status: null, stdout: null, stderr: null, error: spawnErr }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    expect(() => runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, cap: 2, sleep: () => {} }, spawn })).toThrow(spawnErr);
  });
});

// ── decideGhPointsSpend — the PURE budget-window decision (#3670) ────────────────────────────────────────────
describe('decideGhPointsSpend — pure fixed-window token-bucket decision', () => {
  it('allows a call that fits the budget, on a fresh (null) window', () => {
    const r = decideGhPointsSpend({ state: null, points: 4, nowMs: 1_000, budgetPerMin: 10, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.nextState).toEqual({ windowStartMs: 1_000, spent: 4 });
  });

  it('accumulates spend within the same window', () => {
    const state = { windowStartMs: 1_000, spent: 4 };
    const r = decideGhPointsSpend({ state, points: 4, nowMs: 1_500, budgetPerMin: 10, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.nextState).toEqual({ windowStartMs: 1_000, spent: 8 });
  });

  it('disallows a call that would push spend over budget, and reports how long until the window rolls over', () => {
    const state = { windowStartMs: 1_000, spent: 8 };
    const r = decideGhPointsSpend({ state, points: 4, nowMs: 1_500, budgetPerMin: 10, windowMs: 60_000 });
    expect(r.allowed).toBe(false);
    expect(r.nextState).toEqual({ windowStartMs: 1_000, spent: 8 }); // unchanged — nothing was spent
    expect(r.waitMs).toBe(60_000 - 500);
  });

  it('a window whose age has reached windowMs rolls over BEFORE the budget check, even from a maxed-out prior window', () => {
    const state = { windowStartMs: 1_000, spent: 10 };
    const r = decideGhPointsSpend({ state, points: 10, nowMs: 61_000, budgetPerMin: 10, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.nextState).toEqual({ windowStartMs: 61_000, spent: 10 });
  });
});

// ── acquireGhPointsSync — the cross-process points-budget gate, REAL temp lock root ───────────────────────────
describe('acquireGhPointsSync — cross-process points budget over a real lock root (#3670)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'gh-throttle-budget-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('admits a call that fits the budget immediately (waitedMs 0, no sleep)', () => {
    const sleep = vi.fn();
    const r = acquireGhPointsSync({ lockRoot, points: 1, budgetPerMin: 5, owner: 'A', now: () => 0, sleep });
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a call beyond the per-minute points budget WAITS instead of firing — it only succeeds once the window rolls over', () => {
    let clock = 0;
    const now = () => clock;
    const sleepCalls = [];
    const sleep = (ms) => { sleepCalls.push(ms); clock += ms; };
    const windowMs = 100;
    const common = { lockRoot, budgetPerMin: 2, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 10_000, windowMs };

    // First two calls (1 point each) fit the 2-point budget and fire immediately.
    expect(acquireGhPointsSync({ ...common, points: 1 }).ok).toBe(true);
    expect(acquireGhPointsSync({ ...common, points: 1 }).ok).toBe(true);
    expect(sleepCalls.length).toBe(0);

    // A third call is over budget for the CURRENT window — it must wait (sleep called at least once) rather
    // than fire immediately, and it only succeeds once the fake clock has advanced past the window boundary.
    const r3 = acquireGhPointsSync({ ...common, points: 1 });
    expect(r3.ok).toBe(true);
    expect(r3.timedOut).toBe(false);
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(r3.waitedMs).toBeGreaterThan(0);
    expect(clock).toBeGreaterThanOrEqual(windowMs);
  });

  it('fails OPEN (ok:false, timedOut:true) if the budget never clears within timeoutMs — mirrors acquireGhSlotSync', () => {
    let clock = 0;
    const now = () => clock;
    const sleep = (ms) => { clock += ms; };
    // budget already exhausted for a window far longer than the timeout — it can never roll over in time.
    const r1 = acquireGhPointsSync({ lockRoot, points: 5, budgetPerMin: 5, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 10_000, windowMs: 60_000 });
    expect(r1.ok).toBe(true);
    const r2 = acquireGhPointsSync({ lockRoot, points: 1, budgetPerMin: 5, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 50, windowMs: 60_000 });
    expect(r2.ok).toBe(false);
    expect(r2.timedOut).toBe(true);
  });

  it('the budget is host-shared across DIFFERENT owners (a real cross-process gate, not per-owner)', () => {
    const r1 = acquireGhPointsSync({ lockRoot, points: 3, budgetPerMin: 4, owner: 'A', now: () => 0, sleep: vi.fn() });
    expect(r1.ok).toBe(true);
    let clock = 0;
    const sleepCalls = [];
    const r2 = acquireGhPointsSync({
      lockRoot, points: 3, budgetPerMin: 4, owner: 'B', now: () => clock,
      sleep: (ms) => { sleepCalls.push(ms); clock += ms; }, pollMs: 10, timeoutMs: 1000, windowMs: 100,
    });
    // owner B's call would push total spend (3+3=6) over the shared 4-point budget — it must wait, proving
    // the two owners share ONE window rather than each getting their own.
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(r2.ok).toBe(true);
  });
});

// ── #gh-write-burst — classifyGhWrite / deriveGhCaller / the write-only budget ──────────────────────────────
describe('resolveGhWriteBudgetPerMin — env override, clamped sane', () => {
  it('defaults, ignores garbage, floors a fractional override, rejects < 1', () => {
    expect(resolveGhWriteBudgetPerMin({})).toBe(DEFAULT_GH_WRITE_BUDGET_PER_MIN);
    expect(resolveGhWriteBudgetPerMin({ WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN: 'nope' })).toBe(DEFAULT_GH_WRITE_BUDGET_PER_MIN);
    expect(resolveGhWriteBudgetPerMin({ WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN: '12.9' })).toBe(12);
    expect(resolveGhWriteBudgetPerMin({ WE_GH_THROTTLE_WRITE_BUDGET_PER_MIN: '0' })).toBe(DEFAULT_GH_WRITE_BUDGET_PER_MIN);
  });
});

describe('classifyGhWrite — mutation vs read, PURE', () => {
  it('pr: edit/comment/close/merge/reopen/ready/create/review are writes, view/list/diff/checks are not', () => {
    expect(classifyGhWrite(['pr', 'edit', '123'])).toBe(true);
    expect(classifyGhWrite(['pr', 'comment', '123'])).toBe(true);
    expect(classifyGhWrite(['pr', 'merge', '123'])).toBe(true);
    expect(classifyGhWrite(['pr', 'view', '123'])).toBe(false);
    expect(classifyGhWrite(['pr', 'list'])).toBe(false);
    expect(classifyGhWrite(['pr', 'diff', '123'])).toBe(false);
  });

  it('label create/delete/edit are writes; run list is not, run cancel/rerun are', () => {
    expect(classifyGhWrite(['label', 'create', 'x'])).toBe(true);
    expect(classifyGhWrite(['run', 'list'])).toBe(false);
    expect(classifyGhWrite(['run', 'cancel', '1'])).toBe(true);
  });

  it('api: an explicit --method decides (GET/HEAD are reads, everything else is a write)', () => {
    expect(classifyGhWrite(['api', '--method', 'GET', 'repos/o/r'])).toBe(false);
    expect(classifyGhWrite(['api', '--method', 'get', 'repos/o/r'])).toBe(false); // case-insensitive
    expect(classifyGhWrite(['api', '--method', 'PATCH', 'repos/o/r'])).toBe(true);
    expect(classifyGhWrite(['api', '--method', 'POST', 'repos/o/r'])).toBe(true);
  });

  it('api: no --method falls back to gh\'s own POST-on-a-field-flag inference', () => {
    expect(classifyGhWrite(['api', 'repos/o/r'])).toBe(false); // no method, no field flag → gh defaults to GET
    expect(classifyGhWrite(['api', 'repos/o/r/labels', '-f', 'name=x'])).toBe(true); // -f → gh defaults to POST
    expect(classifyGhWrite(['api', 'repos/o/r', '-F', 'per_page=100'])).toBe(true);
  });

  it('an unrecognized subcommand is never classified as a write (safe default: never over-throttle)', () => {
    expect(classifyGhWrite(['repo', 'view'])).toBe(false);
    expect(classifyGhWrite([])).toBe(false);
    expect(classifyGhWrite(undefined)).toBe(false);
  });
});

describe('deriveGhCaller — attribution precedence: explicit override > GH_CALLER env > argv[1] basename > "unknown"', () => {
  it('an explicit throttle.caller wins over everything', () => {
    expect(deriveGhCaller({ caller: 'explicit-caller' }, { GH_CALLER: 'env-caller' })).toBe('explicit-caller');
  });

  it('GH_CALLER env wins when no explicit override is given', () => {
    expect(deriveGhCaller({}, { GH_CALLER: 'parked-pr-conflict-watch-we' })).toBe('parked-pr-conflict-watch-we');
  });

  it('falls back to this process\'s own argv[1] basename when neither is set (in-process mechanical passes get this for free)', () => {
    expect(deriveGhCaller({}, {})).toBe(basename(process.argv[1] || ''));
  });
});

// ── acquireGhWriteBudgetSync — the SEPARATE write-only budget gate, REAL temp lock root (#gh-write-burst) ─────
describe('acquireGhWriteBudgetSync — cross-process WRITE budget over a real lock root, independent of the points budget', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'gh-throttle-write-budget-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('admits a write that fits the budget immediately', () => {
    const sleep = vi.fn();
    const r = acquireGhWriteBudgetSync({ lockRoot, budgetPerMin: 5, owner: 'A', now: () => 0, sleep });
    expect(r.ok).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a write past the per-minute WRITE budget WAITS instead of firing — the #gh-write-burst fix itself', () => {
    let clock = 0;
    const now = () => clock;
    const sleepCalls = [];
    const sleep = (ms) => { sleepCalls.push(ms); clock += ms; };
    const windowMs = 100;
    const common = { lockRoot, budgetPerMin: 2, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 10_000, windowMs };

    expect(acquireGhWriteBudgetSync(common).ok).toBe(true);
    expect(acquireGhWriteBudgetSync(common).ok).toBe(true);
    expect(sleepCalls.length).toBe(0);

    const r3 = acquireGhWriteBudgetSync(common); // third write in the window — over budget, must queue
    expect(r3.ok).toBe(true);
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(clock).toBeGreaterThanOrEqual(windowMs);
  });

  it('fails OPEN on timeout, mirroring every other gate in this module', () => {
    let clock = 0;
    const now = () => clock;
    const sleep = (ms) => { clock += ms; };
    const r1 = acquireGhWriteBudgetSync({ lockRoot, budgetPerMin: 1, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 10_000, windowMs: 60_000 });
    expect(r1.ok).toBe(true);
    const r2 = acquireGhWriteBudgetSync({ lockRoot, budgetPerMin: 1, owner: 'A', now, sleep, pollMs: 10, timeoutMs: 50, windowMs: 60_000 });
    expect(r2.ok).toBe(false);
    expect(r2.timedOut).toBe(true);
  });

  it('is INDEPENDENT of the points budget — exhausting one never blocks the other', () => {
    // Points budget exhausted...
    expect(acquireGhPointsSync({ lockRoot, points: 5, budgetPerMin: 5, owner: 'A', now: () => 0, sleep: vi.fn() }).ok).toBe(true);
    // ...but the write budget, a separate ledger under the same lock root, is untouched.
    const r = acquireGhWriteBudgetSync({ lockRoot, budgetPerMin: 5, owner: 'A', now: () => 0, sleep: vi.fn() });
    expect(r.ok).toBe(true);
  });
});

// ── the sidecar call/exhausted-retry log (#3670) ────────────────────────────────────────────────────────────
describe('recordGhCallLogEntry — best-effort JSONL append', () => {
  it('appends one JSON line per call, carrying op/attempt/points/outcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-throttle-log-'));
    const logPath = join(dir, 'calls.jsonl');
    try {
      recordGhCallLogEntry(logPath, { op: 'pr view', attempt: 1, points: 1, outcome: 'call', ok: true });
      recordGhCallLogEntry(logPath, { op: 'pr list', attempt: 1, points: 4, outcome: 'call', ok: true });
      const entries = readJsonl(logPath);
      expect(entries.length).toBe(2);
      expect(entries[0]).toMatchObject({ op: 'pr view', attempt: 1, points: 1, outcome: 'call', ok: true });
      expect(entries[1]).toMatchObject({ op: 'pr list', attempt: 1, points: 4, outcome: 'call', ok: true });
      expect(typeof entries[0].ts).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws — a bad path is swallowed (best-effort, a logging failure must never break a gh call)', () => {
    expect(() => recordGhCallLogEntry('/nonexistent-dir-xyz/calls.jsonl', { op: 'x', attempt: 1, points: 1, outcome: 'call' })).not.toThrow();
  });
});

describe('runGhSync — points budget + sidecar log wiring (#3670)', () => {
  it('gates each attempt on the points budget, and logs a "call" entry per attempt', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'ok');
    let clock = 0;
    const now = () => clock;
    const sleepCalls = [];
    const sleep = (ms) => { sleepCalls.push(ms); clock += ms; };
    const common = { lockRoot, cap: 2, sleep, now, exec, owner: 'same-owner', budgetPerMin: 1, points: 1, pollMs: 10, pointsWindowMs: 100, op: 'pr-view' };

    runGhSync(['pr', 'view', '1'], { throttle: common });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sleepCalls.length).toBe(0); // first call fits the 1-point budget immediately

    runGhSync(['pr', 'view', '2'], { throttle: common });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sleepCalls.length).toBeGreaterThan(0); // second call had to wait for the window to roll over

    const entries = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.op === 'pr-view' && e.outcome === 'call' && e.ok === true)).toBe(true);
  });

  it('appends a retry_exhausted entry (in addition to each attempt\'s own "call" entry) when retries give up', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => { const e = new Error('fail'); e.stderr = 'secondary rate limit hit'; throw e; });
    const sleep = vi.fn();
    let caught = null;
    try {
      runGhSync(['pr', 'create'], { throttle: { lockRoot, cap: 2, sleep, exec, maxAttempts: 2, retryBaseMs: 1, op: 'pr-create' } });
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();

    const entries = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entries.filter((e) => e.outcome === 'call').length).toBe(2); // one per attempt
    const exhausted = entries.filter((e) => e.outcome === 'retry_exhausted');
    expect(exhausted.length).toBe(1);
    expect(exhausted[0].attempt).toBe(2);
    expect(exhausted[0].op).toBe('pr-create');
  });

  it('a non-rate-limit failure logs one "call" entry and no retry_exhausted entry (never retried)', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => { const e = new Error('fail'); e.stderr = 'gh: pull request #9 already exists'; throw e; });
    try {
      runGhSync(['pr', 'create'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    } catch { /* expected */ }
    const entries = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entries.length).toBe(1);
    expect(entries[0].outcome).toBe('call');
    expect(entries[0].ok).toBe(false);
  });
});

// ── #gh-write-burst — the write-only budget and caller attribution, wired through runGhSync/runGhCliPassthrough
describe('runGhSync — write budget + caller attribution (#gh-write-burst)', () => {
  it('logs caller and w:true on a mutation, w:false on a read — the classification calls.jsonl now carries', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'ok');
    runGhSync(['pr', 'view', '1'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec, caller: 'test-caller' } });
    runGhSync(['pr', 'edit', '1', '--add-label', 'x'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec, caller: 'test-caller' } });
    const entries = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entries.every((e) => e.caller === 'test-caller')).toBe(true);
    expect(entries.find((e) => e.op === 'pr view').w).toBe(false);
    expect(entries.find((e) => e.op === 'pr edit').w).toBe(true);
  });

  it('a caller with no explicit caller/GH_CALLER still gets ITS OWN argv[1] basename, never "unknown", for an in-process call', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'ok');
    runGhSync(['pr', 'view', '1'], { throttle: { lockRoot, cap: 2, sleep: () => {}, exec, env: {} } });
    const [entry] = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entry.caller).toBe(basename(process.argv[1] || ''));
  });

  it('a mutation past the WRITE budget queues (sleeps) even though the points budget alone would have let it through', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'ok');
    let clock = 0;
    const now = () => clock;
    const sleepCalls = [];
    const sleep = (ms) => { sleepCalls.push(ms); clock += ms; };
    // A generous points budget (100/min) but a tight write budget (1/min) — proves the two gates are independent
    // and that the write gate is the one that actually queues the burst this incident's fix targets.
    const common = {
      lockRoot, cap: 2, sleep, now, exec, owner: 'same-owner',
      budgetPerMin: 100, points: 1, writeBudgetPerMin: 1, pollMs: 10, pointsWindowMs: 100, op: 'pr-edit',
    };
    runGhSync(['pr', 'edit', '1'], { throttle: common });
    expect(sleepCalls.length).toBe(0); // first write fits the 1-write budget immediately
    runGhSync(['pr', 'edit', '2'], { throttle: common });
    expect(sleepCalls.length).toBeGreaterThan(0); // second write in the same window must queue
  });

  it('a READ is never gated by the write budget, however tight — only classifyGhWrite-true calls consult it', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const exec = vi.fn(() => 'ok');
    const sleep = vi.fn();
    const common = { lockRoot, cap: 2, sleep, exec, owner: 'same-owner', budgetPerMin: 100, points: 1, writeBudgetPerMin: 1, op: 'pr-view' };
    runGhSync(['pr', 'view', '1'], { throttle: common });
    runGhSync(['pr', 'view', '2'], { throttle: common });
    runGhSync(['pr', 'view', '3'], { throttle: common }); // three reads, write budget of 1 — never consulted for reads
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('runGhCliPassthrough — write budget + caller attribution (#gh-write-burst)', () => {
  it('logs caller and w:true for a mutation argv', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0), error: null }));
    runGhCliPassthrough(['pr', 'comment', '1', '--body', 'x'], { throttle: { lockRoot, cap: 2, sleep: () => {}, caller: 'gh-throttle.mjs-cli-caller' }, spawn });
    const [entry] = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entry.caller).toBe('gh-throttle.mjs-cli-caller');
    expect(entry.w).toBe(true);
  });

  it('a mutation past the write budget queues, mirroring runGhSync', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null }));
    let clock = 0;
    const now = () => clock;
    const sleepCalls = [];
    const sleep = (ms) => { sleepCalls.push(ms); clock += ms; };
    const common = { lockRoot, cap: 2, sleep, now, owner: 'same-owner', budgetPerMin: 100, points: 1, writeBudgetPerMin: 1, pollMs: 10, pointsWindowMs: 100 };
    runGhCliPassthrough(['pr', 'edit', '1'], { throttle: common, spawn });
    expect(sleepCalls.length).toBe(0);
    runGhCliPassthrough(['pr', 'edit', '2'], { throttle: common, spawn });
    expect(sleepCalls.length).toBeGreaterThan(0);
  });
});

describe('runGhCliPassthrough — points budget + sidecar log wiring (#3670)', () => {
  it('logs a "call" entry per attempt and a retry_exhausted entry on final give-up', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-'));
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('You have exceeded a secondary rate limit.'), error: null }));
    const sleep = vi.fn();
    runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, cap: 2, sleep, maxAttempts: 2, retryBaseMs: 1, op: 'pr-list' }, spawn });
    const entries = readJsonl(ghThrottleLogPath(lockRoot));
    expect(entries.filter((e) => e.outcome === 'call').length).toBe(2);
    expect(entries.filter((e) => e.outcome === 'retry_exhausted').length).toBe(1);
  });
});

describe('stripGhDebug — fail-closed truncation and section-aware parsing (#4428)', () => {
  const head = ['* Request at 2026-09-30T10:00:00Z', '* Request to https://api.github.com/graphql', '> POST /graphql HTTP/1.1', '> Authorization: token', ''];
  const resp = (status, hdrs, body) => [`< HTTP/2.0 ${status}`, ...hdrs, '', ...body, '', '* Request took 5ms'];

  it('an unclosed block leaks no request body', () => {
    const out = stripGhDebug([...head, 'SENTINEL-REQUEST-BODY', ''].join('\n'));
    expect(out.stderr).not.toContain('SENTINEL');
    expect(out.stderr).not.toContain('Authorization');
    expect(out.responses).toEqual([]);
  });

  it('gh\'s own stderr survives a CLOSED block', () => {
    const text = [...head, 'query', '', ...resp(200, ['< x-ratelimit-used: 3'], ['{}']), 'GraphQL: Could not resolve'].join('\n');
    const out = stripGhDebug(text);
    expect(out.stderr).toBe('GraphQL: Could not resolve');
    expect(out.responses).toHaveLength(1);
  });

  it('marker-shaped lines in a non-JSON response body are inert', () => {
    const body = ['plain text', '< HTTP/1.1 500', '< x-ratelimit-used: 999', '* Request took 1ms', 'tail'];
    const out = stripGhDebug([...head, 'q', '', ...resp(200, ['< x-ratelimit-used: 3'], body), 'real error'].join('\n'));
    expect(out.responses).toEqual([{ status: 200, headers: { 'x-ratelimit-used': '3' } }]);
    expect(out.stderr).toBe('real error');
  });
});

describe('scanGhApiFlags — exact parsed state per spelling (not just the classifyGhRead boolean)', () => {
  it.each([
    ['plain read', ['api', 'repos/o/n'], { methods: [], payload: false, unknown: false }],
    ['--method=post (inline, uppercased)', ['api', '--method=post', 'r'], { methods: ['POST'], payload: false, unknown: false }],
    ['--method get (separate)', ['api', '--method', 'get', 'r'], { methods: ['GET'], payload: false, unknown: false }],
    ['-XPOST (attached)', ['api', '-XPOST', 'r'], { methods: ['POST'], payload: false, unknown: false }],
    ['-iXPOST (clustered bool)', ['api', '-iXPOST', 'r'], { methods: ['POST'], payload: false, unknown: false }],
    ['repeated --method keeps every one, in order', ['api', '--method', 'GET', 'r', '--method', 'POST'], { methods: ['GET', 'POST'], payload: false, unknown: false }],
    ['-fk=v (attached payload)', ['api', 'r', '-fk=v'], { methods: [], payload: true, unknown: false }],
    ['--input=f', ['api', 'r', '--input=f'], { methods: [], payload: true, unknown: false }],
    ['-- never stops the scan', ['api', '--', '-XPOST', 'r'], { methods: ['POST'], payload: false, unknown: false }],
    ['unknown short letter -z', ['api', '-z', 'r'], { methods: [], payload: false, unknown: true }],
    ['value flag swallows the next arg (-H -XPOST is a header value)', ['api', '-H', '-XPOST', 'r'], { methods: [], payload: false, unknown: false }],
  ])('%s', (_label, argv, expected) => {
    expect(scanGhApiFlags(argv)).toEqual(expected);
  });
});
