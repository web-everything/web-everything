import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
import b from './mq-timeout-same-head.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('a broken mutation probe stays a required failure when the independent fix check passes', async () => {
  const actual = (await vi.importActual('node:child_process')).spawnSync;
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  spawnSync.mockImplementation((file, args, options) => file === process.execPath && args[2].includes('timeoutFixture')
    ? { status: 0, stdout: JSON.stringify({ violations: ['enqueue did not occur'] }) }
    : actual(file, args, options));
  try {
    expect(b.fixPresent(root)).toBe(true);
    expect(b.judge(await b.run({}))).toEqual(['enqueue did not occur']);
  } finally { spawnSync.mockImplementation(actual); }
});

it('fix presence refuses missing ancestry evidence', () => {
  spawnSync.mockReturnValueOnce({ status: 128 });
  expect(b.fixPresent('.')).toBe(false);
});
