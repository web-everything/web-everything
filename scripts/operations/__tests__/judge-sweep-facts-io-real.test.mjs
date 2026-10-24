/** Real subprocess + disk-cache fidelity; GitHub and host ledgers stay injected. */
import { expect, it, vi } from 'vitest';
import { readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createJudgeSweepFactsReader, createShapeCache, JUDGE_SWEEP_REPO } from '../judge-sweep-facts-io.mjs';

it('runs the real shape child and reuses its head-and-base result from an owner-only disk cache in a fresh reader', async () => {
  await withRealRepo(async ctx => {
    const head = ctx.head(), cacheDir = join(ctx.tmp, 'conveyor');
    const options = {
      gh: () => JSON.stringify([{ number: 1, title: 'cache fixture', headRefOid: head, baseRefOid: head,
        labels: [{ name: 'review:human' }], assignees: [], updatedAt: '2026-10-22T13:00:00Z',
        files: [{ path: 'README.md' }], changedFiles: 1 }]),
      now: () => Date.parse('2026-10-22T13:01:00Z'), readLedgerRows: () => [],
      readFixRows: () => [], readJobs: () => [], readComments: () => [],
    };
    const first = createJudgeSweepFactsReader({ ...options, cache: createShapeCache({ cacheDir }) })().prs[0];
    expect(first.humanRequired).toBe(false);
    expect(first.evidenceErrors).toEqual([]);
    const file = join(cacheDir, 'judge-sweep-shape-cache.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ rulesVersion: 1,
      entries: { [`${JUDGE_SWEEP_REPO}:${head}:${head}`]: false } });
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(cacheDir).mode & 0o077).toBe(0);
    const second = createJudgeSweepFactsReader({ ...options, cache: createShapeCache({ cacheDir }),
      shape: () => { throw new Error('cache hit must not spawn shape'); } })().prs[0];
    expect(second.humanRequired).toBe(false);
    expect(second.evidenceErrors).toEqual([]);
  });
});

it.each([128 * 1024, 128 * 1024 + 1])('checks the cache byte bound before reading valid JSON (%i bytes)', size => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'judge-sweep-cache-'));
  try {
    const key = `${JUDGE_SWEEP_REPO}:${'a'.repeat(40)}:${'b'.repeat(40)}`;
    const file = join(cacheDir, 'judge-sweep-shape-cache.json');
    const data = JSON.stringify({ rulesVersion: 1, entries: { [key]: false }, padding: '' });
    writeFileSync(file, data.replace('"padding":""', `"padding":"${'x'.repeat(size - Buffer.byteLength(data))}"`));
    expect(statSync(file).size).toBe(size);
    // Observe only the byte-bounded read; keep real stat, JSON and disk writes.
    const readFile = vi.fn(readFileSync);
    const cache = createShapeCache({ cacheDir, readFile });
    expect(cache.get(key)).toBe(size > 128 * 1024 ? undefined : false);
    expect(readFile).toHaveBeenCalledTimes(size > 128 * 1024 ? 0 : 1);
    cache.set(key, true);
    expect(statSync(file).size).toBeLessThan(128 * 1024);
    expect(createShapeCache({ cacheDir }).get(key)).toBe(true);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});
