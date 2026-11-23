import { expect, it } from 'vitest';
import b from './red-team-clear-removed-after-accept.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('A0 soak fix is present by behaviour in the working tree', async () => {
  expect(b.judge(await b.run())).toEqual([]);
});

it('A0 soak clearance probes work with TMPDIR unset', async () => {
  const saved = process.env.TMPDIR;
  delete process.env.TMPDIR;
  try {
    expect(b.judge(await b.run())).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});
