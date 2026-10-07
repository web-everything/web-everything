/**
 * Live 2026-10-07: fix-4244 ended `blocked-on-infra` on a single GitHub 500 and the PR then waited out the long
 * cool-off. A report that says `--cause=transient` cools off for minutes (a knob); every other case is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { markSelfReportedDone, resolveInfraTransientCooloffMs, INFRA_TRANSIENT_COOLOFF_MS, INFRA_RETRY_COOLOFF_MS } from '../reconcile-core.mjs';
import { applyCompletionUpdate, normalizeInfraCause, validateCompletionRecord } from '../../operations/completion-record.mjs';

const T0 = Date.parse('2026-10-07T16:50:00Z');
const listed = { name: 'fix-4244', state: 'blocked', status: 'idle', startedAt: T0 - 600_000, pid: 1 };
const record = { status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-10-07T16:56:00Z' };
const recFor = (r) => (name) => (name === 'fix-4244' ? r : null);
const at = (min) => Date.parse('2026-10-07T16:56:00Z') + min * 60_000;

describe('blocked-on-infra cool-off by cause', () => {
  it('a transient cause is retried after the short cool-off', () => {
    const t = { ...record, cause: 'transient' };
    expect(markSelfReportedDone([listed], recFor(t), at(2))[0].selfReportedDone).toBeUndefined();
    expect(markSelfReportedDone([listed], recFor(t), at(4))[0].selfReportedDone).toBe(true);
  });
  it('without the cause the normal cool-off still applies', () => {
    expect(markSelfReportedDone([listed], recFor(record), at(4))[0].selfReportedDone).toBeUndefined();
    expect(markSelfReportedDone([listed], recFor(record), at(16))[0].selfReportedDone).toBe(true);
  });
  it('a capped streak stays slow even when transient', () => {
    const t = { ...record, cause: 'transient', infraStreak: 4 };
    expect(markSelfReportedDone([listed], recFor(t), at(30))[0].selfReportedDone).toBeUndefined();
  });
  it('the knob is minutes; bad values fall back, and it never exceeds the normal cool-off', () => {
    expect(resolveInfraTransientCooloffMs({})).toBe(INFRA_TRANSIENT_COOLOFF_MS);
    expect(resolveInfraTransientCooloffMs({ WE_INFRA_TRANSIENT_COOLOFF_MINUTES: '1' })).toBe(60_000);
    expect(resolveInfraTransientCooloffMs({ WE_INFRA_TRANSIENT_COOLOFF_MINUTES: 'x' })).toBe(INFRA_TRANSIENT_COOLOFF_MS);
    const t = { ...record, cause: 'transient' };
    expect(markSelfReportedDone([listed], recFor(t), at(4), { transientCooloffMs: 60 * 60_000 })[0].selfReportedDone).toBeUndefined();
    expect(INFRA_TRANSIENT_COOLOFF_MS).toBeLessThan(INFRA_RETRY_COOLOFF_MS);
  });
});

describe('completion record cause', () => {
  it('only the known cause is stored; anything else is dropped', () => {
    expect(normalizeInfraCause('transient')).toBe('transient');
    expect(normalizeInfraCause('whatever')).toBeNull();
    const base = { v: 1, session: 'fix-4244', kind: 'fix', pr: '4244', item: null, status: 'started', startedAt: '2026-10-07T16:00:00Z', updatedAt: '2026-10-07T16:00:00Z' };
    expect(applyCompletionUpdate(base, { cause: 'transient' }).cause).toBe('transient');
    expect(applyCompletionUpdate(base, { cause: 'rm -rf' }).cause).toBeNull();
    expect(validateCompletionRecord(applyCompletionUpdate(base, { status: 'done', outcome: 'blocked-on-infra', cause: 'transient' })).ok).toBe(true);
  });
});
