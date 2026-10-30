import { expect, it } from 'vitest';
import scenario from './overlay-fallback-registration.mjs';

it(scenario.title, async () => {
  expect(scenario.judge(await scenario.run())).toEqual([]);
}, 60_000);
