/**
 * @file scripts/conveyor/__tests__/fixer-resume-liveness.test.mjs
 * @description Replays of the three 2026-10-21 fixer-time losses, against the session-liveness rules in
 *   we:scripts/lib/fix-session-liveness.mjs:
 *   - #5729 (23:37Z) / #5492 (11:50Z): the await-verify resume read a `done` row with a LIVE pid as gone, skipped its
 *     stop, and the CLI started a copy each time -> forked-copy-stopped x3 -> resume-exhausted -> cold restart.
 *   - #5729 (11:15Z): the ROUND resume never stopped a live idle `done` session first, so it forked too.
 *   - #5758 (11:00Z): the claim sweep released the fixer's claim as settled while its process was still up, and the
 *     session ran on (a hung Bash call) until 11:44Z.
 *   Every replay also pins the kill switch: with the switch off, the old behaviour comes back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRowGone, isRowMidTurn, rowProcessAlive, samePrintedHandle, cliStartedCopy,
  resolveFixSessionPolicy, formatFixSessionPolicyLine, FIX_RESUME_STOPS_LIVE_IDLE_ENV, FIX_STOP_ON_CLAIM_RELEASE_ENV, FIX_CLAIM_LIVENESS_BY_PID_ENV,
} from '../../lib/fix-session-liveness.mjs';
import { defaultAwaitVerifyIo } from '../await-verify-pass.mjs';
import { resumeBgSession, FIXER_MID_TURN_REFUSALS } from '../reconcile-fix-dispatch.mjs';
import { planRoundResume } from '../fix-resume.mjs';
import { refreshLiveFixDispatchClaims, readFixDispatchClaim } from '../fix-dispatch-claim.mjs';
import { acquireFixClaim } from '../fix-procedure.mjs';
import { withFixDispatchClaimRefresh } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

// The live rows, as `claude agents --json --all` listed them (2026-10-21).
const SID_5729 = '6b08e7a7-cad4-4747-a793-90a3c882d59f';
const ROW_5729 = { id: '6b08e7a7', sessionId: SID_5729, kind: 'background', cwd: '/ops/dispatch/087633bd', name: 'fix-5729', state: 'done', status: 'idle', pid: 16844 };
const COPY_NOTE = (orig, copy) => `note: session ${orig} is already running in the background, so this started a copy as ${copy}. \`claude attach ${orig}\` opens the original.\nbackgrounded · ${copy}`;

describe('fix-session-liveness — what a listing row says about the process', () => {
  const alive = (pids) => (pid) => pids.has(pid);
  it('a done row with a live pid is NOT gone; without a pid, or with a dead one, it is', () => {
    expect(isRowGone(ROW_5729, alive(new Set([16844])))).toBe(false);
    expect(isRowGone(ROW_5729, alive(new Set()))).toBe(true);
    const { pid: _p, ...noPid } = ROW_5729;
    expect(isRowGone(noPid, () => { throw new Error('no pid to probe'); })).toBe(true);
    expect(isRowGone({ ...ROW_5729, state: 'working' }, alive(new Set()))).toBe(false);
  });
  it('status is the turn signal; a missing status is unknown (not mid-turn)', () => {
    expect(isRowMidTurn({ state: 'done', status: 'busy' })).toBe(true);
    expect(isRowMidTurn({ state: 'done', status: 'waiting' })).toBe(true);
    expect(isRowMidTurn({ state: 'done', status: 'idle' })).toBe(false);
    expect(isRowMidTurn({ state: 'working' })).toBe(false);
    expect(rowProcessAlive({ pid: 0 }, () => true)).toBe(false);
  });
  it('the printed SHORT handle matches its own session; a copy does not', () => {
    expect(samePrintedHandle('6b08e7a7', ROW_5729)).toBe(true);
    expect(samePrintedHandle('6b08e7a7', { sessionId: SID_5729 })).toBe(true);
    expect(samePrintedHandle('c94eeec8', ROW_5729)).toBe(false);
    expect(samePrintedHandle(null, ROW_5729)).toBe(false);
    expect(cliStartedCopy(COPY_NOTE('6b08e7a7', 'c94eeec8'))).toBe(true);
    expect(cliStartedCopy('backgrounded · 6b08e7a7')).toBe(false);
  });
  it('the three switches resolve through the cascade and name their source', () => {
    expect(resolveFixSessionPolicy({})).toMatchObject({ resumeStopsLiveIdle: true, stopOnClaimRelease: true, sources: { resumeStopsLiveIdle: 'standard', stopOnClaimRelease: 'standard' } });
    const p = resolveFixSessionPolicy({ tool: { stopOnClaimRelease: false }, env: { [FIX_RESUME_STOPS_LIVE_IDLE_ENV]: 'off', [FIX_STOP_ON_CLAIM_RELEASE_ENV]: 'maybe' } });
    expect(p).toMatchObject({ resumeStopsLiveIdle: false, stopOnClaimRelease: false, sources: { resumeStopsLiveIdle: 'env', stopOnClaimRelease: 'tool' } });
    expect(p.invalid).toEqual(['env.stopOnClaimRelease="maybe"']);
    expect(formatFixSessionPolicyLine(p)).toBe('fix-session-policy: resumeStopsLiveIdle=false (env), stopOnClaimRelease=false (tool), claimLivenessByPid=true (standard); ignored invalid env.stopOnClaimRelease="maybe"');
  });
});

/**
 * A fake CLI faithful to the live probe (2026-10-21 ~19:55 ET): `--resume` on a session whose process is up prints the
 * copy note and a NEW id; after `claude stop` (process gone) it wakes the SAME id under a new pid.
 */
function fakeCli({ row, copies = ['c94eeec8', '398bfc2e', 'f0d183d1'] }) {
  const state = { pids: new Set([row.pid]), rows: [{ ...row }], calls: [], copies: [...copies] };
  const find = () => state.rows.find((r) => r.sessionId === row.sessionId);
  state.pidAlive = (pid) => state.pids.has(pid);
  state.stop = ({ handle }) => {
    state.calls.push(['stop', handle]);
    const r = state.rows.find((x) => x.id === handle);
    if (r) { state.pids.delete(r.pid); delete r.pid; r.status = undefined; r.state = 'done'; }
    return { stopped: true };
  };
  state.spawn = () => {
    state.calls.push(['spawn']);
    const r = find();
    if (r && r.pid && state.pids.has(r.pid)) {
      const copy = state.copies.shift();
      state.rows.push({ id: copy, sessionId: `${copy}-0000-4000-8000-000000000000`, kind: 'background', state: 'working', status: 'busy', pid: 900 + state.rows.length });
      state.pids.add(900 + state.rows.length - 1);
      return COPY_NOTE(row.id, copy);
    }
    Object.assign(r, { pid: 28300, state: 'working', status: 'busy' }); state.pids.add(28300);
    return `backgrounded · ${row.id} · ${row.name}`;
  };
  state.list = () => state.rows.map((r) => ({ ...r }));
  return state;
}

async function awaitVerifyResumeIo(cli, env = {}) {
  const dispatch = await import('../../operations/dispatch-lane-io.mjs');
  return defaultAwaitVerifyIo({
    env, sleep: () => {}, pidAliveFn: cli.pidAlive, stopSessionFn: cli.stop,
    dispatchIo: {
      buildAgentArgv: ({ resumeSessionId }) => ['--bg', '--resume', resumeSessionId],
      defaultSpawnAgent: () => cli.spawn(),
      parseBackgroundedId: dispatch.parseBackgroundedId,
      resumeSucceeded: dispatch.resumeSucceeded,
      defaultListAgents: () => cli.list(),
    },
  });
}

describe('replay #5729 23:37Z — await-verify resume of a done row whose process is still up', () => {
  it('stops the idle process by its short id first, then resumes the SAME session (no copy, no exhaustion)', async () => {
    const cli = fakeCli({ row: ROW_5729 });
    const r = (await awaitVerifyResumeIo(cli)).resume({ session: { ...ROW_5729 }, prompt: '[harness verify verdict — #5137] GREEN' });
    expect(r).toEqual({ resumed: true, reason: null });
    expect(cli.calls).toEqual([['stop', '6b08e7a7'], ['spawn']]);
    expect(cli.rows.filter((x) => x.sessionId !== SID_5729)).toEqual([]); // no copy was ever started
  });
  it('kill switch off: the old state-only view comes back (copy started, stopped, forked-copy-stopped)', async () => {
    const cli = fakeCli({ row: ROW_5729 });
    const r = (await awaitVerifyResumeIo(cli, { [FIX_RESUME_STOPS_LIVE_IDLE_ENV]: 'off' })).resume({ session: { ...ROW_5729 }, prompt: 'p' });
    expect(r).toEqual({ resumed: false, reason: 'forked-copy-stopped' });
    expect(cli.calls).toEqual([['spawn'], ['stop', 'c94eeec8']]);
  });
});

describe('replay #5492 11:50Z — the listing showed no pid, but the CLI still said "started a copy"', () => {
  it('stops the copy, stops the original, and resumes it once more within the same attempt', async () => {
    const row = { ...ROW_5729, id: '40d1dea4', sessionId: '40d1dea4-07b0-44db-a3af-b83734d28c60', name: 'fix-5492', pid: 5492 };
    const cli = fakeCli({ row, copies: ['29166621'] }); // the process (pid 5492) is really up
    const { pid: _hidden, ...stale } = row; // but the pass's own (cached) row lacked the pid, so it read as gone
    const r = (await awaitVerifyResumeIo(cli)).resume({ session: { ...stale }, prompt: 'red verdict' });
    expect(r).toEqual({ resumed: true, reason: null });
    expect(cli.calls).toEqual([['spawn'], ['stop', '29166621'], ['stop', '40d1dea4'], ['spawn']]);
  });
});

describe('the copy-note retry never joins a copy that may still be running', () => {
  it('a copy listed busy with no pid (unknown liveness) is not followed by a second resume', async () => {
    const row = { ...ROW_5729, id: '40d1dea4', sessionId: '40d1dea4-07b0-44db-a3af-b83734d28c60', name: 'fix-5492', pid: 5492 };
    const cli = fakeCli({ row, copies: ['29166621'] });
    const stop = cli.stop;
    cli.stop = (a) => { const out = stop(a); const c = cli.rows.find((x) => x.id === a.handle); if (a.handle === '29166621' && c) Object.assign(c, { state: 'working', status: 'busy' }); return out; };
    const { pid: _hidden, ...stale } = row;
    const r = (await awaitVerifyResumeIo(cli)).resume({ session: { ...stale }, prompt: 'red verdict' });
    expect(r).toEqual({ resumed: false, reason: 'forked-copy-stopped' });
    expect(cli.calls.filter((c) => c[0] === 'spawn')).toHaveLength(1);
  });
  it('a copy whose stop failed is not followed by a second resume', async () => {
    const row = { ...ROW_5729, id: '40d1dea4', sessionId: '40d1dea4-07b0-44db-a3af-b83734d28c60', name: 'fix-5492', pid: 5492 };
    const cli = fakeCli({ row, copies: ['29166621'] });
    const stop = cli.stop;
    cli.stop = (a) => { if (a.handle === '29166621') { cli.calls.push(['stop', a.handle]); throw new Error('claude stop timed out'); } return stop(a); };
    const { pid: _hidden, ...stale } = row;
    const r = (await awaitVerifyResumeIo(cli)).resume({ session: { ...stale }, prompt: 'red verdict' });
    expect(r).toEqual({ resumed: false, reason: 'forked-copy-stopped' });
    expect(cli.calls).toEqual([['spawn'], ['stop', '29166621']]); // no stop of the original, no second spawn
  });
});

describe('the printed short handle is never mistaken for a fork', () => {
  it('an unconfirmed resume that printed the session\'s OWN short id stops nothing', async () => {
    const cli = fakeCli({ row: { ...ROW_5729, pid: undefined, state: 'stopped' } });
    cli.pids.clear();
    cli.list = () => []; // the listing lags: the resumed row is not visible yet
    const r = (await awaitVerifyResumeIo(cli)).resume({ session: { ...ROW_5729, pid: undefined, state: 'stopped' }, prompt: 'p' });
    expect(r).toEqual({ resumed: false, reason: 'resume-unconfirmed' });
    expect(cli.calls.filter((c) => c[0] === 'stop')).toEqual([]);
  });
});

describe('replay #5729 11:15Z — the ROUND resume of a done row whose process is still up', () => {
  const planned = { pr: 5729, itemNum: null, headRefOid: '8dd1a0026', scope: [] };
  const run = (cli, extra = {}) => {
    const released = [];
    const r = resumeBgSession(planned, {
      candidate: ROW_5729.sessionId, prompt: '# New review round', listAgentsAll: () => cli.list(),
      spawnAgent: () => cli.spawn(), stop: cli.stop, wait: () => {}, pidAlive: cli.pidAlive,
      acquireClaim: () => ({ ok: true }), releaseClaim: () => released.push('released'),
      sessionCwdFor: () => '/ops/dispatch/x', ensureSessionCwd: (p) => p, awaitingFor: () => null, hasAwaitRecord: () => false,
      listFresh: () => cli.list(), ...extra,
    });
    return { r, released };
  };
  it('stops the idle process first and resumes the same id (no cold start)', () => {
    const cli = fakeCli({ row: ROW_5729 });
    const { r, released } = run(cli);
    expect(r).toMatchObject({ resumed: true, result: { sessionId: SID_5729, resumed: true } });
    expect(cli.calls).toEqual([['stop', '6b08e7a7'], ['spawn']]);
    expect(released).toEqual(['released']);
  });
  it('a session mid-turn is never stopped or resumed', () => {
    const cli = fakeCli({ row: { ...ROW_5729, status: 'busy' } });
    const { r, released } = run(cli);
    expect(r).toMatchObject({ resumed: false, resumeAttempt: { refused: 'session-mid-turn' } });
    expect(FIXER_MID_TURN_REFUSALS.has(r.resumeAttempt.refused)).toBe(true); // the caller defers, never cold-starts
    expect(cli.calls).toEqual([]);
    expect(released).toEqual(['released']);
  });
  it('an idle session holding an await-verify record is never stopped; the caller defers', () => {
    const cli = fakeCli({ row: ROW_5729 });
    const { r, released } = run(cli, { awaitingFor: (row, { pr }) => ({ awaiting: row.sessionId === SID_5729 && pr === 5729 }) });
    expect(r).toMatchObject({ resumed: false, resumeAttempt: { refused: 'session-awaiting-verify' } });
    expect(FIXER_MID_TURN_REFUSALS.has(r.resumeAttempt.refused)).toBe(true);
    expect(cli.calls).toEqual([]);
    expect(released).toEqual(['released']);
  });
  it('an expired or other-PR await record still blocks the stop (declined the old way, no resume)', () => {
    const cli = fakeCli({ row: ROW_5729 });
    const { r } = run(cli, { hasAwaitRecord: () => true });
    expect(r).toMatchObject({ resumed: false, resumeAttempt: { refused: 'stop-before-resume' } });
    expect(cli.calls).toEqual([]);
  });
  it('a live process with no turn status is never stopped (declined the old way)', () => {
    const cli = fakeCli({ row: { ...ROW_5729, status: undefined } });
    const { r } = run(cli);
    expect(r).toMatchObject({ resumed: false, resumeAttempt: { refused: 'stop-before-resume' } });
    expect(cli.calls).toEqual([]);
  });
  it('kill switch off: the copy is started and stopped, as before', () => {
    const cli = fakeCli({ row: ROW_5729 });
    const { r } = run(cli, { sessionPolicy: resolveFixSessionPolicy({ env: { [FIX_RESUME_STOPS_LIVE_IDLE_ENV]: '0' } }) });
    expect(r).toMatchObject({ resumed: false, resumeAttempt: { attempted: true, forked: true } });
    expect(cli.calls).toEqual([['spawn'], ['stop', 'c94eeec8']]);
  });
  it('planRoundResume declines a done row that is mid-turn', () => {
    const d = planRoundResume({ planned: { pr: 5729, attempts: 2 }, settings: {}, prior: { ...ROW_5729, status: 'busy' } });
    expect(d).toMatchObject({ resume: false, reason: 'prior-session-mid-turn' });
    expect(FIXER_MID_TURN_REFUSALS.has(d.reason)).toBe(true);
    const off = planRoundResume({ planned: { pr: 5729, attempts: 2 }, settings: {}, prior: { ...ROW_5729, status: 'busy' }, midTurnGuard: false });
    expect(off.reason).not.toBe('prior-session-mid-turn');
  });
});

describe('replay #5758 11:00Z — the claim sweep and the released fixer\'s live session', () => {
  let claimRoot;
  beforeEach(() => { claimRoot = mkdtempSync(join(tmpdir(), 'fixer-liveness-claims-')); });
  afterEach(() => { rmSync(claimRoot, { recursive: true, force: true }); });
  const T0 = Date.parse('2026-10-21T10:35:00.000Z');
  const SID = 'ddac038c-bcfe-4cd0-9d51-c983476b47b1';
  const key = () => ({ repo: 'we', pr: 5758, kind: 'fixing', lockRoot: claimRoot });
  const sweep = (row, pids, sessionPolicy = resolveFixSessionPolicy({})) => refreshLiveFixDispatchClaims({ sessionPolicy,
    lockRoot: claimRoot, nowMs: T0 + 25 * 60_000, nowIso: () => new Date(T0 + 25 * 60_000).toISOString(),
    hungInfoFor: () => null, awaitingVerifyFor: null, alive: (pid) => pids.has(pid), listAgentsAll: () => [row],
  });
  const claim = () => expect(acquireFixClaim({ ...key(), who: 'fix-5758', sessionId: SID, nowMs: T0 }).ok).toBe(true);

  it('a done row that is mid-turn with a live pid keeps its claim (no second fixer can be admitted)', () => {
    claim();
    const r = sweep({ id: 'ddac038c', sessionId: SID, name: 'fix-5758', kind: 'background', state: 'done', status: 'busy', pid: 7777, startedAt: T0 }, new Set([7777]));
    expect(r.released).toBeUndefined();
    expect(r.refreshed).toHaveLength(1);
    expect(readFixDispatchClaim(key())).not.toBeNull();
  });
  it.each(['hung', 'selfReportedDone', 'authExpired'])('a done row mid-turn with a live pid is never settled, even flagged %s', (flag) => {
    claim();
    const r = refreshLiveFixDispatchClaims({
      lockRoot: claimRoot, nowMs: T0 + 25 * 60_000, nowIso: () => new Date(T0 + 25 * 60_000).toISOString(), sessionPolicy: resolveFixSessionPolicy({}),
      hungInfoFor: () => (flag === 'hung' ? { hung: true } : null), awaitingVerifyFor: null, alive: (pid) => pid === 7777,
      listAgentsAll: () => [{ id: 'ddac038c', sessionId: SID, name: 'fix-5758', kind: 'background', state: 'done', status: 'busy', pid: 7777, startedAt: T0, ...(flag !== 'hung' ? { [flag]: true } : {}) }],
    });
    expect(r.released).toBeUndefined();
    expect(readFixDispatchClaim(key())).not.toBeNull();
  });
  it('a renamed row is still matched by its bound session id', () => {
    claim();
    const r = sweep({ id: 'ddac038c', sessionId: SID, name: 'some generated title', kind: 'background', state: 'working', status: 'busy', pid: 7777, startedAt: T0 }, new Set([7777]));
    expect(r.refreshed).toHaveLength(1);
  });
  it('a settled claim whose process is still up names that session, and the daemon stops it', async () => {
    claim();
    const row = { id: 'ddac038c', sessionId: SID, name: 'fix-5758', kind: 'background', state: 'done', status: 'idle', pid: 7777, startedAt: T0 };
    const result = sweep(row, new Set([7777]));
    expect(result.released).toEqual([expect.objectContaining({ pr: 5758, kind: 'fixing', liveSessions: [{ id: 'ddac038c', sessionId: SID, pid: 7777, status: 'idle' }] })]);
    const stop = vi.fn(() => ({ stopped: true }));
    const lines = [];
    const tick = vi.fn(async () => 'ticked');
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: tick }, { log: { error: (l) => lines.push(l) }, refresh: () => result, stop, loadPolicy: () => resolveFixSessionPolicy({}),
      listFresh: () => [row], awaitingFor: () => null, hasAwaitRecord: () => false, pidAlive: (pid) => pid === 7777 });
    expect(await wrapped.tickOnce()).toBe('ticked');
    expect(stop).toHaveBeenCalledWith({ handle: 'ddac038c' });
    expect(lines.join('\n')).toMatch(/stopped session ddac038c \(pid 7777, status idle\) after releasing claim fixing-5758 \(we\) — fix\.stopOnClaimRelease=true \(standard\)/);
    expect(lines.join('\n')).toMatch(/fix-session-policy: resumeStopsLiveIdle=true \(standard\), stopOnClaimRelease=true \(standard\)/);
  });
  it('kill switch off: the session is left running and the log says why', async () => {
    const result = { checked: 1, refreshed: [], released: [{ repo: 'we', pr: 5758, kind: 'fixing', owner: 'fixer:fix-5758', liveSessions: [{ id: 'ddac038c', sessionId: SID, pid: 7777, status: 'idle' }] }] };
    const stop = vi.fn();
    const lines = [];
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => null }, { log: { error: (l) => lines.push(l) }, refresh: () => result, stop, loadPolicy: () => resolveFixSessionPolicy({ env: { [FIX_STOP_ON_CLAIM_RELEASE_ENV]: 'off' } }) });
    await wrapped.tickOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/left session ddac038c running .* fix\.stopOnClaimRelease=false \(env\)/);
  });
  it('kill switch claimLivenessByPid off: the old name/state-only view releases the mid-turn done row', () => {
    claim();
    const row = { id: 'ddac038c', sessionId: SID, name: 'fix-5758', kind: 'background', state: 'done', status: 'busy', pid: 7777, startedAt: T0 };
    const r = sweep(row, new Set([7777]), resolveFixSessionPolicy({ env: { [FIX_CLAIM_LIVENESS_BY_PID_ENV]: 'off' } }));
    expect(r.released).toHaveLength(1);
    expect(r.released[0].liveSessions).toBeUndefined(); // a mid-turn row is never named for a stop
  });
  it.each([
    ['it started a new turn', { status: 'busy' }, () => null, /mid-turn \(status busy\)/],
    ['it now holds an await-verify record', {}, () => ({ awaiting: true }), /holds an await-verify record/],
    ['its process is already gone', { pid: 1 }, () => null, /process already gone/],
    ['it is interactive', { kind: 'interactive' }, () => null, /interactive session/],
  ])('the stop re-reads the row and leaves it when %s', async (_why, patch, awaitingFor, re) => {
    const sess = { id: 'ddac038c', sessionId: SID, pid: 7777, status: 'idle' };
    const result = { checked: 1, refreshed: [], released: [{ repo: 'we', pr: 5758, kind: 'fixing', owner: 'o', liveSessions: [sess] }] };
    const stop = vi.fn();
    const lines = [];
    const fresh = { ...sess, kind: 'background', state: 'done', cwd: '/x', ...patch };
    const wrapped = withFixDispatchClaimRefresh({ tickOnce: async () => null }, { log: { error: (l) => lines.push(l) }, refresh: () => result, stop,
      loadPolicy: () => resolveFixSessionPolicy({}), listFresh: () => [fresh], awaitingFor, hasAwaitRecord: () => false, pidAlive: (pid) => pid === 7777 });
    await wrapped.tickOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(re);
  });
  it('a gone session (no live pid) is released with nothing to stop', () => {
    claim();
    const result = sweep({ id: 'ddac038c', sessionId: SID, name: 'fix-5758', kind: 'background', state: 'stopped', startedAt: T0 }, new Set());
    expect(result.released).toEqual([expect.not.objectContaining({ liveSessions: expect.anything() })]);
  });
});
