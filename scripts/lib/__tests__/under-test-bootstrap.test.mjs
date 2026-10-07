import { expect, it } from 'vitest';

it('keeps the runner-neutral marker after the setup environment strip', () => {
  expect(process.env.WE_UNDER_TEST).toBe('1');
});
