import { describe, it, expect } from 'vitest';
import { resolveShadowSeatModel, SHADOW_AGY_MODEL_ENV } from '../review-seat-settings.mjs';
import { settingsFromRoutingPolicy, seatProviderDirective, loadReviewSeatSettings } from '../review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { buildShadowRow, compareShadowAnswers, summarizeShadowAgreement } from '../review-shadow-agreement.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';

const model = 'gemini-4-argon-high';
const routingModel = 'claude-opus-5-5-high';
const finding = { summary: 'private finding text', file: 'scripts/example.mjs', line: 12, category: 'security/fail-open', disposition: 'blocker' };
const claudeAnswer = { summary: 'Claude answer', findings: [finding] };
const directive = { mode: 'shadow', model, fallbackModel: routingModel, modelSource: 'settings', repo: 'o/r', pr: 7, head: '123456789012abcdef', seat: 'correctness' };
async function run(runs, extraDirective = {}) {
  const rows = [], logs = [], models = [];
  const answer = await runSeatWithProvider({ lens: 'correctness', runId: 'test', seatProvider: { ...directive, ...extraDirective } }, {
    cwd: '.', claudeJudge: async () => ({ value: claudeAnswer, telemetry: { sessionId: 'claude' } }),
    unwrap: (x) => x, wrap: (value, telemetry) => ({ value, telemetry }),
    agyJuror: async ({ model: actual }) => { models.push(actual); return runs[models.length - 1]; },
    appendRow: (row) => { rows.push(row); return true; }, log: (m) => logs.push(m), now: () => 0,
  });
  return { ...answer, rows, logs, models };
}
const ok = { status: 'ok', sessionId: 'agy', value: { summary: 'agy', findings: [finding] } };

describe('shadow model cascade', () => {
  const readFile = () => JSON.stringify({ shadowSeats: { antigravity: { model } } });
  it('env beats settings, settings beats default', () => {
    expect(resolveShadowSeatModel({ env: { [SHADOW_AGY_MODEL_ENV]: 'other-model' }, readFile })).toEqual({ value: 'other-model', source: 'env' });
    expect(resolveShadowSeatModel({ env: {}, readFile })).toEqual({ value: model, source: 'settings' });
    expect(resolveShadowSeatModel({ env: {}, readFile: () => '{}' })).toEqual({ value: null, source: 'default' });
  });
  it.each(['Bad Model', '', 'a'.repeat(65), '../model', 7])('invalid env %s falls through', (value) => {
    expect(resolveShadowSeatModel({ env: { [SHADOW_AGY_MODEL_ENV]: value }, readFile })).toEqual({ value: model, source: 'settings' });
  });
  it('unreadable and invalid settings fall through', () => {
    expect(resolveShadowSeatModel({ env: {}, readFile: () => { throw new Error('missing'); } })).toEqual({ value: null, source: 'default' });
    expect(resolveShadowSeatModel({ env: {}, readFile: () => '{' })).toEqual({ value: null, source: 'default' });
  });
});

describe('shadow directives', () => {
  it('applies override and freezes it, preserving advisory model', () => {
    const settings = settingsFromRoutingPolicy(DEFAULT_ROUTING_POLICY, { shadowModel: { value: model, source: 'settings' } });
    expect(seatProviderDirective(settings, 'correctness')).toEqual({ mode: 'shadow', model, fallbackModel: routingModel, modelSource: 'settings', onEscape: 'claude' });
    expect(Object.isFrozen(settings.shadowModelOverride)).toBe(true);
    expect(settings.agyModel).toBe(routingModel);
  });
  it('ignores override on a non-shadow agy seat', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    delete policy.operations['review-seat:mandatory:correctness'].mode;
    const settings = settingsFromRoutingPolicy(validateRoutingPolicy(policy), { shadowModel: { value: model, source: 'env' } });
    expect(seatProviderDirective(settings, 'correctness')).toEqual({ mode: 'agy', model: routingModel, onEscape: 'claude' });
  });
  it('uses routing policy without override or when models equal', () => {
    for (const shadowModel of [null, { value: routingModel, source: 'env' }]) {
      expect(seatProviderDirective(settingsFromRoutingPolicy(DEFAULT_ROUTING_POLICY, { shadowModel }), 'correctness')).toEqual({ mode: 'shadow', model: routingModel, onEscape: 'claude' });
    }
  });
  it('logs the cascade once per distinct message', () => {
    const logs = [];
    const options = { policy: DEFAULT_ROUTING_POLICY, shadowModel: { value: 'unique-trial-model', source: 'env' }, log: (m) => logs.push(m) };
    loadReviewSeatSettings(options); loadReviewSeatSettings(options);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('env WE_REVIEW_SHADOW_AGY_MODEL');
    expect(logs[0]).toContain(`fallback ${routingModel}`);
  });
  it('sanitizes the selection log through the shared log boundary', () => {
    const logs = [];
    loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY,
      shadowModel: { value: 'unique\nmodel\u001b\u200b', source: 'env' }, log: (message) => logs.push(message) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });
});

describe('shadow runner', () => {
  it('keeps external text on one log line without terminal controls', async () => {
    const result = await run([{ status: 'failed', reasons: ['a\nreview-seat: forged\r\u001b[31m\u0085\u2028\u2029\u0000\u007f\u200b'] }, ok],
      { repo: 'o/r\nforged', modelSource: 'settings\u001b' });
    for (const message of result.logs) {
      expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    }
    expect(result.logs[0]).toContain('FALLING BACK');
  });
  it('records a failed attempt before loudly falling back and keeps Claude answer', async () => {
    const result = await run([{ status: 'failed', reasons: ['trial unavailable'] }, ok]);
    expect(result.models).toEqual([model, routingModel]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].fellBackTo).toBe(routingModel);
    expect(result.rows[1]).toMatchObject({ requestedModel: model, model: routingModel, fallbackFrom: { model, status: 'failed', reasons: ['trial unavailable'] } });
    expect(result.logs[0]).toContain('FALLING BACK');
    const { shadow, seatProvider, ...answer } = result.value;
    expect(answer).toEqual(claudeAnswer);
    expect(shadow).toMatchObject({ model: routingModel, requestedModel: model, modelSource: 'settings', fallbackFrom: { model } });
    expect(summarizeShadowAgreement(result.rows)[0].runs).toBe(1);
  });
  it('does not rerun voided attempts', async () => {
    const result = await run([{ status: 'voided', reasons: ['escaped'] }]);
    expect(result.models).toEqual([model]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].agyFindingsCount).toBeNull();
    expect(result.logs).toHaveLength(1);
  });
  it('checks independence on the fallback', async () => {
    const result = await run([{ status: 'failed' }, { ...ok, sessionId: 'claude' }]);
    expect(result.value.shadow.status).toBe('voided');
    expect(result.rows[1].verdictAgree).toBeNull();
  });
  it('logs final verdict, model and finding count', async () => {
    const result = await run([ok]);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toContain(`seat correctness model ${model} status ok verdict changes findings 1`);
    expect(result.logs[0]).toContain('head 123456789012');
  });
});

describe('shadow rows', () => {
  it('stores only bounded anchors and counts with one-to-one matches', () => {
    const agyAnswer = { findings: Array.from({ length: 35 }, () => ({ ...finding, claim: 'secret', message: 'secret' })) };
    const comparison = compareShadowAnswers({ claude: claudeAnswer, agy: agyAnswer });
    expect(comparison.agyMatched).toEqual([true, ...Array(34).fill(false)]);
    const row = buildShadowRow({ model, agyRun: ok, agyAnswer, claudeAnswer, comparison, fallbackFrom: { model, status: 'failed', reasons: Array(5).fill('x'.repeat(400)) } });
    expect(row.agyFindingsCount).toBe(35);
    expect(row.claudeFindingsCount).toBe(1);
    expect(row.agyFindings).toHaveLength(30);
    expect(row.agyFindings[0]).toEqual({ path: finding.file, line: 12, defectClass: 'fail-open', severity: 'blocker', matched: true });
    expect(JSON.stringify(row)).not.toMatch(/private finding text|secret|"claim"|"summary"|"message"/);
    expect(row.fallbackFrom.reasons).toEqual(Array(3).fill('x'.repeat(300)));
  });
});
