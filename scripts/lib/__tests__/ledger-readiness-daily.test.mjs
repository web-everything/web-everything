import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAILY_CHECK_DEFAULTS, resolveDailyCheckSettings, dailyCheckDue, buildDailyLine, readLatestLines, runDailyReadinessCheck,
} from '../ledger-readiness-daily.mjs';
import { resolvePromotionSettings } from '../ledger-promotion-readiness.mjs';
import smell from '../../conveyor/health-smells/ledger-readiness-regressed.mjs';

// 2026-10-13 is EDT (UTC-4): 21:59 ET = 01:59Z next day, 22:00 ET = 02:00Z.
const BEFORE = Date.parse('2026-10-14T01:59:00Z'), AT = Date.parse('2026-10-14T02:00:00Z'), MORNING = Date.parse('2026-10-13T12:00:00Z');
const quietSettings = { start: '22:00', end: '07:00', timeZone: 'America/New_York' };

describe('dailyCheck settings cascade', () => {
  it('standard, repo, env, with invalid layers reported', () => {
    expect(resolveDailyCheckSettings({}).settings).toEqual(DAILY_CHECK_DEFAULTS);
    const r = resolveDailyCheckSettings({ repo: { verdictLedger: { promotion: { dailyCheck: { enabled: false, at: '21:30' } } } } });
    expect(r.settings).toEqual({ enabled: false, at: '21:30' }); expect(r.sources).toEqual({ enabled: 'repo', at: 'repo' });
    const e = resolveDailyCheckSettings({ repo: { verdictLedger: { promotion: { dailyCheck: { enabled: false } } } }, env: { WE_LEDGER_DAILY_CHECK_ENABLED: 'true', WE_LEDGER_DAILY_CHECK_AT: '25:00' } });
    expect(e.settings).toEqual({ enabled: true, at: 'quiet-start' }); expect(e.sources.enabled).toBe('env');
    expect(e.invalid).toEqual(['env.WE_LEDGER_DAILY_CHECK_AT']);
  });
  it('pins the TS mirror', () => {
    const ts = readFileSync('config/platformDefaults.ts', 'utf8').split('dailyCheck: {')[1].split('}')[0];
    expect(ts).toMatch(/enabled: true,/); expect(ts).toMatch(/at: 'quiet-start',/);
  });
});

describe('dailyCheckDue', () => {
  it('fires at quiet-hours start, not before, once per ET day', () => {
    expect(dailyCheckDue({ now: BEFORE, quietSettings }).due).toBe(false);
    expect(dailyCheckDue({ now: AT, quietSettings })).toMatchObject({ due: true, day: '2026-10-13' });
    expect(dailyCheckDue({ now: AT, quietSettings, lastDay: '2026-10-13' }).due).toBe(false);
  });
  it('fires early when quiet mode turns on, and never when disabled', () => {
    expect(dailyCheckDue({ now: MORNING, quietSettings, toggle: { on: true, until: null } })).toMatchObject({ due: true, trigger: 'quiet-mode turned on' });
    expect(dailyCheckDue({ now: AT, quietSettings, settings: { enabled: false, at: 'quiet-start' } }).due).toBe(false);
  });
  it('honours an explicit HH:MM', () => {
    expect(dailyCheckDue({ now: MORNING, quietSettings, settings: { enabled: true, at: '07:30' } }).due).toBe(true);
    expect(dailyCheckDue({ now: MORNING, quietSettings, settings: { enabled: true, at: '09:00' } }).due).toBe(false);
  });
});

const measure = (over = {}) => ({ window: { from: 'a', to: 'b' }, ready: false, blockers: ['agreementPct'], agreementPct: 90, agree: 9, disagree: 1, unreadable: 0, transient: 0, unsafe: 0, comparedPRs: 5, shadowDays: 3, topDisagreeReasons: [], ...over });
const promotion = resolvePromotionSettings({});
const dailyCheck = resolveDailyCheckSettings({});

describe('history line and smell', () => {
  it('flags unsafe over the limit and an agreement drop', () => {
    const first = buildDailyLine({ measure: measure(), promotion, dailyCheck, day: 'd1', at: 'x', trigger: 't' });
    expect(first).toMatchObject({ schema: 1, previousAgreementPct: null, agreementDropped: false, unsafeOverLimit: false });
    const second = buildDailyLine({ measure: measure({ agreementPct: 89.5, unsafe: 2 }), previous: first, promotion, dailyCheck, day: 'd2', at: 'x', trigger: 't' });
    expect(second).toMatchObject({ agreementDropped: true, unsafeOverLimit: true, agreementDelta: -0.5 });
    expect(smell.evaluate({ ledgerReadiness: { latest: first } })[0].breach).toBe(false);
    const [row] = smell.evaluate({ ledgerReadiness: { latest: second } });
    expect(row.breach).toBe(true); expect(row.summary).toMatch(/unsafe/); expect(row.summary).toMatch(/fell to 89.5%/);
    expect(smell.evaluate({ ledgerReadiness: { latest: null } })).toEqual([]);
  });
  it('appends one line per day and reads it back; read-only otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrd-')), historyPath = join(dir, 'h.jsonl');
    const deps = { historyPath, env: {}, repoSettings: {}, readRuns: () => ({ runs: [] }), quiet: () => ({ settings: quietSettings, toggle: null }), log: () => {} };
    expect(runDailyReadinessCheck({ ...deps, now: BEFORE }).ran).toBe(false);
    const ran = runDailyReadinessCheck({ ...deps, now: AT });
    expect(ran).toMatchObject({ ran: true, latest: { day: '2026-10-13' } });
    expect(runDailyReadinessCheck({ ...deps, now: AT + 60_000 }).ran).toBe(false);
    expect(readLatestLines(historyPath, 5)).toHaveLength(1);
    runDailyReadinessCheck({ ...deps, now: AT + 86_400_000, dryRun: true });
    expect(readLatestLines(historyPath, 5)).toHaveLength(1);
    writeFileSync(historyPath, readFileSync(historyPath, 'utf8') + '{torn\n');
    expect(readLatestLines(historyPath, 2)).toHaveLength(1);
  });
});
