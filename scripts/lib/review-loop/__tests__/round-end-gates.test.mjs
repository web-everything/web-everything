import { it, expect, vi } from 'vitest';
import { roundEndRefusal, applyIntakeEffects, applyIntakeEffectsSync } from '../round-end-gates.mjs';
const readIntake = () => ({ verdict: 'fail', reason: 'split-required', lines: 585 });
it('on refuses split and unreadable evidence; off never reads; shadow only observes', () => {
  expect(roundEndRefusal({ pr: {}, attempts: 1, readIntake, enforce: 'on' }).kind).toBe('split-required');
  expect(roundEndRefusal({ pr: {}, attempts: 1, enforce: 'on', readIntake: () => { throw Error('read'); } }).kind).toBe('intake-unmeasurable');
  expect(roundEndRefusal({ enforce: 'off', readIntake: () => { throw Error('must not read'); } })).toBeNull();
  expect(roundEndRefusal({ pr: {}, attempts: 1, readIntake, enforce: 'shadow' })).toMatchObject({ shadow: true, kind: 'split-required' });
});
it('card must succeed before event; failure retries and shadow never files', async () => {
  const events = [], card = vi.fn(async () => ({ cardPublished: true }));
  const note = { kind: 'intake-effect', intake: { kind: 'split-required', lines: 585 }, pr: { number: 7181 } };
  await applyIntakeEffects({ notes: [note] }, { runSize: card, appendEvent: async e => events.push(e) });
  expect(card).toHaveBeenCalledTimes(1); expect(events[0].kind).toBe('intake-split-required');
  await expect(applyIntakeEffects({ notes: [note] }, { runSize: async () => ({ body: '' }), appendEvent: async e => events.push(e) })).rejects.toThrow();
  expect(events).toHaveLength(1);
  await applyIntakeEffects({ notes: [{ ...note, intake: { ...note.intake, shadow: true } }] }, { runSize: card, appendEvent: async e => events.push(e) });
  expect(card).toHaveBeenCalledTimes(1);
});

it('moved head refuses effects before card and after card without appending event', async () => {
  const note = { kind: 'intake-effect', intake: { kind: 'split-required' }, pr: { number: 1, headRefOid: 'a'.repeat(40) } };
  const card = vi.fn(async () => ({ cardPublished: true })), event = vi.fn();
  await expect(applyIntakeEffects({ notes: [note] }, { runSize: card, appendEvent: event, readHead: () => 'b'.repeat(40) })).rejects.toThrow('stale size request');
  expect(card).not.toHaveBeenCalled();
  let reads = 0;
  await expect(applyIntakeEffects({ notes: [note] }, { runSize: card, appendEvent: event, readHead: () => ++reads === 1 ? note.pr.headRefOid : 'b'.repeat(40) })).rejects.toThrow('stale size request');
  expect(event).not.toHaveBeenCalled();
});

it('synchronous shell awaits bounded effects and performs no subprocess for an empty plan', () => {
  const exec = vi.fn();
  applyIntakeEffectsSync({ notes: [] }, exec); expect(exec).not.toHaveBeenCalled();
  applyIntakeEffectsSync({ notes: [{ kind: 'intake-effect', intake: { shadow: true } }] }, exec);
  expect(exec.mock.calls[0][2]).toMatchObject({ timeout: 120000, maxBuffer: 1024 * 1024 });
});
it('used override emits its ruling and never files a split card', async () => {
  const runSize = vi.fn(), appendEvent = vi.fn();
  await applyIntakeEffects({ notes: [{ kind: 'intake-effect', pr: { number: 1, headRefOid: 'a'.repeat(40) }, intake: { kind: 'intake-override', overrideUsed: 'R1099', lines: 585 } }] }, { runSize, appendEvent });
  expect(runSize).not.toHaveBeenCalled();
  expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intake-override', pr: 1, detail: expect.objectContaining({ ruling: 'R1099', lines: 585 }) }));
});

it('oversized effect batches ask an operator without starting a child', () => {
  const exec = vi.fn();
  expect(() => applyIntakeEffectsSync({ notes: Array.from({ length: 33 }, () => ({ kind: 'intake-effect' })) }, exec)).toThrow('operator');
  expect(exec).not.toHaveBeenCalled();
});
