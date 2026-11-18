import { describe, expect, it } from 'vitest';
import { planShard, MAX_EXCLUDES } from '../shard-plan.mjs';

describe('soak run-shard planShard — a quarantine never turns a shard green without assertions', () => {
  it('runs the files that are not excluded', () => {
    const plan = planShard({ assigned: ['a', 'b'], excluded: new Set(['a']) });
    expect(plan).toMatchObject({ files: ['b'], skipped: 1, exit: null });
  });

  it('FAILS when every assigned file is excluded', () => {
    const plan = planShard({ assigned: ['a'], excluded: new Set(['a']) });
    expect(plan.exit).toBe(1);
    expect(plan.files).toEqual([]);
  });

  it('a shard with nothing assigned stays a clean no-op', () => {
    expect(planShard({ assigned: [], excluded: new Set() })).toMatchObject({ exit: 0 });
  });

  it('refuses more exclusions than the quarantine cap', () => {
    const excluded = new Set(Array.from({ length: MAX_EXCLUDES + 1 }, (_, i) => `f${i}`));
    expect(planShard({ assigned: ['x'], excluded }).exit).toBe(1);
    const ok = new Set(Array.from({ length: MAX_EXCLUDES }, (_, i) => `f${i}`));
    expect(planShard({ assigned: ['x'], excluded: ok }).exit).toBeNull();
  });
});
