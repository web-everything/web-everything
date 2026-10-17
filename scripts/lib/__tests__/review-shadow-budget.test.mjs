import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveShadowSession, shadowBudgetDay } from '../review-shadow-budget.mjs';
import { resolveReviewSeatSafeguards } from '../review-seat-settings.mjs';
import { loadReviewSeatSettings, seatProviderDirective } from '../review-seat-provider.mjs';
import { buildShapePlan } from '../../review-core-cli.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';

const resolve = (options = {}) => resolveReviewSeatSafeguards({
  env: {}, platform: {}, readFile: () => '{}', log: () => {}, ...options,
});
describe('high-care shadow admission', () => {
  const settings = loadReviewSeatSettings({ safeguards: resolve({ env: { WE_REVIEW_SHADOW_AGY_ENABLED: 'true' } }), log: () => {} });
  it.each(['scripts/lib/review-seat-provider.mjs', 'scripts/lib/gate-config.mjs'])('seats an earned high-care PR: %s', (file) => {
    const earnedShape = buildShapePlan({ changedFiles: [file] });
    expect(['elevated', 'high']).toContain(earnedShape.careLevel);
    expect(seatProviderDirective(settings, 'correctness', { repo: 'o/r', pr: 1, earnedShape })).toMatchObject({ mode: 'shadow', dailyCap: 100 });
  });
  it('does not seat a routine PR', () => {
    const earnedShape = buildShapePlan({ changedFiles: ['backlog/123-example.md'] });
    expect(seatProviderDirective(settings, 'correctness', { repo: 'o/r', pr: 1, earnedShape })).toBeNull();
  });
  it('does not seat a shadow without an explicit operational policy', () => {
    expect(seatProviderDirective({ seatProvider: { correctness: 'shadow' }, agyModel: 'gemini-4-argon-high' },
      'correctness', { repo: 'o/r', pr: 1, careLevel: 'high' })).toBeNull();
  });
  it('honors sensitive escalation reasons even below elevated', () => {
    expect(seatProviderDirective(settings, 'correctness', { repo: 'o/r', pr: 1,
      earnedShape: { careLevel: 'low', reasons: ['gate-self (policy.json)'] } })).toBeTruthy();
  });
  it('resolves both new leaves with provenance and rejects invalid overrides', () => {
    const logs = [];
    const result = resolve({ platform: { shadowSeats: { antigravity: { scope: 'sampled', dailyCap: 42 } } },
      readFile: () => '{"shadowSeats":{"antigravity":{"scope":"high-care","dailyCap":12}}}',
      env: { WE_REVIEW_SHADOW_AGY_SCOPE: 'sampled', WE_REVIEW_SHADOW_AGY_DAILY_CAP: '3' }, log: s => logs.push(s) });
    expect(result.value).toMatchObject({ scope: 'sampled', dailyCap: 3, shadowEnabled: false });
    expect(result.sources).toMatchObject({ scope: 'env', dailyCap: 'env' });
    expect(logs.join(' ')).toContain('dailyCap=3 (env)');
    const invalid = resolve({ env: { WE_REVIEW_SHADOW_AGY_SCOPE: 'all', WE_REVIEW_SHADOW_AGY_DAILY_CAP: '-1' } });
    expect(invalid.value).toMatchObject({ scope: 'high-care', dailyCap: 100 });
    expect(invalid.invalid.length).toBe(2);
    expect(resolve({ platform: { shadowSeats: { antigravity: { scope: 'sampled', dailyCap: 42 } } } }).sources)
      .toMatchObject({ scope: 'platform', dailyCap: 'platform' });
    expect(resolve({ readFile: () => '{"shadowSeats":{"antigravity":{"scope":"sampled","dailyCap":12}}}' }).sources)
      .toMatchObject({ scope: 'tool', dailyCap: 'tool' });
  });
});
describe('daily session cap', () => {
  it.each(['agy', 'shadow'].flatMap(mode => ['claude', 'skip'].flatMap(onEscape =>
    ['quota-hold', 'quota-exhausted', 'cap'].map(kind => ({ mode, onEscape, kind })))))
  ('$mode with onEscape=$onEscape preserves the Claude answer policy on $kind', async ({ mode, onEscape, kind }) => {
    let claudeCalls = 0;
    const result = await runSeatWithProvider({ lens: 'correctness', seatProvider: { mode, onEscape, model: 'm' } }, {
      cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => { claudeCalls++; return { value: { summary: 'Claude judged', findings: [] } }; },
      agyJuror: async () => kind === 'cap' ? { status: 'skipped', reasons: ['daily cap reached'] }
        : { status: 'failed', reasons: [`antigravity: skip-${kind}`] },
      appendRow: () => true, log: () => {},
    });
    const answered = mode === 'shadow' || onEscape === 'claude';
    expect(claudeCalls).toBe(Number(answered));
    if (answered) {
      expect(result.summary).toBe('Claude judged');
      expect(result.skipped).toBeUndefined();
    } else expect(result.skipped).toBeDefined();
  });
  it('refuses admission when the budget store is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-budget-unavailable-'));
    try {
      const path = join(dir, 'not-a-directory');
      writeFileSync(path, 'occupied');
      const models = [];
      const result = await runSeatWithProvider({ lens: 'correctness', seatProvider: {
        mode: 'shadow', model: 'gemini', fallbackModel: 'opus', dailyCap: 1,
      } }, {
        cwd: '.', unwrap: x => x, wrap: value => value,
        claudeJudge: async () => ({ value: { summary: 'Claude judged', findings: [] } }),
        agyJuror: async ({ model }) => { models.push(model); return { status: 'ok' }; },
        reserveSession: options => reserveShadowSession({ ...options, path: join(path, 'budget') }),
        appendRow: () => true, log: () => {},
      });
      expect(models).toEqual([]);
      expect(result.summary).toBe('Claude judged');
      expect(result.shadow).toMatchObject({ status: 'skipped', reasons: ['daily cap store unavailable'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reserves another slot before model fallback and skips when exhausted', async () => {
    const events = [];
    let reservations = 0;
    const result = await runSeatWithProvider({ lens: 'correctness', seatProvider: {
      mode: 'shadow', model: 'gemini', fallbackModel: 'opus', dailyCap: 1,
    } }, {
      cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => ({ value: { summary: 'Claude judged', findings: [] } }),
      agyJuror: async ({ model }) => { events.push(model); return { status: 'failed', reasons: ['model failed'] }; },
      reserveSession: () => { events.push('reserve'); return { allowed: ++reservations === 1, reason: 'daily cap reached' }; },
      appendRow: () => true, log: () => {},
    });
    expect(events).toEqual(['reserve', 'gemini', 'reserve']);
    expect(result.summary).toBe('Claude judged');
    expect(result.shadow).toMatchObject({ status: 'skipped', reasons: ['daily cap reached'] });
  });
  it('persists reservations across callers and resets at New York midnight, including DST', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-budget-'));
    try {
      const path = join(dir, 'agy-shadow-agreement.jsonl');
      const now = Date.parse('2026-10-16T03:59:59Z');
      expect(shadowBudgetDay(now)).toBe('2026-10-15');
      expect(shadowBudgetDay(Date.parse('2026-01-16T04:59:59Z'))).toBe('2026-01-15');
      const reserve = () => reserveShadowSession({ path, now, dailyCap: 2 });
      expect(reserve().allowed).toBe(true);
      expect(reserve().allowed).toBe(true);
      expect(reserve()).toEqual({ allowed: false, reason: 'daily cap reached' });
      expect(reserveShadowSession({ path, now: now + 1000, dailyCap: 2 }).allowed).toBe(true);
      expect(reserveShadowSession({ path, now, dailyCap: 0 }).allowed).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['cap', 'quota'])('%s skips never launch an Opus fallback', async (kind) => {
    const models = [], logs = [];
    let claudeCalls = 0;
    const result = await runSeatWithProvider({ lens: 'correctness', seatProvider: {
      mode: 'shadow', model: 'gemini-4-argon-high', fallbackModel: 'claude-opus-5-5-high', dailyCap: 100,
    } }, {
      cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => { claudeCalls++; return { value: { findings: [] }, telemetry: { sessionId: 'claude' } }; },
      agyJuror: async ({ model }) => { models.push(model); return { status: 'failed', reasons: ['antigravity: skip-quota-hold'] }; },
      reserveSession: () => ({ allowed: kind !== 'cap', reason: 'daily cap reached' }),
      appendRow: () => true, log: s => logs.push(s),
    });
    expect(claudeCalls).toBe(1); // The original mandatory juror, never a fallback.
    expect(models).toEqual(kind === 'cap' ? [] : ['gemini-4-argon-high']);
    expect(result.shadow.status).toBe(kind === 'cap' ? 'skipped' : 'failed');
    expect(logs.join(' ')).not.toContain('FALLING BACK');
    if (kind === 'cap') expect(logs.join(' ')).toContain('daily cap reached');
  });
});
