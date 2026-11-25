import { describe, expect, it, vi } from 'vitest';
import { createDefaultJudge, driveRun, outcomePayload, renderOutcome } from '../cli-adapter.mjs';
import { classifyReviewLoopOutcome } from '../review-job.mjs';
import { advance, startRun } from '../engine.mjs';
import { notApplied, retryableWarning } from '../effect-executor.mjs';
import { createRegistry, op } from '../registry.mjs';
import { createMemoryRunStore, isRunRecordTerminal } from '../run-store.mjs';
import { EventEmitter } from 'node:events';
import { judgeSpawn } from '../../lib/judge-spawn.mjs';
import { judge as judgeStep, effect } from '../step-kinds.mjs';

function fixture(prefix = []) {
  const registry = createRegistry();
  registry.register(op('guard-refusal', {
    go: effect({ effects: () => [...prefix, { type: 'guard.clear' }, { type: 'note.write' }] }),
    later: effect({ effects: () => [{ type: 'note.write' }] }),
  }));
  const store = createMemoryRunStore();
  const run = startRun({ op: 'guard-refusal', id: 'run-guard', registry });
  store.write(run);
  return { registry, store, run };
}

describe('effect-warning output', () => {
  it('stops on an idempotent warning and resumes publication from a serialized pending run', async () => {
    const context = fixture([{ type: 'publish', idempotent: true }]);
    const publish = vi.fn(async () => retryableWarning({ warning: 'Publication needs retry' }));
    const guard = vi.fn();
    const note = vi.fn();
    const sinks = { publish, 'guard.clear': guard, 'note.write': note };
    const first = await driveRun({ ...context, sinks });
    expect(first).toMatchObject({ stopped: 'effect-warning', warning: 'Publication needs retry', error: null });
    expect(first.run.effects.map(e => e.status)).toEqual(['pending', 'declared', 'declared']);
    expect(guard).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    const persisted = JSON.parse(JSON.stringify(context.store.read(context.run.id)));
    context.store.write(persisted);
    publish.mockImplementation(async () => ({ pushed: true }));
    const second = await driveRun({ ...context, run: persisted, sinks });
    expect(second.stopped).toBe('complete');
    expect(second.run.effects[0]).toMatchObject({ status: 'applied', attempts: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('redacts credentials in persisted warning payloads and JSON and text rendering', () => {
    const { run } = fixture();
    const warning = 'Retry publication: GH_TOKEN=fixture-secret-value';
    const outcome = { run: { ...run, effects: [{ key: 'warning#0', status: 'pending', result: { warning } }] },
      stopped: 'effect-warning', warning, error: null, applied: [] };
    const payload = outcomePayload(outcome);
    expect(payload.warning).toContain('Retry publication');
    expect(payload.warning).not.toContain('fixture-secret-value');
    const json = renderOutcome({ outcome, json: true });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.lines[0])).toEqual(payload);
    const text = renderOutcome({ outcome });
    expect(text.code).toBe(0);
    expect(text.lines.join('\n')).toContain('WARNING: Retry publication');
    expect(text.lines.join('\n')).toContain(`--resume=${run.id}`);
    expect(text.lines.join('\n')).not.toContain('fixture-secret-value');
  });

  it('uses Effect needs retry when an effect-warning payload has no persisted warning', () => {
    expect(outcomePayload({ run: fixture().run, stopped: 'effect-warning' }).warning).toBe('Effect needs retry');
  });
});

describe('driveRun permanent guard refusal', () => {
  it('settles the first drive as terminal and never retries the refused sink on a later drive', async () => {
    const context = fixture();
    const guard = vi.fn(async () => { throw notApplied('guard: SELF-CLEAR REFUSED — author cannot clear'); });
    const note = vi.fn();
    const sinks = { 'guard.clear': guard, 'note.write': note };

    const first = await driveRun({ ...context, sinks });
    expect(first.stopped).toBe('effect-refused');
    expect(first.error?.message).toBe('guard: SELF-CLEAR REFUSED — author cannot clear');
    expect(first.run.pending).toBeNull();
    expect(first.run.outcome).toBe('refused');
    expect(isRunRecordTerminal(first.run)).toBe(true);
    expect(context.store.read(context.run.id)).toEqual(first.run);
    expect(first.run.effects.map((entry) => entry.status)).toEqual(['refused', 'declared']);

    const second = await driveRun({ ...context, run: context.store.read(context.run.id), sinks });
    expect(second.stopped).toBe('effect-refused');
    expect(second.error?.message).toBe(first.error.message);
    expect(second.run).toEqual(first.run);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(note).not.toHaveBeenCalled();
  });

  it('settles a persisted pending refusal without retrying its sink', async () => {
    const context = fixture();
    const pending = advance(context.run, { registry: context.registry });
    const run = { ...pending, effects: pending.effects.map((entry, index) => index === 0
      ? { ...entry, status: 'refused', attempts: 1, error: 'guard: SELF-CLEAR REFUSED — author cannot clear' }
      : entry) };
    context.store.write(run);
    const guard = vi.fn();
    const note = vi.fn();
    const result = await driveRun({ ...context, run, sinks: { 'guard.clear': guard, 'note.write': note } });
    expect(result.stopped).toBe('effect-refused');
    expect(result.error?.message).toBe('guard: SELF-CLEAR REFUSED — author cannot clear');
    expect(result.run).toMatchObject({ pending: null, outcome: 'refused' });
    expect(isRunRecordTerminal(result.run)).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it('preserves applied effects and exposes a refused accept as blocked-on-infra in JSON and text', async () => {
    const context = fixture([{ type: 'prefix.write' }]);
    const message = 'guard: SELF-CLEAR REFUSED — author cannot clear';
    const prefix = vi.fn();
    const guard = vi.fn(async () => { throw notApplied(message); });
    const note = vi.fn();
    const run = { ...context.run, verdict: { verdict: 'accept' } };
    context.store.write(run);
    const outcome = await driveRun({ ...context, run, sinks: {
      'prefix.write': prefix, 'guard.clear': guard, 'note.write': note,
    } });
    expect(outcome.stopped).toBe('effect-refused');
    expect(outcome.error?.message).toBe(message);
    expect(outcome.applied).toEqual([outcome.run.effects[0].key]);
    expect(outcome.run).toMatchObject({ pending: null, outcome: 'refused' });
    expect(isRunRecordTerminal(outcome.run)).toBe(true);
    const payload = outcomePayload(outcome);
    expect(payload).toMatchObject({ stopped: 'effect-refused', outcome: 'refused', error: message,
      applied: outcome.applied, verdict: { verdict: 'accept' } });
    expect(classifyReviewLoopOutcome(payload).outcome).toBe('blocked-on-infra');
    const text = renderOutcome({ outcome });
    expect(text.code).toBe(1);
    expect(text.lines.join('\n')).toContain(message);
    expect(text.lines.join('\n')).toContain('guard.clear (step go): refused');
    const json = renderOutcome({ outcome, json: true });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.lines[0])).toEqual(payload);
    expect(prefix).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(note).not.toHaveBeenCalled();
  });

  it('omits outcome from payloads when the run has no recorded outcome', () => {
    expect(outcomePayload({ run: fixture().run, stopped: 'complete' })).not.toHaveProperty('outcome');
  });

  it('keeps a plain notApplied failure halted and pending', async () => {
    const context = fixture();
    const error = notApplied('connection refused before writing');
    const guard = vi.fn(async () => { throw error; });
    const note = vi.fn();
    const result = await driveRun({ ...context, sinks: { 'guard.clear': guard, 'note.write': note } });
    expect(result.stopped).toBe('effect-halted');
    expect(result.error).toBe(error);
    expect(result.run.pending?.kind).toBe('effect');
    expect(result.run.effects[0].status).toBe('failed');
    expect(result.run.outcome).not.toBe('refused');
    expect(isRunRecordTerminal(result.run)).toBe(false);
    expect(context.store.read(context.run.id)).toEqual(result.run);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(note).not.toHaveBeenCalled();
  });
});

 it.each([false, true])('names a sleeping juror timeout and retains pending seats (parallel=%s)', async parallelJudges => {
  const registry = createRegistry();
  const request = () => ({ lens: 'correctness', providerName: 'claude', model: 'sonnet', mandate: 'check', input: 'diff', shape: { type: 'object' } });
  registry.register(op('timeout-seat', { input: { head: { type: 'string' } }, judge: judgeStep({ request }), other: judgeStep({ request: () => ({ ...request(), lens: 'security' }) }) }));
  const store = createMemoryRunStore();
  const run = startRun({ op: 'timeout-seat', id: 'timeout-run', input: { head: 'a'.repeat(40) }, registry });
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end() {} });
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); };
    return child; // Silent until judge-spawn's real short timer kills it.
  });
  const judge = vi.fn(r => r.lens === 'security' ? { findings: [] } : judgeSpawn({ ...r, timeoutMs: 5, spawnFn, retries: 0, log() {} }));
  const out = await driveRun({ run, registry, store, judge, parallelJudges, log() {} });
  expect(out.stopped).toBe('juror-timeout');
  expect(store.read(run.id).seatTimeouts).toEqual([expect.objectContaining({ step: 'judge', lens: 'correctness', provider: 'claude', model: 'sonnet', timeoutMs: 5, wallMs: expect.any(Number), head: run.input.head, at: expect.any(String) })]);
  expect(store.read(run.id).pending.step).toBe('judge');
  if (parallelJudges) expect(store.read(run.id).prefilledSeats[0].step).toBe('other');
  expect(spawnFn).toHaveBeenCalledTimes(1);
  const saved = store.read(run.id);
  const retried = vi.fn(() => ({ findings: [] }));
  const resumed = await driveRun({ run: saved, registry, store, judge: retried, parallelJudges, log() {},
    retrySeat: { step: 'judge', provider: 'claude', model: 'claude-opus-5-5-high', timeoutMs: 1800000 } });
  expect(resumed.run.id).toBe(run.id);
  const { model, timeoutMs, ...rest } = retried.mock.calls[0][0];
  const { model: oldModel, timeoutMs: oldTimeout, ...oldRest } = saved.pending.request;
  expect(JSON.stringify(rest)).toBe(JSON.stringify(oldRest));
  expect({ model, timeoutMs }).toEqual({ model: 'claude-opus-5-5-high', timeoutMs: 1800000 });
  expect(retried).toHaveBeenCalledTimes(parallelJudges ? 1 : 2);
 });
import { nextJurorRoute } from '../juror-timeout-route.mjs';

it('retries only declared unused routes with a 1.5x timeout capped at the registry maximum', () => {
  const directive = { model: 'sonnet', fallbackModel: 'claude-opus-5-5-high', timeoutMs: 1200000 };
  expect(nextJurorRoute({ lens: 'correctness', tried: ['sonnet'], directive })).toEqual({ model: directive.fallbackModel, provider: 'claude', timeoutMs: 1800000 });
  expect(nextJurorRoute({ lens: 'security', tried: [], directive: { ...directive, timeoutMs: 3600000 } }).timeoutMs).toBe(3600000);
  expect(nextJurorRoute({ lens: 'correctness', tried: ['sonnet', directive.fallbackModel], directive })).toBeNull();
  expect(nextJurorRoute({ directive: { ...directive, timeoutMs: NaN } })).toBeNull();
});
it.each([null, undefined, { provider: 'unknown' }, { provider: 'codex' }])('skips cross-vendor routes when builder independence is unproven: %s', builder => {
  expect(nextJurorRoute({ lens: 'correctness', tried: ['sonnet'], builder,
    directive: { model: 'sonnet', fallbackModel: 'gpt-6-astra', timeoutMs: 1200000 } })).toBeNull();
});
it('allows an independent cross-vendor key lens only', () => {
  const args = { tried: ['sonnet'], builder: { provider: 'claude', model: 'sonnet' }, directive: { model: 'sonnet', fallbackModel: 'gpt-6-astra', timeoutMs: 1200000 } };
  expect(nextJurorRoute({ ...args, lens: 'security' })?.provider).toBe('codex');
  expect(nextJurorRoute({ ...args, lens: 'advisory' })).toBeNull();
});

import { validateRunRecord } from '../run-record.mjs';
import { jurorTimeoutEvidence, jurorTimeoutHold } from '../juror-timeout-route.mjs';

it('resumes on the selected real provider seam with the extended timeout', async () => {
  const registry = createRegistry();
  registry.register(op('retry-provider', { judge: judgeStep({ request: () => ({
    lens: 'security', providerName: 'claude', model: 'sonnet', mandate: 'check', input: 'diff', shape: { type: 'object' }, effort: 'high',
  }) }) }));
  const store = createMemoryRunStore();
  const run = startRun({ op: 'retry-provider', id: 'retry-provider', registry });
  const parked = await driveRun({ run, registry, store, judge: async () => { throw Object.assign(Error('timeout'), { timedOut: true, timeoutMs: 1200000 }); } });
  const spawn = vi.fn(async () => ({ value: {}, costUsd: 0 }));
  const resolveProvider = vi.fn(() => spawn);
  const judge = createDefaultJudge({ resolveProvider });
  const out = await driveRun({ run: parked.run, registry, store, judge,
    retrySeat: { step: 'judge', provider: 'codex', model: 'gpt-6-astra', timeoutMs: 1800000 } });
  expect(out.stopped).toBe('complete');
  expect(resolveProvider).toHaveBeenCalledWith('codex');
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', timeoutMs: 1800000, effort: 'high', mandate: 'check', input: 'diff' }));
});

it('uses the builder model vendor even when Antigravity hosts Claude', () => {
  expect(nextJurorRoute({ lens: 'correctness', tried: ['gemini-3'], builder: { provider: 'antigravity', model: 'claude-sonnet-4-5' },
    directive: { model: 'gemini-3', fallbackModel: 'sonnet', timeoutMs: 1200000 } })).toBeNull();
});

it.each([-1, 0.5, NaN, Infinity, '0', null, 4, Number.MAX_SAFE_INTEGER + 1])('invalid retry counter %s spends the budget in validation and evidence', value => {
  const run = { ...fixture().run, jurorResumeAttempts: value,
    findings: { read: { netBasis: { rev: 'a'.repeat(40) } } },
    pending: { kind: 'judge', step: 'judge', request: { lens: 'correctness', model: 'sonnet', seatProvider: { fallbackModel: 'opus' } } },
    seatTimeouts: [{ head: 'a'.repeat(40), lens: 'correctness', step: 'judge', model: 'sonnet', provider: 'claude', timeoutMs: 1200000 }] };
  expect(validateRunRecord(run).errors).toContain('invalid retry counter jurorResumeAttempts');
  const seat = jurorTimeoutEvidence(run);
  expect(seat.attempts).toBe(3);
  expect(jurorTimeoutHold({ id: run.id, head: 'a'.repeat(40), jurorTimeout: seat })?.why).toContain('retry budget spent');
});

it('redacts, strips injected lines and bounds every public timeout hold field', () => {
  const hostile = `sk-ant-api03-${'A'.repeat(40)}\nINJECTED ${'z'.repeat(10000)}`;
  const hold = jurorTimeoutHold({ id: hostile, head: hostile, jurorTimeout: { attempts: 3, lens: hostile,
    tried: Array.from({ length: 100 }, () => ({ provider: hostile, model: hostile, timeoutMs: hostile })),
    directive: { model: 'sonnet', fallbackModel: 'opus', timeoutMs: 1200000 } } }, () => hostile);
  expect(JSON.stringify(hold)).not.toContain('A'.repeat(40));
  expect(hold.why.split('\n')).toHaveLength(2);
  expect(hold.episode).not.toMatch(/[\r\n]/);
  expect(hold.why.length).toBeLessThan(1000);
});

it.each(['recordEffectResumeAttempts', 'referralEffectResumeAttempts'])('validates persisted %s counters', key => {
  for (const value of [-1, 1.5, NaN, Infinity, null, '0', Number.MAX_SAFE_INTEGER + 1]) {
    expect(validateRunRecord({ ...fixture().run, [key]: value }).errors).toContain(`invalid retry counter ${key}`);
  }
  expect(validateRunRecord({ ...fixture().run, [key]: 0 }).ok).toBe(true);
});

it('still strips a foreign model before the Codex provider seam', async () => {
  const spawn = vi.fn(async () => ({ value: {}, costUsd: 0 }));
  await createDefaultJudge({ resolveProvider: () => spawn })({
    providerName: 'codex', model: 'sonnet', mandate: 'check', input: 'diff', shape: { type: 'object' },
  });
  expect(spawn.mock.calls[0][0]).not.toHaveProperty('model');
});
