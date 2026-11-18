/**
 * @file scripts/lib/__tests__/gh-throttle.lockroot-fail-open.test.mjs
 * @description Landing freeze 2026-09-27 ~04:10Z: every `gh` call routed through the App shim runs
 *   gh-throttle.mjs, whose lock root was derived from the CALLER'S cwd — from `/tmp` it became
 *   `/private/.lanes/.admission/gh`, mkdir hit EACCES, and the throttle crashed instead of running `gh`.
 *   Proves: (1) the lock root is cwd-independent (env override, else LANE_POOL_ROOT, else a fixed host path);
 *   (2) throttle SETUP failure refuses execution and emits an actionable warning;
 *   (3) the real CLI, run from a cwd outside any workspace, runs gh (the live repro, with a fake gh binary).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ghThrottleLockRoot, runGhCliPassthrough, runGhSync, failOpenGate, resetGhThrottleFailOpenWarning, ghThrottleLogPath,
} from '../gh-throttle.mjs';

const THROTTLE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh-throttle.mjs');

beforeEach(() => resetGhThrottleFailOpenWarning());

describe('ghThrottleLockRoot — independent of the caller cwd', () => {
  it('is the SAME path whatever checkoutRoot/cwd is passed (was /private/.lanes/... from /tmp)', () => {
    const env = { HOME: '/Users/x' };
    const a = ghThrottleLockRoot('/private/tmp', env);
    const b = ghThrottleLockRoot('/Users/x/workspace/.lanes/web-everything/lane-3', env);
    const c = ghThrottleLockRoot(undefined, env);
    expect(a).toBe(join('/Users/x', 'workspace', '.lanes', '.admission', 'gh'));
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.startsWith('/private')).toBe(false);
  });

  it('WE_GH_THROTTLE_LOCK_ROOT wins (with ~ expansion), then LANE_POOL_ROOT', () => {
    expect(ghThrottleLockRoot('/tmp', { HOME: '/h', WE_GH_THROTTLE_LOCK_ROOT: '/srv/gh-lock' })).toBe('/srv/gh-lock');
    expect(ghThrottleLockRoot('/tmp', { HOME: '/h', WE_GH_THROTTLE_LOCK_ROOT: '~/gh-lock' })).toBe('/h/gh-lock');
    expect(ghThrottleLockRoot('/tmp', { HOME: '/h', LANE_POOL_ROOT: '/pool' })).toBe(join('/pool', '.admission', 'gh'));
  });
});

/** A lock root that can never be created: a path UNDER a regular file (ENOTDIR — same class as the live EACCES). */
function unusableLockRoot() {
  const d = mkdtempSync(join(tmpdir(), 'gh-t-failopen-'));
  const file = join(d, 'not-a-dir');
  writeFileSync(file, 'x');
  return join(file, '.admission', 'gh');
}

describe('admission fails closed; cleanup remains best effort', () => {
  it('runGhCliPassthrough: unusable lock root refuses gh and emits a warning', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[{"number":1}]'), stderr: Buffer.alloc(0), error: null }));
    const warn = vi.fn();
    const r = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot: unusableLockRoot(), cap: 2, sleep: () => {}, warn }, spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(r.status).toBe(1);
    expect(r.stdout.toString()).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/admission failed \(lock-root setup\)/));
  });

  it('runGhSync: unusable lock root refuses execution', () => {
    const exec = vi.fn(() => 'ok-out');
    const warn = vi.fn();
    expect(() => runGhSync(['api', 'rate_limit'], { throttle: { lockRoot: unusableLockRoot(), cap: 2, sleep: () => {}, exec, warn } })).toThrow(/admission failed/);
    expect(exec).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('failOpenGate: a throwing step returns the fallback and logs a fail_open line', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-t-failopen-log-'));
    const logPath = ghThrottleLogPath(lockRoot);
    const warn = vi.fn();
    const out = failOpenGate('release', () => { throw new Error('EACCES: permission denied'); }, { fallback: { ok: false }, warn, logPath, op: 'pr list' });
    expect(out).toEqual({ ok: false });
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(line).toMatchObject({ outcome: 'fail_open', stage: 'release', op: 'pr list' });
  });
});

describe('the real CLI, run from a cwd OUTSIDE any workspace (the live repro)', () => {
  it('runs gh from cwd=/ (lock root used to derive to /.lanes → EACCES) instead of crashing', () => {
    const home = mkdtempSync(join(tmpdir(), 'gh-t-home-'));
    const fakeGh = join(home, 'fake-gh');
    writeFileSync(fakeGh, '#!/bin/sh\necho "fake-gh:$*"\n');
    chmodSync(fakeGh, 0o755);
    const env = { PATH: process.env.PATH, HOME: home, WE_GH_THROTTLE_GH_BIN: fakeGh };
    const r = spawnSync(process.execPath, [THROTTLE_CLI, 'pr', 'list'], { cwd: '/', env, encoding: 'utf8' });
    expect(r.stderr).not.toMatch(/gh-throttle error/);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('fake-gh:pr list\n');
    expect(existsSync(join(home, 'workspace', '.lanes', '.admission', 'gh'))).toBe(true);
  });
});
