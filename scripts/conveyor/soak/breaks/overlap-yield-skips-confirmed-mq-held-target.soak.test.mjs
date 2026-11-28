import { expect, it } from 'vitest';
import b, { probe } from './overlap-yield-skips-confirmed-mq-held-target.mjs';

it(b.title, async () => {
  expect(b.judge(await b.run())).toEqual([]);
});

it('detects a confirmed hold left as a target', () => {
  expect(probe(({openPrRows}) => openPrRows,() => null)).toContain('confirmed exact-head hold remains a yield target');
});

it('detects an unknown hold incorrectly dropped', () => {
  expect(probe(() => [],() => null)).toContain('unknown hold changed overlap yield');
});
