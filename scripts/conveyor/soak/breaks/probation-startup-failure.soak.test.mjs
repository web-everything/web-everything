import { expect, it } from 'vitest';
import scenario from './probation-startup-failure.mjs';

it(scenario.title, async () => {
  expect(scenario.judge(await scenario.run())).toEqual([]);
});
