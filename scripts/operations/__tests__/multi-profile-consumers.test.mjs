import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopSession } from '../dispatch-abort.mjs';
import { assertHandleNotLive } from '../wake.mjs';
import { stampLiveness, createDispatchSinks, grantDispatchTrust, revokeDispatchTrust, resumeSucceeded, defaultSpawnAgent } from '../dispatch-lane-io.mjs';
import { dispatchStillHolds, DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { SessionsUnknown } from '../../lib/claude-sessions.mjs';
import { markWorkerEnv } from '../session-role.mjs';
import * as claudeAccount from '../../lib/claude-account.mjs';
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
  it('partial preserves positive evidence and holds unseen handles beyond the deadline until complete absence', () => {
    const now = '2026-11-17T12:00:00Z';
    const result = stampLiveness({ runs: [
      { handle: sid }, { handle: 'bbbbbbbb', startedAt: '2026-11-17T11:00:00Z', expectedBy: '2026-11-17T12:30:00Z' },
    ] }, { listAgents: listing(agg([row], 'unknown')) });
    expect(result.runs.map(r => r.live)).toEqual([true, null]);
    expect(result.livenessSource).toBe('partial');
    expect(dispatchStillHolds(result.runs[1], now)).toBe(true);
    expect(result.runs[1].livenessSource).toBe('partial');
    expect(dispatchStillHolds(result.runs[1], '2026-11-19T12:00:00Z')).toBe(true);
    const absent = stampLiveness({ runs: result.runs }, { listAgents: () => [] });
    expect(absent.runs[1].live).toBe(false);
    expect(absent.runs[1].livenessSource).toBe('claude-agents');
    expect(dispatchStillHolds(absent.runs[1], '2026-11-19T12:00:00Z')).toBe(false);
  });
  it.each(['unreadable', 'unknown', 'claude-agents'])('%s null liveness retains its clock fallback', source => {
    const entry = { live: null, livenessSource: source, expectedBy: '2026-11-17T12:30:00Z' };
    expect(dispatchStillHolds(entry, '2026-11-17T12:00:00Z')).toBe(true);
    expect(dispatchStillHolds(entry, '2026-11-19T12:00:00Z')).toBe(false);
  });

});

describe('inspection counting table', () => {
  it.each(cases)('%s: counts only deduplicated positive rows', (name, a) => {
    const count = () => defaultCountLiveInspections({ listAgents: listing(a) });
    if (name === 'ok') expect(count()).toBe(1); else expect(count).toThrow();
  });
  it('refuses partial discovery even with positive rows from ok stores', () => {
    expect(() => defaultCountLiveInspections({ listAgents: listing(agg([row, row], 'unknown')) })).toThrow(/unknown/);
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
    runSessionReaperPass({ listAgents: () => [row, row, { ...row, storeKey: '/stores/a', sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' }], stop,
      groundTruthFor: null, completionFor: null, reapedLedger: null, backstopCompletion: false, log: () => {} });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('await-verify-pass stop-before-resume table', () => {
  it.each([
    ['same-store', '/stores/a'],
    ['cross-store', '/stores/b'],
  ])('%s resume retains owner A through worker marking when the launch label selects B', async (_name, inheritedStore) => {
    const map = { accounts: { a: { configDir: '/stores/a' }, b: { configDir: '/stores/b' } },
      daemons: { 'com.we.build': 'b' }, routing: { accountB: true } };
    const mapSpy = vi.spyOn(claudeAccount, 'loadAccountMap').mockReturnValue(map);
    try {
      const env = { CLAUDE_CONFIG_DIR: inheritedStore, XPC_SERVICE_NAME: 'com.we.build',
        ANTHROPIC_API_KEY: 'inherited', KEEP: '1' };
      // Establish the conflicting default: launch-account selection would switch this env to B.
      expect(markWorkerEnv(env).CLAUDE_CONFIG_DIR).toBe('/stores/b');
      const session = { ...row, storeKey: '/stores/a', cwd: '/scratch' };
      const exec = vi.fn(() => 'backgrounded');
      const io = await defaultAwaitVerifyIo({ env, realpath: path => path,
        dispatchIo: { defaultListAgents: () => [session],
          defaultSpawnAgent: (argv, opts) => defaultSpawnAgent(argv, opts, { exec }),
          buildAgentArgv: ({ resumeSessionId }) => ['--bg', '--resume', resumeSessionId, 'continue'],
          parseBackgroundedId: () => 'job-a', resumeSucceeded },
      });
      expect(io.resume({ session, prompt: 'continue' }).resumed).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith('claude', ['--bg', '--resume', sid, 'continue'],
        expect.objectContaining({ env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/stores/a', WE_CONVEYOR_WORKER: '1', KEEP: '1',
        }) }));
      expect(exec.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally { mapSpy.mockRestore(); }
  });
  it.each(cases.flatMap(([name, a]) => ['working', 'done'].map(state => [name, a, state])))('%s (%s): refuses unknown and ambiguous ownership before resume', async (name, a, state) => {
    const exec = vi.fn(() => 'stopped');
    const spawn = vi.fn(() => 'backgrounded');
    const io = await defaultAwaitVerifyIo({ exec, env: { KEEP: '1', CLAUDE_CONFIG_DIR: '/stores/a' }, sleep: () => {}, pidAliveFn: () => false,
      stopSessionFn: o => stopSession({ ...o, listSessions: () => a }),
      dispatchIo: { defaultListAgents: listing(a), defaultSpawnAgent: spawn,
        buildAgentArgv: () => [], parseBackgroundedId: () => 'job-a', resumeSucceeded: () => ({ resumed: true }) },
    });
    const result = io.resume({ session: { ...row, state, status: 'idle', pid: 123, cwd: '/scratch' }, prompt: 'continue' });
    expect(result.resumed).toBe(name === 'ok');
    if (name !== 'ok') { expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); }
    else expect(spawn).toHaveBeenCalledWith([], expect.objectContaining({ owningStore: '/stores/b',
      env: { KEEP: '1', CLAUDE_CONFIG_DIR: '/stores/b' } }));
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

describe('resume confirmation ownership table', () => {
  it.each([
    ['ok', agg(), '/stores/b', true],
    ['unknown', agg([row], 'unknown'), '/stores/b', false],
    ['ambiguous stores', agg([row, { ...row, storeKey: '/stores/a' }]), '/stores/b', false],
    ['ambiguous rows', agg([row, { ...row, sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' }]), '/stores/b', false],
    ['wrong launch store', agg(), '/stores/a', false],
    ['unknown store', agg([{ ...row, storeKey: undefined }]), null, false],
    ['absent', agg([]), '/stores/b', false],
  ])('%s: confirms only a unique match in the owning launch store', (_name, evidence, owningStore, expected) => {
    for (const rows of [evidence.rows, [...evidence.rows].reverse()]) {
      expect(resumeSucceeded({ printedId: 'job-a', requestedSessionId: sid,
        agentsAfter: { ...evidence, rows }, owningStore }).resumed).toBe(expected);
    }
  });
  it('derives ownership from a unique requested session when no launch store was recorded', () => {
    expect(resumeSucceeded({ printedId: 'job-a', requestedSessionId: sid, agentsAfter: [row] }).resumed).toBe(true);
  });
  it('resume spawn retains the owning profile through worker marking', () => {
    const exec = vi.fn(() => 'ok');
    const mapSpy = vi.spyOn(claudeAccount, 'loadAccountMap').mockReturnValue({
      accounts: { a: { configDir: '/stores/a' }, b: { configDir: '/stores/b' } },
      daemons: {}, routing: { accountB: true },
    });
    try {
      defaultSpawnAgent(['--bg', '--resume', sid, 'continue'], {
        env: { CLAUDE_CONFIG_DIR: '/stores/a', ANTHROPIC_API_KEY: 'inherited' }, owningStore: '/stores/b',
      }, { exec });
    } finally { mapSpy.mockRestore(); }
    expect(exec.mock.calls[0][2].env).toMatchObject({ CLAUDE_CONFIG_DIR: '/stores/b', WE_CONVEYOR_WORKER: '1' });
    expect(exec.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
