/** @file Crash recovery and live/unknown-holder exclusion for the R863 pass lock. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { acquireLiveOwnerWatchLock as acquireLock } from '../pr-live-owner-lock.mjs';
import { pidIdentity, pidNamespace } from '../../lib/pid-alive.mjs';

const BIRTH = 'Tue Nov 10 18:00:00 2026';
// The sandbox may deny ps. Keep its output hermetic, but ask the kernel whether the real child
// still exists and run that evidence through the production birth-identity parser/probe.
const kernelIdentity = (pid, options) => pidIdentity(pid, { ...options, exec: () => {
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return ''; throw e; }
  return `S ${BIRTH} node`;
} });
const acquireLiveOwnerWatchLock = (dir, options = {}) => acquireLock(dir, {
  stamp: () => ({ runnerStart: BIRTH }), identity: kernelIdentity, ...options,
});

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-owner-lock-'));
  dirs.push(dir); return dir;
};
const seed = (dir, changes = {}, legacy = false) => {
  const token = '00000000-0000-4000-8000-000000000001';
  mkdirSync(join(dir, 'pass.lock'));
  const owner = { token, pid: 123, at: '2026-01-01T00:00:00Z', host: hostname(), namespace: pidNamespace(), runnerStart: 'old-birth', ...changes };
  const path = join(dir, 'pass.lock', legacy ? 'owner.json' : `owner-${token}.json`);
  writeFileSync(path, JSON.stringify(owner)); return path;
};

describe('live-owner pass crash recovery', () => {
  it('SIGKILL of a lock-owning pass permits the next pass while excluding a live holder', async () => {
    const dir = scratch();
    const source = `
      const { acquireLiveOwnerWatchLock } = await import(process.argv[1]);
      const { runLiveOwnerWatchPass } = await import(process.argv[2]);
      await runLiveOwnerWatchPass({ deps: {
        acquireRun: () => acquireLiveOwnerWatchLock(process.argv[3], { stamp: () => ({ runnerStart: ${JSON.stringify(BIRTH)} }) }),
        readGaps: async () => { process.on('message', () => {}); process.send('lock-owned'); await new Promise(() => {}); }
      }});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source,
      pathToFileURL(join(process.cwd(), 'scripts/conveyor/pr-live-owner-lock.mjs')).href,
      pathToFileURL(join(process.cwd(), 'scripts/conveyor/pr-live-owner-watch.mjs')).href, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    let timer;
    try {
      const ready = await Promise.race([once(child, 'message'), exited.then(() => { throw Error('child exited before acquiring lock'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lock-owning child did not signal readiness')), 5000); })]);
      clearTimeout(timer);
      expect(ready[0]).toBe('lock-owned');
      expect(() => acquireLiveOwnerWatchLock(dir)).toThrow(/lock held or identity unknown/);
      child.kill('SIGKILL');
      expect((await exited)[1]).toBe('SIGKILL');
      const release = acquireLiveOwnerWatchLock(dir);
      expect(() => acquireLiveOwnerWatchLock(dir)).toThrow(/lock held or identity unknown/);
      release();
      const releaseAgain = acquireLiveOwnerWatchLock(dir); releaseAgain();
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  }, 15_000);

  it('a reused PID is reclaimed only after the shared identity probe verifies its birth mismatch', () => {
    const dir = scratch(), path = seed(dir);
    const identity = (pid, options) => {
      expect(pid).toBe(123); expect(options.expectStart).toBe('old-birth');
      return pidIdentity(pid, { ...options, exec: () => `S ${BIRTH} node` });
    };
    const release = acquireLiveOwnerWatchLock(dir, { identity });
    expect(readdirSync(join(dir, 'pass.lock'))).not.toContain(path.split('/').at(-1)); release();
  });

  it.each(['live', 'unknown', 'foreign-host', 'foreign-namespace', 'missing-stamp', 'oversized', 'malformed'])('preserves %s ownership and names operator inspection', kind => {
    const dir = scratch();
    const path = seed(dir, kind === 'foreign-host' ? { host: 'another-host' } : kind === 'foreign-namespace' ? { namespace: 'another-namespace' }
      : kind === 'missing-stamp' ? { runnerStart: null } : {});
    if (kind === 'oversized') writeFileSync(path, 'x'.repeat(16 * 1024 + 1));
    if (kind === 'malformed') writeFileSync(path, '{');
    const before = readFileSync(path, 'utf8');
    expect(() => acquireLiveOwnerWatchLock(dir, { identity: () => ({ alive: kind === 'live' ? true : null }) })).toThrow(/operator must inspect/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('legacy PID-only state recovers proven death but never assumes a reused living PID is dead', () => {
    const dead = scratch(); seed(dead, { runnerStart: undefined, host: undefined, namespace: undefined }, true);
    const release = acquireLiveOwnerWatchLock(dead, { identity: () => ({ alive: false, reason: 'gone' }) }); release();
    const reused = scratch(); const path = seed(reused, { runnerStart: undefined }, true);
    expect(() => acquireLiveOwnerWatchLock(reused, { identity: () => ({ alive: false, reason: 'start-mismatch' }) })).toThrow(/operator must inspect/);
    expect(readdirSync(join(reused, 'pass.lock'))).toContain('owner.json');
    expect(readFileSync(path, 'utf8')).toContain('123');
  });

  it('a delayed stale reclaimer and an old release cannot remove a successor lock', () => {
    const dir = scratch(), originalRelease = acquireLiveOwnerWatchLock(dir);
    let successorRelease, probes = 0;
    expect(() => acquireLiveOwnerWatchLock(dir, { identity: () => {
      if (++probes === 1) { originalRelease(); successorRelease = acquireLiveOwnerWatchLock(dir); }
      return { alive: false, reason: 'gone' };
    } })).toThrow(/operator must inspect/);
    originalRelease();
    expect(() => acquireLiveOwnerWatchLock(dir)).toThrow(/lock held or identity unknown/);
    successorRelease();
  });

  it('an initializing lock without readable ownership fails closed', () => {
    const dir = scratch(); mkdirSync(join(dir, 'pass.lock'));
    expect(() => acquireLiveOwnerWatchLock(dir)).toThrow(/operator must inspect/);
    expect(readdirSync(join(dir, 'pass.lock'))).toEqual([]);
  });
  it('missing birth evidence for the acquiring process fails closed before creating the lock', () => {
    const dir = scratch();
    expect(() => acquireLock(dir, { stamp: () => ({ runnerStart: null }) })).toThrow(/operator must inspect/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
