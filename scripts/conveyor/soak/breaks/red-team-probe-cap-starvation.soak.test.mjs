import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import scenario, { probeCapFixPresent } from './red-team-probe-cap-starvation.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(scenario);

it('static fix detection rejects a hardcoded probe slice regression', () => {
  const source = readFileSync(new URL('../../../lib/red-team-dispatch-queue.mjs', import.meta.url), 'utf8');
  expect(probeCapFixPresent(source)).toBe(true);
  const regressed = source.replace('slice(0, probeCap(maxProbes))', 'slice(0, 2)');
  expect(regressed).not.toBe(source);
  expect(probeCapFixPresent(regressed)).toBe(false);
});
