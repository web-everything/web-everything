import { it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import b from '../breaks/same-content-head-move-voids-carry.mjs';
import { classifyHeadMove } from '../../../lib/same-content-carry.mjs';

it('independent fix presence accepts the real classifier and refuses broken admission or refusal', () => {
  expect(b.fixPresent(resolve('.'), { classify: classifyHeadMove })).toBe(true);
  for (const carries of [false, true]) {
    const classify = vi.fn(() => ({ carries, commits: [{ kind: 'clean-main-merge' }] }));
    expect(b.fixPresent(resolve('.'), { classify })).toBe(false);
  }
});

it('broken classifier presence makes the shipped break fail, never pass as an expected failure', async () => {
  const broken = () => ({ carries: false, commits: [] });
  const registered = [];
  const register = (title, run) => registered.push({ expectedFailure: false, run });
  register.fails = (title, run) => registered.push({ expectedFailure: true, run });
  vi.doMock('vitest', () => ({ describe: (title, run) => run(), expect, it: register }));
  try {
    const { defineBreakTest } = await import('../define-break-test.mjs');
    defineBreakTest({ ...b, fixPresent: root => b.fixPresent(root, { classify: broken }),
      run: async () => ({ violations: [] }) });
    expect(registered).toHaveLength(1);
    expect(registered[0].expectedFailure).toBe(false);
    await expect(registered[0].run()).rejects.toThrow('required fix presence probe failed');
  } finally { vi.doUnmock('vitest'); }
});
