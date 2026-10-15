// @vitest-environment node
// Main went red at 8cd0b3d12 with NO code cause: `test-shard (2)` was cancelled by its 15-minute job cap (it needs ~9-11 min
// on a normal runner, 13.5+ on a slow one) and the 50-tick `daemon-soak` baseline hit its 10-minute vitest timeout (550s on the
// last green run, 615s on the red one). Both caps were sized when the shards ran ~4 min, so any slow runner turned a green
// tree red. This pins the headroom: a cap must sit well above the worst time observed on a slow runner, and the soak test
// timeout must stay BELOW its job cap so a hung scenario still fails loudly instead of showing up as a cancelled job (PR #4235).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const jobs = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs;
const soakConfig = readFileSync(new URL('../../../vitest.soak.config.ts', import.meta.url), 'utf8');

// Worst observed (run 38604669331, slow runner): unit shard 2 = ~14 min of tests, daemon-soak baseline = 615s.
const WORST_UNIT_SHARD_MIN = 14;
const WORST_SOAK_BASELINE_MIN = 10.25;

describe('CI job caps keep headroom over a slow runner', () => {
  it('test-shard cap is at least 1.5x the slowest observed shard', () => {
    expect(jobs['test-shard']['timeout-minutes']).toBeGreaterThanOrEqual(WORST_UNIT_SHARD_MIN * 1.5);
  });

  it('soak-shard cap is at least 1.5x the slowest observed shard', () => {
    expect(jobs['soak-shard']['timeout-minutes']).toBeGreaterThanOrEqual(WORST_UNIT_SHARD_MIN * 1.5);
  });

  it('the soak vitest timeout leaves 1.5x headroom over the slowest baseline and still fires before the job cap', () => {
    const m = /testTimeout:\s*Number\(process\.env\.WE_SOAK_TEST_TIMEOUT_MS\)\s*\|\|\s*(\d+)\s*\*\s*60_000/.exec(soakConfig);
    expect(m, 'vitest.soak.config.ts testTimeout default not found').not.toBeNull();
    const testTimeoutMin = Number(m[1]);
    expect(testTimeoutMin).toBeGreaterThanOrEqual(WORST_SOAK_BASELINE_MIN * 1.5);
    expect(testTimeoutMin).toBeLessThan(jobs['soak-shard']['timeout-minutes']);
  });
});
