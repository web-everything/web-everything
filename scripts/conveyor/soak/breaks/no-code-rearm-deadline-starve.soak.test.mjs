import { it, expect } from 'vitest';
import b from './no-code-rearm-deadline-starve.mjs';

it('no-code rearm deadline starvation stays fixed with persistent promotions and a refused first rearm', async () => {
  const report = await b.run();
  expect(b.judge(report)).toEqual([]);
  expect(report.attempts).toEqual([42, 43]);
  expect(report.receipts).toBe(1);
});
