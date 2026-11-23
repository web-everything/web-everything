import { expect, it, vi } from 'vitest';
import * as rule from '../../draft-promotion-rule.mjs';
import b from './draft-park-label-respected.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// Mandatory pass: removing the real guard must fail even if defineBreakTest chooses it.fails.
it('reproduces the pinned old classifier and requires the real label guard', async () => {
  expect(b.reproduce().owed).toBe(true);
  expect(b.fixPresent()).toBe(true);
  expect(b.judge(await b.run())).toEqual([]);
});

it('detects a missing real guard without editing production code', async () => {
  const probe = vi.spyOn(rule, 'isDraftOwedPromotion').mockImplementation(input => b.reproduce(input));
  try {
    // The mandatory pass above requires true, so this regression cannot hide behind it.fails.
    expect(b.fixPresent()).toBe(false);
    expect(b.judge(await b.run())).toContain('loop: incorrect draft state on push 1');
  } finally {
    probe.mockRestore();
  }
});
