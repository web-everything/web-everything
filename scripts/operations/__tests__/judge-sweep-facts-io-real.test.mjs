/** Real subprocess + disk-cache fidelity; GitHub and host ledgers stay injected. */
import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [`${JUDGE_SWEEP_REPO}:${head}:${head}`]: false });
    expect(statSync(file).mode & 0o077).toBe(0);
    const second = createJudgeSweepFactsReader({ ...options, cache: createShapeCache({ cacheDir }),
      shape: () => { throw new Error('cache hit must not spawn shape'); } })().prs[0];
    expect(second.humanRequired).toBe(false);
    expect(second.evidenceErrors).toEqual([]);
  });
});

it('treats an oversized cache file as a miss and replaces it with a small valid result', async () => {
  await withRealRepo(async ctx => {
    const cacheDir = join(ctx.tmp, 'conveyor'), key = `${JUDGE_SWEEP_REPO}:${ctx.head()}:${ctx.head()}`;
    mkdirSync(cacheDir);
    const file = join(cacheDir, 'judge-sweep-shape-cache.json');
    writeFileSync(file, ' '.repeat(128 * 1024 + 1));
    const cache = createShapeCache({ cacheDir });
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, true);
    expect(statSync(file).size).toBeLessThan(128 * 1024);
    expect(createShapeCache({ cacheDir }).get(key)).toBe(true);
  });
});
