import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stampLiveness, createDispatchSinks, defaultListAgents, grantDispatchTrust, revokeDispatchTrust } from '../dispatch-lane-io.mjs';
import { DISPATCH_EFFECT, dispatchStillHolds } from '../dispatch-lane.mjs';
import { markWorkerEnv } from '../session-role.mjs';
import { stopSession, STOP_EXEC_OPTS } from '../dispatch-abort.mjs';
import { assertHandleNotLive } from '../wake.mjs';
import { SessionsUnknown } from '../../lib/claude-sessions.mjs';
import { cachedClaudeAgents } from '../../lib/claude-agents-cache.mjs';
import { defaultCountLiveInspections, watchStuckPrs } from '../../conveyor/stuck-pr-watch.mjs';
import { runSessionReaperPass } from '../../conveyor/session-reaper.mjs';
import { sessionStoreEvidenceOk, classifyReap } from '../../conveyor/lease-reaper.mjs';
import { classifyOrphan, planOrphanRelease } from '../../conveyor/orphan-claim-release.mjs';
import { lookupAwaitSession } from '../../conveyor/await-verify-pass.mjs';
import { runFixerStuckReclaimPass } from '../../conveyor/fixer-stuck-reclaim.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';
const row = { id: 'job-a', sessionId: UUID, storeKey: '/profile/a', name: 'inspect-123', kind: 'background', state: 'done' };
const duplicate = { ...row, storeKey: '/profile/b' };
const snapshots = {
  ok: { status: 'ok', rows: [row], problems: [] },
  unknown: { status: 'unknown', rows: [row], problems: ['/profile/b: unreadable'] },
  ambiguous: { status: 'ok', rows: [row, duplicate], problems: [] },
};
const map = { accounts: {}, daemons: {}, routing: { accountB: false } };
const fsPorts = { home: '/home/test', exists: () => true, realpath: path => path };
const reader = snapshot => () => {
  if (snapshot.status !== 'ok') throw new SessionsUnknown(snapshot);
  return snapshot.rows;
};

describe.each(Object.entries(snapshots))('S2b %s evidence', (kind, snapshot) => {
  it('stampLiveness retains positive partial evidence and never infers partial absence', () => {
    const result = stampLiveness({ runs: [{ handle: UUID }, { handle: 'missing' }] }, { listAgents: reader(snapshot) });
    expect(result.runs.map(r => r.live)).toEqual([true, kind === 'unknown' ? null : false]);
    expect(result.livenessSource).toBe(kind === 'unknown' ? 'partial' : 'claude-agents');
  });
  it('wake close-out refuses live, unknown and ambiguous ownership', () => {
    expect(() => assertHandleNotLive({ handle: UUID }, { listAgents: reader(snapshot) })).toThrow();
    if (kind === 'unknown') expect(() => assertHandleNotLive({ handle: 'missing' }, { listAgents: reader(snapshot) })).toThrow();
    else expect(() => assertHandleNotLive({ handle: 'missing' }, { listAgents: reader(snapshot) })).not.toThrow();
  });
  it('dispatch-abort refuses indeterminate ownership and stops the owning CLI job id', () => {
    const exec = vi.fn(() => 'stopped');
    const options = { handle: UUID, exec, map, ...fsPorts, storeKey: '/profile/a', list: () => snapshot };
    if (kind === 'ok') {
      expect(stopSession(options).stopped).toBe(true);
      expect(exec).toHaveBeenCalledWith('claude', ['stop', row.id], expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: row.storeKey }) }));
    } else {
      expect(() => stopSession(options)).toThrow(/ownership/);
      expect(exec).not.toHaveBeenCalled();
    }
  });
  it('inspection cap counts complete rows and fails closed on unknown stores', () => {
    expect(defaultCountLiveInspections({ listAgents: reader(snapshot) })).toBe(kind === 'unknown' ? Infinity : kind === 'ambiguous' ? 2 : 1);
  });
  it('session reaper deduplicates within stores and passes store identity into every stop', () => {
    const stop = vi.fn(() => ({ stopped: true }));
    const result = runSessionReaperPass({
      listAgents: reader({ ...snapshot, rows: [...snapshot.rows, row] }), stop, log: () => {},
      groundTruthFor: () => null, completionFor: () => null, hungFor: null, noOutcomeFor: null,
      chatSpawnGuardFor: null, authExpiredFor: null, idleFinishedFor: null, awaitingVerifyFor: null,
      pidDeadFor: null, backstopCompletion: false, reapedLedger: null,
    });
    expect(result.stopped).toBe(kind === 'ambiguous' ? 2 : 1);
    expect(stop.mock.calls.map(([o]) => o.storeKey)).toEqual(kind === 'ambiguous' ? ['/profile/a', '/profile/b'] : ['/profile/a']);
  });
  it('lease reaper refuses all release axes when store evidence is unknown or ambiguous', () => {
    const evidence = sessionStoreEvidenceOk({ sessionId: UUID }, snapshot);
    expect(evidence).toBe(kind === 'ok');
    expect(classifyReap({ session: 'inspect-123', acquiredAt: '2020-01-01' }, {
      nowMs: Date.now(), prState: 'merged', sessionGone: true, sessionEvidenceOk: evidence,
    }).reap).toBe(kind === 'ok');
  });
  it('orphan release refuses incomplete or ambiguous ownership even with no live row', () => {
    const sessions = Object.defineProperty([...snapshot.rows], 'aggregate', { value: snapshot });
    const decision = classifyOrphan({ id: '999', status: 'active', kind: 'story', sessionId: UUID, dateStarted: '2020-01-01' }, {
      nowMs: Date.now(), leases: [], openPrs: [], mergedPrs: [], sessions,
    });
    expect(decision.act).toBe(kind === 'ok');
  });
  it('await-verify lookup refuses ambiguous identities and missing incomplete evidence', () => {
    const listed = Object.defineProperty([...snapshot.rows], 'incomplete', { value: kind === 'unknown' ? [{ session: null, reason: 'unreadable store' }] : [] });
    if (kind === 'ambiguous') expect(() => lookupAwaitSession({ sessionId: UUID }, listed)).toThrow(/ambiguous/);
    else expect(lookupAwaitSession({ sessionId: UUID }, listed)).toEqual(row);
    if (kind === 'unknown') expect(() => lookupAwaitSession({ sessionId: 'missing' }, listed)).toThrow(/incomplete/);
  });
  it('fixer reclaim keeps the claim and acknowledgement when stop ownership is refused', async () => {
    const nowMs = Date.parse('2026-10-08T15:40:00Z');
    const event = { type: 'session-watchdog.fixer-stuck', key: 'test', repo: 'we', pr: 4453, claimKind: 'fixing', session: { ...row, name: 'ci-heal-4453' }, classification: 'stalled', headSha: 'old' };
    const endFix = vi.fn(), appendAck = vi.fn();
    const result = await runFixerStuckReclaimPass({
      env: { WE_FIXER_STUCK_RECLAIM: '1' }, nowMs, readEvents: () => [event], readAcked: () => new Set(),
      listClaims: () => [{ owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: UUID } }],
      awaitFor: () => ({ sessionId: UUID, who: 'ci-heal-4453', sha: 'pushed' }), prHeadFor: () => 'pushed',
      lastActivityMsFor: () => nowMs - 4 * 3600_000, stopSession: o => stopSession({ ...o, map, ...fsPorts, list: () => snapshot, exec: () => '' }),
      endFix, appendAck, clearAwait: () => true, releaseDispatch: () => {}, orphanPass: null,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    if (kind === 'ok') expect(endFix).toHaveBeenCalled();
    else { expect(endFix).not.toHaveBeenCalled(); expect(appendAck).not.toHaveBeenCalled(); }
  });
});

it.each(['ok', 'unknown', 'ambiguous'])('session-role launch separates listing state (%s) from account resolution', kind => {
  const launchMap = kind === 'unknown' ? null : kind === 'ambiguous' ? { ...map, routing: [] } : map;
  if (kind === 'ok') expect(markWorkerEnv({ KEEP: 'same' }, { map: launchMap })).toEqual({ KEEP: 'same', WE_CONVEYOR_WORKER: '1' });
  else expect(() => markWorkerEnv({}, { map: launchMap })).toThrow(/repair account configuration/);
});

it('a recorded resume store survives changed daemon routing and repeated worker env application', () => {
  const routed = { accounts: { a: { configDir: '/profile/a' }, b: { configDir: '/profile/b' } }, daemons: { 'com.we.build': 'a' }, routing: { accountB: false } };
  const env = { XPC_SERVICE_NAME: 'com.we.build', CLAUDE_CONFIG_DIR: '/profile/a', ANTHROPIC_API_KEY: 'old-account' };
  const selected = markWorkerEnv(env, { map: routed, storeKey: '/profile/b' });
  expect(selected).toEqual({ XPC_SERVICE_NAME: 'com.we.build', CLAUDE_CONFIG_DIR: '/profile/b', WE_CONVEYOR_WORKER: '1' });
  expect(markWorkerEnv(selected, { map: routed, storeKey: '/profile/b' })).toEqual(selected);
});

it('a launch credential refusal is notApplied before any process can start', () => {
  const routed = { accounts: { a: { service: 'test', account: 'test' } }, daemons: { 'com.we.build': 'a' } };
  let error;
  try { markWorkerEnv({ XPC_SERVICE_NAME: 'com.we.build' }, { map: routed, readKeychain: () => { throw new Error('private'); } }); }
  catch (caught) { error = caught; }
  expect(error).toMatchObject({ notApplied: true });
  expect(error.message).not.toContain('private');
});

it('OFF single-store stop matches the recorded main trace exactly, without listing', () => {
  const exec = vi.fn(() => 'stopped'), list = vi.fn();
  stopSession({ handle: 'job-a', exec, list, env: process.env, map, ...fsPorts });
  expect(exec.mock.calls).toEqual([['claude', ['stop', 'job-a'], STOP_EXEC_OPTS]]);
  expect(list).not.toHaveBeenCalled();
});

it('OFF single-store listing preserves main argv, child env and cache filename', () => {
  const dir = mkdtempSync(join(tmpdir(), 's2b-main-trace-'));
  try {
    const env = { HOME: '/home/test', PATH: '/bin', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '20000' };
    const exec = vi.fn(() => JSON.stringify([row]));
    defaultListAgents({ env, exec, map, ...fsPorts, dir });
    expect(exec.mock.calls).toEqual([['claude', ['agents', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      timeout: 15000, killSignal: 'SIGKILL', env,
    }]]);
    const key = createHash('sha1').update(JSON.stringify(['/bin', '/home/test', ''])).digest('hex').slice(0, 12);
    expect(readdirSync(dir)).toEqual([`agents-${key}.json`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('an enabled routing map uses owner resolution even when its store aliases the inherited store', () => {
  const key = '/home/test/.claude';
  const exec = vi.fn(() => 'stopped');
  const list = vi.fn(() => ({ ...snapshots.ok, rows: [{ ...row, storeKey: key }] }));
  stopSession({ handle: UUID, env: { HOME: '/home/test' }, exec, list, ...fsPorts,
    map: { accounts: { b: { configDir: key } }, daemons: { 'com.we.build': 'b' }, routing: { accountB: true } } });
  expect(list).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0][1]).toEqual(['stop', row.id]);
});

it.each(['stopped', 'absent', 'present', 'unknown'])('a supplied sole-store env resolves ownership and confirms a stop miss: %s', state => {
  const key = '/profile/selected';
  const selectedRow = { ...row, storeKey: key };
  const env = { HOME: '/home/test', CLAUDE_CONFIG_DIR: key, ANTHROPIC_API_KEY: 'inherited-secret' };
  const list = vi.fn(() => ({ status: 'ok', rows: [selectedRow], problems: [] }));
  const exec = vi.fn((_cmd, argv) => {
    if (argv[0] === 'stop') {
      if (state === 'stopped') return 'stopped';
      throw Object.assign(new Error('No job matching'), { stderr: 'No job matching' });
    }
    return state === 'unknown' ? '{}' : JSON.stringify(state === 'absent' ? [] : [selectedRow]);
  });
  const stop = () => stopSession({ handle: UUID, env, map, ...fsPorts, exec, list });
  if (state === 'present' || state === 'unknown') expect(stop).toThrow(/did not confirm absence/);
  else expect(stop().alreadyGone).toBe(state === 'absent');
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ env }));
  expect(exec.mock.calls[0][1]).toEqual(['stop', row.id]);
  for (const call of exec.mock.calls) {
    expect(call[2].env.CLAUDE_CONFIG_DIR).toBe(key);
    expect(call[2].env.ANTHROPIC_API_KEY).toBeUndefined();
  }
  if (state !== 'stopped') expect(exec.mock.calls[1][1]).toEqual(['agents', '--json', '--all']);
});

it.each(['absent', 'present', 'unknown'])('stop miss freshly re-lists only its owning store: %s', state => {
  const miss = Object.assign(new Error('No job matching'), { stderr: 'No job matching' });
  const exec = vi.fn((_cmd, argv) => {
    if (argv[0] === 'stop') throw miss;
    return state === 'unknown' ? '{}' : JSON.stringify(state === 'absent' ? [] : [row]);
  });
  const stop = () => stopSession({ handle: UUID, storeKey: row.storeKey, map, ...fsPorts, env: {}, exec, list: () => snapshots.ok });
  if (state === 'absent') expect(stop().alreadyGone).toBe(true);
  else expect(stop).toThrow(/did not confirm absence/);
  expect(exec.mock.calls[1][1]).toEqual(['agents', '--json', '--all']);
  expect(exec.mock.calls[1][2].env.CLAUDE_CONFIG_DIR).toBe(row.storeKey);
});

it('pre-launch account refusal is notApplied and happens before reserveLane', async () => {
  const reserveLane = vi.fn();
  const sinks = createDispatchSinks({ root: '/primary', reserveLane, resolveLaunchEnv: () => { throw new Error('account unknown'); } });
  await expect(sinks[DISPATCH_EFFECT]({})).rejects.toMatchObject({ notApplied: true });
  expect(reserveLane).not.toHaveBeenCalled();
});

it.each(['ok', 'unknown', 'ambiguous'])('listing cache validates and isolates store reads: %s', kind => {
  const dir = mkdtempSync(join(tmpdir(), 's2b-cache-'));
  try {
    const stdout = kind === 'unknown' ? '[{}]' : JSON.stringify(snapshots[kind].rows);
    const fetch = vi.fn(() => stdout);
    const options = { dir, fetch, storeKey: '/a', env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '20000' } };
    cachedClaudeAgents(options); cachedClaudeAgents(options);
    expect(fetch).toHaveBeenCalledTimes(kind === 'unknown' ? 2 : 1);
    cachedClaudeAgents({ ...options, storeKey: '/b' });
    cachedClaudeAgents({ ...options, fresh: true });
    expect(fetch).toHaveBeenCalledTimes(kind === 'unknown' ? 4 : 3);
    if (kind === 'unknown') expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('trust grant selects the launch file and revocation continues after an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 's2b-trust-'));
  try {
    const a = join(dir, 'a'), b = join(dir, 'b');
    writeFileSync(a, 'broken'); writeFileSync(b, JSON.stringify({ projects: { '/scratch': { hasTrustDialogAccepted: true } } }));
    const result = revokeDispatchTrust(['/scratch'], { stores: [
      { key: '/a', status: 'ok', env: { WE_DISPATCH_TRUST_PATH: a } },
      { key: '/b', status: 'ok', env: { WE_DISPATCH_TRUST_PATH: b } },
    ], env: {} });
    expect(result.revoked).toContain('/scratch');
    expect(JSON.parse(readFileSync(b, 'utf8')).projects['/scratch']).toBeUndefined();
    grantDispatchTrust('/scratch', { env: { WE_DISPATCH_TRUST_PATH: b }, scratchRoot: '/scratch' });
    expect(JSON.parse(readFileSync(b, 'utf8')).projects['/scratch'].hasTrustDialogAccepted).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('partial liveness keeps the dispatch on its clock backstop beyond the absence grace', () => {
  const result = stampLiveness({ runs: [{ handle: 'missing', startedAt: '2026-11-16T10:00:00Z', expectedBy: '2026-11-16T12:00:00Z' }] }, { listAgents: reader(snapshots.unknown) });
  expect(result.livenessSource).toBe('partial');
  expect(dispatchStillHolds(result.runs[0], '2026-11-16T11:00:00Z')).toBe(true);
});

it.each(['ok', 'unknown'])('ambiguous working ownership holds beyond the clock backstop: %s listing', status => {
  const snapshot = { status, rows: [row, duplicate].map(r => ({ ...r, state: 'working' })), problems: [] };
  const result = stampLiveness({ runs: [{
    handle: UUID, startedAt: '2026-11-15T10:00:00Z', expectedBy: '2026-11-15T12:00:00Z',
  }] }, { listAgents: reader(snapshot) });
  expect(dispatchStillHolds(result.runs[0], '2026-11-16T12:00:00Z')).toBe(true);
  expect(result.runs[0].live).toBe(true);
});

it.each(['recorded', 'global'])('a working owner in the %s store listing vetoes orphan release', source => {
  const owner = { ...row, name: 'conveyor-999', state: 'working' };
  const unrelated = { ...row, sessionId: '22222222-2222-4222-8222-222222222222', name: 'unrelated' };
  const storeSnapshotFor = vi.fn(() => ({ status: 'ok', rows: [source === 'recorded' ? owner : unrelated], problems: [] }));
  const sessions = Object.defineProperty([source === 'global' ? owner : unrelated], 'storeSnapshotFor', { value: storeSnapshotFor });
  const result = planOrphanRelease([{
    id: '999', stem: '999-test', status: 'active', kind: 'story', storeKey: row.storeKey,
    sessionId: UUID, scaffoldedBy: owner.name, dateStarted: '2020-01-01',
  }], { nowMs: Date.parse('2026-11-16'), leases: [], openPrs: [], mergedPrs: [], sessions });
  expect(storeSnapshotFor).toHaveBeenCalledWith(row.storeKey);
  expect(result).toEqual({ release: [], skip: [{ id: '999', reason: 'live-session' }] });
});

it.each(['absent', 'present', 'unknown', 'unreadable'])('an inherited single-store stop miss requires fresh confirmation: %s', state => {
  const list = vi.fn(); // The genuine single-store path needs no pre-stop listing.
  const exec = vi.fn((_cmd, argv) => {
    if (argv[0] === 'stop') throw Object.assign(new Error('No job matching'), { stderr: 'No job matching' });
    if (state === 'unreadable') throw new Error('store unreadable');
    return state === 'unknown' ? '{}' : JSON.stringify(state === 'absent' ? [] : [row]);
  });
  const stop = () => stopSession({ handle: UUID, env: process.env, map, ...fsPorts, exec, list });
  if (state === 'absent') expect(stop().alreadyGone).toBe(true);
  else expect(stop).toThrow(/did not confirm absence/);
  expect(list).not.toHaveBeenCalled();
  expect(exec.mock.calls.map(([, argv]) => argv)).toEqual([['stop', UUID], ['agents', '--json', '--all']]);
  expect(exec.mock.calls[1][2].env).toBe(process.env);
});

it.each(['partial-error', 'unknown-aggregate', 'unreadable', 'invalid'])('incomplete inspection evidence prevents dispatch this tick: %s', kind => {
  const listAgents = () => {
    if (kind === 'partial-error') throw new SessionsUnknown({ ...snapshots.unknown, rows: [] });
    if (kind === 'unknown-aggregate') return { ...snapshots.unknown, rows: [] };
    if (kind === 'unreadable') throw new Error('unreadable store');
    return {};
  };
  const dispatch = vi.fn(() => ({ sessionSlug: 'inspect-42', agentId: 'job-inspect' })), postComment = vi.fn();
  const result = watchStuckPrs({
    repo: 'web-everything/web-everything', now: Date.parse('2026-11-16T12:00:00Z'), maxConcurrent: 2,
    listPrs: () => [{ number: 42, headRefName: 'lane/42-x', headRefOid: 'deadbeef',
      labels: [{ name: 'review:changes' }], mergeable: 'MERGEABLE', isDraft: false, comments: [] }],
    listTimelineEvents: () => [{ createdAt: '2026-11-16T10:00:00Z', event: 'commented' }],
    readAgents: () => [], enrich: a => a,
    countLiveInspections: () => defaultCountLiveInspections({ listAgents }),
    dispatch, provider: { postComment },
  });
  expect(result.dispatchedCount).toBe(0);
  expect(result.results).toEqual([expect.objectContaining({ num: 42, deferredReason: 'concurrency-cap' })]);
  expect(dispatch).not.toHaveBeenCalled();
  expect(postComment).not.toHaveBeenCalled();
});
