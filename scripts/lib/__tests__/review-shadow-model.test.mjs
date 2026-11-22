import { callsUsedToday, callsUsedTodayForProvider, reviewSeatCapUsage } from '../../operations/review-extra-seats.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { carbonNonShadowAllowed, resolveShadowPromoted, resolveReviewSeatSafeguards, resolveShadowSeatModel, resolveShadowPromotionPrs, resolveShadowPromotionReplaces, SHADOW_AGY_MODEL_ENV } from '../review-seat-settings.mjs';
import { CARBON_SHADOW_CAP_ENV, resolveCarbonShadowCap, resolveProviderCap } from '../review-seat-caps.mjs';
import { assertCrossVendorPanel, vendorOfModel, settingsFromRoutingPolicy, shadowSeatStatus, seatProviderDirective, loadReviewSeatSettings } from '../review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { buildShadowRow, compareShadowAnswers, summarizeShadowAgreement, summarizeCarbonPromotion, renderShadowReport } from '../review-shadow-agreement.mjs';
import { REVIEW_JUDGE_SHAPE } from '../../operations/review-pr.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';
import { deriveVerdict } from '../jury-core.mjs';
import { buildTrialReport } from '../agy-shadow-trial-report.mjs';
import { reserveShadowSession } from '../review-shadow-budget.mjs';

const model = 'gemini-4-argon-high';
const routingModel = 'claude-sonnet-5-5-high';
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
  // Historical shadow fixtures opt out of the newly shipped counted correctness seat.
  vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'false');
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
  it('ships enabled Carbon with ten agreeing PRs as the reporting target', () => {
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
  ('$mode Carbon=$carbon Gemini cap=$geminiCap Carbon shadow cap=$carbonCap requires the Gemini cap and, for Carbon shadows, the shadow cap', async ({ mode, carbon, geminiCap, carbonCap }) => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', geminiCap);
    vi.stubEnv(CARBON_SHADOW_CAP_ENV, carbonCap);
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const selectedModel = carbon ? 'gemini-4-carbon-high' : model;
    const carbonShadow = carbon && mode === 'shadow';
    // R1062a: a Carbon shadow ignores the live Gemini cap and follows only its own switch
    const enabled = carbonShadow ? Number(carbonCap) > 0 : Number(geminiCap) > 0 && !(carbon && mode === 'agy');
    const result = await run([{ ...ok, servedModel: selectedModel }], { mode, model: selectedModel, onEscape: 'skip' });
    expect(result.models).toEqual(enabled ? [selectedModel] : []);
    if (!enabled) {
      const reasons = [carbonShadow && carbonCap === '0' ? 'carbon shadow seat off'
        : carbon && mode === 'agy' && Number(geminiCap) > 0 ? 'Carbon not promoted — non-shadow seat refused' : 'agy-gemini seat cap 0'];
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
  it.each([''])('Carbon shadow runs with its default cap when the override is %j (blank) and Gemini is enabled', async value => {
    vi.stubEnv(CARBON_SHADOW_CAP_ENV, value);
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '3');
    const selectedModel = 'gemini-4-carbon-high';
    const result = await run([{ ...ok, servedModel: selectedModel }], { model: selectedModel });
    expect(result.models).toEqual([selectedModel]);
    expect(result.logs.join(' ')).toContain(`${CARBON_SHADOW_CAP_ENV}=1 (default)`);
  });
  it('skips both non-Carbon and Carbon Gemini shadows at cap zero', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const skipped = await run([ok]);
    expect(skipped.models).toEqual([]);
    expect(skipped.value.findings).toEqual(claudeAnswer.findings);
    expect(skipped.value.shadow).toMatchObject({ status: 'skipped', reasons: ['agy-gemini seat cap 0'] });
    expect(skipped.rows).toHaveLength(1);
    expect(skipped.rows[0]).toMatchObject({ model, status: 'skipped', verdictAgree: null });
    expect(skipped.logs.join(' ')).not.toContain('FALLING BACK');

    const carbonModel = 'gemini-4-carbon-high';
    const carbon = await run([{ ...ok, servedModel: carbonModel }], { model: carbonModel });
    // R1062a: a Carbon shadow sits outside the live agy-gemini cap
    expect(carbon.models).toEqual([carbonModel]);
    expect(carbon.value.findings).toEqual(claudeAnswer.findings);
  });
  it.each(['claude', 'skip'])('skips counted Carbon at cap zero with onEscape=%s and never uses its answer', async onEscape => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const result = await run([ok], { mode: 'agy', model: 'gemini-4-carbon-high', onEscape });
    expect(result.models).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.value.seatProvider).toMatchObject(onEscape === 'claude'
      ? { provider: 'claude', fellBackFrom: { status: 'skipped', reasons: ['agy-gemini seat cap 0'] } }
      : { provider: 'agy', status: 'skipped', reasons: ['agy-gemini seat cap 0'] });
    expect(result.value.summary).toBe(onEscape === 'claude' ? claudeAnswer.summary : 'skipped: agy seat skipped: agy-gemini seat cap 0');
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
    { summary: 'reviewed', findings: [{ summary: 'defect', quote: {} }] },
  ])('malformed raw answer %j is invalid promotion evidence on either side', malformed => {
    const valid = { summary: 'reviewed', findings: [finding] };
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
  it.each([
    'reviewed',
    'Review not performed: diff omitted.',
    'Unable to review this diff',
    'Reviewer could not access the files.',
  ])('a Carbon answer with zero findings is invalid, never agree, regardless of summary: %s', summary => {
    const agy = { summary, findings: [] };
    for (const claude of [{ summary: 'reviewed', findings: [] }, claudeAnswer]) {
      const row = buildShadowRow({
        repo: 'o/r', pr: 1, head: 'head-a', lens: 'correctness', model: 'gemini-4-carbon-high',
        agyRun: { ...ok, servedModel: 'gemini-4-carbon-high' }, claudeAnswer: claude, agyAnswer: agy,
        comparison: compareShadowAnswers({ claude, agy }),
      });
      expect(row).toMatchObject({ claudeValid: true, agyValid: true, overlap: { agyCount: 0 } });
      expect(summarizeCarbonPromotion([row])).toEqual({ agree: 0, disagree: 0, invalid: 1, prs: 1, threshold: 10 });
    }
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
  it.each(['', 'unknown', {}, ['claude'], 'x'.repeat(10000)])('invalid target refuses promotion visibly: %j', value => {
    expect(resolveShadowPromotionReplaces({ env: { WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES: value }, readFile })).toEqual({ value: null, source: 'refused' });
    expect(resolveShadowPromotionReplaces({ env: {}, readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promotionReplaces: value } } }) })).toEqual({ value: null, source: 'refused' });
  });
  it('unreadable replacement settings refuse promotion', () => {
    expect(resolveShadowPromotionReplaces({ env: {}, readFile: () => { throw Error('unreadable'); } })).toEqual({ value: null, source: 'refused' });
  });
  it('reports a one-seat replacement for Claude and Codex builders using routed models', () => {
    const settings = settingsFromRoutingPolicy(DEFAULT_ROUTING_POLICY, { aiRouting: {} });
    const before = structuredClone(settings);
    const lines = renderShadowReport([], undefined, 'claude', settings);
    for (const builder of ['claude', 'codex']) {
      expect(lines).toContain(`Post-promotion cross-vendor panel for ${builder} builder: pass`);
    }
    expect(lines.join('\n')).toContain('Post-promotion cross-vendor panel for agy builder: refused');
    expect(settings).toEqual(before);
  });
  it.each(['claude-sonnet-5-5', 'gemini-4-carbon-high'])('uses the advisory agy seat actual model %s', agyModel => {
    const settings = { seatProvider: { correctness: 'claude' }, claudeSeatModel: { correctness: 'claude-opus-5-5' }, agyCorrectnessAdvisory: true, agyModel };
    const lines = renderShadowReport([], undefined, 'claude', settings);
    expect(lines).toContain('Post-promotion cross-vendor panel for codex builder: pass');
    expect(lines).toContain('Post-promotion cross-vendor panel for claude builder: pass');
    if (agyModel.startsWith('claude-')) expect(() => assertCrossVendorPanel([agyModel], 'claude')).toThrow(/operator must replace/);
    else expect(assertCrossVendorPanel([agyModel], 'claude')).toBe(true);
  });
  it.each([undefined, null, 'unreadable', 'agy'])('refuses an unreadable advisory model %j', agyModel => {
    const settings = { seatProvider: { correctness: 'claude' }, agyCorrectnessAdvisory: true, agyModel };
    expect(renderShadowReport([], undefined, 'claude', settings).join('\n')).toContain('Post-promotion cross-vendor panel for claude builder: refused');
  });
  it('refuses a remaining Claude seat whose routing model cannot be read', () => {
    const settings = { seatProvider: { correctness: 'shadow', security: 'claude' } };
    expect(renderShadowReport([], undefined, 'claude', settings).join('\n')).toContain('Post-promotion cross-vendor panel for codex builder: refused');
  });
  it.each([
    ['claude-opus-5-5', 'Anthropic'], ['gemini-4-carbon-high', 'Google'], ['gpt-6.1-sol', 'OpenAI'],
    ['claude-sonnet-5-5', 'Anthropic'], ['claude', 'Anthropic'], ['shadow', 'Anthropic'],
    ['codex', 'OpenAI'], ['carbon', 'Google'], ['agy-claude', 'Anthropic'], ['agy-gemini', 'Google'],
    ['agy', null], ['unreadable', null], [undefined, null],
  ])('maps model or unambiguous provider %j to %j', (id, vendor) => {
    expect(vendorOfModel(id)).toBe(vendor);
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
    for (const [panel, builder] of [[['codex'], 'codex'], [['agy'], 'agy'], [['shadow'], 'claude'], [['unknown', 'codex'], 'claude'], [['claude'], 'unknown'], [['claude', 'carbon'], 'agy']]) {
      expect(() => assertCrossVendorPanel(panel, builder)).toThrow(/operator must replace an existing seat/);
    }
  });
  it('refuses the ambiguous agy panel provider for a Claude builder', () => {
    expect(() => assertCrossVendorPanel(['agy'], 'claude')).toThrow(/operator must replace an existing seat/);
  });
  it('accepts explicit panel and builder model IDs', () => {
    expect(assertCrossVendorPanel(['claude-opus-5-5', 'gemini-4-carbon-high'], 'gpt-6.1-sol')).toBe(true);
    expect(() => assertCrossVendorPanel(['claude-sonnet-5-5'], 'claude-opus-5-5')).toThrow(/operator must replace/);
  });
  it.each(['carbon', 'agy-gemini'])('recognizes %s as Google and agy-claude as Anthropic', provider => {
    expect(() => assertCrossVendorPanel([provider], 'claude')).not.toThrow();
    expect(() => assertCrossVendorPanel([provider], 'agy-gemini')).toThrow(/operator must replace an existing seat/);
    expect(() => assertCrossVendorPanel(['agy-claude'], 'claude')).toThrow(/operator must replace an existing seat/);
    expect(() => assertCrossVendorPanel(['agy-claude'], provider)).not.toThrow();
  });
});

it.each([0, 1])('Carbon shadow respects daily cap %i after the Gemini switch allows it', async dailyCap => {
  vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '5');
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

// Explicit promotion fixtures exercise counted seats without granting a default promotion.
it.each(['false', 'garbage'])('unpromoted Carbon cannot occupy a non-shadow seat (%s)', async promoted => {
  vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', promoted);
  const result = await run([ok], { mode: 'agy', model: 'gemini-4-carbon-high', onEscape: 'skip' });
  expect(result.models).toEqual([]);
  expect(result.value.seatProvider).toMatchObject({ status: 'skipped', reasons: ['Carbon not promoted — non-shadow seat refused'] });
  expect((await run([ok], { model: 'gemini-4-carbon-high' })).models).toEqual(['gemini-4-carbon-high']);
});
it('manual promotion cannot authorize an unscoped Carbon role with a positive Gemini cap', async () => {
  vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
  expect((await run([ok], { mode: 'agy', model: 'gemini-4-carbon-high' })).models).toEqual([]);
});
it.each([
  ['garbage', false], ['true', true], [' TRUE ', true], ['false', false], [' FaLsE ', false], ['   ', false], ['', true],
])('promotion env %j overrides tool true fail closed (%s)', (value, expected) => {
  expect(resolveShadowPromoted({
    env: { WE_REVIEW_SHADOW_AGY_PROMOTED: value }, platform: {}, log: () => {},
    readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promoted: true } } }),
  })).toEqual({ value: expected, source: value === '' ? 'tool' : 'env' });
});
it.each(['yes', 1, null, {}, [], 'true'])('malformed tool promotion %j overrides platform true fail closed', promoted => {
  expect(resolveShadowPromoted({
    env: {}, platform: { shadowSeats: { antigravity: { promoted: true } } }, log: () => {},
    readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promoted } } }),
  })).toEqual({ value: false, source: 'tool' });
});
it('promotion resolves standard, platform, tool and env and rejects incomplete settings', () => {
  const base = { env: {}, platform: {}, readFile: () => '{}', log: () => {} };
  expect(resolveShadowPromoted(base)).toEqual({ value: false, source: 'standard' });
  expect(resolveShadowPromoted({ ...base, platform: { shadowSeats: { antigravity: { promoted: true } } } }).value).toBe(true);
  const tool = { ...base, readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promoted: true } } }) };
  expect(resolveShadowPromoted(tool)).toEqual({ value: true, source: 'tool' });
  expect(resolveShadowPromoted({ ...tool, env: { WE_REVIEW_SHADOW_AGY_PROMOTED: 'false' } })).toEqual({ value: false, source: 'env' });
  for (const promoted of [null, {}, { value: true }, [], 'true']) {
    expect(carbonNonShadowAllowed('gemini-4-carbon-high', { ...base, readFile: () => JSON.stringify({ shadowSeats: { antigravity: { promoted } } }) })).toBe(false);
  }
  expect(resolveShadowPromoted({ ...base, readFile: () => { throw Error('unreadable'); } }).value).toBe(false);
});

describe('resolveShadowPromoted fails closed on an unreadable or malformed tool file (audit)', () => {
  const platform = { shadowSeats: { antigravity: { promoted: true } } };
  it.each([['malformed JSON', () => '{nope'], ['EACCES', () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }]])(
    'a %s tool file refuses promotion even when the platform layer says true', (_n, readFile) => {
      expect(resolveShadowPromoted({ env: {}, readFile, platform, log: () => {} })).toMatchObject({ value: false });
    });
  it.each([['null', { shadowSeats: { antigravity: null } }], ['array', { shadowSeats: [] }], ['string', { shadowSeats: 'x' }],
    ['non-object root', []]])('a malformed ancestor (%s) refuses promotion even when the platform layer says true', (_n, tool) => {
    expect(resolveShadowPromoted({ env: {}, readFile: () => JSON.stringify(tool), platform, log: () => {} })).toMatchObject({ value: false });
  });
  it('an absent tool file lets the platform layer speak', () => {
    const readFile = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    expect(resolveShadowPromoted({ env: {}, readFile, platform, log: () => {} })).toMatchObject({ value: true });
  });
});


describe('one counted Carbon correctness seat', () => {
  const carbon = 'gemini-4-carbon-high';
  const settings = () => loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY, aiRouting: {}, log: () => {} });
  async function counted(agyRun) {
    if (agyRun === ok) agyRun = { ...ok, servedModel: carbon };
    const rows = [];
    const claudeJudge = vi.fn(async () => ({ value: claudeAnswer }));
    const answer = await runSeatWithProvider({ lens: 'correctness', runId: 'promotion-test', shape: REVIEW_JUDGE_SHAPE,
      seatProvider: { ...seatProviderDirective(settings(), 'correctness', highCarePr), repo: 'o/r', pr: 7, head: 'head', citationScope: [finding.file] } }, {
      cwd: '.', claudeJudge, unwrap: x => x, wrap: value => value,
      agyJuror: async () => { if (agyRun instanceof Error) throw agyRun; return agyRun; },
      // This fixture exercises standard caps, independent of operator platform preferences.
      readRoutingPolicy: () => DEFAULT_ROUTING_POLICY, readSeatSettings: () => ({ tool: {}, platform: {} }),
      appendPromotion: row => { rows.push(row); return true; }, reserveSession: () => ({ allowed: true }), log: () => {},
    });
    return { answer, rows, claudeJudge };
  }
  it('correctness lens resolves to promoted agy-gemini Carbon seat; a Carbon error falls back to the Claude seat and never accepts', async () => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const s = settings();
    expect(s.seatProvider).toEqual({ correctness: 'agy', security: 'shadow' });
    expect(seatProviderDirective(s, 'correctness')).toMatchObject({ mode: 'agy', model: carbon, promoted: true, onEscape: 'claude' });
    const { answer, claudeJudge, rows } = await counted(new Error('login lost'));
    expect(claudeJudge).toHaveBeenCalledOnce();
    expect(answer.seatProvider.provider).toBe('claude');
    expect(answer.findings).toEqual(claudeAnswer.findings);
    expect(deriveVerdict(answer)).toBe('changes');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: 'o/r', pr: 7, fallback: true, agyVerdict: null });
  });
  it.each([
    null,
    { status: 'failed', reasons: ['timeout'] },
    { status: 'skipped', reasons: ['quota exhausted'] },
    { status: 'ok', sessionId: 's', value: { summary: '', findings: [] } },
    { status: 'ok', sessionId: 's', value: { summary: 'unparseable', findings: 'bad' } },
    { status: 'ok', sessionId: 's' },
    { status: 'ok', sessionId: 's', value: { summary: 'bad finding', findings: [null] } },
  ])('Carbon timeout, quota or malformed answer falls back: %j', async failure => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const { answer, claudeJudge, rows } = await counted(failure);
    expect(answer.seatProvider.provider).toBe('claude');
    expect(answer.findings).toEqual(claudeAnswer.findings);
    expect(deriveVerdict(answer)).toBe('changes');
    expect(claudeJudge).toHaveBeenCalledOnce();
    expect(rows[0].fallback).toBe(true);
  });
  it('counts a valid Carbon answer without running Claude and records the attempt', async () => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const { answer, claudeJudge, rows } = await counted(ok);
    expect(answer.seatProvider).toMatchObject({ provider: 'agy', model: carbon });
    expect(claudeJudge).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ fallback: false, agyVerdict: 'changes', runId: 'promotion-test' });
  });
  it('promotion enables the default-disabled Gemini seat without changing other Gemini caps; explicit zero falls back', async () => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    // Vitest 1.x stringifies undefined; remove the key after registering its restoration.
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '');
    delete process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI;
    expect((await counted(ok)).answer.seatProvider.provider).toBe('agy');
    expect(resolveProviderCap('agy-gemini', {}, () => ({ tool: {}, platform: {} }))).toBe(0);
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
    const result = await counted(ok);
    expect(result.answer.seatProvider.provider).toBe('claude');
    expect(result.rows[0].fallback).toBe(true);
  });
  it('ships promotion enabled and samples other lenses deterministically at about ten percent', () => {
    expect(resolveShadowPromoted({ env: {}, log: () => {} }).value).toBe(true);
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const s = settings();
    expect(s.shadowPolicy).toMatchObject({ scope: 'sampled', sampleRate: 0.1 });
    const selected = Array.from({ length: 2000 }, (_, i) => shadowSeatStatus(s, { repo: 'o/r', pr: i + 1 }));
    expect(selected.filter(x => x === 'sampled').length).toBeGreaterThan(150);
    expect(selected.filter(x => x === 'sampled').length).toBeLessThan(250);
    expect(selected).toEqual(Array.from({ length: 2000 }, (_, i) => shadowSeatStatus(s, { repo: 'O/R', pr: i + 1 })));
  });
  it('promotion leaves red-team routing and the human gate unchanged', async () => {
    const { derivePanelVerdict } = await import('../jury-core.mjs');
    const { RED_TEAM_MODELS } = await import('../../operations/review-extra-seats.mjs');
    const before = structuredClone(RED_TEAM_MODELS);
    expect(before.codex.model).toMatch(/^gpt-/);
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    settings();
    const { antigravityReviewFromEnv } = await import('../../operations/review-pr.mjs');
    expect(antigravityReviewFromEnv({ WE_REVIEW_SHADOW_AGY_PROMOTED: 'true' }, { isOnProbation: () => true })).toBe(false);
    expect(RED_TEAM_MODELS).toEqual(before);
    expect(derivePanelVerdict({ lensVerdicts: { correctness: 'accept', security: 'accept' }, findings: [], humanRequired: true })).toBe('needs-human');
  });
  it('records JSONL and reports agreement, later confirmations, explicit false positives, timeouts and PR count', async () => {
    const { appendPromotionRow, readPromotionRows, buildPromotionReport, renderPromotionReport } = await import(/* @vite-ignore */ '../' + 'review-carbon-promotion.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'carbon-promotion-'));
    try {
      const path = join(dir, 'promotion.jsonl');
      const row = { repo: 'o/r', pr: 7, head: 'h', runId: 'r', model: carbon, status: 'ok', fallback: false,
        agyVerdict: 'changes', agyFindings: [{ path: 'scripts/x.mjs', line: 10, normSummary: 'bad guard' }] };
      expect(appendPromotionRow(row, { path })).toBe(true);
      appendPromotionRow({ ...row, pr: 8, runId: 'timeout', status: 'failed', fallback: true, agyVerdict: null, agyFindings: [], reasons: ['timeout'] }, { path });
      const runs = new Map([['r', { verdict: { verdict: 'changes' } }]]);
      const later = new Map([['o/r#7', [{ findings: { read: { latestFix: { priorHead: 'h', files: { 'scripts/x.mjs': [10] } } } } }]]]);
      const report = buildPromotionReport({ rows: readPromotionRows({ path }), runRecords: runs, prRuns: later });
      expect(report).toMatchObject({ prs: 2, agreement: { agree: 1, compared: 1 }, confirmedFindings: 1, falsePositives: 0, timeouts: 1, fallbacks: 1 });
      const falsePositive = { findings: { read: { findingIdentity: [{ path: 'scripts/x.mjs', normSummary: 'bad guard', rulings: [{ head: 'h', result: 'not-real' }] }] } } };
      expect(buildPromotionReport({ rows: [row], prRuns: new Map([['o/r#7', [falsePositive]]]) }).falsePositives).toBe(1);
      expect(buildPromotionReport({ rows: [row] })).toMatchObject({ pendingVerdicts: 1, pendingFindings: 1, falsePositives: 0 });
      expect(renderPromotionReport(report)).toMatch(/agreement.*confirmed findings.*false positives.*timeouts.*2 PRs/);
      const { main } = await import('../agy-shadow-trial-report.mjs');
      let output = '';
      main(['--promotion'], { readPromotion: () => readPromotionRows({ path }), write: text => { output += text; }, evidenceIO: { resolveDirs: () => [] } });
      expect(output).toMatch(/agreement.*confirmed findings.*false positives.*timeouts.*2 PRs/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('promotion verdict authorization audit', () => {
  const carbon = 'gemini-4-carbon-high';
  const good = { status: 'ok', sessionId: 'carbon-session', servedModel: carbon, value: { summary: 'Reviewed diff: inverted guard', findings: [finding] } };
  const policyWith = patch => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    Object.assign(policy.operations['review-seat:mandatory:correctness'], patch);
    return validateRoutingPolicy(policy);
  };
  const selection = policy => loadReviewSeatSettings({ policy, aiRouting: {}, log: () => {} });
  async function attempt(result = good, { lens = 'correctness', promoted = true, policy = DEFAULT_ROUTING_POLICY, append = () => true, scope = [finding.file], transcript = '' } = {}) {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const rows = [], calls = [];
    const answer = await runSeatWithProvider({ lens, runId: 'audit', shape: REVIEW_JUDGE_SHAPE, seatProvider: {
      mode: 'agy', promoted, model: carbon, onEscape: 'claude', repo: 'o/r', pr: 7, head: 'head', citationScope: scope,
    } }, {
      cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => { calls.push('claude'); return { value: claudeAnswer }; },
      agyJuror: async () => { calls.push('carbon'); return result; }, readTranscript: () => transcript,
      readRoutingPolicy: () => policy, readSeatSettings: () => ({ tool: {}, platform: {} }),
      appendPromotion: row => { rows.push(row); return append(row); }, reserveSession: () => ({ allowed: true }), log: () => {},
    });
    return { answer, rows, calls };
  }
  const fellBack = result => {
    expect(result.answer.seatProvider.provider).toBe('claude');
    expect(deriveVerdict(result.answer)).toBe('changes');
    expect(result.calls.at(-1)).toBe('claude');
  };
  it.each([
    { provider: 'claude', model: 'sonnet', mode: undefined },
    { disabledProviders: ['agy-gemini'] },
  ])('validated routing restrictions refuse correctness promotion: %j', patch => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    const settings = selection(policyWith(patch));
    expect(seatProviderDirective(settings, 'correctness', highCarePr)?.mode).not.toBe('agy');
  });
  it('dispatch rechecks real disabledProviders rather than trusting synthetic enabledProviders', async () => {
    const result = await attempt(good, { policy: policyWith({ disabledProviders: ['agy-gemini'] }) });
    fellBack(result);
    expect(result.calls).toEqual(['claude']);
  });
  it('invalid promotionReplaces refuses promotion and logs instead of falling through', () => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'cluade');
    const logs = [];
    const settings = loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY, aiRouting: {}, log: m => logs.push(m) });
    expect(seatProviderDirective(settings, 'correctness', highCarePr)?.mode).not.toBe('agy');
    expect(logs.join(' ')).toMatch(/invalid.*promotion.*refus|promotion.*invalid.*refus/i);
  });
  it.each([
    { ...good, value: { summary: 'Review not performed: no diff evidence', findings: [] } },
    { ...good, value: { summary: 'Clean', findings: [] } },
    ...[{ file: 42 }, { line: 0 }, { line: -1 }, { line: 1.5 }, { category: {} }].map(patch => ({ ...good, value: { summary: 'Reviewed', findings: [{ ...finding, ...patch }] } })),
    ...[undefined, 'unknown', 'gemini-4-argon-high'].map(servedModel => ({ ...good, servedModel })),
    { ...good, timedOut: true },
    { ...good, telemetry: { timedOut: true } },
  ])('invalid, abstaining, wrong-model or salvaged timeout Carbon answer never counts: %j', async result => {
    const out = await attempt(result);
    fellBack(out);
    expect(out.rows[0]).toMatchObject({ fallback: true, agyVerdict: null });
    if (result.timedOut || result.telemetry?.timedOut) expect(out.rows[0].timeout).toBe(true);
  });
  it('failed ledger write refuses to count a valid Carbon answer', async () => {
    const result = await attempt(good, { append: () => false });
    fellBack(result);
    expect(result.answer.seatProvider.fellBackFrom.reasons.join(' ')).toMatch(/ledger/i);
  });
  it.each(['security', 'red-team'])('promotion does not authorize another non-shadow role: %s', async lens => {
    const result = await attempt(good, { lens });
    fellBack(result);
    expect(result.calls).toEqual(['claude']);
  });
  it.each([
    { ...good.value, outcome: 'fixed' },
    { ...good.value, findings: [{ ...finding, outcome: 'fixed' }] },
    { ...good.value, findings: [{ ...finding, preventionCaptured: 'false' }] },
    { ...good.value, findings: [{ ...finding, introduced: 'false' }] },
    { ...good.value, findings: [{ ...finding, verdict: 'ACCEPT' }] },
    { ...good.value, findings: [{ ...finding, disposition: 'accept' }] },
    { ...good.value, findings: [{ ...finding, citationScope: 'in-scope' }] },
  ])('counted Carbon rejects properties and types outside the strict review schema: %j', async value => {
    const result = await attempt({ ...good, value });
    fellBack(result);
    expect(result.rows[0]).toMatchObject({ fallback: true, agyVerdict: null });
  });
  it.each([{ scope: [] }, { scope: null }, { scope: ['elsewhere.mjs'] }])('citation admission refuses missing or out-of-scope evidence before Carbon counts: %j', async ({ scope }) => {
    const result = await attempt(good, { scope });
    fellBack(result);
    expect(result.rows[0]).toMatchObject({ fallback: true, agyVerdict: null });
  });
  it('discarding even one out-of-scope Carbon finding requires the Claude seat', async () => {
    fellBack(await attempt({ ...good, value: { ...good.value, findings: [finding, { ...finding, file: 'elsewhere.mjs' }] } }));
  });
  it.each([
    { summary: 'could not inspect the diff' },
    { summary: 'could not inspect the diff', file: finding.file },
    { summary: 'could not inspect the diff', file: '', line: 1 },
  ])('uncited counted placeholders cannot satisfy evidence admission: %j', async placeholder => {
    fellBack(await attempt({ ...good, value: { summary: 'Reviewed', findings: [placeholder] } }));
  });
  const readTrace = (path, state = 'DONE', extra = {}) => [
    { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', tool_name: 'read_file', state, tool_info: { parameters: { AbsolutePath: path } }, ...extra } },
    { event: 'result', result: { status: 'SUCCESS' } },
  ].map(x => JSON.stringify(x)).join('\n');
  it.each([
    '',
    readTrace('elsewhere.mjs'),
    readTrace(finding.file, 'ACTIVE'),
    readTrace(finding.file, 'DONE', { status: 'TOOL_ERROR' }),
    [
      { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', tool_name: 'read_file', state: 'ACTIVE', tool_info: { parameters: { AbsolutePath: finding.file } } } },
      { event: 'step_update', step_update: { step_index: 1, step_type: 'finish', state: 'DONE' } },
      { event: 'result', result: { status: 'SUCCESS' } },
    ].map(x => JSON.stringify(x)).join('\n'),
  ])('a clean Carbon answer without a successful diff read still runs Claude: %j', async transcript => {
    fellBack(await attempt({ ...good, transcriptFile: 'served.jsonl', value: { summary: 'Clean', findings: [] } }, { transcript }));
  });
  it('zero findings can count only with a served successful read_file of a diff path', async () => {
    const result = await attempt({ ...good, transcriptFile: 'served.jsonl', value: { summary: 'Clean', findings: [] } }, { transcript: readTrace(finding.file) });
    expect(result.calls).toEqual(['carbon']);
    expect(result.answer.seatProvider.provider).toBe('agy');
  });

});
