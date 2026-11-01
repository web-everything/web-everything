import { expect, it } from 'vitest';
import runtimeClosure from '../../conveyor/soak/breaks/overlay-runtime-closure.mjs';
import savedScope from '../../conveyor/soak/breaks/overlay-saved-scope-mode-flip.mjs';
import aliasedEntries from '../../conveyor/soak/breaks/overlay-aliased-runtime-entries.mjs';
import shadowBoot from '../../conveyor/soak/breaks/overlay-shadow-boot-discovery.mjs';

it.each([runtimeClosure, savedScope, aliasedEntries, shadowBoot])('$id exercises the locked fallback without losing its regression coverage', async scenario => {
  const report = await scenario.run();
  expect(scenario.judge(report)).toEqual([]);
}, 30_000);
