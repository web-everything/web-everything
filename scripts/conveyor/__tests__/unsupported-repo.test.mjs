import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { withLedgerAppendLock } from '../../lib/ledger-append-lock.mjs';
import { afterEach, expect, it } from 'vitest';
import { readUnsupported, recordUnsupported } from '../unsupported-repo.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
it('replaces and clears one repo while preserving the others and stamping time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsupported-')); dirs.push(dir);
  const path = join(dir, 'rows.json');
  const now = () => '2026-09-20T00:00:00.000Z';
  expect(readUnsupported({ path })).toEqual([]);
  recordUnsupported({ repo: 'frontierui', rows: [{ prNumber: 1 }], path, now });
  recordUnsupported({ repo: 'plateau-app', rows: [{ prNumber: 2 }], path, now });
  recordUnsupported({ repo: 'frontierui', rows: [{ prNumber: 3 }], path, now });
  expect(readUnsupported({ path })).toEqual([
    { repo: 'plateau-app', prNumber: 2, at: now() }, { repo: 'frontierui', prNumber: 3, at: now() },
  ]);
  recordUnsupported({ repo: 'frontierui', rows: [], path });
  expect(readUnsupported({ path })).toEqual([{ repo: 'plateau-app', prNumber: 2, at: now() }]);
  for (const corrupt of ['{', '{}', '[null]']) {
    writeFileSync(path, corrupt);
    expect(readUnsupported({ path })).toEqual([]);
  }
});

it('refuses a replacement when existing durable records are unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsupported-closed-')); dirs.push(dir);
  const path = join(dir, 'rows.json');
  writeFileSync(path, '{');
  expect(() => recordUnsupported({ repo: 'we', rows: [], path })).toThrow();
});

it('holds the shared writer lock throughout read-modify-write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsupported-locked-')); dirs.push(dir);
  const path = join(dir, 'rows.json');
  recordUnsupported({ repo: 'we', rows: [{}], path, now: () => {
    expect(() => withLedgerAppendLock(`unsupported-repo:${path}`, () => {}, { waitMs: 0 })).toThrow('queue is busy');
    return 'now';
  } });
});

it.each([false, true])('concurrent writers preserve durable records across repositories and action scopes (shared repo=%s)', async sameRepo => {
  const dir = mkdtempSync(join(tmpdir(), 'unsupported-concurrent-')); dirs.push(dir);
  const path = join(dir, 'rows.json');
  const workers = Array.from({ length: 4 }, (_, index) => fork('--eval', [`
    process.on('message', async data => {
      try {
        const { recordUnsupported } = await import(data.url);
        recordUnsupported({ repo: data.sameRepo ? 'shared' : 'repo-' + data.index,
          actions: data.sameRepo ? ['action-' + data.index] : null,
          rows: [{ pr: data.index, action: 'action-' + data.index }], path: data.path });
        process.exit(0);
      } catch (error) { console.error(error); process.exit(1); }
    });
    process.send('ready');
  `], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  try {
    const completed = workers.map(worker => new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(Error('writer failed')));
    }));
    await Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve))));
    workers.forEach((worker, index) => worker.send({
      url: pathToFileURL(resolve('scripts/conveyor/unsupported-repo.mjs')).href, index, path, sameRepo,
    }));
    await Promise.all(completed);
  } finally { workers.forEach(worker => worker.kill()); }
  expect(readUnsupported({ path }).map(row => row.pr).sort()).toEqual([0, 1, 2, 3]);
  expect(readUnsupported({ path }).every(row => row.repo === (sameRepo ? 'shared' : 'repo-' + row.pr))).toBe(true);
});

it('clearing a scoped action cannot delete another writer records for the same repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsupported-scope-')); dirs.push(dir);
  const path = join(dir, 'rows.json');
  recordUnsupported({ repo: 'we', rows: [{ action: 'fix' }, { action: 'ci-heal' }, { action: 'review' }], path });
  recordUnsupported({ repo: 'we', actions: ['ci-heal'], rows: [], path });
  expect(readUnsupported({ path }).map(row => row.action)).toEqual(['fix', 'review']);
  expect(() => recordUnsupported({ repo: 'we', actions: ['fix'], rows: [{ action: 'review' }], path })).toThrow('scope incomplete');
  expect(readUnsupported({ path }).map(row => row.action)).toEqual(['fix', 'review']);
});
