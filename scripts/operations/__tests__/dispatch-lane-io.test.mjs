import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTickReader } from '../dispatch-lane-io.mjs';

describe('the tick reader handoff', () => {
  const at = '2026-10-06T12:00:00.000Z';
  const bookkeeping = { tick: 3, buildGuards: [] };
  const stdin = JSON.stringify({ bookkeeping });
  const tick = {
    decisions: { spawnBuilds: [{ num: '3037', lane: 8 }], statusLine: 'handed-off tick' },
    nextState: { tick: 4 },
  };
  const envelope = {
    at, bookkeepingHash: createHash('sha256').update(stdin).digest('hex'), tick,
  };
  function fixture(file = envelope, overrides = {}) {
    const runNode = vi.fn(() => JSON.stringify({ decisions: {}, nextState: { tick: 99 } }));
    const readText = vi.fn((path) => {
      if (path === '/tmp/bookkeeping.json') return JSON.stringify({ bookkeeping, config: { verbose: true } });
      if (path === '/tmp/tick.json') {
        if (file instanceof Error) throw file;
        return typeof file === 'string' ? file : JSON.stringify(file);
      }
      return 'dispatch brief';
    });
    const read = createTickReader({
      runNode, readText, now: () => new Date(at),
      loadItems: () => [{ num: '3037', slug: 'tick-handoff', scope: ['we:scripts/operations/'] }],
      listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
      recordLiveness: (value) => value, listAgents: () => [],
      checkAlreadyDone: () => ({ done: false, checked: true, pr: null }),
      checkBuildDelivery: () => null,
      readScorecards: () => [], readSizePolicy: () => ({}), readPromotions: () => [],
      readDeliveryAgentOverride: () => null,
      ...overrides,
    });
    return { runNode, readText, read: (options = {}) => read({
      num: '3037', bookkeepingFile: '/tmp/bookkeeping.json', tickFile: '/tmp/tick.json', ...options,
    }) };
  }

  it('uses a fresh tick file with the matching forwarded bookkeeping hash before the verbose rewrite', () => {
    const { read, runNode } = fixture();
    expect(read({ verbose: false })).toMatchObject({
      launch: tick.decisions.spawnBuilds[0], nextState: tick.nextState, statusLine: 'handed-off tick',
    });
    expect(runNode).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', { ...envelope, at: '2026-10-06T11:54:59.000Z' }],
    ['exactly five minutes old', { ...envelope, at: '2026-10-06T11:55:00.000Z' }],
    ['hash mismatch', { ...envelope, bookkeepingHash: 'wrong' }],
    ['future', { ...envelope, at: '2026-10-06T12:01:01.000Z' }],
    ['invalid timestamp', { ...envelope, at: 'invalid' }],
    ['unreadable', new Error('ENOENT')],
    ['malformed JSON', '{'],
    ['missing tick', { ...envelope, tick: undefined }],
    ['malformed tick', { ...envelope, tick: [] }],
  ])('falls back from a %s tick file', (_name, file) => {
    const { read, runNode } = fixture(file);
    expect(read().nextState).toEqual({ tick: 99 });
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(runNode.mock.calls[0][1].input).toBe(stdin);
  });

  it('checks the in-flight guard before reading a tick file', () => {
    const { read, readText, runNode } = fixture(envelope, {
      listInFlightDispatches: () => ({ runs: [{ status: 'in-flight', live: true }], unreadable: 0 }),
      recordLiveness: (value) => ({ ...value, runs: value.runs.map(r => ({ ...r, live: true })) }),
    });
    expect(read().launch).toBeNull();
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
    expect(runNode).not.toHaveBeenCalled();
  });

  it('accepts a Date.now-style clock for a tick file', () => {
    const { read, runNode } = fixture(envelope, { now: () => Date.parse(at) });
    expect(read().launch).toEqual(tick.decisions.spawnBuilds[0]);
    expect(runNode).not.toHaveBeenCalled();
  });

  it('ignores the tick file for whole-queue reads', () => {
    const { read, readText, runNode } = fixture();
    runNode.mockReturnValue(JSON.stringify({ decisions: {
      admission: { queue: [], held: [], planned: [] },
    } }));
    expect(read({ all: true })).toEqual([]);
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
  });
});
