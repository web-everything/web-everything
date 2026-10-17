import { describe, expect, it } from 'vitest';
import { isLanePreparePrFor, isPreparePrFor, preparePrGuard, prepareLaunchRefusal } from '../prepare-pr-match.mjs';

const pr = (extra = {}) => ({ number: 91, state: 'OPEN', headRefName: 'lane/5028d-prepare-x',
  createdAt: '2026-10-14T12:00:00Z', isCrossRepository: false, ...extra });
const args = { num: '5028' };

describe('prepare PR matching', () => {
  it.each(['lane/5028-prepare-x', 'lane/5028d-prepare-x', 'lane/5028e-prepare-x'])(
    'matches %s with a normalized card number', headRefName => {
      expect(isPreparePrFor(pr({ headRefName }), { num: '#05028' })).toBe(true);
    });
  it('matches bornAs and escapes regex characters', () => {
    expect(isPreparePrFor(pr({ headRefName: 'lane/abc.12b-prepare-x' }), { ...args, bornAs: 'abc.12' })).toBe(true);
    expect(isPreparePrFor(pr({ headRefName: 'lane/abcX12b-prepare-x' }), { ...args, bornAs: 'abc.12' })).toBe(false);
  });
  it('matches the title with a word boundary', () => {
    expect(isPreparePrFor(pr({ headRefName: 'other', title: 'WE #5028: prepare — work' }), args)).toBe(true);
    expect(isPreparePrFor(pr({ headRefName: 'other', title: 'WE #5028: prepared work' }), args)).toBe(false);
  });
  it.each(['lane/50280-prepare-x', 'lane/5028de-prepare-x', 'lane/5028-build-x'])(
    'rejects %s', headRefName => expect(isPreparePrFor(pr({ headRefName }), args)).toBe(false));
  it('rejects cross-repository PRs even with matching titles', () => {
    expect(isPreparePrFor(pr({ isCrossRepository: true, title: 'WE #5028: prepare' }), args)).toBe(false);
  });
  // PR #5366 review round 7: a title may refuse a launch; only a lane prepare branch may drive a stamp or a hold.
  it('the write-grade match requires a lane prepare branch; a title alone is refusal-grade only', () => {
    const titled = pr({ headRefName: 'someone/manual', title: 'WE #5028: prepare — work' });
    expect(isPreparePrFor(titled, args)).toBe(true);
    expect(isLanePreparePrFor(titled, args)).toBe(false);
    expect(isLanePreparePrFor(pr({ headRefName: 'lane/5028d-prepare-x' }), args)).toBe(true);
    expect(isLanePreparePrFor(pr({ headRefName: 'lane/abc.12b-prepare-x' }), { ...args, bornAs: 'abc.12' })).toBe(true);
    expect(isLanePreparePrFor(pr({ headRefName: 'lane/5028-prepare-x', isCrossRepository: true }), args)).toBe(false);
    expect(isLanePreparePrFor(pr({ headRefName: 'xlane/5028-prepare-x' }), args)).toBe(false);
  });
});

describe('prepare PR guard', () => {
  it('selects the newest eligible PR, ignoring closed and older merged PRs', () => {
    const open = pr({ createdAt: '2026-10-01' });
    const merged = pr({ number: 92, state: 'MERGED' });
    expect(preparePrGuard({ ...args, prs: [open, merged, pr({ state: 'CLOSED', createdAt: '2026-10-15' })],
      lastDispatchAt: merged.createdAt })).toBe(merged);
    expect(preparePrGuard({ ...args, prs: [open, merged], lastDispatchAt: '2026-10-15' })).toBe(open);
    expect(preparePrGuard({ ...args, prs: [merged] })).toBe(merged);
    expect(preparePrGuard({ ...args, prs: [merged], lastDispatchAt: '2026-10-15' })).toBeNull();
  });
});

describe('prepare launch refusal', () => {
  const refuse = extra => prepareLaunchRefusal({ ...args, now: Date.parse('2026-10-15T00:00:00Z'), mergedGuardHours: 24, ...extra });
  it('prioritizes an open PR over every other refusal', () => {
    expect(refuse({ prs: [pr()], claims: [{ meta: { num: '5028' }, owner: 'codex' }],
      liveRows: [{ num: '5028', runId: 'r1' }] })).toEqual({ reason: 'open prepare PR #91 (lane/5028d-prepare-x)' });
  });
  it('refuses a recent merged PR regardless of surviving dispatch history', () => {
    expect(refuse({ prs: [pr({ state: 'MERGED' })], lastDispatchAt: pr().createdAt }))
      .toEqual({ reason: 'merged prepare PR #91 (within 24h guard)' });
    expect(refuse({ prs: [pr({ state: 'MERGED' })], lastDispatchAt: '2026-10-15' })).toEqual({ reason: 'merged prepare PR #91 (within 24h guard)' });
    expect(refuse({ prs: [pr({ state: 'MERGED' })] })).toEqual({ reason: 'merged prepare PR #91 (within 24h guard)' });
  });
  it.each([
    [12, '2026-10-15T00:00:00Z', true],
    [12, '2026-10-15T00:00:00.001Z', false],
    [24, '2026-10-18T12:00:00Z', false],
    [0, '2026-10-14T12:00:00Z', false],
  ])('limits the merged refusal to a %sh guard at %s', (mergedGuardHours, now, blocked) => {
    const refusal = refuse({ prs: [pr({ state: 'MERGED' })], lastDispatchAt: pr().createdAt,
      now: Date.parse(now), mergedGuardHours });
    expect(refusal).toEqual(blocked
      ? { reason: `merged prepare PR #91 (within ${mergedGuardHours}h guard)` } : null);
  });
  it.each([
    [{ mergedAt: '2026-10-16T20:32:38Z', closedAt: '2026-10-15T17:18:00Z' }, true],
    [{ closedAt: '2026-10-16T20:32:38Z' }, true],
    [{}, false],
    [{ mergedAt: '2026-10-15T20:53:36Z' }, true],
    [{ mergedAt: '2026-10-15T20:53:35Z', closedAt: '2026-10-16T20:32:38Z' }, false],
    [{ mergedAt: '2026-10-16T20:53:37Z' }, false],
  ])('guards #5399 by merge time with timestamp fallbacks: %j', (timestamps, blocked) => {
    expect(prepareLaunchRefusal({ num: '5966', now: Date.parse('2026-10-16T20:53:36Z'), prs: [pr({
      number: 5399, state: 'MERGED', headRefName: 'lane/5966-prepare-stand-down',
      createdAt: '2026-10-15T17:18:00Z', ...timestamps,
    })] })).toEqual(blocked ? { reason: 'merged prepare PR #5399 (within 24h guard)' } : null);
  });
  it('does not let a newer-created, older-merged PR hide a recent merge', () => {
    expect(refuse({ prs: [
      pr({ number: 92, state: 'MERGED', createdAt: '2026-10-13T11:00:00Z', mergedAt: '2026-10-13T12:00:00Z' }),
      pr({ state: 'MERGED', createdAt: '2026-10-01T12:00:00Z', mergedAt: '2026-10-14T23:39:00Z' }),
    ] })).toEqual({ reason: 'merged prepare PR #91 (within 24h guard)' });
  });
  it.each(['claude', 'codex'])('refuses a live %s claim', owner => {
    expect(refuse({ claims: [{ meta: { num: '#05028' }, owner }] }))
      .toEqual({ reason: `live prepare claim (${owner})` });
  });
  it('refuses a live run', () => {
    expect(refuse({ liveRows: [{ num: 5028, runId: 'run-1' }] })).toEqual({ reason: 'live prepare run (run-1)' });
  });
  it('keeps a held needs-you park', () => {
    expect(refuse({ ledgerFailures: [{ num: '5028', recordedAt: '2026-10-14', holdReason: `needs-you: ${'x'.repeat(150)}`, held: true }] }))
      .toEqual({ reason: `parked needs-you: ${`needs-you: ${'x'.repeat(150)}`.slice(0, 120)}` });
  });
  // PR #5366 review (round 4): a hand stamp completes the record (`completePrepareFailures`); that resolves the park,
  // so a later prepare-stale re-prepare must launch. Same `held && !completed` view as the needs-you list.
  it.each([{ held: true, completed: true }, { held: false, completed: true }, { held: false }])(
    'does not park on a resolved needs-you record: %j', flags => {
      expect(refuse({ ledgerFailures: [{ num: '5028', recordedAt: '2026-10-14', holdReason: 'needs-you: call', ...flags }] })).toBeNull();
    });
  it.each(['releasedAt', 'releasedBy'])('honors an explicit %s release', field => {
    expect(refuse({ ledgerFailures: [{ num: '5028', held: true, holdReason: 'needs-you: call', [field]: 'release' }] })).toBeNull();
  });
  // PR #5366 review: a reviewed release lives in the releases store, not on the ledger record.
  it('honors a reviewed release of the newest attempt', () => {
    const ledgerFailures = [{ num: '5028', attempt: 'run x', recordedAt: '2026-10-14', holdReason: 'needs-you: call', held: true }];
    expect(refuse({ ledgerFailures, releases: [{ target: '5028', attempt: 'run x' }] })).toBeNull();
  });
  it.each([
    ['another attempt', { target: '5028', attempt: 'run old' }],
    ['another card', { target: '99', attempt: 'run x' }],
  ])('keeps the park when the release names %s', (_name, release) => {
    const ledgerFailures = [{ num: '5028', attempt: 'run x', recordedAt: '2026-10-14', holdReason: 'needs-you: call', held: true }];
    expect(refuse({ ledgerFailures, releases: [release] })).toEqual({ reason: 'parked needs-you: needs-you: call' });
  });
  it('uses only the newest record for this card, independent of array order', () => {
    expect(refuse({ ledgerFailures: [
      { num: '5028', recordedAt: '2026-10-15', holdReason: 'transient', held: true },
      { num: '5028', recordedAt: '2026-10-14', holdReason: 'needs-you: old', held: true },
      { num: '99', recordedAt: '2026-10-16', holdReason: 'needs-you: other', held: true },
    ] })).toBeNull();
  });
  it('admits a card with no blocking evidence', () => expect(refuse({})).toBeNull());
});

it('refuses duplicate prepare batch members by exact title identity without granting write authority', () => {
  const pr = { title: 'prepare: 7201, 7202, 7203', headRefName: 'lane/7201-prepare-batch', state: 'OPEN' };
  expect(isPreparePrFor(pr, { num: '7202' })).toBe(true);
  expect(isPreparePrFor(pr, { num: '720' })).toBe(false);
  expect(isLanePreparePrFor(pr, { num: '7202' })).toBe(false);
  expect(isPreparePrFor({ ...pr, isCrossRepository: true }, { num: '7202' })).toBe(false);
});
