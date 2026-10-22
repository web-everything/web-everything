import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyRunEvidence, readAgyHold, saveAgyHold, canonicalAgyModel, pickAgyEvidence } from '../antigravity-run-evidence.mjs';
import { normalizeJudgeTelemetry } from '../../operations/run-record.mjs';
import { classifySeatCall } from '../../operations/review-extra-seats.mjs';
const stream = (model, result) => [JSON.stringify({ event: 'init', init: { model } }), JSON.stringify({ event: 'result', result })].join('\n');
describe('agy observed model and quota evidence', () => {
  it.each([
    ['Resets in unknown ... Resets in 90h', false, 3600000],
    ...['1month', '5x', '2h3mx', '1h2h', '1h-2m', '1h:'].map((token) => [`Resets in ${token}`, false, 3600000]),
    ['Resets in 1month ... Resets in 90h', false, 3600000],
    ['Resets in 126h11m11s.', true, 454271000],
    ...[' ', '.', ',', ';', ')', '"', "'"].map((boundary) => [`Resets in 30m${boundary}more`, true, 1800000]),
    ['Resets in 2h3m4s', true, 7384000],
    ['Resets in 30m', true, 1800000],
    ['Resets in 20s', true, 20000],
    ['no reset', false, 3600000],
  ])('derives reset certainty and deadline from the same phrase: %s', (text, explicit, delay) => {
    const evidence = agyRunEvidence({ now: 0, stderr: `RESOURCE_EXHAUSTED ${text}` });
    expect(evidence.quotaResetExplicit).toBe(explicit);
    expect(evidence.quotaResetsAt).toBe(new Date(delay).toISOString());
    expect(pickAgyEvidence(evidence)).not.toHaveProperty('quotaResetExplicit');
  });
  it('records reported Gemini separately from requested Claude through persisted telemetry', () => {
    const evidence = agyRunEvidence({ requestedModel: 'claude-sonnet-4-6', stdout: stream('gemini-3.1-pro', { status: 'SUCCESS' }) });
    expect(normalizeJudgeTelemetry({ telemetry: evidence })).toMatchObject({ requestedModel: 'claude-sonnet-4-6', servedModel: 'gemini-3.1-pro', servedBackend: 'google', modelEvidence: 'agy-init', fallbackDecision: 'skip-backend-mismatch' });
  });
  it('does not invent a served model from a request or quota from answer text', () => {
    expect(agyRunEvidence({ requestedModel: 'sonnet', stdout: 'null\nnoise\n' + stream(null, { response: 'RESOURCE_EXHAUSTED' }) })).toMatchObject({ servedModel: 'unknown', quotaState: 'unknown' });
  });
  it('holds Claude until the observed reset, across wrappers, without holding Gemini', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-hold-test-'));
    try {
      const row = agyRunEvidence({ requestedModel: 'claude-sonnet-4-6', now: 0, stdout: stream('claude-sonnet-4-6', { status: 'ERROR', error: 'Individual quota reached. Resets in 90h29m27s.' }) });
      saveAgyHold(row, { dir });
      expect(readAgyHold('claude-sonnet-4-6', { dir, now: 1000 })).toMatchObject({ servedModel: 'unknown', fallbackDecision: 'skip-quota-hold' });
      expect(readAgyHold('sonnet', { dir, now: 1000 })).toMatchObject({ servedModel: 'unknown', fallbackDecision: 'skip-quota-hold' });
      const shorter = { ...row, quotaResetsAt: new Date(2000).toISOString() };
      saveAgyHold(shorter, { dir });
      expect(readAgyHold('claude-sonnet-4-6', { dir, now: 3000 })?.quotaResetsAt).toBe(row.quotaResetsAt);
      expect(readAgyHold('sonnet', { dir, now: 3000 })?.quotaResetsAt).toBe(row.quotaResetsAt);
      expect(readAgyHold('gemini-3.1-pro', { dir, now: 1000 })).toBeNull();
      expect(readAgyHold('claude-sonnet-4-6', { dir, now: Date.parse(row.quotaResetsAt) })).toBeNull();
      expect(readAgyHold('sonnet', { dir, now: Date.parse(row.quotaResetsAt) })).toBeNull();
      expect(classifySeatCall('agy-claude', { report: { ...row, events: { finalResponse: '{"findings":[]}' } } }).status).toBe('quota-exhausted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runAgyDirectExec } from '../../gemini-direct-task.mjs';
import { antigravityJudgeSpawn } from '../antigravity-judge-spawn.mjs';
function spawnStream(stdout, stderr = '') {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', 0); });
    return child;
  };
}
it('worker records a partial-answer quota failure and the next judge skips without spawning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wrapper-test-'));
  try {
    const readHold = (model) => readAgyHold(model, { dir });
    const saveHold = (row) => saveAgyHold(row, { dir });
    const run = await runAgyDirectExec({ dir, task: 'test', model: 'claude-sonnet-4-6', logFile: join(dir, 'run.jsonl'), stream: false,
      readHold, saveHold, spawnFn: spawnStream(stream('claude-sonnet-4-6', { status: 'SUCCESS', response: '{"findings":[]}' }), 'Individual quota reached. Resets in 90h29m27s.') });
    expect(run).toMatchObject({ code: 1, servedModel: 'claude-sonnet-4-6', quotaState: 'exhausted', fallbackDecision: 'skip-quota-exhausted' });
    const rows = [];
    await expect(antigravityJudgeSpawn({ mandate: 'judge', input: 'diff', shape: {}, model: 'claude-sonnet-4-6', readHold, saveHold,
      recordScorecard: (row) => rows.push(row), spawnFn: () => { throw new Error('must not spawn'); } })).rejects.toThrow('skip-quota-hold');
    expect(rows[0]).toMatchObject({ servedModel: 'unknown', modelEvidence: 'not-launched', quotaState: 'exhausted' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('judge refuses a reported substitute and preserves evidence in its scorecard and error', async () => {
  const rows = [];
  await expect(antigravityJudgeSpawn({ mandate: 'judge', input: 'diff', shape: {}, model: 'claude-sonnet-4-6', readHold: () => null, saveHold: () => {},
    persistTranscript: () => null, recordScorecard: (row) => rows.push(row),
    spawnFn: spawnStream(stream('gemini-3.1-pro', { status: 'SUCCESS', structured_output: { findings: [] } })) })).rejects.toMatchObject({ telemetry: { servedBackend: 'google', fallbackDecision: 'skip-backend-mismatch' } });
  expect(rows[0]).toMatchObject({ model: 'gemini-3.1-pro', requestedModel: 'claude-sonnet-4-6' });
});

import { buildSeatRows } from '../../operations/review-extra-seats.mjs';
import { launchScorecardRow } from '../probation-launcher.mjs';
import { createDefaultJudge, unwrapJudgeOutcome } from '../../operations/cli-adapter.mjs';
it('retains provenance through the judge adapter, extra seats and probation rows', async () => {
  const evidence = agyRunEvidence({ requestedModel: 'gemini-3.1-pro-high', stdout: stream('gemini-3.1-pro', { status: 'SUCCESS' }) });
  const judge = createDefaultJudge({ providerName: 'antigravity', provider: async () => ({ value: { findings: [] }, ...evidence }) });
  const { telemetry } = unwrapJudgeOutcome(await judge({ mandate: 'judge', input: 'diff', shape: {}, model: 'gemini-3.1-pro-high' }));
  expect(normalizeJudgeTelemetry({ telemetry })).toMatchObject({ model: 'gemini-3.1-pro', requestedModel: 'gemini-3.1-pro-high', modelEvidence: 'agy-init' });
  expect(buildSeatRows({ evidence, model: 'gemini-3.1-pro-high', seats: [{ key: 'review' }], call: { status: 'ok' }, parsed: { review: { ok: true, findings: [], verdict: 'accept' } } })[0]).toMatchObject({ model: 'gemini-3.1-pro', requestedModel: 'gemini-3.1-pro-high' });
  expect(launchScorecardRow({ worker: { provider: 'antigravity', model: 'gemini-3.1-pro-high' }, modelEvidence: evidence })).toMatchObject({ model: 'gemini-3.1-pro', requestedModel: 'gemini-3.1-pro-high' });
});
it('rejects a changed model within the same backend, while accepting effort suffix resolution', () => {
  expect(agyRunEvidence({ requestedModel: 'claude-sonnet-4-6', stdout: stream('claude-opus-4-6', {}) }).fallbackDecision).toBe('skip-model-mismatch');
  expect(agyRunEvidence({ requestedModel: 'gemini-3.1-pro-high', stdout: stream('gemini-3.1-pro', {}) }).fallbackDecision).toBe('none');
});


describe('per-model hold matching and supersession', () => {
  const opus = 'claude-opus-5-5';
  const row = (requestedModel, servedModel = requestedModel) => ({ requestedModel, servedModel, servedBackend: 'anthropic', quotaState: 'exhausted', quotaResetsAt: new Date(100000).toISOString() });
  const fixture = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-model-hold-'));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it.each(['sonnet', 'opus', 'custom', 'claude-sonnet', 'gemini-latest', 'gpt-latest'])('does not canonicalize alias %s', (alias) => {
    expect(canonicalAgyModel(alias)).toBeNull();
  });
  it.each(['sonnet', 'opus'])('alias request %s honors any active hold in its backend', (alias) => fixture((dir) => {
    saveAgyHold(row('claude-sonnet-4-6'), { dir });
    expect(readAgyHold(alias, { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold(alias, { dir, now: 100000 })).toBeNull();
  }));
  it.each(['sonnet', 'opus', 'claude-latest'])('alias-only hold %s applies backend-wide and cannot be superseded by a model probe', (alias) => fixture((dir) => {
    saveAgyHold(row(alias), { dir });
    mkdirSync(join(dir, 'probes'));
    writeFileSync(join(dir, 'probes', `${alias}.json`), JSON.stringify({ outcome: 'ok', supersedesBefore: Date.now() + 10000 }));
    for (const model of [opus, 'claude-sonnet-4-6', 'sonnet']) expect(readAgyHold(model, { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold('gemini-3.1-pro', { dir, now: 0 })).toBeNull();
  }));
  it('shares effort variants only, keeping sonnet, Gemini and thinking independent', () => fixture((dir) => {
    saveAgyHold(row(`${opus}-high`), { dir });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(readAgyHold(`${opus}-${effort}`, { dir, now: 0 })).not.toBeNull();
    for (const model of ['claude-sonnet-5-5-high', 'gemini-3.1-pro', `${opus}-thinking`]) expect(readAgyHold(model, { dir, now: 0 })).toBeNull();
  }));
  it.each(['opus', opus])('keeps ambiguous served identity %s backend-wide despite a concrete request and successful probes', (served) => fixture((dir) => {
    const requested = 'claude-sonnet-5-5';
    saveAgyHold(row(requested, served), { dir });
    for (const model of [opus, requested, 'claude-sonnet-4-6']) expect(readAgyHold(model, { dir, now: 0 })).not.toBeNull();
    mkdirSync(join(dir, 'probes'));
    for (const model of [opus, requested]) writeFileSync(join(dir, 'probes', `${model}.json`), JSON.stringify({ supersedesBefore: Date.now() + 10000 }));
    for (const model of [opus, requested, 'claude-sonnet-4-6']) expect(readAgyHold(model, { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold('gemini-3.1-pro', { dir, now: 0 })).toBeNull();
  }));
  it('uses the requested canonical model when served identity is unavailable', () => fixture((dir) => {
    saveAgyHold(row(opus, 'unknown'), { dir });
    expect(readAgyHold(opus, { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold('claude-sonnet-5-5', { dir, now: 0 })).toBeNull();
  }));
  it.each([{}, { requestedModel: 'unknown', servedModel: 'default' }])('keeps legacy model-less holds scoped to the backend: %j', (models) => fixture((dir) => {
    mkdirSync(join(dir, 'anthropic'));
    writeFileSync(join(dir, 'anthropic', 'old.json'), JSON.stringify({ quotaResetsAt: new Date(100000).toISOString(), ...models }));
    expect(readAgyHold(opus, { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold('claude-sonnet-5-5', { dir, now: 0 })).not.toBeNull();
    expect(readAgyHold('gemini-3.1-pro', { dir, now: 0 })).toBeNull();
  }));
  it('default launches ignore named holds, but honor default-launch holds across backends', () => fixture((dir) => {
    saveAgyHold(row(opus), { dir });
    expect(readAgyHold(undefined, { dir, now: 0 })).toBeNull();
    expect(readAgyHold('default', { dir, now: 0 })).toBeNull();
    saveAgyHold(row('default', opus), { dir });
    expect(readAgyHold(undefined, { dir, now: 0 })).toMatchObject({ requestedModel: 'default', fallbackDecision: 'skip-quota-hold' });
  }));
  it('default launches honor observations with missing requestedModel', () => fixture((dir) => {
    saveAgyHold(row(undefined, opus), { dir });
    expect(readAgyHold(undefined, { dir, now: 0 })).not.toBeNull();
  }));
  it('supersedes only observations at or before the model probe boundary', () => fixture((dir) => {
    saveAgyHold(row(`${opus}-high`), { dir });
    saveAgyHold(row('claude-sonnet-5-5'), { dir });
    for (const name of readdirSync(join(dir, 'anthropic'))) utimesSync(join(dir, 'anthropic', name), 1, 1);
    mkdirSync(join(dir, 'probes'));
    writeFileSync(join(dir, 'probes', `${opus}.json`), JSON.stringify({ outcome: 'ok', supersedesBefore: 1000 }));
    expect(readAgyHold(`${opus}-low`, { dir, now: 0 })).toBeNull();
    expect(readAgyHold('claude-sonnet-5-5', { dir, now: 0 })).not.toBeNull();
    saveAgyHold(row(opus), { dir });
    expect(readAgyHold(opus, { dir, now: 0 })).not.toBeNull();
  }));
});
