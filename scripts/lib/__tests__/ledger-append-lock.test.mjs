import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { withLedgerAppendLock } from '../ledger-append-lock.mjs';

const interleaving = { afterUnlink: null, afterPublish: null };

const fixture = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-lock-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('synchronous ledger writer queue', () => {
  it.each(['release', 'stale reclaim'])('%s preserves a successor when a second remover replaces the directory after unlink', (mode) => fixture((dir) => {
    let replaced = false;
    let preserved = false;
    const io = {
      unlinkSync(path) {
        fs.unlinkSync(path);
        interleaving.afterUnlink?.(path);
      },
      mkdirSync(path, opts) {
        const result = fs.mkdirSync(path, opts);
        if (path.endsWith('.lock')) interleaving.afterPublish?.(path);
        return result;
      },
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (to.endsWith('.lock')) interleaving.afterPublish?.(to);
      },
    };
    try {
      withLedgerAppendLock('replacement', () => {
        interleaving.afterUnlink = (path) => {
          interleaving.afterUnlink = null;
          const lock = join(path, '..');
          // A second remover wins rmdir before the first remover resumes.
          rmdirSync(lock);
          interleaving.afterPublish = (successor) => {
            interleaving.afterPublish = null;
            replaced = true;
            // Resume the first remover at the earliest successor publication point.
            expect(() => rmdirSync(successor)).toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }));
            preserved = readdirSync(successor).length === 1;
          };
          expect(withLedgerAppendLock('replacement', () => 'successor wrote', { dir, io }))
            .toBe('successor wrote');
        };
        if (mode === 'stale reclaim') {
          expect(withLedgerAppendLock('replacement', () => 'reclaimed', {
            dir, io, clock: () => 300_001, pidAlive: () => false,
          })).toBe('reclaimed');
        }
      }, { dir, io, clock: () => 0 });
      expect(replaced).toBe(true);
      expect(preserved).toBe(true);
    } finally {
      interleaving.afterUnlink = null;
      interleaving.afterPublish = null;
    }
  }));

  it('returns the callback value and releases after success or throw', () => fixture((dir) => {
    expect(withLedgerAppendLock('repo/branch', () => 42, { dir })).toBe(42);
    expect(() => withLedgerAppendLock('repo/branch', () => { throw new Error('write failed'); }, { dir })).toThrow('write failed');
    expect(readdirSync(dir)).toEqual([]);
  }));

  it('never evicts an old lock whose owner pid is alive (mutual exclusion holds)', () => fixture((dir) => {
    let now = 0; let ran = false;
    withLedgerAppendLock('key', () => {
      expect(() => withLedgerAppendLock('key', () => { ran = true; }, { dir, clock: () => (now += 400_000), sleep: () => {}, pidAlive: () => true, waitMs: 1_000_000 })).toThrow(/queue is busy/);
    }, { dir, clock: () => 0 });
    expect(ran).toBe(false);
  }));

  it.each(['dead pid'])('reclaims a lock with a %s', (mode) => fixture((dir) => {
    withLedgerAppendLock('key', () => {
      const lock = join(dir, readdirSync(dir)[0]);
      const ownerPath = join(lock, readdirSync(lock)[0]);
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      writeFileSync(ownerPath, JSON.stringify({ ...owner, timestamp: 0 }));
      expect(withLedgerAppendLock('key', () => 'reclaimed', {
        dir, clock: () => mode === 'dead pid' ? 1 : 300_001,
        pidAlive: () => mode !== 'dead pid',
      })).toBe('reclaimed');
    }, { dir, clock: () => 0 });
    expect(readdirSync(dir)).toEqual([]);
  }));

  it('bounds live-owner waiting and throws retry-later without running the write', () => fixture((dir) => {
    let now = 0;
    const waits = [];
    let wrote = false;
    withLedgerAppendLock('key', () => {
      expect(() => withLedgerAppendLock('key', () => { wrote = true; }, {
        dir, clock: () => now, pidAlive: () => true, waitMs: 625,
        sleep: (ms) => { waits.push(ms); now += ms; },
      })).toThrow(/ledger writer queue is busy.*retry later/i);
    }, { dir, clock: () => 0 });
    expect(wrote).toBe(false);
    expect(now).toBe(625);
    expect(waits.every((ms) => ms > 0 && ms <= 250)).toBe(true);
    expect(waits.slice(0, -1).every((ms) => ms >= 50)).toBe(true);
  }));

  it('different keys do not block each other', () => fixture((dir) => {
    withLedgerAppendLock('repo/branch-a', () => {
      expect(withLedgerAppendLock('repo/branch-b', () => 'ok', { dir, waitMs: 0 })).toBe('ok');
    }, { dir });
  }));

  it('serializes writers in separate processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-lock-process-'));
    const trace = join(dir, 'trace');
    const url = pathToFileURL(resolve('scripts/lib/ledger-append-lock.mjs')).href;
    const child = (name, onEntry = () => {}) => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', `
        import { withLedgerAppendLock } from ${JSON.stringify(url)};
        import { appendFileSync } from 'node:fs';
        withLedgerAppendLock('shared', () => {
          appendFileSync(${JSON.stringify(trace)}, '${name} enter\\n');
          process.stdout.write('entered\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          appendFileSync(${JSON.stringify(trace)}, '${name} exit\\n');
        }, { dir: ${JSON.stringify(dir)}, waitMs: 3000 });
      `], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stdout.once('data', onEntry);
      proc.stderr.on('data', (data) => { stderr += data; });
      proc.on('error', reject);
      proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    try {
      let second;
      await child('first', () => { second = child('second'); });
      await second;
      expect(readFileSync(trace, 'utf8')).toBe('first enter\nfirst exit\nsecond enter\nsecond exit\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
