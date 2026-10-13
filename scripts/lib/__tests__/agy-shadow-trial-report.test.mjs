import { describe, expect, it } from 'vitest';
import { buildTrialReport } from '../agy-shadow-trial-report.mjs';

const model = 'gemini-4-argon-high';
const row = (extra = {}) => ({
  at: '2026-10-12T01:00:00Z', repo: 'o/r', pr: 7, head: 'a'.repeat(40), lens: 'correctness',
  runId: 'review-pr-first', model, status: 'ok', agyVerdict: 'accept', claudeVerdict: 'accept',
  verdictAgree: true, overlap: { jaccard: 1, agyCount: 0 }, agyFindings: [], ...extra,
});
const anchor = (path, line, matched = false) => ({ path, line, matched });
const fixRecord = (files, extra = {}) => ({
  input: { repo: 'o/r', pr: 7 },
  findings: { read: { latestFix: { priorHead: 'a'.repeat(40), head: 'b'.repeat(40), files } } },
  ...extra,
});
const report = (rows, extra = {}) => buildTrialReport({ rows, model, ...extra });

describe('buildTrialReport', () => {
  it('counts quota holds, failures, voided attempts and actual-model fallback attempts separately', () => {
    const rows = [
      row({ status: 'failed', reasons: ['antigravity: skip-quota-hold'] }),
      row({ status: 'failed', reasons: ['antigravity: skip-quota-exhausted'] }),
      row({ status: 'failed', reasons: ['unavailable'], fellBackTo: 'routing-model' }),
      row({ status: 'voided' }), row(),
      row({ model: 'routing-model', requestedModel: model, fallbackFrom: { model } }),
    ];
    expect(report(rows)).toMatchObject({ attempts: 5, quota: { held: 2, rate: 2 / 5 }, failed: 1, voided: 1, ok: 1, fellBack: 1 });
    expect(report(rows, { model: 'routing-model' })).toMatchObject({ attempts: 1, ok: 1, fellBack: 0 });
  });

  it('reports null rates when there is no evidence', () => {
    expect(report([])).toMatchObject({ attempts: 0, quota: { held: 0, rate: null },
      agreement: { compared: 0, verdictAgree: 0, rate: null, meanJaccard: null, byLens: {} }, runs: [] });
    expect(report([row({ verdictAgree: null, overlap: null })]).agreement).toMatchObject({ compared: 0, meanJaccard: null });
  });

  it('compares only ok verdicts and aggregates agreement by lens and numeric finding overlap', () => {
    const result = report([
      row({ overlap: { jaccard: 0.5 } }),
      row({ verdictAgree: false, overlap: { jaccard: 0.25 } }),
      row({ lens: 'security', overlap: { jaccard: 0.75 } }),
      row({ status: 'failed', overlap: { jaccard: 0 } }), row({ status: 'voided' }),
      row({ verdictAgree: null, overlap: null }),
    ]);
    expect(result.agreement).toEqual({ compared: 3, verdictAgree: 2, rate: 2 / 3, meanJaccard: 0.5,
      byLens: { correctness: { compared: 2, agree: 1, rate: 0.5 }, security: { compared: 1, agree: 1, rate: 1 } } });
  });

  it('classifies fixer confirmation, red-team confirmation, not confirmed and pending anchors', () => {
    const rows = [row({ agyFindings: [anchor('fix.mjs', 10, true), anchor('./red.mjs', 20), anchor('elsewhere.mjs', 30)] }),
      row({ head: 'c'.repeat(40), agyFindings: [anchor('pending.mjs', 40)] }),
      row({ status: 'failed', agyFindings: [anchor('ignored.mjs', 1)] })];
    const prRuns = new Map([['o/r#7', [fixRecord({ 'fix.mjs': [15], 'elsewhere.mjs': [36] })]]]);
    const redTeamByPrHead = new Map([['o/r#7@' + 'a'.repeat(40), { findings: [
      { confirmed: true, file: 'b/red.mjs', line: 28 },
      { confirmed: false, file: 'elsewhere.mjs', line: 30 },
    ] }]]);
    expect(report(rows, { prRuns, redTeamByPrHead }).findings).toEqual({ total: 4, matchedByMandatory: 1, agyOnly: 3,
      confirmedByFix: 1, confirmedByRedTeam: 1, notConfirmed: 1, pending: 1 });
  });

  it('counts both confirmation sources once per anchor and accepts unknown lines or touched-file ranges', () => {
    const rows = [row({ agyFindings: [anchor('both.mjs', 10), anchor('unknown.mjs', null), anchor('touched.mjs', 100)] })];
    const prRuns = new Map([['o/r#7', [fixRecord({ 'both.mjs': [5, 15], 'unknown.mjs': [], 'touched.mjs': null }),
      fixRecord({ 'both.mjs': [10] })]]]);
    const redTeamByPrHead = new Map([['o/r#7@' + 'a'.repeat(40), { findings: [
      { confirmed: true, file: './a/both.mjs', line: 2 },
      { confirmed: true, file: 'both.mjs', line: 10 },
      { confirmed: true, file: 'unknown.mjs', line: 999 },
      { confirmed: true, file: 'touched.mjs', line: null },
    ] }]]);
    expect(report(rows, { prRuns, redTeamByPrHead }).findings).toMatchObject({ total: 3,
      confirmedByFix: 3, confirmedByRedTeam: 3, notConfirmed: 0, pending: 0 });
  });

  it('a head with no red-team comment is still pending (no evidence either way) and requires same PR and head for fixes', () => {
    const rows = [row({ agyFindings: [anchor('file.mjs', 10)] })];
    const unrelated = new Map([['o/r#8', [fixRecord({ 'file.mjs': null })]],
      ['o/r#7', [fixRecord({ 'file.mjs': null }, { findings: { read: { latestFix: { priorHead: 'c'.repeat(40), files: { 'file.mjs': null } } } } })]]]);
    expect(report(rows, { prRuns: unrelated }).findings).toMatchObject({ confirmedByFix: 0, pending: 1 });
    expect(report(rows, { redTeamByPrHead: new Map([['o/r#7@' + 'a'.repeat(40), null]]) }).findings)
      .toMatchObject({ notConfirmed: 0, pending: 1 });
    expect(report(rows, { redTeamByPrHead: new Map([['o/r#7@' + 'a'.repeat(40), { findings: [] }]]) }).findings)
      .toMatchObject({ notConfirmed: 1, pending: 0 });
    expect(report(rows, { prRuns: new Map([['o/r#7', [fixRecord({ 'other.mjs': null })]]]) }).findings)
      .toMatchObject({ notConfirmed: 1, pending: 0 });
  });

  it('uses run-record lens verdicts, bounds failure reasons, sorts runs and preserves inputs', () => {
    const rows = [row({ at: '2026-10-12T02:00:00Z', status: 'failed', reasons: ['x'.repeat(200), 'second'], agyVerdict: null }), row()];
    const record = { verdict: { lensVerdicts: { correctness: 'accept', security: 'changes', 'codex-correctness': 'accept' } } };
    const before = JSON.stringify({ rows, record });
    const result = report(rows, { runRecords: new Map([['review-pr-first', record]]) });
    expect(result.runs[0]).toMatchObject({ at: '2026-10-12T01:00:00Z', pr: 'o/r#7', head12: 'a'.repeat(12),
      seat: 'correctness', findings: 0, otherVerdicts: { security: 'changes', 'codex-correctness': 'accept' } });
    expect(result.runs[0]).not.toHaveProperty('reason');
    expect(result.runs[1].reason).toBe('x'.repeat(160));
    expect(JSON.stringify({ rows, record })).toBe(before);
    expect(report([row({ agyFindingsCount: 35 })]).findings.total).toBe(0);
  });
});

describe('trial progress — measured in reviews, never auto-promoted', async () => {
  const { trialProgress, renderTrialLine } = await import('../agy-shadow-trial-report.mjs');
  const { resolveShadowTrialReviews } = await import('../review-seat-settings.mjs');
  const row = (runId, status, lens = 'correctness') => ({ runId, status, lens, model: 'gemini-4-argon-high' });

  it('counts one review per run with a usable answer; held/failed/voided never count', () => {
    const rows = [row('r1', 'ok'), row('r1', 'ok', 'security'), row('r2', 'failed'), row('r3', 'voided'), row('r4', 'ok')];
    expect(trialProgress(rows, { value: 30, source: 'settings' })).toEqual({ reviews: 2, target: 30, source: 'settings', complete: false });
    expect(renderTrialLine(trialProgress(rows, { value: 30, source: 'settings' }))).toContain('2 of 30 reviews');
  });

  it('says trial complete at the target and nothing else changes', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, 'ok'));
    const t = trialProgress(rows, { value: 30, source: 'settings' });
    expect(t.complete).toBe(true);
    expect(renderTrialLine(t)).toContain('30 of 30 reviews — trial complete');
  });

  it('the cascade: env beats the file beats no target; a bad value falls through', () => {
    const readFile = () => JSON.stringify({ shadowSeats: { antigravity: { trialReviews: 30 } } });
    expect(resolveShadowTrialReviews({ env: {}, readFile })).toEqual({ value: 30, source: 'settings' });
    expect(resolveShadowTrialReviews({ env: { WE_REVIEW_SHADOW_AGY_TRIAL_REVIEWS: '12' }, readFile })).toEqual({ value: 12, source: 'env' });
    expect(resolveShadowTrialReviews({ env: { WE_REVIEW_SHADOW_AGY_TRIAL_REVIEWS: 'x' }, readFile })).toEqual({ value: 30, source: 'settings' });
    expect(resolveShadowTrialReviews({ env: {}, readFile: () => { throw new Error('nope'); } })).toEqual({ value: null, source: 'default' });
  });
});
