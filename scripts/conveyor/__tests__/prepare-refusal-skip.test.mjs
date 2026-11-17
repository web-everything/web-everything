import { describe, it, expect, vi, afterEach } from 'vitest';
import { planPrepareSpawns, planTick, PREPARE_REFUSAL_LIMIT, PREPARE_REFUSAL_WINDOW_MS } from '../tick-core.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const args = { needsPrepare: [{ num: '#099' }, { num: 100 }], availableLanes: [5], maxConcurrentItemPrepares: 1, now };
afterEach(() => vi.restoreAllMocks());

describe('prepare refusal skip', () => {
  it('exports the two-refusal, 24-hour bounds', () => {
    expect(PREPARE_REFUSAL_LIMIT).toBe(2);
    expect(PREPARE_REFUSAL_WINDOW_MS).toBe(86400000);
  });

  it('two recent refusals skip the normalized item without consuming a lane or slot', () => {
    const prepareRefusals = Object.freeze({ 99: Object.freeze([now - 1, now - 1000]) });
    const result = planPrepareSpawns({ ...args, prepareRefusals });
    expect(result.itemPrepareSpawns).toEqual([{ num: 100, lane: 5 }]);
    expect(result.consumedLanes).toEqual([5]);
    expect(result.newGuards).toHaveLength(1);
    expect(result.notes).toEqual([{ kind: 'prepare-refusal-skip', num: '#099', text: expect.any(String) }]);
  });

  it.each([
    ['one refusal', [now - 1]],
    ['stale refusals', [now - PREPARE_REFUSAL_WINDOW_MS - 1, now - PREPARE_REFUSAL_WINDOW_MS - 2]],
    ['one recent and one stale', [now - 1, now - PREPARE_REFUSAL_WINDOW_MS - 1]],
    ['future refusals', [now + 1, now + 2]],
  ])('%s does not skip the item', (_name, timestamps) => {
    const result = planPrepareSpawns({ ...args, prepareRefusals: { 99: timestamps } });
    expect(result.itemPrepareSpawns).toEqual([{ num: '#099', lane: 5 }]);
    expect(result.notes.some(note => note.kind === 'prepare-refusal-skip')).toBe(false);
  });

  it('counts refusals at the exact 24-hour boundary', () => {
    expect(planPrepareSpawns({ ...args, prepareRefusals: { 99: [now, now - PREPARE_REFUSAL_WINDOW_MS] } })
      .itemPrepareSpawns).toEqual([{ num: 100, lane: 5 }]);
  });

  it('omitted refusal map is identical to an empty map', () => {
    expect(planPrepareSpawns(args)).toEqual(planPrepareSpawns({ ...args, prepareRefusals: {} }));
  });

  it('uses Date.now when now is absent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const result = planPrepareSpawns({ ...args, now: undefined, prepareRefusals: { 99: [now - 1, now - 2] } });
    expect(result.itemPrepareSpawns).toEqual([{ num: 100, lane: 5 }]);
  });

  it('never changes in-flight guards or reports them as refusal skips', () => {
    const livePrepareGuards = Object.freeze([Object.freeze({ num: 99, kind: 'prepare-item', lane: 4 })]);
    const result = planPrepareSpawns({ ...args, livePrepareGuards, prepareRefusals: { 99: [now, now] } });
    expect(result.itemPrepareSpawns).toEqual([]);
    expect(result.newGuards).toEqual([]);
    expect(result.consumedLanes).toEqual([]);
    expect(result.notes.some(note => note.kind === 'prepare-refusal-skip')).toBe(false);
    expect(livePrepareGuards).toEqual([{ num: 99, kind: 'prepare-item', lane: 4 }]);
  });

  it('planTick keeps an in-flight prepare guard live despite two recent refusals', () => {
    const guard = Object.freeze({ num: 99, kind: 'prepare-item', lane: 4, spawnedTick: 0, sawPr: false, claimed: true });
    const prepareGuards = Object.freeze([guard]);
    const prepareRefusals = Object.freeze({ 99: Object.freeze([now - 1, now - 1000]) });

    const result = planTick({
      state: {},
      plan: { held: [{ num: '#099', reason: 'needs-prepare' }] },
      freeLanes: [5],
      bookkeeping: { tick: 1, prepareGuards, prepareRefusals },
      now,
    });

    expect(result.nextState.prepareGuards).toEqual([guard]);
    expect(result.nextState.prepareGuards[0]).toBe(guard);
    expect(result.decisions.retireGuards.prepare).toEqual([]);
    expect(result.decisions.spawnPrepareItems).toEqual([]);
    expect(result.decisions.notes.some(note => note.kind === 'prepare-refusal-skip')).toBe(false);
  });

  it('passes bookkeeping.prepareRefusals through planTick without modifying it', () => {
    const prepareRefusals = Object.freeze({ 99: Object.freeze([now - 1, now - 2]) });
    const input = { state: {}, plan: { held: [{ num: 99, reason: 'needs-prepare' }] }, freeLanes: [5], now };
    expect(planTick(input).decisions.spawnPrepareItems).toEqual([{ num: 99, lane: 5 }]);
    const result = planTick({ ...input, bookkeeping: { prepareRefusals } });
    expect(result.decisions.spawnPrepareItems).toEqual([]);
    expect(result.decisions.notes).toContainEqual({ kind: 'prepare-refusal-skip', num: 99, text: expect.any(String) });
  });
});
