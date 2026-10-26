import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyEvidenceError, agyRunEvidence, readAgyHold, saveAgyHold } from '../antigravity-run-evidence.mjs';
import { normalizeJudgeTelemetry } from '../../operations/run-record.mjs';
import { classifySeatCall } from '../../operations/review-extra-seats.mjs';
const stream = (model, result) => [JSON.stringify({ event: 'init', init: { model } }), JSON.stringify({ event: 'result', result })].join('\n');
describe('agy observed model and quota evidence', () => {
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
      expect(readAgyHold('claude-opus-4-6', { dir, now: 1000 })).toMatchObject({ servedModel: 'unknown', fallbackDecision: 'skip-quota-hold' });
      const shorter = { ...row, quotaResetsAt: new Date(2000).toISOString() };
      saveAgyHold(shorter, { dir });
      expect(readAgyHold('sonnet', { dir, now: 3000 })?.quotaResetsAt).toBe(row.quotaResetsAt);
      expect(readAgyHold('gemini-3.1-pro', { dir, now: 1000 })).toBeNull();
      expect(readAgyHold('sonnet', { dir, now: Date.parse(row.quotaResetsAt) })).toBeNull();
      expect(classifySeatCall('agy-claude', { report: { ...row, events: { finalResponse: '{"findings":[]}' } } }).status).toBe('quota-exhausted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('agy family-keyed quota holds and legacy observations', () => {
  let dir;
  const setup = () => { dir = mkdtempSync(join(tmpdir(), 'agy-family-hold-test-')); return dir; };
  const rowFor = (model) => agyRunEvidence({ requestedModel: model, now: 0,
    stdout: stream(model, { status: 'ERROR', error: 'RESOURCE_EXHAUSTED. Resets in 1h.' }) });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it.each([
    ['claude-sonnet-4-6', 'anthropic', 'claude-opus-4-6', 'gemini-3.1-pro-high'],
    ['gemini-3.1-pro-high', 'google', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'],
  ])('%s hold blocks its family and leaves the other family available', (heldModel, heldBackend, sameFamily, otherFamily) => {
    setup();
    saveAgyHold(rowFor(heldModel), { dir });
    expect(readAgyHold(sameFamily, { dir, now: 1000 })).toMatchObject({ requestedModel: sameFamily,
      servedModel: 'unknown', servedBackend: 'unknown', modelEvidence: 'not-launched',
      fallbackDecision: 'skip-quota-hold', heldBackend, heldModel });
    expect(readAgyHold(otherFamily, { dir, now: 1000 })).toBeNull();
  });

  it.each([
    ['claude-sonnet-4-6', 'anthropic'], ['gemini-3.1-pro-high', 'google'], ['experimental-model', 'unknown'],
  ])('default and unknown launches scan the %s backend folder', (heldModel, heldBackend) => {
    setup();
    saveAgyHold(rowFor(heldModel), { dir });
    for (const model of [undefined, 'unrecognized-model']) {
      const hold = readAgyHold(model, { dir, now: 1000 });
      expect(hold).toMatchObject({ requestedModel: model || 'default', heldBackend, heldModel });
      expect(agyEvidenceError(hold).message).toContain(`(held by ${heldBackend} model ${heldModel})`);
      expect(agyEvidenceError(hold).telemetry).toBe(hold);
    }
  });

  it('uses the reported held model, falling back to the request when init was unavailable', () => {
    setup();
    const row = { ...rowFor('claude-sonnet-4-6'), servedModel: 'claude-opus-4-6' };
    saveAgyHold(row, { dir });
    expect(readAgyHold('sonnet', { dir, now: 1000 })).toMatchObject({ heldModel: 'claude-opus-4-6' });
    saveAgyHold({ ...row, servedModel: 'unknown', servedBackend: 'unknown', quotaResetsAt: new Date(7200000).toISOString() }, { dir });
    expect(readAgyHold('sonnet', { dir, now: 1000 })).toMatchObject({ heldBackend: 'anthropic', heldModel: 'claude-sonnet-4-6' });
  });

  it.each([
    ['claude-opus-4-6', 'gemini-3.1-pro-high', 'anthropic', 'sonnet', 'gemini-3.1-pro-high'],
    ['unknown', 'gemini-3.1-pro-high', 'google', 'gemini-3.1-pro-high', 'sonnet'],
    [undefined, 'claude-sonnet-4-6', 'anthropic', 'opus', 'gemini-3.1-pro-high'],
  ])('attributes legacy served %s / requested %s to its known backend', (servedModel, requestedModel, heldBackend, blocked, available) => {
    setup();
    const row = { ...rowFor(requestedModel), servedModel };
    const file = join(dir, 'legacy.json');
    const original = JSON.stringify(row);
    writeFileSync(file, original);
    const heldModel = servedModel && servedModel !== 'unknown' ? servedModel : requestedModel;
    expect(readAgyHold(blocked, { dir, now: 1000 })).toMatchObject({ heldBackend, heldModel });
    expect(readAgyHold(available, { dir, now: 1000 })).toBeNull();
    expect(readAgyHold(undefined, { dir, now: 1000 })).toMatchObject({ heldBackend, heldModel });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(dir)).toEqual(['legacy.json']);
    expect(readAgyHold(blocked, { dir, now: Date.parse(row.quotaResetsAt) })).toBeNull();
  });

  it.each([
    ['experimental-served', 'experimental-request', 'experimental-served'],
    ['unknown', 'experimental-request', 'experimental-request'],
    [undefined, undefined, 'unknown'],
  ])('keeps unattributed legacy served %s / requested %s global', (servedModel, requestedModel, heldModel) => {
    setup();
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ servedModel, requestedModel,
      quotaResetsAt: new Date(3600000).toISOString(), quotaState: 'exhausted' }));
    for (const model of ['claude-sonnet-4-6', 'gemini-3.1-pro-high', undefined, 'unrecognized-model']) {
      expect(readAgyHold(model, { dir, now: 1000 })).toMatchObject({ heldBackend: 'unknown', heldModel,
        fallbackDecision: 'skip-quota-hold' });
    }
  });

  it('ignores expired legacy holds and root JSON without a quota reset', () => {
    setup();
    writeFileSync(join(dir, 'expired.json'), JSON.stringify({ quotaResetsAt: new Date(1000).toISOString() }));
    writeFileSync(join(dir, 'unrelated.json'), JSON.stringify({ requestedModel: 'sonnet' }));
    expect(readAgyHold(undefined, { dir, now: 1000 })).toBeNull();
  });

  it('refuses malformed legacy evidence rather than silently launching', () => {
    setup();
    writeFileSync(join(dir, 'legacy.json'), '{');
    expect(() => readAgyHold('gemini-3.1-pro-high', { dir, now: 1000 })).toThrow(SyntaxError);
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
