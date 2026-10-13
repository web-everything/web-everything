import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PROMOTION_DEFAULTS, resolvePromotionSettings, formatPromotionSettings, reclassifyRow, readShadowRuns, measureReadiness, formatReadinessLine } from '../ledger-promotion-readiness.mjs';
describe('promotion settings', () => {
  it('cascades with sources and ignores invalid layers', () => {
    expect(resolvePromotionSettings()).toMatchObject({ settings: PROMOTION_DEFAULTS, sources: { windowDays: 'standard' } });
    const s = resolvePromotionSettings({ repo: { verdictLedger: { promotion: { windowDays: 3, minComparedPRs: -1, minAgreementPct: 95.5 } } }, env: { WE_LEDGER_PROMOTION_WINDOW_DAYS: '4', WE_LEDGER_PROMOTION_MIN_AGREEMENT_PCT: '101' } });
    expect(s.settings).toMatchObject({ windowDays: 4, minComparedPRs: 100, minAgreementPct: 95.5 });
    expect(s.sources).toMatchObject({ windowDays: 'env', minComparedPRs: 'standard', minAgreementPct: 'repo' });
    expect(s.invalid).toHaveLength(2);
    expect(formatPromotionSettings(s)).toContain('windowDays=4 (env)');
  });
  it.each(['-1', 'NaN', 'Infinity', '0', '1.5', ' '])('rejects invalid window %s', (raw) => {
    const s = resolvePromotionSettings({ env: { WE_LEDGER_PROMOTION_WINDOW_DAYS: raw } });
    expect(s.settings.windowDays).toBe(7);
    expect(s.sources.windowDays).toBe('standard');
    expect(s.invalid).toHaveLength(1);
  });
  it('pins the TS mirror', () => {
    const ts = readFileSync('config/platformDefaults.ts', 'utf8').split('PLATFORM_VERDICT_LEDGER_DEFAULTS =')[1].split('} as const')[0];
    for (const [key, value] of Object.entries(PROMOTION_DEFAULTS)) expect(ts).toMatch(new RegExp(key + ': ' + value + '[,\\s]'));
  });
});
const legacy = (code, direction = 'ledger-holds-label-clears') => ({ status: 'disagree', direction, reason: 'ledger holds: ' + code });
describe('promotion evidence', () => {
  it('replays only legacy mechanical ledger holds', () => {
    expect(reclassifyRow(legacy('hold:drain:required check test, hold:drain:red-main-hold')).status).toBe('transient');
    for (const r of [legacy('hold:drain:review'), legacy('stale-acceptance'), legacy('hold:drain:codeql', 'ledger-clears-label-holds'), { ...legacy('hold:drain:codeql'), schema: 2 }]) expect(reclassifyRow(r).status).toBe('disagree');
  });
  it('reuses the shadow history reader with injected IO', () => {
    expect(readShadowRuns({ dir: '/x', listIds: () => ['drain-ledger-shadow-1', 'other-1'], read: () => ({ op: 'drain-ledger-shadow' }) }).runs).toHaveLength(1);
  });
  it('takes schema-2 records as written and blocks truncated evidence', () => {
    const runs = [{ input: { at: '2026-10-13T12:00:00Z', schema: 2 }, findings: {
      rows: [{ repo: 'o/r', pr: 1, ...legacy('hold:drain:codeql') }], rowsTruncated: true,
    } }];
    const m = measureReadiness(runs, { now: '2026-10-13T14:00:00Z', settings: PROMOTION_DEFAULTS });
    expect(m.disagree).toBe(1);
    expect(m.transient).toBe(0);
    expect(m.blockers).toContain('incompleteRecords');
  });
  it('counts ET days, unique PRs, unsafe rows and excludes transient from agreement', () => {
    const run = (at, rows, schema = 2) => ({ input: { at, schema }, findings: { rows } });
    const r = { repo: 'O/R', pr: 1, status: 'agree' };
    const runs = [run('2026-10-11T03:00:00Z', [r]), run('2026-10-12T12:00:00Z', [r, { ...r, pr: 2, ...legacy('hold:drain:codeql') }], 1),
      run('2026-10-13T12:00:00Z', [r, { ...r, pr: 3, status: 'disagree', direction: 'ledger-clears-label-holds', reason: 'unsafe' }, { ...r, pr: 4, status: 'unreadable' }])];
    const m = measureReadiness(runs, { now: '2026-10-13T14:00:00Z', settings: { ...PROMOTION_DEFAULTS, windowDays: 2 } });
    expect(m).toMatchObject({ window: { from: '2026-10-12', to: '2026-10-13' }, records: 2, shadowDays: 2, comparedPRs: 4, rows: 5, agree: 2, disagree: 1, unreadable: 1, transient: 1, unsafe: 1, agreementPct: 50, ready: false });
    expect(m.topDisagreeReasons).toEqual([{ reason: 'unsafe', n: 1 }]);
    expect(formatReadinessLine(m, resolvePromotionSettings())).toContain('NOT READY');
    expect(measureReadiness([], { now: '2026-10-13', settings: PROMOTION_DEFAULTS }).ready).toBe(false);
    const ready = measureReadiness([run('2026-10-13T12:00:00Z', [r])], { now: '2026-10-13T14:00:00Z', settings: { ...PROMOTION_DEFAULTS, minComparedPRs: 1, minShadowDays: 1 } });
    expect(ready.ready).toBe(true);
    expect(formatReadinessLine(ready, resolvePromotionSettings())).toContain('operator flips');
  });
});
