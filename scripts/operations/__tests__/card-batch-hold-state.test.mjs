// @vitest-environment node
/** An open, collecting card batch is held on purpose and must not raise a needs-you alert. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCollectingBatchPr } from '../card-batch-hold-state.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const MIN = 60_000;
const OPENED = Date.parse('2026-10-21T10:54:31.090Z');
const policy = loadCardBatchPolicy();
// #5790's real shape: open filing batch, one card, PR recorded, hold applied, no seal fields.
const open5790 = { batchRef: 'lane/card-batch-filing-5', seq: 5, headSha: 'f'.repeat(40), openedAt: '2026-10-21T10:54:31.090Z',
  members: [{ cardId: 'xpayu3l', source: { repo: 'web-everything/web-everything', pr: '5729' } }],
  pr: 5790, kind: 'filing', repo: 'web-everything/web-everything', holdApplied: true };
function check(state, now, number = 5790, name = 'web-everything-web-everything-filing.json') {
  const dir = mkdtempSync(join(tmpdir(), 'hold-state-')); dirs.push(dir);
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(state));
  return isCollectingBatchPr('web-everything/web-everything', number, { stateDir: dir, now, policy });
}
it('is quiet for an open one-card batch inside its window (#5790)', () => {
  expect(check(open5790, OPENED + 20 * MIN)).toBe(true);
});
it('raises once the batch is past its seal deadline', () => {
  expect(check(open5790, OPENED + 61 * MIN)).toBe(false);
});
it('raises once the batch has reached its card count', () => {
  const members = Array.from({ length: 10 }, (_, i) => ({ cardId: `c${i}`, source: { repo: 'web-everything/web-everything' } }));
  expect(check({ ...open5790, members }, OPENED + MIN)).toBe(false);
});
it('raises when a seal failure is recorded', () => {
  expect(check({ ...open5790, sealFailure: { reason: 'verify red' } }, OPENED + MIN)).toBe(false);
});
it('does not cover another PR, another repo, or an archived generation with no active batch', () => {
  expect(check(open5790, OPENED + MIN, 5999)).toBe(false);
  expect(check({ seq: 5, lastSealedState: '/x/sealed.json' }, OPENED + MIN)).toBe(false);
});
it('stays quiet while a capacity-paused seal waits to retry, and raises when it is long overdue', () => {
  const paused = { ...open5790, sealedAt: OPENED + 60 * MIN, seal: { step: 'record-sealed' }, verifyUnrun: 3,
    verifyRetryAfter: new Date(OPENED + 75 * MIN).toISOString() };
  expect(check(paused, OPENED + 80 * MIN)).toBe(true);
  expect(check(paused, OPENED + 200 * MIN)).toBe(false);
});
it('fails open (keeps alerting) when the state dir is unreadable', () => {
  expect(isCollectingBatchPr('web-everything/web-everything', 5790, { stateDir: '/nonexistent/x', now: OPENED, policy })).toBe(false);
});
it('covers paused extraction remainders in sealed only until grace expires and excludes ordinary archives', () => {
  const paused = { ...open5790, sealedAt: OPENED + 60 * MIN, seal: { step: 'record-sealed' }, verifyUnrun: 3,
    verifyRetryAfter: new Date(OPENED + 75 * MIN).toISOString() };
  const remainder = 'sealed/web-everything-web-everything-5r1-filing.json';
  expect(check(paused, OPENED + 70 * MIN, 5790, remainder)).toBe(true);
  expect(check(paused, OPENED + 200 * MIN, 5790, remainder)).toBe(false);
  expect(check(paused, OPENED + 70 * MIN, 5999, remainder)).toBe(false);
  expect(check({ ...paused, repo: 'other/repo' }, OPENED + 70 * MIN, 5790, remainder)).toBe(false);
  expect(check(paused, OPENED + 70 * MIN, 5790, 'sealed/web-everything-web-everything-5-filing.json')).toBe(false);
});
