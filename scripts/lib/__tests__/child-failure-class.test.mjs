import { it, expect } from 'vitest';
import { classifyChildFailure } from '../child-failure-class.mjs';
it('the 4-5 s unclassified exit is named', () => {
  // daemon.log 2026-11-25T18:04:07.332Z, #7496, exit 1 in 4s.
  const sample = 'merge-ai-prs   Error: fast-drain: incomplete pass context (snapshot unavailable/disabled/stale/dirty   retry next pass)   retry next pass';
  expect(classifyChildFailure(sample)).toBe('incomplete-context');
});
