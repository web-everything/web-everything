import { expect, it } from 'vitest';
import b from './probation-caller-ownership.mjs';

it(b.title, async () => {
  expect(b.judge(await b.run())).toEqual([]);
});
