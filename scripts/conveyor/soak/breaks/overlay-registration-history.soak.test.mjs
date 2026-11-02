import { expect, it } from 'vitest';
import scenario from './overlay-registration-history.mjs';

it(scenario.title, async () => {
  expect(scenario.judge(await scenario.run())).toEqual([]);
}, 60_000);
