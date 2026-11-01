import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createDrainDebugLog, createDrainDebugSink, resolveDrainDebugSetting } from '../drain-debug-log.mjs';

const decode = line => JSON.parse(line.slice(line.indexOf(' {') + 1));
describe('drain debug metadata', () => {
  it('defaults on and resolves standard/platform/tool/environment with provenance', () => {
    expect(resolveDrainDebugSetting()).toEqual({ enabled: true, source: 'standard' });
    expect(resolveDrainDebugSetting({ platform: { debugLog: false } })).toEqual({ enabled: false, source: 'platform' });
    expect(resolveDrainDebugSetting({ platform: { debugLog: false }, tool: { debugLog: true } })).toEqual({ enabled: true, source: 'tool' });
    for (const raw of ['0', 'false', 'FALSE']) expect(resolveDrainDebugSetting({ tool: { debugLog: true }, env: { WE_DRAIN_DEBUG: raw } })).toEqual({ enabled: false, source: 'env' });
    expect(resolveDrainDebugSetting({ tool: { debugLog: 'invalid' } }).enabled).toBe(true);
  });
  it('bounds oversized lines to 600 characters including newline, retaining valid single-line JSON', () => {
    const lines = [], log = createDrainDebugLog({ sink: l => lines.push(l) });
    log.emit('listing', { reads: Array.from({ length: 100 }, () => ({ label: 'read step '.repeat(20), ms: 5 })), repo: 'owner/repo' });
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(600);
    expect(lines[0].split('\n')).toHaveLength(2);
    expect(decode(lines[0]).truncated).toBe(true);
  });
  it('scrubs token-looking strings and control characters and excludes payloads/environment', () => {
    const lines = [], log = createDrainDebugLog({ sink: l => lines.push(l) });
    log.emit('decision', { num: 1, repo: 'owner/repo\n\u001b', reason: 'ghp_secretvalue', step: 'github_pat_secretvalue',
      label: 'a'.repeat(50), payload: 'private body', env: { TOKEN: 'private' }, token: 'private' });
    expect(lines[0]).not.toMatch(/secretvalue|private|aaaaa|\u001b/);
    expect(decode(lines[0])).toMatchObject({ num: 1, repo: 'owner/repo', reason: '[redacted]', step: '[redacted]' });
  });
  it('off emits nothing, reads no clock and returns the original gh wrapper', async () => {
    const sink = vi.fn(), now = vi.fn(), fn = vi.fn(() => 42);
    const log = createDrainDebugLog({ enabled: false, sink, now });
    expect(log.wrapGh(fn)).toBe(fn);
    expect(log.wrapGh(fn)('gh')).toBe(42);
    log.emit('decision', { num: 1 }); log.listing(); log.listingPage({ pages: 1 }); log.checkpoint('mergeCascade')('step');
    const gate = log.gate({ num: 1 }); expect(await gate.read('commits', () => 3)).toBe(3); gate.finish(true);
    expect(sink).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled(); expect(fn).toHaveBeenCalledTimes(1);
  });
  it('records top five gh calls, pages and cache counts without observing argv or results', async () => {
    let t = 0; const lines = [], log = createDrainDebugLog({ now: () => t, sink: l => lines.push(l) });
    for (let i = 1; i <= 7; i++) log.wrapGh(() => { t += i; return 'private payload'; }, 'page')('gh', ['private argv']);
    log.wrapGh(() => { t += 100; })('git');
    log.listingPage({ pages: 2, hydrated: 3, reused: 4 }); log.listing();
    expect(decode(lines[0])).toMatchObject({ ghCalls: 7, pages: 2, hits: 4, misses: 3, slowest: [7, 6, 5, 4, 3].map(ms => ({ label: 'page', ms })) });
    expect(lines[0]).not.toContain('private');
  });
  it('records per-read and total gate durations, slowest name and cache hits', async () => {
    let t = 0; const lines = [], log = createDrainDebugLog({ now: () => t, sink: l => lines.push(l) });
    const g = log.gate({ num: 2, repo: 'owner/repo' });
    await g.read('commits', () => { t += 12; }); await g.read('manifest', () => { t += 3; }); g.finish(false);
    expect(decode(lines[0])).toMatchObject({ totalMs: 15, cache: 'miss', slowest: 'commits', reads: [{ label: 'commits', ms: 12 }, { label: 'manifest', ms: 3 }] });
    log.gate({ num: 2 }).finish(true); expect(decode(lines[1])).toMatchObject({ cache: 'hit', reads: [] });
  });
  it('times cascade/sync checkpoints and tolerates failing sinks and clocks', () => {
    let t = 0; const lines = [], log = createDrainDebugLog({ now: () => t, sink: l => lines.push(l) });
    const mark = log.checkpoint('postMergeSync'); t = 20; mark('local-pull'); t = 25; mark('primary-sync');
    expect(lines.map(decode).map(x => x.ms)).toEqual([20, 5]);
    const broken = createDrainDebugLog({ sink: () => { throw Error('sink'); }, now: () => { throw Error('clock'); } });
    expect(broken.wrapGh(() => 9)('gh')).toBe(9); expect(() => broken.listing()).not.toThrow();
  });
  it('contains synchronous stderr write throws and asynchronous EPIPE without replacing existing handlers', async () => {
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    expect(() => createDrainDebugSink({ on() {}, write() { throw error; } })('line')).not.toThrow();
    const stream = new Writable({ write(_line, _encoding, callback) { queueMicrotask(() => callback(error)); } });
    const existing = vi.fn();
    stream.on('error', existing);
    const sink = createDrainDebugSink(stream);
    sink('first'); createDrainDebugSink(stream)('second');
    expect(stream.listenerCount('error')).toBe(2);
    await new Promise(resolve => setImmediate(resolve));
    expect(existing).toHaveBeenCalledExactlyOnceWith(error);
    expect(stream.listeners('error')).toContain(existing);

    // With no other handler, the actual asynchronous stream error is still contained.
    const unhandled = new Writable({ write(_line, _encoding, callback) { queueMicrotask(() => callback(error)); } });
    createDrainDebugSink(unhandled)('line');
    await new Promise(resolve => setImmediate(resolve));
    expect(unhandled.errored).toBe(error);
  });
  it('does not install stream handlers or write when diagnostics are disabled', () => {
    const stream = { on: vi.fn(), write: vi.fn() };
    createDrainDebugLog({ enabled: false, sink: createDrainDebugSink(stream) }).listing();
    expect(stream.on).not.toHaveBeenCalled(); expect(stream.write).not.toHaveBeenCalled();
  });
  it('excludes slow and throwing emit costs from its clock and subsequent checkpoints', () => {
    let t = 0;
    const lines = [], log = createDrainDebugLog({ now: () => t, sink: line => { lines.push(line); t += 100; throw Error('pipe'); } });
    const checkpoint = log.checkpoint('mergeCascade');
    t += 7; checkpoint('first'); t += 3; checkpoint('second');
    expect(lines.map(decode).map(row => row.ms)).toEqual([7, 3]);
    expect(log.timingNow()).toBe(10);
  });
});


describe('terminal decision emission', () => {
  const pr = { num: 17, repo: null };
  it.each([
    ['successful direct merge', { merged: [pr] }, 'merged', 'merged', null],
    ['successful enqueue', { enqueueOutcomes: [{ ...pr, outcome: 'enqueued' }] }, 'enqueued', 'enqueued', null],
    ['overlap yield', { deferred: [{ ...pr, overlapYield: { untilMs: 12345 } }], skipReasons: [{ ...pr, kind: 'overlap-yield' }] }, 'yielded', 'overlap-yield', 12345],
    ['classified skip', { skipReasons: [{ ...pr, kind: 'checks-pending' }] }, 'skipped', 'checks-pending', null],
    ['hold with expiry', { verdicts: [{ ...pr, holdUntilMs: 54321 }], skipReasons: [{ ...pr, kind: 'review-hold' }] }, 'skipped', 'review-hold', 54321],
    ['failed enqueue', { enqueueOutcomes: [{ ...pr, outcome: 'not-enqueued' }], skipReasons: [{ ...pr, kind: 'merge-failed' }] }, 'skipped', 'merge-failed', null],
    ['ready but not reached', {}, 'skipped', 'ready-not-reached', null],
    ['same number merged in another repo', { merged: [{ ...pr, repo: 'other/repo' }] }, 'skipped', 'ready-not-reached', null],
  ])('emits the correct decision for %s without mutating results', (_name, buckets, decision, reason, untilMs) => {
    const input = { verdicts: [pr], localSlug: 'owner/repo', ...buckets };
    const before = structuredClone(input), lines = [];
    createDrainDebugLog({ sink: line => lines.push(line) }).decisions(input);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[drain-debug\] decision /);
    expect(decode(lines[0])).toEqual({ num: 17, repo: 'owner/repo', decision, reason, untilMs });
    expect(input).toEqual(before);
    const off = createDrainDebugLog({ enabled: false, sink: line => lines.push(line) });
    off.decisions(input);
    expect(lines).toHaveLength(1);
    expect(input).toEqual(before);
  });
});
