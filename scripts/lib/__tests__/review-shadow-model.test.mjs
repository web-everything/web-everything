import { callsUsedToday, callsUsedTodayForProvider, reviewSeatCapUsage } from '../../operations/review-extra-seats.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resolveReviewSeatSafeguards, resolveShadowSeatModel, resolveShadowPromotionPrs, resolveShadowPromotionReplaces, SHADOW_AGY_MODEL_ENV } from '../review-seat-settings.mjs';
import { CARBON_SHADOW_CAP_ENV, resolveCarbonShadowCap, resolveProviderCap } from '../review-seat-caps.mjs';
import { assertCrossVendorPanel, settingsFromRoutingPolicy, shadowSeatStatus, seatProviderDirective, loadReviewSeatSettings } from '../review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { buildShadowRow, compareShadowAnswers, summarizeShadowAgreement, summarizeCarbonPromotion, renderShadowReport } from '../review-shadow-agreement.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';
import { buildTrialReport } from '../agy-shadow-trial-report.mjs';
import { reserveShadowSession } from '../review-shadow-budget.mjs';

const model = 'gemini-4-argon-high';
const routingModel = 'claude-opus-5-5-high';
const finding = { summary: 'private finding text', file: 'scripts/example.mjs', line: 12, category: 'security/fail-open', disposition: 'blocker' };
const claudeAnswer = { summary: 'Claude answer', findings: [finding] };
const directive = { mode: 'shadow', model, fallbackModel: routingModel, modelSource: 'settings', repo: 'o/r', pr: 7, head: '123456789012abcdef', seat: 'correctness' };
const shadowPolicy = { shadowEnabled: true, scope: 'high-care', dailyCap: 100 };
const highCarePr = { repo: 'o/r', pr: 7, careLevel: 'high' };
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

// These legacy Argon trials explicitly opt in to non-Carbon Gemini execution.
beforeEach(() => {
  vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '5');
  vi.stubEnv(CARBON_SHADOW_CAP_ENV, '1');
});
afterEach(() => vi.unstubAllEnvs());

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

describe('Carbon promotion settings and advisory guards', () => {
  const readFile = () => JSON.stringify({ shadowSeats: { antigravity: { promotionAgreeingPrs: 20 } } });
  const resolve = (env = {}, read = readFile) => resolveShadowPromotionPrs({ env, readFile: read });
  it('resolves env > settings > built-in 10 with source', () => {
    expect(resolve({ WE_REVIEW_SHADOW_AGY_PROMOTION_PRS: '12' })).toEqual({ value: 12, source: 'env' });
    expect(resolve()).toEqual({ value: 20, source: 'settings' });
    expect(resolve({}, () => '{}')).toEqual({ value: 10, source: 'default' });
  });
  it.each([0, -1, 1.5, true, {}, '', 'nope', '1e2', Number.MAX_SAFE_INTEGER + 1])('invalid threshold %j falls through each layer', value => {
    expect(resolve({ WE_REVIEW_SHADOW_AGY_PROMOTION_PRS: value })).toEqual({ value: 20, source: 'settings' });
    expect(resolve({}, () => JSON.stringify({ shadowSeats: { antigravity: { promotionAgreeingPrs: value } } })))
      .toEqual({ value: 10, source: 'default' });
  });
  it('ignores and logs env=1 and settings=1, preserving the ruled floor of ten', () => {
    const logs = [];
    const readFile = () => JSON.stringify({ shadowSeats: { antigravity: { promotionAgreeingPrs: 1 } } });
    expect(resolveShadowPromotionPrs({ env: { WE_REVIEW_SHADOW_AGY_PROMOTION_PRS: '1' }, readFile, log: m => logs.push(m) }))
      .toEqual({ value: 10, source: 'default' });
    expect(logs.join(' ')).toMatch(/invalid env.*falling through.*invalid settings.*falling through/);
    expect(resolveShadowPromotionPrs({ env: {}, readFile, log: () => {} })).toEqual({ value: 10, source: 'default' });
    expect(resolve({ WE_REVIEW_SHADOW_AGY_PROMOTION_PRS: '1' })).toEqual({ value: 20, source: 'settings' });
  });
  it('unreadable or malformed settings use the built-in threshold', () => {
    for (const read of [() => '{', () => { throw new Error('unreadable'); }]) {
      expect(resolve({}, read)).toEqual({ value: 10, source: 'default' });
    }
  });
  it('ships enabled watch-only Carbon with ten agreeing PRs as the reporting target', () => {
    expect(resolveShadowSeatModel({ env: {} })).toEqual({ value: 'gemini-4-carbon-high', source: 'settings' });
    expect(resolveShadowPromotionPrs({ env: {} })).toEqual({ value: 10, source: 'settings' });
    expect(resolveReviewSeatSafeguards({ env: {}, platform: {}, log: () => {} }).value.shadowEnabled).toBe(true);
  });
  it('keeps non-Carbon Gemini capped at zero unless its existing env cap enables it', () => {
    expect(resolveProviderCap('agy-gemini', {})).toBe(0);
    expect(resolveProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '5' })).toBe(5);
    expect(resolveProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' })).toBe(0);
    expect(resolveProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '-1' })).toBe(0);
  });
  it.each([
    [undefined, 1], ['0', 0], ['1', 1], ['4', 4], ['-1', 0], ['1.5', 0], ['', 1], ['nope', 0],
    [String(Number.MAX_SAFE_INTEGER + 1), 0],
  ])('resolves the independent Carbon shadow cap %j to %i', (value, expected) => {
    expect(resolveCarbonShadowCap({ [CARBON_SHADOW_CAP_ENV]: value })).toBe(expected);
    expect(resolveCarbonShadowCap({ WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' })).toBe(1);
  });
  it.each(['shadow', 'agy'].flatMap(mode => [true, false].flatMap(carbon =>
    ['0', '3'].flatMap(geminiCap => ['0', '2'].map(carbonCap => ({ mode, carbon, geminiCap, carbonCap }))))))
  ('$mode Carbon=$carbon Gemini cap=$geminiCap Carbon shadow cap=$carbonCap uses only its own cap', async ({ mode, carbon, geminiCap, carbonCap }) => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', geminiCap);
    vi.stubEnv(CARBON_SHADOW_CAP_ENV, carbonCap);
    const selectedModel = carbon ? 'gemini-4-carbon-high' : model;
    const carbonShadow = carbon && mode === 'shadow';
    const enabled = Number(carbonShadow ? carbonCap : geminiCap) > 0;
    const result = await run([{ ...ok, servedModel: selectedModel }], { mode, model: selectedModel, onEscape: 'skip' });
    expect(result.models).toEqual(enabled ? [selectedModel] : []);
    if (!enabled) {
      const reasons = [carbonShadow ? 'carbon shadow seat off' : mode === 'shadow' ? 'non-carbon gemini seat cap 0' : 'gemini seat cap 0'];
      expect(mode === 'shadow' ? result.value.shadow : result.value.seatProvider).toMatchObject({ status: 'skipped', reasons });
    }
    if (mode === 'shadow') expect(result.value.findings).toEqual(claudeAnswer.findings);
    if (carbonShadow) expect(result.logs.join(' ')).toContain(`${CARBON_SHADOW_CAP_ENV}=${carbonCap} (env)`);
  });
  it.each(['-1', 'invalid'])('a malformed Carbon shadow override %j fails closed (shadow off)', async value => {
    vi.stubEnv(CARBON_SHADOW_CAP_ENV, value);
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '3');
    const selectedModel = 'gemini-4-carbon-high';
    const result = await run([{ ...ok, servedModel: selectedModel }], { model: selectedModel });
    expect(result.models).toEqual([]);
    expect(result.value.shadow).toMatchObject({ status: 'skipped', reasons: ['carbon shadow seat off'] });
  });
  it.each([''])('Carbon shadow runs with its default cap when the override is %j (blank) and Gemini is off', async value => {
    vi.stubEnv(CARBON_SHADOW_CAP_ENV, value);
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const selectedModel = 'gemini-4-carbon-high';
    const result = await run([{ ...ok, servedModel: selectedModel }], { model: selectedModel });
    expect(result.models).toEqual([selectedModel]);
    expect(result.logs.join(' ')).toContain(`${CARBON_SHADOW_CAP_ENV}=1 (default)`);
  });
  it('skips non-Carbon Gemini shadow at cap zero while Carbon runs', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const skipped = await run([ok]);
    expect(skipped.models).toEqual([]);
    expect(skipped.value.findings).toEqual(claudeAnswer.findings);
    expect(skipped.value.shadow).toMatchObject({ status: 'skipped', reasons: ['non-carbon gemini seat cap 0'] });
    expect(skipped.rows).toHaveLength(1);
    expect(skipped.rows[0]).toMatchObject({ model, status: 'skipped', verdictAgree: null });
    expect(skipped.logs.join(' ')).not.toContain('FALLING BACK');

    const carbonModel = 'gemini-4-carbon-high';
    const carbon = await run([{ ...ok, servedModel: carbonModel }], { model: carbonModel });
    expect(carbon.models).toEqual([carbonModel]);
    expect(carbon.value.findings).toEqual(claudeAnswer.findings);
    expect(carbon.rows[0]).toMatchObject({ model: carbonModel, servedModel: carbonModel, status: 'ok', verdictAgree: true });
  });
  it.each(['claude', 'skip'])('skips counted Carbon at cap zero with onEscape=%s and never uses its answer', async onEscape => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const result = await run([ok], { mode: 'agy', model: 'gemini-4-carbon-high', onEscape });
    expect(result.models).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.value.seatProvider).toMatchObject(onEscape === 'claude'
      ? { provider: 'claude', fellBackFrom: { status: 'skipped', reasons: ['gemini seat cap 0'] } }
      : { provider: 'agy', status: 'skipped', reasons: ['gemini seat cap 0'] });
    expect(result.value.summary).toBe(onEscape === 'claude' ? claudeAnswer.summary : 'skipped: agy seat skipped: gemini seat cap 0');
    expect(result.value.findings).toEqual(onEscape === 'claude' ? claudeAnswer.findings : []);
  });
  it('keeps the Claude answer when Carbon disagrees in shadow', async () => {
    const result = await run([{ ...ok, value: { findings: [] } }], { model: 'gemini-4-carbon-high' });
    expect(result.value.findings).toEqual(claudeAnswer.findings);
    expect(result.value.shadow).toMatchObject({ model: 'gemini-4-carbon-high', verdictAgree: false });
    expect(result.rows[0].verdictAgree).toBe(false);
  });
});

describe('shadow directives', () => {
  it('applies override and freezes it, preserving advisory model', () => {
    const settings = { ...settingsFromRoutingPolicy(DEFAULT_ROUTING_POLICY, { shadowModel: { value: model, source: 'settings' } }), shadowPolicy };
    expect(seatProviderDirective(settings, 'correctness', highCarePr)).toEqual({ mode: 'shadow', model, fallbackModel: routingModel, modelSource: 'settings', onEscape: 'claude', dailyCap: 100 });
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
      expect(seatProviderDirective({ ...settingsFromRoutingPolicy(DEFAULT_ROUTING_POLICY, { shadowModel }), shadowPolicy }, 'correctness', highCarePr))
        .toEqual({ mode: 'shadow', model: routingModel, onEscape: 'claude', dailyCap: 100 });
    }
  });
  it('logs the cascade once per distinct message', () => {
    const logs = [];
    const options = { safeguards: { value: { ...shadowPolicy, sampleRate: 0.1, minNonClaudeSeats: 1 } }, policy: DEFAULT_ROUTING_POLICY, shadowModel: { value: 'unique-trial-model', source: 'env' }, log: (m) => logs.push(m) };
    loadReviewSeatSettings(options); loadReviewSeatSettings(options);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('env WE_REVIEW_SHADOW_AGY_MODEL');
    expect(logs[0]).toContain(`fallback ${routingModel}`);
  });
  it('sanitizes the selection log through the shared log boundary', () => {
    const logs = [];
    loadReviewSeatSettings({ safeguards: { value: { ...shadowPolicy, sampleRate: 0.1, minNonClaudeSeats: 1 } }, policy: DEFAULT_ROUTING_POLICY,
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
  it.each([
    { status: 'ok', compared: 1, failed: 0, voided: 0, held: 0, skipped: 0 },
    { status: 'failed', compared: 0, failed: 1, voided: 0, held: 0, skipped: 0 },
    { status: 'voided', compared: 0, failed: 0, voided: 1, held: 0, skipped: 0 },
    { status: 'skipped', compared: 0, failed: 0, voided: 0, held: 0, skipped: 1 },
    { status: 'failed', reasons: ['antigravity: skip-quota-hold'], compared: 0, failed: 0, voided: 0, held: 1, skipped: 0 },
    { status: 'failed', reasons: ['antigravity: skip-quota-exhausted'], compared: 0, failed: 0, voided: 0, held: 1, skipped: 0 },
  ])('classifies runner status $status ($reasons) consistently in agreement and trial reports', async (expected) => {
    const result = await run([{ ...ok, status: expected.status, reasons: expected.reasons }], { fallbackModel: null });
    const [summary] = summarizeShadowAgreement(result.rows);
    expect(summary).toMatchObject({ runs: 1, compared: expected.compared, failed: expected.failed,
      voided: expected.voided, held: expected.held, skipped: expected.skipped });
    const trial = buildTrialReport({ rows: result.rows, model });
    expect(trial).toMatchObject({ attempts: 1, ok: expected.compared, failed: expected.failed,
      voided: expected.voided, quota: { held: expected.held }, skipped: expected.skipped,
      agreement: { compared: expected.compared }, trial: { reviews: expected.compared } });
  });
  it.each([
    { summary: '', findings: [] },
    { summary: '   ', findings: [] },
    { summary: 42, findings: [] },
    { summary: 'reviewed', findings: {} },
    { summary: 'reviewed' },
    { summary: 'reviewed', findings: [null] },
    { summary: 'reviewed', findings: [[]] },
    { summary: 'reviewed', findings: [{}] },
    { summary: 'reviewed', findings: [{ summary: 42 }] },
    { summary: 'reviewed', findings: [{ summary: 'defect', file: 42 }] },
    { summary: 'reviewed', findings: [{ summary: 'defect', line: -1 }] },
  ])('malformed raw answer %j is invalid promotion evidence on either side', malformed => {
    const valid = { summary: 'reviewed', findings: [] };
    const makeRow = (claude, agy, lens) => buildShadowRow({
      repo: 'o/r', pr: 1, head: 'head-a', lens, model: 'gemini-4-carbon-high',
      agyRun: { ...ok, servedModel: 'gemini-4-carbon-high' }, claudeAnswer: claude, agyAnswer: agy,
      comparison: compareShadowAnswers({ claude, agy }),
    });
    for (const side of ['claude', 'agy']) {
      const rows = ['correctness', 'security'].map(lens => makeRow(side === 'claude' ? malformed : valid, side === 'agy' ? malformed : valid, lens));
      expect(rows[0]).toMatchObject({ claudeValid: side !== 'claude', agyValid: side !== 'agy' });
      expect(summarizeCarbonPromotion(rows)).toMatchObject({ agree: 0, invalid: 1 });
    }
    const validRows = ['correctness', 'security'].map(lens => makeRow(valid, valid, lens));
    expect(validRows[0]).toMatchObject({ claudeValid: true, agyValid: true });
    expect(summarizeCarbonPromotion(validRows).agree).toBe(1);
  });
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

describe('shadow operational safeguards', () => {
  const resolve = (options = {}) => resolveReviewSeatSafeguards({ env: {}, platform: {}, readFile: () => '{}', log: () => {}, ...options });
  it('defaults off and logs each source through all four cascade layers', () => {
    const logs = [];
    expect(resolve().value).toEqual({ shadowEnabled: false, scope: 'high-care', dailyCap: 100, sampleRate: 0.1, minNonClaudeSeats: 1 });
    const result = resolve({ platform: { shadowSeats: { antigravity: { enabled: true, sampleRate: 0.2 } }, minNonClaudeSeats: 2 },
      readFile: () => JSON.stringify({ shadowSeats: { antigravity: { enabled: false } } }),
      env: { WE_REVIEW_MIN_NON_CLAUDE_SEATS: '3', WE_REVIEW_SHADOW_AGY_DAILY_CAP: '3' }, log: m => logs.push(m) });
    expect(result.sources).toEqual({ shadowEnabled: 'tool', sampleRate: 'platform', scope: 'standard', dailyCap: 'env', minNonClaudeSeats: 'env' });
    expect(logs.join(' ')).toContain('shadowEnabled=false (tool)');
    expect(logs.join(' ')).toContain('sampleRate=0.2 (platform)');
    expect(logs.join(' ')).toContain('minNonClaudeSeats=3 (env)');
    expect(logs.join(' ')).toContain('dailyCap=3 (env)');
  });
  it('refuses 100%, invalid caps and invalid minima with a logged warning', () => {
    const logs = [];
    const result = resolve({ env: { WE_REVIEW_SHADOW_AGY_SAMPLE_RATE: '1', WE_REVIEW_MIN_NON_CLAUDE_SEATS: '0', WE_REVIEW_SHADOW_AGY_DAILY_CAP: '-1' }, log: m => logs.push(m) });
    expect(result.value.sampleRate).toBe(0.1);
    expect(result.value.minNonClaudeSeats).toBe(1);
    expect(result.value.dailyCap).toBe(100);
    expect(logs.join(' ')).toContain('ignored invalid: env.sampleRate=1');
  });
  const safeguardCases = [
    { key: 'shadowEnabled', leaf: false, config: value => ({ shadowSeats: { antigravity: { enabled: value } } }) },
    { key: 'sampleRate', leaf: 0.2, config: value => ({ shadowSeats: { antigravity: { sampleRate: value } } }) },
    { key: 'scope', leaf: 'sampled', config: value => ({ shadowSeats: { antigravity: { scope: value } } }) },
    { key: 'dailyCap', leaf: 2, config: value => ({ shadowSeats: { antigravity: { dailyCap: value } } }) },
    { key: 'minNonClaudeSeats', leaf: 2, config: value => ({ minNonClaudeSeats: value }) },
  ];
  for (const layer of ['platform', 'tool']) {
    for (const { key, leaf, config } of safeguardCases) {
      it.each([{ value: leaf }, { nested: { value: leaf } }, {}, { value: leaf, extra: 'invalid' }, [leaf], null])(
        `rejects ${layer}.${key}=%j as a whole scalar setting`, (value) => {
          const lower = { shadowEnabled: true, scope: 'sampled', dailyCap: 42, sampleRate: 0.3, minNonClaudeSeats: 3 };
          const logs = [];
          const result = resolve({
            platform: layer === 'platform' ? config(value) : { shadowSeats: { antigravity: { enabled: true, scope: 'sampled', dailyCap: 42, sampleRate: 0.3 } }, minNonClaudeSeats: 3 },
            readFile: () => JSON.stringify(layer === 'tool' ? config(value) : {}),
            log: m => logs.push(m),
          });
          expect(result.value).toEqual(layer === 'tool' ? lower : { shadowEnabled: false, scope: 'high-care', dailyCap: 100, sampleRate: 0.1, minNonClaudeSeats: 1 });
          expect(result.sources[key]).toBe(layer === 'tool' ? 'platform' : 'standard');
          expect(result.invalid).toContain(`${layer}.${key}=${JSON.stringify(value)}`);
          expect(logs.join(' ')).toContain(`${layer}.${key}=${JSON.stringify(value)}`);
        });
    }
  }
  it('rejects a nested platform enable without bypassing tool shadow-off through directive selection', () => {
    const safeguards = resolve({ platform: { shadowSeats: { antigravity: { enabled: { value: false } } } },
      readFile: () => JSON.stringify({ shadowSeats: { antigravity: { enabled: false } } }) });
    const settings = loadReviewSeatSettings({ safeguards, policy: DEFAULT_ROUTING_POLICY,
      shadowModel: { value: model, source: 'settings' }, log: () => {} });
    for (const lens of ['correctness', 'security']) {
      expect(seatProviderDirective(settings, lens, { repo: 'o/r', pr: 15 })).toBeNull();
      expect(shadowSeatStatus(settings, { repo: 'o/r', pr: 15 })).toBe('off (setting)');
    }
    expect(safeguards.value.shadowEnabled).toBe(false);
    expect(safeguards.sources.shadowEnabled).toBe('tool');
    expect(safeguards.invalid).toEqual(['platform.shadowEnabled={"value":false}']);
  });
  it('disabled settings produce no shadow directive on either lens (no agy launch)', () => {
    const settings = loadReviewSeatSettings({ safeguards: resolve(), log: () => {} });
    for (const lens of ['correctness', 'security']) {
      expect(seatProviderDirective(settings, lens, { repo: 'o/r', pr: 7 })).toBeNull();
      expect(shadowSeatStatus(settings, { repo: 'o/r', pr: 7 })).toBe('off (setting)');
    }
  });
  it('samples a stable subset by repo#pr, shares selection across lenses, and refuses missing identity', () => {
    const settings = loadReviewSeatSettings({ safeguards: resolve({ env: { WE_REVIEW_SHADOW_AGY_ENABLED: 'true', WE_REVIEW_SHADOW_AGY_SCOPE: 'sampled' } }), log: () => {} });
    const sample = () => Array.from({ length: 1000 }, (_, i) => {
      const context = { repo: 'o/r', pr: i + 1 };
      const first = seatProviderDirective(settings, 'correctness', context);
      expect(Boolean(seatProviderDirective(settings, 'security', context))).toBe(Boolean(first));
      return Boolean(first);
    });
    const first = sample();
    expect(sample()).toEqual(first);
    expect(first.filter(Boolean).length).toBeGreaterThan(20);
    expect(first.filter(Boolean).length).toBeLessThan(200);
    expect(seatProviderDirective(settings, 'correctness')).toBeNull();
    expect(shadowSeatStatus({ shadowPolicy: { shadowEnabled: true, scope: 'sampled', sampleRate: 1 } }, { repo: 'o/r', pr: 1 })).toBe('off (invalid sample rate)');
  });
});

describe('Carbon replacement target', () => {
  const readFile = () => JSON.stringify({ shadowSeats: { antigravity: { promotionReplaces: 'codex' } } });
  it('resolves env > settings > claude and reports provenance', () => {
    expect(resolveShadowPromotionReplaces({ env: { WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES: 'agy' }, readFile })).toEqual({ value: 'agy', source: 'env' });
    expect(resolveShadowPromotionReplaces({ env: {}, readFile })).toEqual({ value: 'codex', source: 'settings' });
    expect(resolveShadowPromotionReplaces({ env: {}, readFile: () => '{}' })).toEqual({ value: 'claude', source: 'default' });
  });
  it.each(['', 'unknown', {}, ['claude'], 'x'.repeat(10000)])('invalid target falls back visibly: %j', value => {
    expect(resolveShadowPromotionReplaces({ env: { WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES: value }, readFile })).toEqual({ value: 'codex', source: 'settings' });
    expect(resolveShadowPromotionReplaces({ env: {}, readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promotionReplaces: value } } }) })).toEqual({ value: 'claude', source: 'default' });
  });
  it('unreadable settings fall back to one Claude seat', () => {
    expect(resolveShadowPromotionReplaces({ env: {}, readFile: () => { throw Error('unreadable'); } })).toEqual({ value: 'claude', source: 'default' });
  });
  it('reports a one-seat replacement against every builder through the production renderer', () => {
    const settings = { seatProvider: { correctness: 'shadow', security: 'claude', simplicity: 'codex' } };
    const before = structuredClone(settings);
    const lines = renderShadowReport([], undefined, 'claude', settings);
    for (const builder of ['claude', 'codex', 'agy']) {
      expect(lines).toContain(`Post-promotion cross-vendor panel for ${builder} builder: pass`);
    }
    expect(settings).toEqual(before);
  });
  it('reports refused without throwing for same-vendor, unknown or absent replacement evidence', () => {
    for (const [seatProvider, target, builder] of [
      [{ correctness: 'shadow' }, 'claude', 'agy'],
      [{ correctness: 'shadow', security: 'unknown' }, 'claude', 'codex'],
      [{ correctness: 'claude' }, 'codex', 'claude'],
    ]) {
      const lines = renderShadowReport([], undefined, target, { seatProvider });
      expect(lines.join('\n')).toContain(`Post-promotion cross-vendor panel for ${builder} builder: refused`);
      expect(lines.join('\n')).toContain('operator must replace an existing seat');
    }
  });
  it('refuses same-vendor and unknown evidence with an operator replacement fallback', () => {
    for (const [panel, builder] of [[['codex'], 'codex'], [['agy'], 'agy'], [['shadow'], 'claude'], [['unknown', 'codex'], 'claude'], [['claude'], 'unknown']]) {
      expect(() => assertCrossVendorPanel(panel, builder)).toThrow(/operator must replace an existing seat/);
    }
  });
  it('refuses the ambiguous agy panel provider for a Claude builder', () => {
    expect(() => assertCrossVendorPanel(['agy'], 'claude')).toThrow(/operator must replace an existing seat/);
  });
  it.each(['carbon', 'agy-gemini'])('recognizes %s as Google and agy-claude as Anthropic', provider => {
    expect(() => assertCrossVendorPanel([provider], 'claude')).not.toThrow();
    expect(() => assertCrossVendorPanel([provider], 'agy-gemini')).toThrow(/operator must replace an existing seat/);
    expect(() => assertCrossVendorPanel(['agy-claude'], 'claude')).toThrow(/operator must replace an existing seat/);
    expect(() => assertCrossVendorPanel(['agy-claude'], provider)).not.toThrow();
  });
});

it.each([0, 1])('Carbon shadow respects daily cap %i separately from shared and per-provider seat caps', async dailyCap => {
  vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
  const root = mkdtempSync(join(tmpdir(), 'carbon-budget-'));
  const rows = [];
  const reservations = [], launches = [];
  try {
    const result = await runSeatWithProvider({ lens: 'correctness', seatProvider: { ...directive, model: 'gemini-4-carbon-high', dailyCap } }, {
      cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => ({ value: claudeAnswer, telemetry: { sessionId: 'claude' } }),
      agyJuror: async () => { launches.push('carbon'); return ok; },
      reserveSession: options => {
        reservations.push(options);
        return reserveShadowSession({ ...options, path: join(root, 'agreement.jsonl') });
      },
      appendRow: row => { rows.push(row); return true; }, now: () => 0, log: () => {},
    });
    expect(reservations).toEqual([{ dailyCap, now: 0 }]);
    expect(launches).toHaveLength(dailyCap);
    expect(result.shadow.status).toBe(dailyCap === 0 ? 'skipped' : 'ok');
    if (dailyCap === 0) expect(result.shadow.reasons).toEqual(['daily cap reached']);
    expect(result.findings).toEqual(claudeAnswer.findings);
    expect(rows).toHaveLength(1);
    expect(callsUsedToday(rows, 0)).toBe(0);
    expect(callsUsedTodayForProvider(rows, 0, 'agy-gemini')).toBe(0);
    expect(reviewSeatCapUsage(rows, 0, {})).toEqual(reviewSeatCapUsage([], 0, {}));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('persists served-model evidence through the shadow runner for promotion counting', async () => {
  const servedModel = 'gemini-4-carbon-high';
  const result = await run([{ ...ok, servedModel }], { model: servedModel });
  expect(result.rows[0].servedModel).toBe(servedModel);
  const security = await run([{ ...ok, servedModel }], { model: servedModel, seat: 'security' });
  expect(result.rows[0]).toMatchObject({ claudeValid: true, agyValid: true });
  expect(summarizeCarbonPromotion([...result.rows, ...security.rows]).agree).toBe(1);
  const legacy = await run([ok], { model: servedModel });
  expect(legacy.rows[0].servedModel).toBeNull();
  expect(summarizeCarbonPromotion(legacy.rows)).toMatchObject({ agree: 0, invalid: 1, prs: 1 });
});
