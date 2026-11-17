import { describe, it, expect, vi, afterEach } from 'vitest';
import { planPrepareSpawns, planTick, PREPARE_REFUSAL_LIMIT, PREPARE_REFUSAL_WINDOW_MS } from '../tick-core.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const args = { needsPrepare: [{ num: '#099' }, { num: 100 }], availableLanes: [5], maxConcurrentItemPrepares: 1, now };
afterEach(() => vi.restoreAllMocks());

describe('prepare refusal skip', () => {
  it('preserves recent refusals across successive ticks and drops expired or invalid entries', () => {
    const input = { state: {}, plan: { held: [{ num: '#099', reason: 'needs-prepare' }] }, freeLanes: [5], now };
    const prepareRefusals = Object.freeze({
      99: Object.freeze([now - 1, now - 2, now - PREPARE_REFUSAL_WINDOW_MS - 1, now + 1, 'bad']),
      100: Object.freeze([now - PREPARE_REFUSAL_WINDOW_MS - 1]),
      101: null,
      102: Object.freeze([now - PREPARE_REFUSAL_WINDOW_MS]),
    });
    const first = planTick({ ...input, bookkeeping: { prepareRefusals } });
    expect(first.decisions.spawnPrepareItems).toEqual([]);
    const second = planTick({ ...input, now: now + 1000, bookkeeping: first.nextState });
    expect(second.decisions.spawnPrepareItems).toEqual([]);
    expect(first.nextState.prepareRefusals).toEqual({ 99: [now - 1, now - 2], 102: [now - PREPARE_REFUSAL_WINDOW_MS] });
    expect(second.nextState.prepareRefusals).toEqual({ 99: [now - 1, now - 2] });
    const expired = planTick({ ...input, now: now + PREPARE_REFUSAL_WINDOW_MS, bookkeeping: second.nextState });
    expect(expired.nextState.prepareRefusals).toEqual({});
    expect(expired.decisions.spawnPrepareItems).toEqual([{ num: '#099', lane: 5 }]);
  });

  it.each(['needs-prepare', 'prepare-stale', 'no-size'])('refused %s cards do not occupy a one-card prepare window', reason => {
    const result = planTick({
      state: { queue: [{ num: '#099', buildPriority: 0 }, { num: 100 }] },
      plan: { held: [{ num: '#099', reason }, { num: 100, reason: 'needs-prepare' }] },
      freeLanes: [5], now,
      config: { prepareAheadWindow: 1, prepareAutoSize: true },
      bookkeeping: { prepareRefusals: { 99: [now - 1, now - 2] } },
    });
    expect(result.decisions.spawnPrepareItems).toEqual([{ num: 100, lane: 5 }]);
    expect(result.decisions.notes.filter(note => note.kind === 'prepare-refusal-skip'))
      .toEqual([{ kind: 'prepare-refusal-skip', num: '#099', text: expect.any(String) }]);
    expect(result.decisions.notes.some(note => note.kind === 'prepare-ahead-window' && note.num === '#099')).toBe(false);
  });

  it('exports the two-refusal, 24-hour bounds', () => {
    expect(PREPARE_REFUSAL_LIMIT).toBe(2);
    expect(PREPARE_REFUSAL_WINDOW_MS).toBe(86400000);
  });

  it.each(['guard', 'open PR'])('keeps in-flight %s cards in the prepare window without refusal notes', kind => {
    const guard = { num: 99, kind: 'prepare-item', lane: 4, spawnedTick: 1, sawPr: false, claimed: true };
    const result = planTick({
      state: { queue: [{ num: 99 }, { num: 100 }], prs: kind === 'open PR' ? [{ num: 99, pr: 7000, state: 'OPEN' }] : [] },
      plan: { held: [{ num: 99, reason: 'needs-prepare' }, { num: 100, reason: 'needs-prepare' }] },
      freeLanes: [5], now, config: { prepareAheadWindow: 1 },
      bookkeeping: { tick: 1, prepareRefusals: { 99: [now - 1, now - 2] }, prepareGuards: kind === 'guard' ? [guard] : [] },
    });
    expect(result.decisions.spawnPrepareItems).toEqual([]);
    expect(result.decisions.notes.some(note => note.kind === 'prepare-refusal-skip')).toBe(false);
    if (kind === 'guard') expect(result.nextState.prepareGuards).toEqual([guard]);
  });

  it('a retired guard no longer exempts a refused card from the window filter', () => {
    const result = planTick({
      state: { queue: [{ num: 99 }, { num: 100 }] },
      plan: { held: [{ num: 99, reason: 'needs-prepare' }, { num: 100, reason: 'needs-prepare' }] },
      freeLanes: [5], now, config: { prepareAheadWindow: 1, prepareItemTtlTicks: 1 },
      bookkeeping: { tick: 2, prepareRefusals: { 99: [now - 1, now - 2] },
        prepareGuards: [{ num: 99, kind: 'prepare-item', lane: 4, spawnedTick: 0, sawPr: false, claimed: true }] },
    });
    expect(result.decisions.retireGuards.prepare).toContainEqual(expect.objectContaining({ num: 99, reason: 'ttl' }));
    expect(result.decisions.spawnPrepareItems).toEqual([{ num: 100, lane: 5 }]);
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
