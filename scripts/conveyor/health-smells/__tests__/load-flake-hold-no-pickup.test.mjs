import { expect, it } from 'vitest';
import smell from '../load-flake-hold-no-pickup.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment } from '../../stand-down.mjs';
const now = Date.parse('2026-10-06T21:00:00Z');
const c = (body, createdAt) => ({ body, createdAt, author: { login: 'web-everything' } });
const hold = (createdAt) => c(buildLoadFlakeHoldComment({ alt: 'lane/x-alt', altSha: 'bbb2222' }), createdAt);
const pr = (comments) => ({ repo: 'web-everything/web-everything', number: 4017, headRefOid: 'aaa1111', comments });
const run = (comments, env = {}) => smell.evaluate({ prs: [pr(comments)] }, { now, env });
it('validates and breaches on an unattended old hold', () => {
  expect(validateSmellShape(smell, 'load-flake-hold-no-pickup.mjs')).toBe(smell);
  expect(run([hold('2026-10-06T19:51:00Z')])).toEqual([expect.objectContaining({ subject: 'pr:we#4017', breach: true, measure: expect.objectContaining({ ageMinutes: 69, limitMinutes: 60 }) })]);
});
it('ignores young holds, picked-up holds, and honours the setting', () => {
  expect(run([hold('2026-10-06T20:30:00Z')])).toEqual([]);
  expect(run([hold('2026-10-06T19:51:00Z'), c(buildLoadFlakeResolvedComment({ altSha: 'bbb2222', result: 'red-again' }), '2026-10-06T20:00:00Z')])).toEqual([]);
  expect(run([hold('2026-10-06T20:30:00Z')], { WE_LOAD_FLAKE_NO_PICKUP_MINUTES: '10' })).toHaveLength(1);
});
