import { describe, expect, it, vi } from 'vitest';
import { driveRun } from '../cli-adapter.mjs';
import { advance, startRun } from '../engine.mjs';
import { notApplied } from '../effect-executor.mjs';
import { createRegistry, op } from '../registry.mjs';
import { createMemoryRunStore, isRunRecordTerminal } from '../run-store.mjs';
import { effect } from '../step-kinds.mjs';

function fixture() {
  const registry = createRegistry();
  registry.register(op('guard-refusal', {
    go: effect({ effects: () => [{ type: 'guard.clear' }, { type: 'note.write' }] }),
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
    expect(first.stopped).toBe('complete');
    expect(first.run.pending).toBeNull();
    expect(first.run.outcome).toBe('refused');
    expect(isRunRecordTerminal(first.run)).toBe(true);
    expect(context.store.read(context.run.id)).toEqual(first.run);
    expect(first.run.effects.map((entry) => entry.status)).toEqual(['refused', 'declared']);

    const second = await driveRun({ ...context, run: context.store.read(context.run.id), sinks });
    expect(second.stopped).toBe('complete');
    expect(second.run).toEqual(first.run);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(note).not.toHaveBeenCalled();
  });

  it('settles a persisted pending refusal without retrying its sink', async () => {
    const context = fixture();
    const pending = advance(context.run, { registry: context.registry });
    const run = { ...pending, effects: pending.effects.map((entry, index) => index === 0
      ? { ...entry, status: 'refused', error: 'guard: SELF-CLEAR REFUSED — author cannot clear' }
      : entry) };
    context.store.write(run);
    const guard = vi.fn();
    const note = vi.fn();
    const result = await driveRun({ ...context, run, sinks: { 'guard.clear': guard, 'note.write': note } });
    expect(result.stopped).toBe('complete');
    expect(result.run).toMatchObject({ pending: null, outcome: 'refused' });
    expect(isRunRecordTerminal(result.run)).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
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
