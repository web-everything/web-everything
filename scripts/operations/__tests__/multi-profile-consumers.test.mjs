import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopSession } from '../dispatch-abort.mjs';
import { assertHandleNotLive } from '../wake.mjs';
import { stampLiveness, createDispatchSinks, grantDispatchTrust, revokeDispatchTrust } from '../dispatch-lane-io.mjs';
import { dispatchStillHolds, DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { SessionsUnknown } from '../../lib/claude-sessions.mjs';
import { markWorkerEnv } from '../session-role.mjs';
import { cachedClaudeAgents } from '../../lib/claude-agents-cache.mjs';
import { defaultCountLiveInspections } from '../../conveyor/stuck-pr-watch.mjs';
import { runSessionReaperPass } from '../../conveyor/session-reaper.mjs';
import { fetchSessionSignals, reapPlan, buildLeaseSignalsFor } from '../../conveyor/lease-reaper.mjs';
import { listSessions as orphanSessions, classifyOrphan } from '../../conveyor/orphan-claim-release.mjs';
import { defaultAwaitVerifyIo } from '../../conveyor/await-verify-pass.mjs';

const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
const row = { id: 'job-a', sessionId: sid, storeKey: '/stores/b', name: 'inspect-42', kind: 'background', state: 'done' };
const agg = (rows = [row], status = 'ok') => ({ status, rows, problems: status === 'ok' ? [] : ['store A unreadable; repair and retry'] });
const cases = [
  ['ok', agg()],
  ['unknown', agg([], 'unknown')],
  ['ambiguous', agg([row, { ...row, storeKey: '/stores/a' }])],
];
const listing = a => () => { if (a.status !== 'ok') throw new SessionsUnknown(a); return a.rows; };

describe('dispatch-abort ownership table', () => {
  it.each(cases)('%s: stops only a resolved owner', (name, a) => {
    const exec = vi.fn(() => 'stopped');
    const read = vi.fn(() => a);
    const run = () => stopSession({ handle: sid, exec, listSessions: read, env: { KEEP: '1' } });
    if (name === 'ok') {
      expect(run().alreadyGone).toBe(false);
      expect(exec).toHaveBeenCalledWith('claude', ['stop', 'job-a'], expect.objectContaining({ env: { KEEP: '1', CLAUDE_CONFIG_DIR: '/stores/b' } }));
    } else { expect(run).toThrow(name); expect(exec).not.toHaveBeenCalled(); }
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ fresh: true, all: true }));
  });
  it('absent is already gone without a stop', () => {
    const exec = vi.fn();
    expect(stopSession({ handle: sid, exec, listSessions: () => agg([]) }).alreadyGone).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([['absent', '[]', true], ['still listed', JSON.stringify([row]), false], ['invalid', '{}', false], ['unreadable', null, false]])(
    'stop miss re-lists only the owning store: %s', (_name, output, gone) => {
      const exec = vi.fn((_cmd, args, opts) => {
        expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/stores/b');
        if (args[0] === 'stop') throw Object.assign(new Error('miss'), { stderr: 'No job matching job-a' });
        expect(args).toEqual(['agents', '--json', '--all']);
        if (output === null) throw new Error('unreadable');
        return output;
      });
      const read = vi.fn(() => agg());
      const run = () => stopSession({ handle: sid, exec, listSessions: read });
      if (gone) expect(run().alreadyGone).toBe(true); else expect(run).toThrow(/stop missed/);
      expect(read).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(2);
    });
});

describe('wake ownership table', () => {
  it.each([...cases, ['absent', agg([])]])('%s: only absent permits close-out', (name, a) => {
    const run = () => assertHandleNotLive({ handle: sid }, { listAgents: listing(a) });
    if (name === 'absent') expect(run).not.toThrow(); else expect(run).toThrow();
  });
  it('a non-eight-character UUID prefix cannot slip through the close-out guard', () => {
    expect(() => assertHandleNotLive({ handle: 'aaaa' }, { listAgents: () => [row] })).toThrow();
  });
});

describe('dispatch liveness table', () => {
  it.each([...cases, ['absent', agg([])]])('%s: only complete evidence can stamp false', (name, a) => {
    const result = stampLiveness({ runs: [{ handle: sid }] }, { listAgents: listing(a) });
    expect(result.runs[0].live).toBe(name === 'unknown' ? null : name === 'absent' ? false : true);
    if (name === 'unknown') expect(result.livenessSource).toBe('partial');
  });
  it('partial preserves positive evidence and falls back to the clock for other handles', () => {
    const now = '2026-11-17T12:00:00Z';
    const result = stampLiveness({ runs: [
      { handle: sid }, { handle: 'bbbbbbbb', expectedBy: '2026-11-17T12:30:00Z' },
    ] }, { listAgents: listing(agg([row], 'unknown')) });
    expect(result.runs.map(r => r.live)).toEqual([true, null]);
    expect(result.livenessSource).toBe('partial');
    expect(dispatchStillHolds(result.runs[1], now)).toBe(true);
    expect(dispatchStillHolds(result.runs[1], '2026-11-19T12:00:00Z')).toBe(false);
  });
});

describe('inspection counting table', () => {
  it.each(cases)('%s: counts only deduplicated positive rows', (name, a) => {
    expect(defaultCountLiveInspections({ listAgents: listing(a) })).toBe(name === 'unknown' ? 0 : name === 'ambiguous' ? 2 : 1);
  });
  it('uses positive rows from ok stores even when discovery is partial', () => {
    expect(defaultCountLiveInspections({ listAgents: listing(agg([row, row], 'unknown')) })).toBe(1);
  });
});

describe('lease-reaper table', () => {
  it.each(cases)('%s: unknown and ambiguous evidence cannot release even expired leases', (name, a) => {
    const sig = fetchSessionSignals({}, { listAgents: listing(a), exec: () => '' });
    expect(sig.agents === null).toBe(name !== 'ok');
    const signalsFor = buildLeaseSignalsFor({ prStatesByRepo: new Map(), sessionStates: sig.states, sessionPidAlive: sig.pidAlive,
      sessionAgents: sig.agents, wrapperPids: new Map(), nowMs: Date.now() });
    const result = reapPlan([{ lease: { session: 'conveyor-42', acquiredAt: '2000-01-01T00:00:00Z' } }], { nowMs: Date.now(), signalsFor });
    if (name !== 'ok') { expect(result.reap).toEqual([]); expect(result.keep[0].reason).toMatch(/sessions-unknown/); }
  });
});

describe('orphan-claim-release table', () => {
  it.each(cases)('%s: only complete unambiguous discovery permits release', (name, a) => {
    const sessions = orphanSessions({ listAgents: listing(a) });
    const result = classifyOrphan({ id: '1', status: 'active', dateStarted: '2000-01-01', dateOpened: '2000-01-01' }, {
      nowMs: Date.now(), leases: [], openPrs: [], mergedPrs: [], sessions,
    });
    expect(result.act).toBe(name === 'ok');
  });
});

describe('session-reaper table', () => {
  it.each(cases)('%s: stops resolve ownership again and failures retain the candidate', (name, a) => {
    const exec = vi.fn(() => 'stopped');
    const result = runSessionReaperPass({ listAgents: listing(a),
      stop: ({ handle }) => stopSession({ handle, exec, listSessions: () => a }),
      groundTruthFor: null, completionFor: null, reapedLedger: null, backstopCompletion: false,
      hungFor: null, noOutcomeFor: null, chatSpawnGuardFor: null, authExpiredFor: null,
      idleFinishedFor: null, pidDeadFor: null, log: () => {},
    });
    expect(result.stopped).toBe(name === 'ok' ? 1 : 0);
    if (name !== 'ok') expect(exec).not.toHaveBeenCalled();
  });
  it('deduplicates candidates by store and UUID', () => {
    const stop = vi.fn(() => ({ stopped: true }));
    runSessionReaperPass({ listAgents: () => [row, row, { ...row, storeKey: '/stores/a' }], stop,
      groundTruthFor: null, completionFor: null, reapedLedger: null, backstopCompletion: false, log: () => {} });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('await-verify-pass stop-before-resume table', () => {
  it.each(cases)('%s: refuses unknown and ambiguous ownership before resume', async (name, a) => {
    const exec = vi.fn(() => 'stopped');
    const spawn = vi.fn(() => 'backgrounded');
    const io = await defaultAwaitVerifyIo({ exec, sleep: () => {}, pidAliveFn: () => false,
      stopSessionFn: o => stopSession({ ...o, listSessions: () => a }),
      dispatchIo: { defaultListAgents: listing(a), defaultSpawnAgent: spawn,
        buildAgentArgv: () => [], parseBackgroundedId: () => 'job-a', resumeSucceeded: () => ({ resumed: true }) },
    });
    const result = io.resume({ session: { ...row, state: 'working', status: 'idle', pid: 123, cwd: '/scratch' }, prompt: 'continue' });
    expect(result.resumed).toBe(name === 'ok');
    if (name !== 'ok') { expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); }
  });
});

describe('session-role launch table', () => {
  it.each([
    ['ok', { accounts: { b: { configDir: '/stores/b' } }, daemons: { 'com.we.build': 'b' }, routing: { accountB: true } }],
    ['unknown', null],
    ['ambiguous', { accounts: {}, daemons: { 'com.we.build': ['a', 'b'] } }],
  ])('%s: validates account selection before launch', (name, map) => {
    const run = () => markWorkerEnv({ XPC_SERVICE_NAME: 'com.we.build', HOME: '/fixture', ANTHROPIC_API_KEY: 'old' }, { map });
    if (name === 'ok') { expect(run().CLAUDE_CONFIG_DIR).toBe('/stores/b'); expect(run().ANTHROPIC_API_KEY).toBeUndefined(); }
    else expect(run).toThrow(expect.objectContaining({ notApplied: true }));
  });
  it('account refusal is notApplied before reserveLane', async () => {
    const reserveLane = vi.fn();
    const sinks = createDispatchSinks({ root: '/fixture/repo', spawnEnv: { CLAUDE_CONFIG_DIR: 'relative' }, reserveLane });
    await expect(sinks[DISPATCH_EFFECT]({})).rejects.toMatchObject({ notApplied: true });
    expect(reserveLane).not.toHaveBeenCalled();
  });
});

describe('listing cache table', () => {
  it.each([['ok', JSON.stringify([row]), 1], ['unknown', '{}', 2], ['ambiguous/invalid row', '[{}]', 2]])('%s: caches only valid store reads', (_name, output, calls) => {
    const dir = mkdtempSync(join(tmpdir(), 'multi-profile-cache-'));
    try {
      const fetch = vi.fn(() => output);
      const opts = { dir, fetch, storeKey: '/stores/b', env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '20000' } };
      cachedClaudeAgents(opts); cachedClaudeAgents(opts);
      expect(fetch).toHaveBeenCalledTimes(calls);
      cachedClaudeAgents({ ...opts, fresh: true });
      expect(fetch).toHaveBeenCalledTimes(calls + 1);
      cachedClaudeAgents({ ...opts, storeKey: '/stores/a' });
      cachedClaudeAgents({ ...opts, all: true });
      expect(fetch).toHaveBeenCalledTimes(calls + 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
