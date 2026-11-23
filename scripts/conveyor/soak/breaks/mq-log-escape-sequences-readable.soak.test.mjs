import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b from './mq-log-escape-sequences-readable.mjs';

it('DRAIN-LOG-ESCAPE remains present in the real tree', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

it('escaped MQ logs stay readable; explicitly simulated broken and empty readers fail closed', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});
