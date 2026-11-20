import { describe, expect, it } from 'vitest';
import { finishExtraSeats, redTeamReadFingerprint, recordDiscardedSeats, quotaHold } from '../review-extra-seats.mjs';
import { REVIEW_SEAT_DISPATCH_KIND } from '../../lib/provider-routing.mjs';

describe('discarded added-seat quota observation ordering', () => {
  it.each([
    ['finishedAt', true], ['finishedAt', false],
    ['startedAt', true], ['startedAt', false],
  ])('%s: a newer exhaustion survives an older clean call (exhaustion recorded first: %s)', (timestamp, exhaustionFirst) => {
    return checkOrdering(timestamp, exhaustionFirst, true);
  });

  it.each([
    ['finishedAt', true], ['finishedAt', false],
    ['startedAt', true], ['startedAt', false],
  ])('%s: a newer clean call clears an older exhaustion (exhaustion recorded first: %s)', (timestamp, exhaustionFirst) => {
    return checkOrdering(timestamp, exhaustionFirst, false);
  });
});

it.each(['finishedAt', 'startedAt'])('finished comparison rows preserve %s so older clean evidence cannot clear a newer hold', async timestamp => {
  await checkOrdering(timestamp, true, true, true);
});

async function checkOrdering(timestamp, exhaustionFirst, exhaustionNewer, finish = false) {
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
  const read = { diffText: '+test', netBasis: { rev: 'a'.repeat(40) } };
  const pass = { status: 'speculated', rev: read.netBasis.rev, readFingerprint: redTeamReadFingerprint(read), calls,
    reservations: calls.map(({ callId, provider, model, effort }) => ({ callId, provider, model, effort })) };
  const io = { now: () => now, append: row => rows.push({ scoredAt: new Date(now).toISOString(), ...row }), log: message => { throw new Error(message); } };
  const result = finish
    ? await finishExtraSeats({ pass, loopPayload: { findings: { read } }, env: {} }, io)
    : recordDiscardedSeats({ pr: 5, repo: 'web-everything/web-everything', reason: 'head moved', pass }, io);

  expect(result).toMatchObject({ status: finish ? 'ran' : 'recorded', rowsWritten: 2 });
  const quotaRows = rows.filter(row => row.dispatchKind === REVIEW_SEAT_DISPATCH_KIND);
  expect(quotaRows).toHaveLength(2);
  expect(quotaRows.map(row => row.scoredAt)).toEqual(calls.map(call => call[timestamp]));
  if (finish) {
    expect(quotaRows.every(row => !row.discarded)).toBe(true);
    expect(quotaRows.find(row => row.status === 'ok').seatVerdict).toBe('accept');
  } else expect(quotaRows.every(row => row.discarded && row.seatVerdict === null && row.findings.length === 0)).toBe(true);
  if (exhaustionNewer) expect(quotaHold(rows, 'codex', now)).toContain('quota exhausted');
  else expect(quotaHold(rows, 'codex', now)).toBeNull();
}
