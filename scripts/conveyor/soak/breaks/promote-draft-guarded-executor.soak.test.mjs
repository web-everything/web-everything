import { describe, expect, it } from 'vitest';
import b from './promote-draft-guarded-executor.mjs';

describe('promote-draft guarded executor soak', () => {
  it('bounds every half, rotates failed heads, names untouched work and never strands a receipt for adoption', async () => {
    expect(b.judge(await b.run())).toEqual([]);
  });
});
