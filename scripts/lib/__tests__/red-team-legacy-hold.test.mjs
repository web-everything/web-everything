// @vitest-environment node
// A legacy `ran` result whose seat row conflicts with a posted "no break found" comment must hold the PR end to end:
// publisher -> stored status -> label planner and gate disposition (PR #6622, operator send-back).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { readRedTeamDisposition, legacyConflictHold, redTeamMarker } from '../red-team-gate.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { writeStore, resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';

const head = 'a'.repeat(40);
const clearComment = { author: { login: 'web-everything' },
  body: `${redTeamMarker(42, head)}\n### Post-accept red team — no break found` };
const brokenFinding = { summary: 'Confirmed boundary check bypass', file: 'scripts/x.mjs', line: 12,
  category: 'correctness', impactIfUnfixed: 'broken', confirmedByRecheck: true };
const seatRow = (extra = {}) => ({ dispatchKind: 'review-seat', seat: 'red-team', repo: 'o/n', pr: 42, rev: head,
  status: 'ok', provider: 'claude', model: 'test-model', callId: 'call-1', recheckStatus: 'ok',
  foldedVerdict: 'changes', confirmedMissCount: 1, findings: [brokenFinding], ...extra });
const legacyStatus = () => ({ repo: 'o/n', pr: 42, head, status: 'finished', result: 'ran' });

function run(status, extra = {}) {
  const io = { status, readStatus: () => io.status, withLock: (_p, fn) => fn(), listComments: () => [clearComment],
    postComment: vi.fn(), writeStatus: vi.fn(next => { io.status = next; }), publishNeedsYou: vi.fn(),
    now: () => '2026-11-10T12:00:00.000Z', ...extra };
  return { io, out: publishStoredRedTeamResult(io) };
}

describe('legacy conflict hold reaches the label planner and the gate', () => {
  it('the exact reproduction: planner is blocked, never clear, and the gate holds a finding', () => {
    const { io, out } = run(legacyStatus(), { readSeatRow: () => seatRow() });
    expect(out).toEqual({ status: 'held' });
    expect(io.status.legacyHoldPublished).toBe(true);
    expect(legacyConflictHold(io.status, head)).toBe(true);
    // Planner: the thread alone reads clear (the red proof), the stored hold must override it.
    const base = { repo: 'o/n', pr: 42, head, env: {}, labels: ['red-team:pending'], comments: [clearComment] };
    expect(planRedTeamStatusLabels({ ...base, evidence: { status: { ...io.status, legacyHoldPublished: false } } }))
      .toEqual({ add: 'red-team:clear', remove: ['red-team:pending'] });
    const plan = planRedTeamStatusLabels({ ...base, evidence: { status: io.status } });
    expect(plan.add).not.toBe('red-team:clear');
    expect(plan).toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    // Gate: the same stored status counts as a held finding.
    const free = readRedTeamDisposition({ comments: [clearComment], pr: 42, head });
    expect(free.held).toHaveLength(0);
    const held = readRedTeamDisposition({ comments: [clearComment], pr: 42, head, legacyHold: legacyConflictHold(io.status, head) });
    expect(held.held.length).toBeGreaterThanOrEqual(1);
    expect(held.held[0]).toMatchObject({ legacyHold: true, confirmed: true });
  });
  it('an already-clear label is removed rather than kept', () => {
    const { io } = run(legacyStatus(), { readSeatRow: () => seatRow() });
    expect(planRedTeamStatusLabels({ repo: 'o/n', pr: 42, head, env: {}, labels: ['red-team:clear'],
      comments: [clearComment], evidence: { status: io.status } }))
      .toEqual({ add: 'red-team:blocked', remove: ['red-team:clear'] });
  });
  it('legacyConflictHold fails closed on shape: only an unposted bare ran result for this head counts', () => {
    expect(legacyConflictHold({ ...legacyStatus(), legacyHoldPublished: true }, head)).toBe(true);
    expect(legacyConflictHold({ ...legacyStatus(), legacyHoldPublished: true }, 'b'.repeat(40))).toBe(false);
    expect(legacyConflictHold({ ...legacyStatus(), legacyHoldPublished: true, result: { status: 'ran', comment: 'posted' } }, head)).toBe(false);
    expect(legacyConflictHold({ ...legacyStatus(), legacyHoldPublished: true, status: 'running' }, head)).toBe(false);
    expect(legacyConflictHold({ ...legacyStatus() }, head)).toBe(false);
    expect(legacyConflictHold(undefined, head)).toBe(false);
  });
  it('the hold lifts once the posted comment agrees with the stored evidence', () => {
    const agreeing = { author: { login: 'web-everything' }, body: renderRedTeamComment({ pr: 42, rev: head,
      provider: 'claude', model: 'test-model', findings: [brokenFinding], recheckStatus: 'ok', foldedVerdict: 'changes' }) };
    const { io, out } = run({ ...legacyStatus(), legacyHoldPublished: true },
      { readSeatRow: () => seatRow(), listComments: () => [agreeing] });
    expect(out).toEqual({ status: 'skipped' });
    expect(io.status.legacyHoldPublished).toBeUndefined();
    expect(legacyConflictHold(io.status, head)).toBe(false);
  });
  it('a successful post drops the hold flag from the stored status', () => {
    const { io, out } = run({ ...legacyStatus(), legacyHoldPublished: true },
      { readSeatRow: () => seatRow(), listComments: () => [] });
    expect(out).toEqual({ status: 'posted' });
    expect(io.status.legacyHoldPublished).toBeUndefined();
    expect(io.status.result).toMatchObject({ comment: 'posted' });
  });
});

describe('the default seat-row reader (real scorecard store -> priorRedTeamRow)', () => {
  let dir;
  const prior = process.env.CONVEYOR_STATE_ROOT;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt-seat-')); process.env.CONVEYOR_STATE_ROOT = dir; });
  afterEach(() => {
    if (prior === undefined) delete process.env.CONVEYOR_STATE_ROOT; else process.env.CONVEYOR_STATE_ROOT = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  const store = records => writeStore({ version: 1, records }, { path: resolveScorecardStorePath(process.env) });

  it('recovers the exact-head row from the store and holds on a conflicting clear comment', () => {
    store([seatRow({ rev: 'c'.repeat(40) }), seatRow()]);
    const { io, out } = run(legacyStatus()); // readSeatRow NOT injected
    expect(out).toEqual({ status: 'held' });
    expect(io.status.legacyHoldPublished).toBe(true);
    expect(io.postComment).not.toHaveBeenCalled();
  });
  it('posts the recovered break when no comment exists yet', () => {
    store([seatRow()]);
    const { io, out } = run(legacyStatus(), { listComments: () => [] });
    expect(out).toEqual({ status: 'posted' });
    expect(io.postComment.mock.calls[0][0].body).toContain('Confirmed boundary check bypass');
  });
  it.each([
    ['a row for another repo', [seatRow({ repo: 'o/other' })]],
    ['a row for another pr', [seatRow({ pr: 43 })]],
    ['a row that did not complete', [seatRow({ status: 'error' })]],
    ['no rows at all', []],
  ])('does not use %s', (_name, records) => {
    store(records);
    const { io, out } = run(legacyStatus(), { listComments: () => [] });
    expect(out).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
  });
  it('a malformed store fails closed (held, nothing posted)', () => {
    const path = resolveScorecardStorePath(process.env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    const { io, out } = run(legacyStatus(), { listComments: () => [] });
    expect(out).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
  });
});
