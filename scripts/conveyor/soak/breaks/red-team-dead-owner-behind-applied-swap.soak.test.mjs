import { expect, it } from 'vitest';
import scenario from './red-team-dead-owner-behind-applied-swap.mjs';
it(scenario.title, async () => { expect(scenario.judge(await scenario.run())).toEqual([]); });
