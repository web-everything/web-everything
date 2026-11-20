import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
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
  const barrier = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 4 }, (_, index) => new Worker(`
    const { workerData } = require('node:worker_threads');
    (async () => {
      const { recordUnsupported } = await import(workerData.url);
      const gate = new Int32Array(workerData.barrier);
      Atomics.add(gate, 0, 1);
      Atomics.wait(gate, 0, Atomics.load(gate, 0), 30);
      recordUnsupported({ repo: workerData.sameRepo ? 'shared' : 'repo-' + workerData.index,
        actions: workerData.sameRepo ? ['action-' + workerData.index] : null,
        rows: [{ pr: workerData.index, action: 'action-' + workerData.index }], path: workerData.path });
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { url: pathToFileURL(resolve('scripts/conveyor/unsupported-repo.mjs')).href, index, path, barrier, sameRepo } }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject); worker.on('exit', code => code === 0 ? resolve() : reject(Error('writer failed')));
  })));
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
