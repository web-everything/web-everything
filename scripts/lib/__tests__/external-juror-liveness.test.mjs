import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityJudgeSpawn } from '../antigravity-judge-spawn.mjs';
import { readAgyHold, saveAgyHold, agyEvidenceError } from '../antigravity-run-evidence.mjs';
import { resolveExternalJurorSettings } from '../review-seat-settings.mjs';
import { normalizeJudgeTelemetry } from '../../operations/run-record.mjs';
import { createDefaultJudge, unwrapJudgeOutcome, judgeOutcome } from '../../operations/cli-adapter.mjs';
import { antigravityReviewFromEnv, buildReviewAntigravityJudgeRequest, buildReviewAgyCorrectnessJudgeRequest,
  reviewSeatOptionsForRun } from '../../operations/review-pr.mjs';
import { referralSeatDisabled } from '../../operations/review-seat-policy.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null); return true; });
  return child;
}
const base = { mandate: 'review', input: 'diff', shape: {}, env: {}, firstOutputMs: 15, cooldownMs: 1000,
  readHold: () => null, saveHold: () => {}, persistTranscript: () => null, recordScorecard: () => {} };
const settings = (extra = {}) => resolveExternalJurorSettings({ env: {}, platform: {}, readFile: () => '{}', log: () => {}, ...extra });
const stream = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'session',
  structured_output: { summary: 'reviewed', findings: [] } } });

describe('external juror first-output liveness', () => {
  it('kills a silent child and records telemetry even if kill never emits close', async () => {
    const child = childProcess(); child.kill = vi.fn();
    const records = [];
    const error = await antigravityJudgeSpawn({ ...base, spawnFn: () => child, recordScorecard: r => records.push(r) }).catch(e => e);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(error.telemetry).toMatchObject({ fallbackDecision: 'skip-provider-unresponsive', quotaState: 'provider-unresponsive', firstOutputMs: 15, cooldownMs: 1000 });
    expect(error.message).toContain('first-output window 15 ms; cooldown 1000 ms');
    expect(records[0]).toMatchObject({ fallbackDecision: 'skip-provider-unresponsive', firstOutputMs: 15, cooldownMs: 1000 });
    expect(normalizeJudgeTelemetry({ telemetry: error.telemetry })).toMatchObject({ firstOutputMs: 15, cooldownMs: 1000 });
  });
  it('persists a binary-wide hold and skips another backend without spawning until expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-liveness-'));
    try {
      const spawnFn = vi.fn(childProcess);
      const opts = { ...base, spawnFn, model: 'claude-sonnet-4-6', readHold: m => readAgyHold(m, { dir }), saveHold: e => saveAgyHold(e, { dir }) };
      const error = await antigravityJudgeSpawn(opts).catch(e => e);
      saveAgyHold({ requestedModel: 'gemini-3.1-pro', servedBackend: 'google', quotaState: 'exhausted', quotaResetsAt: new Date(Date.now() + 100000).toISOString() }, { dir });
      const next = await antigravityJudgeSpawn({ ...opts, model: 'gemini-3.1-pro' }).catch(e => e);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(next.telemetry).toMatchObject({ fallbackDecision: 'skip-provider-unresponsive', modelEvidence: 'not-launched', quotaState: 'provider-unresponsive' });
      expect(next.message).toContain('first-output window 15 ms; cooldown 1000 ms');
      expect(Date.parse(error.telemetry.quotaResetsAt) - Date.now()).toBeGreaterThan(500);
      expect(readAgyHold('claude-sonnet-4-6', { dir, now: Date.parse(error.telemetry.quotaResetsAt) })).toBeNull();
      expect(readAgyHold('gemini-3.1-pro', { dir, now: Date.parse(error.telemetry.quotaResetsAt) }).quotaState).toBe('exhausted');
      writeFileSync(join(dir, 'corrupt.json'), '{');
      await expect(antigravityJudgeSpawn({ ...opts, model: 'gemini-3.1-pro' })).rejects.toThrow(SyntaxError);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['stdout', 'stderr'])('one %s byte cancels only the first-output timer', async channel => {
    const child = childProcess();
    queueMicrotask(() => child[channel].write('x'));
    setTimeout(() => { child.stdout.write('\n' + stream); child.emit('close', 0); }, 45);
    const answer = await antigravityJudgeSpawn({ ...base, spawnFn: () => child });
    expect(answer.value.summary).toBe('reviewed'); expect(child.kill).not.toHaveBeenCalled();
  });
  it('zero disables liveness while the normal wall still kills after an initial byte', async () => {
    const child = childProcess();
    setTimeout(() => { child.stdout.write(stream); child.emit('close', 0); }, 35);
    await antigravityJudgeSpawn({ ...base, firstOutputMs: 0, spawnFn: () => child });
    expect(child.kill).not.toHaveBeenCalled();
    const active = childProcess();
    queueMicrotask(() => active.stderr.write('started'));
    const watchdog = setTimeout(() => active.emit('error', new Error('normal wall failed to settle')), 100);
    try {
      const error = await antigravityJudgeSpawn({ ...base, timeoutMs: 30, spawnFn: () => active }).catch(e => e);
      expect(active.kill).toHaveBeenCalledWith('SIGKILL');
      expect(error.telemetry.fallbackDecision).toBe('none');
    } finally { clearTimeout(watchdog); }
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid injectable bounds %s before launch', async firstOutputMs => {
    const spawnFn = vi.fn();
    await expect(antigravityJudgeSpawn({ ...base, firstOutputMs, spawnFn })).rejects.toThrow(TypeError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('review external juror setting cascade', () => {
  it('uses standard defaults and logs their provenance', () => {
    const log = vi.fn(); const result = settings({ log });
    expect(result.value).toEqual({ firstOutputMs: 120000, cooldownMs: 1800000, antigravityReview: 'probation' });
    expect(log.mock.calls[0][0]).toContain('firstOutputMs=120000 (standard)');
  });
  it('resolves each leaf standard -> platform -> tool -> env', () => {
    const platform = { externalJurors: { firstOutputMs: 20, cooldownMs: 30 }, advisorySeats: { antigravityReview: 'on' } };
    expect(settings({ platform }).sources.firstOutputMs).toBe('platform');
    const readFile = () => JSON.stringify({ externalJurors: { firstOutputMs: 40 }, advisorySeats: { antigravityReview: 'off' } });
    expect(settings({ platform, readFile })).toMatchObject({ value: { firstOutputMs: 40, cooldownMs: 30, antigravityReview: 'off' }, sources: { firstOutputMs: 'tool', cooldownMs: 'platform' } });
    expect(settings({ platform, readFile, env: { WE_REVIEW_JUROR_FIRST_OUTPUT_MS: '0', WE_REVIEW_JUROR_COOLDOWN_MS: '80', REVIEW_PR_ANTIGRAVITY_REVIEW: '1' } }))
      .toMatchObject({ value: { firstOutputMs: 0, cooldownMs: 80, antigravityReview: 'on' }, sources: { firstOutputMs: 'env', cooldownMs: 'env', antigravityReview: 'env' } });
  });
  it.each([-1, 1.2, 9007199254740992, 'garbage', { nested: 5 }])('rejects malformed and oversized setting %j', value => {
    const readFile = () => JSON.stringify({ externalJurors: { firstOutputMs: value, cooldownMs: value } });
    const r = settings({ readFile, env: { WE_REVIEW_JUROR_FIRST_OUTPUT_MS: String(value), WE_REVIEW_JUROR_COOLDOWN_MS: String(value) } });
    expect(r.value.firstOutputMs).toBe(120000); expect(r.value.cooldownMs).toBe(1800000); expect(r.invalid.length).toBeGreaterThan(0);
  });
  it.each([true, false])('default probation mode preserves old seating when probation=%s', active => {
    const opts = { platform: {}, readFile: () => '{}', log: () => {}, isOnProbation: () => active };
    expect(antigravityReviewFromEnv({}, opts)).toBe(active);
    expect(antigravityReviewFromEnv({}, { ...opts, readFile: () => '{"advisorySeats":{"antigravityReview":"probation"}}' })).toBe(active);
  });
  it.each(['on', 'off'])('forced %s bypasses probation and literal env overrides win', mode => {
    const opts = { platform: {}, readFile: () => JSON.stringify({ advisorySeats: { antigravityReview: mode } }),
      log: () => {}, isOnProbation: () => { throw Error('must not consult probation'); } };
    expect(antigravityReviewFromEnv({}, opts)).toBe(mode === 'on');
    for (const value of ['1', '0', '', 'true']) expect(antigravityReviewFromEnv({ REVIEW_PR_ANTIGRAVITY_REVIEW: value }, opts)).toBe(value === '1');
  });
  it('invalid seat mode falls back to probation and logs tool provenance for valid probation', () => {
    expect(settings({ readFile: () => '{"advisorySeats":{"antigravityReview":"unknown"}}' }))
      .toMatchObject({ value: { antigravityReview: 'probation' }, sources: { antigravityReview: 'standard' }, invalid: [expect.stringContaining('antigravityReview')] });
    expect(settings({ readFile: () => '{"advisorySeats":{"antigravityReview":"probation"}}' }))
      .toMatchObject({ value: { antigravityReview: 'probation' }, sources: { antigravityReview: 'tool' } });
  });
  it('shipped probation keeps existing unruled Antigravity referrals enabled and saved rosters intact', () => {
    expect(referralSeatDisabled('judgeAntigravityReview', {})).toBe(false);
    expect(reviewSeatOptionsForRun({ findings: { read: { seatSteps: ['judge', 'judgeSecurity', 'judgeAntigravityReview'] }, judgeAntigravityReview: {} } }, null, { antigravityReview: false }).antigravityReview).toBe(true);
  });
});

describe('unresponsive advisory skip evidence', () => {
  const evidence = { requestedModel: 'gemini-3.1-pro', servedModel: 'unknown', quotaState: 'provider-unresponsive',
    fallbackDecision: 'skip-provider-unresponsive', firstOutputMs: 15, cooldownMs: 1000 };
  it('the antigravity builder opts into graceful handling and the adapter records the reason', async () => {
    const request = buildReviewAntigravityJudgeRequest({ read: { title: 'fixture', netChangedFiles: [], diffText: 'diff' } });
    expect(request.gracefulOnUnavailable).toBe(true);
    const judge = createDefaultJudge({ resolveProvider: () => async () => { throw agyEvidenceError(evidence); }, checkProviderHold: () => null, logGracefulOutcome: () => {} });
    const answer = unwrapJudgeOutcome(await judge(request));
    expect(answer.value.skipped.reason).toBe('provider-unresponsive');
    expect(answer.value.summary).toContain('first-output window 15 ms; cooldown 1000 ms');
    expect(answer.telemetry).toMatchObject({ fallbackDecision: 'skip-provider-unresponsive', firstOutputMs: 15 });
  });
  it.each(['skip-provider-unresponsive', 'skip-quota-exhausted', 'skip-quota-hold', 'skip-backend-mismatch', 'skip-model-mismatch'])('skips explicit provider evidence %s', fallbackDecision => {
    const error = agyEvidenceError({ ...evidence, fallbackDecision });
    const judge = createDefaultJudge({ resolveProvider: () => async () => { throw error; }, checkProviderHold: () => null, logGracefulOutcome: () => {} });
    const request = buildReviewAntigravityJudgeRequest({ read: { title: 'fixture', netChangedFiles: [], diffText: 'diff' } });
    return judge(request).then(result => {
      const answer = unwrapJudgeOutcome(result);
      expect(answer.value.skipped).toBeDefined();
      expect(answer.value.findings).toEqual([]);
      expect(answer.telemetry.fallbackDecision).toBe(fallbackDecision);
    });
  });
  it.each(['missing structured output', 'malformed structured output', 'schema validation failed', 'tool-denial', 'unexpected failure'])('fails closed on %s without skip evidence', async message => {
    const error = new Error(message);
    const log = vi.fn();
    const judge = createDefaultJudge({ resolveProvider: () => async () => { throw error; }, checkProviderHold: () => null, logGracefulOutcome: log });
    const request = buildReviewAntigravityJudgeRequest({ read: { title: 'fixture', netChangedFiles: [], diffText: 'diff' } });
    await expect(judge(request)).rejects.toBe(error);
    error.telemetry = { ...evidence, fallbackDecision: 'none' };
    await expect(judge(request)).rejects.toBe(error);
    error.telemetry.fallbackDecision = 'skip-unknown';
    await expect(judge(request)).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
  });
  it('agy-correctness preserves unresponsive evidence through its advisory runner', async () => {
    const request = buildReviewAgyCorrectnessJudgeRequest({ read: { title: 'fixture', netChangedFiles: [], diffText: 'diff' }, model: 'fixture' });
    const outcome = await runSeatWithProvider(request, { cwd: '.', wrap: judgeOutcome, unwrap: unwrapJudgeOutcome,
      claudeJudge: () => { throw Error('must not fallback'); }, agyJuror: async () => ({ status: 'failed', reasons: [agyEvidenceError(evidence).message], telemetry: evidence }) });
    expect(unwrapJudgeOutcome(outcome).value).toMatchObject({ skipped: { reason: 'provider-unresponsive' } });
    expect(unwrapJudgeOutcome(outcome).value.summary).toContain('first-output window 15 ms; cooldown 1000 ms');
  });
});

it('safe-integer windows above Node timer range do not overflow into immediate kills', async () => {
  const child = childProcess();
  setTimeout(() => { child.stdout.write(stream); child.emit('close', 0); }, 30);
  const result = await antigravityJudgeSpawn({ ...base, firstOutputMs: 2 ** 32, spawnFn: () => child });
  expect(child.kill).not.toHaveBeenCalled();
  expect(result.value.summary).toBe('reviewed');
});
