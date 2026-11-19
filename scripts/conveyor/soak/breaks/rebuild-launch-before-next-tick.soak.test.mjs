/** @file scripts/conveyor/soak/breaks/rebuild-launch-before-next-tick.soak.test.mjs — Positive and unfixed controls. */
import { it, expect } from 'vitest';
import b from './rebuild-launch-before-next-tick.mjs';
import { probeEarlyRebuild } from '../fixtures/early-rebuild-probe.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('reproduces the missing between-tick launch with the watcher disabled', async () => {
  expect(b.judge(await b.run({ probe: () => probeEarlyRebuild(undefined, false) }))).toHaveLength(1);
});
