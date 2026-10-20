import { it, expect, vi } from 'vitest';
const { runs } = vi.hoisted(() => ({ runs: [{ input: { schema: 2, at: '2026-10-13T12:00:00Z' }, findings: { rows: [
  { status: 'disagree', direction: 'ledger-holds-label-clears', reason: 'no ledger row for this PR' },
  { status: 'disagree', direction: 'ledger-holds-label-clears', ledgerHolds: ['stale-acceptance', 'verdict:pending'], reason: 'mixed' },
  { status: 'disagree', direction: 'ledger-clears-label-holds', ledgerHolds: ['hold:drain:review'], reason: 'unsafe' },
  { status: 'disagree', direction: 'ledger-holds-label-clears', reason: 'unknown strictness' },
] } }] }));
vi.mock('../settings-files.mjs', () => ({ readSettings: () => ({ verdictLedger: { promotion: { countRecordsAfter: null } } }) }));
vi.mock('../ledger-promotion-readiness.mjs', async importOriginal => ({ ...await importOriginal(), readShadowRuns: () => ({ runs, corrupt: 0 }) }));
it('replay reports before, after, projected and residual strictness without projecting live readiness', async () => {
  const argv = process.argv;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    // Keep the fixture inside the live readiness window regardless of the test run date.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T14:00:00Z'));
    process.argv = ['node', 'ledger-readiness', '--replay', '--json'];
    await import('../../ledger-readiness.mjs');
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.replay.before.disagree).toBe(4);
    expect(report.replay.after.disagree).toBe(4);
    expect(report.replay.projected).toMatchObject({ agree: 1, disagree: 3,
      remainingByCode: { 'verdict:pending': 1, 'hold:drain:review': 1, 'unknown strictness': 1 } });
    expect(report.disagree).toBe(4);
  } finally { process.argv = argv; log.mockRestore(); vi.useRealTimers(); }
});
