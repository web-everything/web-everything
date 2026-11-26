import { test } from 'vitest';
import assert from 'node:assert/strict';
import { strategyFixture, HEAD } from './fixtures/fast-drain-strategy.mjs';

test('check-run: a result failing between the two reads refuses', () => {
  let reads = 0;
  const h = strategyFixture({ source: 'check-run', readRedTeamCheck: () => ++reads === 1 ? { ok: true } : { ok: false, reason: 'red-team failed' } });
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).enqueued, false);
  assert.equal(reads, 2);
  assert.deepEqual(h.writes, []);
});
test('drain-scan: red-team:pending added before the fresh read refuses', () => {
  const h = strategyFixture({ wait: true, onLive: n => ({ headRefOid: HEAD, labels: ['ready-to-merge', ...(n === 2 ? ['red-team:pending'] : [])] }) });
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).enqueued, false);
  assert.equal(h.liveReads(), 2);
  assert.ok(!h.writes.includes('enqueue'));
});
test('wait off: only the label hold', () => {
  const h = strategyFixture({ wait: false, readRedTeamEvidence: () => { throw new Error('must not read evidence'); }, labels: ['ready-to-merge', 'red-team:pending'] });
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).kind, 'red-team-pending');
  assert.deepEqual(h.writes, []);
});
test('override env: red-team-override defer', () => {
  const h = strategyFixture({ env: { WE_UNDER_TEST: '1', WE_RED_TEAM_GATE_SOURCE: 'drain-scan',
    WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'operator' } });
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).kind, 'defer-to-pass:red-team-override');
  assert.deepEqual(h.writes, []);
});
