import { describe, it, expect, vi } from 'vitest';
import { jitteredDelayMs } from '../lane-acquire-backoff.mjs';

describe('jitteredDelayMs', () => {
  it.each([200, 1000])('jitters base %sms across [base*0.5, base*1.5] using the supplied RNG', (base) => {
    const rng = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(1);
    const delays = [jitteredDelayMs(base, rng), jitteredDelayMs(base, rng), jitteredDelayMs(base, rng)];
    expect(delays).toEqual([base * 0.5, base, base * 1.5]);
    expect(rng).toHaveBeenCalledTimes(3);
  });
});
