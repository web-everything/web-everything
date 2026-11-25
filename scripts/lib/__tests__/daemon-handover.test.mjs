// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  EX_RELOAD, EX_HANDED_OVER, swapEnabled, validateReadyRecord, probationVerdict, switchPauseMs,
} from '../daemon-handover.mjs';

const ready = { gen: 2, codeDigest: 'abc', pid: 42, smoke: 'ok' };

describe('daemon-handover', () => {
  it('exit codes', () => { expect([EX_RELOAD, EX_HANDED_OVER]).toEqual([76, 77]); });

  it('swap setting is off unless explicitly on', () => {
    expect(swapEnabled(undefined, 'drain')).toBe(false);
    expect(swapEnabled({ daemons: { blueGreenSwap: {} } }, 'drain')).toBe(false);
    expect(swapEnabled({ daemons: { blueGreenSwap: { drain: 'off' } } }, 'drain')).toBe(false);
    expect(swapEnabled({ daemons: { blueGreenSwap: { drain: 'on' } } }, 'drain')).toBe(true);
    expect(swapEnabled({ daemons: { blueGreenSwap: { drain: true } } }, 'review')).toBe(false);
  });

  it('ready record: missing fields, foreign pid and digest mismatch refuse', () => {
    expect(validateReadyRecord(ready, { gen: 2, codeDigest: 'abc', pid: 42 }).ok).toBe(true);
    expect(validateReadyRecord(undefined).ok).toBe(false);
    expect(validateReadyRecord({ ...ready, smoke: 'fail' }).reason).toBe('smoke');
    expect(validateReadyRecord({ ...ready, pid: undefined }).ok).toBe(false);
    expect(validateReadyRecord(ready, { pid: 43 }).reason).toBe('foreign-pid');
    expect(validateReadyRecord(ready, { codeDigest: 'zzz' }).reason).toBe('digest-mismatch');
    expect(validateReadyRecord(ready, { gen: 3 }).reason).toBe('gen-mismatch');
  });

  it('probation verdict is pure and never promotes on missing data', () => {
    const base = { startedAt: 0, now: 100, lastHeartbeatAt: 90, staleAfterMs: 50, probationMs: 1000 };
    expect(probationVerdict({ ...base, passExitCodes: [0] })).toBe('promote');
    expect(probationVerdict({ ...base, passExitCodes: [] })).toBe('wait');
    expect(probationVerdict({ ...base, passExitCodes: [0, 1] })).toBe('rollback');
    expect(probationVerdict({ ...base, passExitCodes: [0], lastHeartbeatAt: 10 })).toBe('rollback');
    expect(probationVerdict({ ...base, passExitCodes: [0], lastHeartbeatAt: undefined })).toBe('rollback');
    expect(probationVerdict({ ...base, passExitCodes: [], now: 2000, lastHeartbeatAt: 1990 })).toBe('rollback');
    expect(probationVerdict({ passExitCodes: [0] })).toBe('rollback');
  });

  it('switch pause measurement', () => {
    expect(switchPauseMs(1000, 4000)).toBe(3000);
    expect(switchPauseMs(1000, undefined)).toBeNull();
    expect(switchPauseMs(4000, 1000)).toBeNull();
  });
});

describe('probation audit regressions', () => {
  const base = { startedAt: 0, now: 100, lastHeartbeatAt: 90, staleAfterMs: 50, probationMs: 1000, passExitCodes: [0] };
  it.each([1000, 1001])('rejects a clean pass at or after expiry (%i)', (now) => {
    expect(probationVerdict({ ...base, now, lastHeartbeatAt: now })).toBe('rollback');
  });
  it('rejects future heartbeats', () => {
    expect(probationVerdict({ ...base, lastHeartbeatAt: 101 })).toBe('rollback');
  });
  it.each([new Array(1), [0, , 0], ['0'], [NaN], [false], [undefined], null, { length: 1 }].map((passExitCodes) => ({ passExitCodes })))('rejects non-dense numeric pass arrays: $passExitCodes', ({ passExitCodes }) => {
    expect(probationVerdict({ ...base, passExitCodes })).toBe('rollback');
  });
});

describe('ready record field regressions', () => {
  it.each(['gen', 'codeDigest', 'pid', 'smoke'])('missing %s refuses readiness', (field) => {
    const record = { ...ready };
    delete record[field];
    expect(validateReadyRecord(record)).toEqual({ ok: false, reason: field });
  });
  it('a probation start later than now never promotes', () => {
    expect(probationVerdict({ startedAt: 101, now: 100, lastHeartbeatAt: 90,
      staleAfterMs: 50, probationMs: 1000, passExitCodes: [0] })).toBe('wait');
  });
});
