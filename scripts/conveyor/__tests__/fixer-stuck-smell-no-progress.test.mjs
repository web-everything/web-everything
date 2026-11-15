import { describe, expect, it } from 'vitest';
import fixerStuck from '../health-smells/fixer-stuck.mjs';
import { escalationAckKey } from '../session-watchdog.mjs';

const finding = {
  type: 'fixer-stuck', repo: 'we', pr: 6770, classification: 'no-progress',
  key: 'we#6770|sid-fix-6770|no-progress|head', at: '2026-11-14T23:47:00.000Z',
  session: { name: 'fix-6770' }, evidence: { noProgressMinutes: 120 },
};
const evaluate = (f, acked) => fixerStuck.evaluate({ sessionWatchdog: { findings: [f], acked } })[0];

describe('fixer-stuck smell — event acknowledgments', () => {
  it('hands off a no-progress event acknowledged with key@at', () => {
    const result = evaluate(finding, [escalationAckKey(finding)]);
    expect(result.measure.handedOff).toBe(true);
    expect(result.escalation.humanOnly).toBe(false);
  });

  it('keeps a legacy bare-key no-progress ack human-only', () => {
    const result = evaluate(finding, [finding.key]);
    expect(result.measure.handedOff).toBe(false);
    expect(result.escalation.humanOnly).toBe(true);
  });

  it('keeps a different event instance human-only', () => {
    const result = evaluate(finding, [escalationAckKey({ ...finding, at: '2026-11-14T22:47:00.000Z' })]);
    expect(result.measure.handedOff).toBe(false);
    expect(result.escalation.humanOnly).toBe(true);
  });

  it.each(['stalled', 'waiting-loop'])('preserves bare-key handoff for %s', (classification) => {
    const f = { ...finding, classification, key: `we#6770|sid|${classification}|head` };
    expect(evaluate(f, [f.key])).toMatchObject({ measure: { handedOff: true }, escalation: { humanOnly: false } });
    expect(evaluate(f, [])).toMatchObject({ measure: { handedOff: false }, escalation: { humanOnly: true } });
  });
});
