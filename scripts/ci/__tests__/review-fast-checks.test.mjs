// @vitest-environment node
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { REVIEW_TIMING_DEFAULTS } from '../../lib/review-timing.mjs';
const jobs = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs;
it('the default fast checks exist and standards can finish independently of the aggregate CI gate', () => {
  // Only WE's ci.yml publishes these names; every other repo waits on its own required checks.
  expect(REVIEW_TIMING_DEFAULTS.fastChecks).toEqual({ we: ['standards', 'test-shard (1)'] });
  expect(jobs.standards.needs).toBeUndefined();
  expect(jobs.standards.steps.some(s => s.run === 'npm run check:standards')).toBe(true);
  expect(jobs['test-shard'].strategy.matrix.shard).toContain(1);
});
it('card-only PRs get a scope receipt while every expensive shard step stays skipped', () => {
  const shard = jobs['test-shard'];
  expect(shard.if).toBeUndefined();
  const receipt = shard.steps.filter(s => s.name === 'Card-only unit scope receipt');
  expect(receipt).toHaveLength(1);
  expect(receipt[0].if).toContain("needs.changes.outputs.light == 'true'");
  const otherSteps = shard.steps.filter(s => s !== receipt[0]);
  expect(otherSteps.length).toBeGreaterThan(5);
  for (const step of otherSteps) expect(step.if).toContain("needs.changes.outputs.light != 'true'");
});
