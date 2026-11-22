// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import b, { exerciseReaders } from './drain-mq-log-reader-escape-sequences.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { breakById } from './index.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('discovers the break and behaviorally requires the fix on this tree', () => {
  expect(breakById(b.id)).toBe(b);
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('reads escape-coded logs through every drain MQ evidence path', async () => {
  const report = await b.run();
  expect(b.judge(report)).toEqual([]);
  expect(Object.keys(report.readers)).toEqual(['recovery', 'same-head']);
  for (const { reads, accepted } of Object.values(report.readers)) {
    expect(reads.length).toBeGreaterThan(0);
    expect(accepted).toHaveLength(reads.length);
    expect(reads.every(({ args }) => args.includes('--allow-escape-sequences'))).toBe(true);
  }
});

it.each(['recovery', 'same-head'])(
  'detects the pre-fix transport refusal in the %s reader', async reader => {
    const report = await exerciseReaders(ROOT, reader);
    expect(b.judge(report)).toContain(`${reader}: escape-coded log was not read successfully`);
    expect(report.readers[reader].accepted).toEqual([]);
  });

it('fails closed when the probe tree is unreadable and honors SOAK_TREE_ROOT', async () => {
  const missing = new URL('./missing-reader-tree/', import.meta.url).pathname;
  expect(b.fixPresent(missing)).toBe(false);
  vi.stubEnv('SOAK_TREE_ROOT', missing);
  try { await expect(b.run()).rejects.toThrow(); }
  finally { vi.unstubAllEnvs(); }
  expect(b.judge(null)).toEqual(['drain MQ reader probe returned incomplete evidence']);
});
