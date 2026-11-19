import { describe, expect, it } from 'vitest';
import { recordDiscardedSeats, quotaHold } from '../review-extra-seats.mjs';
import { REVIEW_SEAT_DISPATCH_KIND } from '../../lib/provider-routing.mjs';

describe('discarded added-seat quota observation ordering', () => {
  it.each([
    ['finishedAt', true], ['finishedAt', false],
    ['startedAt', true], ['startedAt', false],
  ])('%s: a newer exhaustion survives an older clean call (exhaustion recorded first: %s)', (timestamp, exhaustionFirst) => {
    checkOrdering(timestamp, exhaustionFirst, true);
  });

  it.each([
    ['finishedAt', true], ['finishedAt', false],
    ['startedAt', true], ['startedAt', false],
  ])('%s: a newer clean call clears an older exhaustion (exhaustion recorded first: %s)', (timestamp, exhaustionFirst) => {
    checkOrdering(timestamp, exhaustionFirst, false);
  });
});

function checkOrdering(timestamp, exhaustionFirst, exhaustionNewer) {
  const older = '2026-09-26T14:58:00.000Z';
  const newer = '2026-09-26T14:59:00.000Z';
  const now = Date.parse('2026-09-26T15:00:00.000Z');
  const makeCall = (status, at) => ({
    callId: status, provider: 'codex', model: 'test', effort: 'high',
    startedAt: timestamp === 'finishedAt' ? '2026-09-26T14:57:00.000Z' : at,
    finishedAt: timestamp === 'finishedAt' ? at : null,
    seats: [{ seat: 'red-team', lens: 'red-team', key: 'red-team' }],
    call: { status }, parsed: { 'red-team': { ok: true, verdict: 'accept', findings: [] } },
  });
  const exhausted = makeCall('quota-exhausted', exhaustionNewer ? newer : older);
  const clean = makeCall('ok', exhaustionNewer ? older : newer);
  const calls = exhaustionFirst ? [exhausted, clean] : [clean, exhausted];
  const rows = [];
  const result = recordDiscardedSeats({
    pr: 5, repo: 'web-everything/web-everything', reason: 'head moved',
    pass: { status: 'speculated', rev: 'a'.repeat(40), calls,
      reservations: calls.map(({ callId, provider, model, effort }) => ({ callId, provider, model, effort })) },
  }, { now: () => now, append: row => rows.push(row), log: message => { throw new Error(message); } });

  expect(result).toMatchObject({ status: 'recorded', rowsWritten: 2 });
  const quotaRows = rows.filter(row => row.dispatchKind === REVIEW_SEAT_DISPATCH_KIND);
  expect(quotaRows).toHaveLength(2);
  expect(quotaRows.map(row => row.scoredAt)).toEqual(calls.map(call => call[timestamp]));
  expect(quotaRows.every(row => row.discarded && row.seatVerdict === null && row.findings.length === 0)).toBe(true);
  if (exhaustionNewer) expect(quotaHold(rows, 'codex', now)).toContain('quota exhausted');
  else expect(quotaHold(rows, 'codex', now)).toBeNull();
}
