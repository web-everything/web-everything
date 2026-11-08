import { expect, it, vi } from 'vitest';
import { findSuspendedReferralRuns, resolveReferralJudgeWindow } from '../suspended-referral-run.mjs';
const run = { id: 'review-pr-one', op: 'review-pr', input: { repo: 'o/r', pr: 1, head: 'old' },
  findings: { read: { netBasis: { rev: 'head' } } }, pending: { kind: 'effect', step: 'mandatoryReferrals' },
  stepTimings: [{ step: 'mandatoryReferrals', startedAt: '2026-11-08T12:00:00Z' }],
  effects: [{ payload: { referrals: [{ seat: 'judge', original: { file: 'x', line: 2, summary: 'broken guard' } }] } }] };
const opts = { repo: 'o/r', pr: 1, head: 'head', now: Date.parse('2026-11-08T13:00:00Z'), runsDir: 'runs',
  list: () => ['other', run.id], read: () => run, stat: () => ({ mtimeMs: Date.parse('2026-11-08T12:30:00Z') }) };
it('reads current-head suspended referrals with finding identity and step age', () => {
  expect(findSuspendedReferralRuns(opts)).toEqual([{ id: run.id, ageMs: 3600000,
    pendingSince: '2026-11-08T12:00:00.000Z', findings: [expect.objectContaining({ key: expect.any(String), summary: 'broken guard', file: 'x', line: 2 })] }]);
  expect(findSuspendedReferralRuns({ ...opts, head: 'old' })).toEqual([]);
  expect(findSuspendedReferralRuns({ ...opts, read: () => ({ ...run, pending: { kind: 'confirm', step: 'mandatoryReferrals' } }) })).toEqual([]);
});
it('falls back to mtime, refuses oversized scans and propagates unreadable evidence', () => {
  expect(findSuspendedReferralRuns({ ...opts, read: () => ({ ...run, stepTimings: [] }) })[0].ageMs).toBe(1800000);
  expect(() => findSuspendedReferralRuns({ ...opts, list: () => Array(10001).fill(run.id) })).toThrow(/inspect run store/);
  expect(() => findSuspendedReferralRuns({ ...opts, read: () => { throw Error('unreadable'); } })).toThrow('unreadable');
});
it('resolves window with cascade provenance and rejects invalid env values', () => {
  const log = vi.fn();
  const readFile = path => String(path).endsWith('referral-judge-window.json') ? '{"referralWindowMinutes":60}' : '{"referralJudgeWindow":{"referralWindowMinutes":20}}';
  const setting = resolveReferralJudgeWindow({ env: { WE_REFERRAL_JUDGE_WINDOW_MIN: '7', WE_POLICY_CASCADE_LOG: '1' }, log, readFile });
  expect(setting.value.referralWindowMinutes).toBe(7); expect(setting.sources.referralWindowMinutes).toBe('env');
  expect(log.mock.calls.flat().join(' ')).toMatch(/referralWindowMinutes=7.*env/);
  for (const value of ['0', '1.5', '9007199254740992']) expect(resolveReferralJudgeWindow({ env: { WE_REFERRAL_JUDGE_WINDOW_MIN: value }, readFile }).value.referralWindowMinutes).toBe(60);
});
