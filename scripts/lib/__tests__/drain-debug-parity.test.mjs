import { describe, it, expect } from 'vitest';
import { createDrainDebugLog } from '../drain-debug-log.mjs';
import { createStepTimer, formatTimingsSummary } from '../pass-timings.mjs';
import { readFileSync } from 'node:fs';
import { fetchPrReadsCached, resolveRequiredCheck, classifyPr } from '../../merge-ai-prs.mjs';

describe('drain debug observational parity', () => {
  it('preserves synchronous gate results and throws before the next statement', () => {
    const value = {}, error = Error('read failed');
    for (const enabled of [false, true]) {
      const gate = createDrainDebugLog({ enabled }).gate({ num: 1 });
      expect(gate.read('sync', () => value)).toBe(value);
      expect(gate.read('undefined', () => undefined)).toBeUndefined();
      expect(() => gate.read('throw', () => { throw error; })).toThrow(error);
    }
  });
  it.each(['gate', 'gh'])('preserves %s promise identity and consumer microtask order on success and rejection', async kind => {
    for (const rejects of [false, true]) {
      const run = async enabled => {
        const log = createDrainDebugLog({ enabled });
        const wrap = fn => kind === 'gate' ? log.gate({}).read('read', fn) : log.wrapGh(fn)('gh');
        const events = [], value = {};
        const promise = rejects ? Promise.reject(value) : Promise.resolve(value);
        const result = wrap(() => promise);
        expect(result).toBe(promise);
        result.then(v => { expect(v).toBe(value); events.push('fulfilled'); }, e => { expect(e).toBe(value); events.push('rejected'); });
        queueMicrotask(() => events.push('queued'));
        try { await result; } catch (e) { expect(e).toBe(value); }
        events.push('awaited');
        return events;
      };
      expect(await run(true)).toEqual(await run(false));
    }
  });
  it.each(['gate', 'gh'])('returns the identical %s thenable and catches a rejected observer side branch', async kind => {
    const lines = [], log = createDrainDebugLog({ sink: line => lines.push(line), now: () => 5 });
    const thenable = { then(done) { done(); return Promise.reject(Error('observer branch')); } };
    const result = kind === 'gate' ? log.gate({}).read('thenable', () => thenable) : log.wrapGh(() => thenable)('gh');
    expect(result).toBe(thenable);
    log.listing();
    await new Promise(resolve => setImmediate(resolve));
    expect(lines).toHaveLength(1);
    if (kind === 'gh') expect(lines[0]).toContain('"ghCalls":1');
  });
  it('keeps timed cache reads, cascade/sync marks, total and summary independent of debug sink cost', async () => {
    const run = async enabled => {
      let t = 0;
      const debug = createDrainDebugLog({ enabled, now: () => t, sink: () => { t += 1000; } });
      const timer = createStepTimer(debug.timingNow), start = timer.mark();
      await timer.timeAsync('classifyGateReads', () => fetchPrReadsCached([{ number: 1 }], {
        cache: new Map(), debug, keyOf: p => p.number, shaOf: () => 'head',
        fetchOne: (_p, observed) => observed.read('commits', () => { t += 7; return {}; }),
      }));
      for (const label of ['mergeCascade', 'postMergeSync']) {
        const mark = timer.mark(), checkpoint = debug.checkpoint(label);
        t += 3; checkpoint('first'); t += 2; checkpoint('second');
        timer.add(label, timer.mark() - mark);
      }
      const timings = { ...timer.snapshot(), total: timer.mark() - start };
      return { timings, summary: formatTimingsSummary(timer.snapshot(), { total: timings.total }) };
    };
    const off = await run(false), on = await run(true);
    expect(on).toEqual(off);
    expect(on.timings).toEqual({ classifyGateReads: 7, mergeCascade: 5, postMergeSync: 5, total: 17 });
    // Pin the CLI wiring too: the JSON result and unconditional summary share this clock.
    const cli = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    expect(cli).toContain('sink: createDrainDebugSink()');
    expect(cli).toContain('createStepTimer(drainDebug.timingNow)');
    expect(cli).toContain('const __passStart = __t.mark()');
    expect(cli).toContain('const passTotalMs = __t.mark() - __passStart');
  });
  it('returns identical cache reads and classifications through miss/hit/changed/degraded/eviction paths', async () => {
    const run = async enabled => {
      const lines = [], cache = new Map(), calls = [];
      const debug = createDrainDebugLog({ enabled, sink: l => lines.push(l), now: () => 5 });
      const fetch = prs => fetchPrReadsCached(prs, { cache, debug, concurrency: 2,
        keyOf: p => String(p.number), shaOf: p => p.sha, isDegraded: v => v.degraded,
        fetchOne: async (p, observed) => observed.read('commits', () => {
          calls.push(p.number); return { degraded: p.degraded, commits: [] };
        }),
      });
      const a = { number: 1, sha: 'a' }, b = { number: 2, sha: 'b', degraded: true };
      const snapshots = [];
      for (const prs of [[a, b], [a, b], [{ ...a, sha: 'new' }], []]) snapshots.push([...await fetch(prs)]);
      const decisions = snapshots.flatMap(entries => entries.map(([num, read]) => classifyPr({ number: Number(num), body: 'fixture',
        commits: read.value.commits, baseRefName: 'main', statusCheckRollup: [], labels: [] }, { defaultBranch: 'main' })));
      return { snapshots, decisions, calls, cache: [...cache], lines };
    };
    const off = await run(false), on = await run(true);
    expect(off.lines).toEqual([]); expect(on.lines.length).toBeGreaterThan(0);
    expect({ ...on, lines: [] }).toEqual(off); expect(on.calls).toEqual([1, 2, 2, 1]);
  });
  it('preserves exact synchronous values, promise identities, errors, arguments and call counts', async () => {
    const value = {}, error = new Error('private');
    for (const enabled of [false, true]) {
      const log = createDrainDebugLog({ enabled, sink: () => { throw Error('sink'); } });
      const calls = [], receiver = { wrap: log.wrapGh(function (...args) { calls.push([this, args]); return value; }) };
      expect(receiver.wrap('gh', ['private'], { flag: true })).toBe(value);
      expect(calls).toEqual([[receiver, ['gh', ['private'], { flag: true }]]]);
      expect(() => log.wrapGh(() => { throw error; })('gh')).toThrow(error);
      const promise = Promise.resolve(value); expect(log.wrapGh(() => promise)('gh')).toBe(promise);
      const rejected = Promise.reject(error); expect(log.wrapGh(() => rejected)('gh')).toBe(rejected);
      await expect(rejected).rejects.toBe(error);
    }
  });
  it('preserves direct-check success, closed failure and skip paths with identical gh calls and decisions', async () => {
    for (const fails of [false, true]) {
      const run = async enabled => {
        const calls = [], notices = [], log = createDrainDebugLog({ enabled });
        const pr = { number: 3, headRefOid: 'abc', baseRefName: 'main', body: 'fixture', labels: [], statusCheckRollup: [] };
        const exec = log.wrapGh(async (...args) => { calls.push(args); if (fails) throw Error('read failed'); return { stdout: JSON.stringify([{ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }]) }; });
        const resolved = await resolveRequiredCheck(pr, { repo: 'owner/repo', exec, onDeferred: r => notices.push(r) });
        const decision = classifyPr(resolved, { defaultBranch: 'main' });
        const green = { ...pr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }] };
        const skipped = await resolveRequiredCheck(green, { exec });
        expect(skipped).toBe(green);
        return { resolved, decision, calls, notices };
      };
      expect(await run(true)).toEqual(await run(false));
    }
  });
});
