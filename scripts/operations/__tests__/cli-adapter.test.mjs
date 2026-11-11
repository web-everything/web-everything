import { describe, expect, it, vi } from 'vitest';
import { driveRun, outcomePayload, renderOutcome } from '../cli-adapter.mjs';
import { classifyReviewLoopOutcome } from '../review-job.mjs';
import { advance, startRun } from '../engine.mjs';
import { notApplied } from '../effect-executor.mjs';
import { createRegistry, op } from '../registry.mjs';
import { createMemoryRunStore, isRunRecordTerminal } from '../run-store.mjs';
import { effect } from '../step-kinds.mjs';

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
