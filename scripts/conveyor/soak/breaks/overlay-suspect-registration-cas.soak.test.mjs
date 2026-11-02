import { expect, it } from 'vitest';
import b from './overlay-suspect-registration-cas.mjs';

it(b.title, async () => {
  expect(b.judge(await b.run())).toEqual([]);
});
