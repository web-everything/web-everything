import { describe, it, expect } from 'vitest';
import { boundedPool, createRefreshBudget } from '../lib/bounded-pool.mjs';

describe('cascade bounded pool', () => {
  it('overlaps work, preserves results, and never exceeds the bound', async () => {
    let active = 0, peak = 0;
    const result = await boundedPool(Array.from({ length: 11 }, (_, i) => i), 3, async i => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return i * 2;
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(result).toEqual(Array.from({ length: 11 }, (_, i) => i * 2));
  });
  it('never refreshes a PR key twice, including after failure and across pools', async () => {
    const budget = createRefreshBudget(2);
    let calls = 0;
    const run = () => budget.run('repo#1', async () => { calls++; await Promise.resolve(); throw Error('failed'); });
    const results = await boundedPool([1, 2, 3], 3, async () => { try { return await run(); } catch { return 'error'; } });
    expect(calls).toBe(1);
    expect(results).toEqual(['error', { ok: false, action: 'refresh-already-attempted' }, { ok: false, action: 'refresh-already-attempted' }]);
    expect(await run()).toEqual({ ok: false, action: 'refresh-already-attempted' });
  });
  it('caps refreshes at two per pass and reports retry-next-pass for excess candidates', async () => {
    const budget = createRefreshBudget(2);
    const seen = [];
    const result = await boundedPool(['a#1', 'b#1', 'a#2', 'b#2', 'c#1'], 4,
      key => budget.run(key, async () => { seen.push(key); await Promise.resolve(); return { ok: true }; }));
    expect(seen).toEqual(['a#1', 'b#1']);
    expect(result.slice(2)).toEqual(Array(3).fill({ ok: false, action: 'refresh-cap-retry-next-pass' }));
  });
  it('rejects invalid bounds and missing PR keys without running work', async () => {
    for (const width of [0, -1, NaN, Infinity, 1.5]) await expect(boundedPool([1], width, () => { throw Error('ran'); })).rejects.toThrow('bound');
    expect(() => createRefreshBudget(Infinity)).toThrow('bound');
    await expect(createRefreshBudget(2).run('', () => { throw Error('ran'); })).rejects.toThrow('key');
  });
  it('settles all in-flight tasks before rejecting, so no work leaks past the barrier', async () => {
    let settled = false;
    await expect(boundedPool([1, 2], 2, async i => {
      if (i === 1) throw Error('read failed');
      await new Promise(resolve => setImmediate(resolve)); settled = true;
    })).rejects.toThrow('read failed');
    expect(settled).toBe(true);
  });
});
