import { describe, expect, it } from 'vitest';
import b from './claude-auth-needs-you.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('claude-auth-needs-you judge', () => {
  const good = () => ({
    sustained: { opened: true, refreshCleared: 0, calls: [{ kind: 'claude-auth-expired', reason: 'Claude login expired — re-login' }] },
    blip: { opened: false, calls: [] },
  });
  it('rejects missing or incomplete replay evidence', () => {
    expect(b.judge({})).not.toEqual([]);
    expect(b.judge({ sustained: good().sustained })).not.toEqual([]);
  });
  it('rejects a silent sustained outage', () => {
    const report = good();
    report.sustained.calls = [];
    expect(b.judge(report)).not.toEqual([]);
  });
  it('rejects duplicate sustained-outage publications', () => {
    const report = good();
    report.sustained.calls.push(report.sustained.calls[0]);
    expect(b.judge(report)).not.toEqual([]);
  });
  it('rejects an alert cleared by a complete feed refresh', () => {
    const report = good();
    report.sustained.refreshCleared = 1;
    expect(b.judge(report)).not.toEqual([]);
  });
  it('rejects a single-session blip alert', () => {
    const report = good();
    report.blip.calls.push(report.sustained.calls[0]);
    expect(b.judge(report)).not.toEqual([]);
  });
  it('accepts one re-login item and a silent single-session blip', () => {
    expect(b.judge(good())).toEqual([]);
  });
});
