/**
 * @file scripts/lib/__tests__/gh-throttle.budget-block.test.mjs
 * @description #gh-graphql-budget — live 2026-09-27 04:31-05:20Z the App installation's GraphQL bucket hit 0 and
 *   every caller retried on its own guessed ladder (`GraphQL: API rate limit already exceeded for installation
 *   ID 163880042.` — 21 drain `retry_exhausted`s in one window), none able to succeed before the hourly reset.
 *   Proves: a PRIMARY exhaustion is recorded ONCE as a shared block with the bucket's REAL reset (read from the
 *   GraphQL `rateLimit` field) and is not retried; every later call on that identity+resource fails fast WITHOUT
 *   calling GitHub; the other resource (REST) and other identities are untouched; a secondary limit keeps its
 *   own retry path; and a landed write marks the shared open-PR snapshot dirty.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGhSync, runGhCliPassthrough, classifyGhResource, primaryExhaustedResource, ghAuthIdentity, ghAuthProvenance, readBudgetBlock,
  writeBudgetBlock, parseBudgetProbe, budgetProbeArgs, ghThrottleLogPath, MAX_BUDGET_BLOCK_MS,
} from './gh-throttle.window-fixture.mjs';

const NOW = Date.parse('2026-09-27T05:13:00Z');
const RESET = '2026-09-27T05:19:56Z';
const EXHAUSTED = 'GraphQL: API rate limit already exceeded for installation ID 163880042.\n';
const APP_ENV = { GH_TOKEN: 'ghs_notARealToken', HOME: '/h' };

const tmp = () => mkdtempSync(join(tmpdir(), 'gh-budget-'));
const probeAt0 = () => JSON.stringify({ data: { rateLimit: { limit: 6100, remaining: 0, resetAt: RESET } } });

function throttleOpts(lockRoot, extra = {}) {
  return { lockRoot, cap: 4, sleep: () => {}, now: () => NOW, env: {}, maxAttempts: 5, retryBaseMs: 1, ...extra };
}

describe('pure classifiers', () => {
  it('classifyGhResource: pr/issue/repo and `api graphql` spend GraphQL; REST paths, run, label spend core', () => {
    expect(classifyGhResource(['pr', 'list', '--json', 'number'])).toBe('graphql');
    expect(classifyGhResource(['issue', 'comment', '1'])).toBe('graphql');
    expect(classifyGhResource(['api', 'graphql', '-f', 'query=x'])).toBe('graphql');
    expect(classifyGhResource(['api', '--method', 'GET', 'repos/o/n/pulls'])).toBe('core');
    expect(classifyGhResource(['api', 'repos/o/n/compare/a...b'])).toBe('core');
    expect(classifyGhResource(['run', 'list'])).toBe('core');
    expect(classifyGhResource(['label', 'create', 'x'])).toBe('core');
  });
  it('primaryExhaustedResource: the live GraphQL text → graphql; REST primary → core; secondary → null', () => {
    expect(primaryExhaustedResource(EXHAUSTED)).toBe('graphql');
    expect(primaryExhaustedResource('gh: API rate limit exceeded for installation ID 1. (HTTP 403)')).toBe('core');
    expect(primaryExhaustedResource('You have exceeded a secondary rate limit.')).toBe(null);
    expect(primaryExhaustedResource('HTTP 404')).toBe(null);
  });
  it('ghAuthIdentity never exposes the token', () => {
    expect(ghAuthIdentity({})).toBe('default');
    expect(ghAuthIdentity({ GH_TOKEN: 'ghs_abc' })).toBe('app');
    const other = ghAuthIdentity({ GH_TOKEN: 'gho_secret' });
    expect(other).toMatch(/^t-[0-9a-f]{12}$/);
    expect(other).not.toContain('secret');
  });
  it('parseBudgetProbe reads the in-band GraphQL rateLimit (the authoritative bucket)', () => {
    expect(budgetProbeArgs('graphql')).toEqual(['api', 'graphql', '-f', 'query=query{rateLimit{limit remaining resetAt}}']);
    expect(parseBudgetProbe('graphql', probeAt0())).toEqual({ remaining: 0, resetMs: Date.parse(RESET) });
    expect(parseBudgetProbe('core', JSON.stringify({ remaining: 3, reset: 1790000000 }))).toEqual({ remaining: 3, resetMs: 1790000000000 });
  });
  it('a recorded block is clamped to at most MAX_BUDGET_BLOCK_MS', () => {
    const root = tmp();
    const rec = writeBudgetBlock(root, 'app', 'graphql', { untilMs: NOW + 10 * 3600_000, nowMs: NOW });
    expect(rec.untilMs).toBe(NOW + MAX_BUDGET_BLOCK_MS);
  });
});

describe('runGhSync — a primary GraphQL exhaustion backs EVERYONE off until the reset', () => {
  it('records ONE shared block at the probed reset and does not walk the retry ladder', () => {
    const lockRoot = tmp();
    const seen = [];
    const exec = vi.fn((args) => {
      seen.push(args.join(' '));
      if (args[0] === 'api' && args[1] === 'graphql') return probeAt0();
      const e = new Error('Command failed'); e.status = 1; e.stderr = EXHAUSTED; throw e;
    });
    expect(() => runGhSync(['pr', 'list', '--repo', 'o/n'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec }) })).toThrow();
    expect(seen).toEqual(['pr list --repo o/n', 'api graphql -f query=query{rateLimit{limit remaining resetAt}}']); // 1 call + 1 probe, no retries
    const block = readBudgetBlock(lockRoot, 'app', 'graphql', NOW);
    expect(block.until).toBe('2026-09-27T05:19:56.000Z');
    expect(readFileSync(ghThrottleLogPath(lockRoot), 'utf8')).toMatch(/"outcome":"budget_exhausted"/);
  });

  it('a later GraphQL call on the same identity fails FAST without calling gh, rate-limit shaped', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.parse(RESET), nowMs: NOW });
    const exec = vi.fn(() => 'should not run');
    let err;
    try { runGhSync(['pr', 'view', '1'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec }) }); } catch (e) { err = e; }
    expect(exec).not.toHaveBeenCalled();
    expect(String(err.stderr)).toMatch(/API rate limit exceeded .*until 2026-09-27T05:19:56/);
    expect(readFileSync(ghThrottleLogPath(lockRoot), 'utf8')).toMatch(/"outcome":"budget_blocked"/);
  });

  it('does NOT block the REST bucket, another identity, or anything after the reset', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.parse(RESET), nowMs: NOW });
    const exec = vi.fn(() => 'ok');
    expect(runGhSync(['api', 'repos/o/n/pulls/1/files'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec }) })).toBe('ok');
    expect(runGhSync(['pr', 'view', '1'], { env: {}, throttle: throttleOpts(lockRoot, { exec }) })).toBe('ok'); // personal login
    expect(runGhSync(['pr', 'view', '1'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec, now: () => Date.parse(RESET) + 1 }) })).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('a probe that shows budget left records NO block (the ordinary retry path runs)', () => {
    const lockRoot = tmp();
    let n = 0;
    const exec = vi.fn((args) => {
      if (args[0] === 'api') return JSON.stringify({ data: { rateLimit: { limit: 6100, remaining: 500, resetAt: RESET } } });
      n += 1; if (n === 1) { const e = new Error('x'); e.stderr = EXHAUSTED; throw e; }
      return 'ok';
    });
    expect(runGhSync(['pr', 'list'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec }) })).toBe('ok');
    expect(readBudgetBlock(lockRoot, 'app', 'graphql', NOW)).toBe(null);
  });

  it('a SECONDARY limit keeps its own retry ladder (no block)', () => {
    const lockRoot = tmp();
    let n = 0;
    const exec = vi.fn(() => { n += 1; if (n < 3) { const e = new Error('x'); e.stderr = 'You have exceeded a secondary rate limit.'; throw e; } return 'ok'; });
    expect(runGhSync(['pr', 'edit', '1'], { env: APP_ENV, throttle: throttleOpts(lockRoot, { exec }) })).toBe('ok');
    expect(n).toBe(3);
    expect(readBudgetBlock(lockRoot, 'app', 'graphql', NOW)).toBe(null);
  });
});

describe('runGhCliPassthrough (the gh App shim path) honours the same shared block', () => {
  it('returns the fail-fast result without spawning gh', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.parse(RESET), nowMs: NOW });
    const spawn = vi.fn();
    const r = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, now: () => NOW }, spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/shared backoff until/);
  });

  it('records the block from the live stderr + probe, and returns without retrying', () => {
    const lockRoot = tmp();
    const spawn = vi.fn((bin, argv) => (argv[0] === 'api'
      ? { status: 0, stdout: Buffer.from(probeAt0()), stderr: Buffer.alloc(0) }
      : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(EXHAUSTED) }));
    const r = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, now: () => NOW, sleep: () => {}, cap: 4 }, spawn });
    expect(r.status).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2); // the call + the probe
    expect(readBudgetBlock(lockRoot, 'app', 'graphql', NOW).until).toBe('2026-09-27T05:19:56.000Z');
  });
});

describe('a landed write marks the shared open-PR snapshot dirty', () => {
  it('pr edit --repo o/n → o__n.dirty', () => {
    const lockRoot = tmp();
    const snapDir = tmp();
    mkdirSync(snapDir, { recursive: true });
    runGhSync(['pr', 'edit', '1', '--repo', 'o/n', '--add-label', 'x'], { throttle: { ...throttleOpts(lockRoot, { exec: () => '' }), env: { WE_PR_SNAPSHOT_DIR: snapDir } } });
    expect(existsSync(join(snapDir, 'o__n.dirty'))).toBe(true);
  });
});

it.each(['sync', 'passthrough'])('strict-budget %s calls record exhaustion without a diagnostic network probe', mode => {
  const root = tmp();
  const env = { WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' };
  const probeBudget = vi.fn(() => probeAt0());
  const sleep = vi.fn();
  const throttle = throttleOpts(root, { env, probeBudget, maxAttempts: 1, sleep });
  if (mode === 'sync') {
    const exec = vi.fn(() => { throw Object.assign(new Error(EXHAUSTED), { stderr: EXHAUSTED, status: 1 }); });
    expect(() => runGhSync(['api', 'graphql'], { throttle: { ...throttle, exec } })).toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
  } else {
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from(EXHAUSTED) }));
    expect(runGhCliPassthrough(['api', 'graphql'], { env, throttle, spawn }).status).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  }
  expect(probeBudget).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
  expect(readBudgetBlock(root, 'default', 'graphql', NOW)).toMatchObject({ source: 'fallback' });
});

describe('installation provenance (#4652)', () => {
  const bound = (id, token) => ({ GH_TOKEN: token, WE_GH_AUTH_INSTALLATION: id,
    WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex'), WE_GH_AUTH_SOURCE: 'cache' });
  it('rotation preserves the installation, other installations and fallback credentials do not', () => {
    const first = bound('123', 'ghs_synthetic_first');
    expect(ghAuthIdentity(first)).toBe('app-installation-123');
    expect(ghAuthIdentity(bound('123', 'ghs_synthetic_rotated'))).toBe(ghAuthIdentity(first));
    expect(ghAuthIdentity(bound('456', 'ghs_synthetic_second'))).toBe('app-installation-456');
    expect(ghAuthProvenance(first)).toEqual({ kind: 'installation', installationId: '123', source: 'cache' });
    expect(ghAuthProvenance({ ...first, GH_TOKEN: 'gho_synthetic_personal' })).toEqual({ kind: 'personal-token' });
    expect(ghAuthProvenance({ ...first, GH_TOKEN: 'ghs_synthetic_unbound' })).toEqual({ kind: 'installation', installationId: null, source: 'unknown' });
    expect(ghAuthProvenance({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'test/repo', GITHUB_TOKEN: 'ghs_synthetic_action' })).toEqual({ kind: 'actions', repository: 'test/repo' });
    expect(ghAuthIdentity({ GH_TOKEN: 'ghs_synthetic_unknown', WE_GITHUB_APP_INSTALLATION_ID: '123' })).toBe('app');
  });
  it('records effective child provenance and never its token or binding hash', () => {
    const lockRoot = tmp();
    const env = bound('123', 'ghs_synthetic_child');
    runGhSync(['pr', 'view', '1'], { env, throttle: throttleOpts(lockRoot, { exec: () => '{}' }) });
    const raw = readFileSync(ghThrottleLogPath(lockRoot), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({ id: 'app-installation-123', auth: { installationId: '123', source: 'cache' } });
    expect(raw).not.toContain(env.GH_TOKEN);
    expect(raw).not.toContain(env.WE_GH_AUTH_TOKEN_HASH);
  });
});


it('CLI call records carry the effective installation provenance (#4652)', () => {
  const lockRoot = tmp();
  const token = 'ghs_synthetic_cli';
  const env = { GH_TOKEN: token, WE_GH_AUTH_INSTALLATION: '987', WE_GH_AUTH_SOURCE: 'mint',
    WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex') };
  runGhCliPassthrough(['pr', 'view', '1'], {
    throttle: throttleOpts(lockRoot, { env, personalRoute: false }),
    spawn: () => ({ status: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }),
  });
  const raw = readFileSync(ghThrottleLogPath(lockRoot), 'utf8');
  expect(JSON.parse(raw.trim())).toMatchObject({ outcome: 'call', id: 'app-installation-987', auth: { kind: 'installation', installationId: '987', source: 'mint' } });
  expect(raw).not.toContain(token);
  expect(raw).not.toContain(env.WE_GH_AUTH_TOKEN_HASH);
});
