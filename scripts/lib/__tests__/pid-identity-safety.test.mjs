import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidIdentity, pidIdentityStamp } from '../pid-alive.mjs';
import { isClaimRunnerDead } from '../dispatch-throttle.mjs';
import { enrichAgents, probePid } from '../../conveyor/reconcile-pass.mjs';
import { assessLiveness } from '../../conveyor/reconcile-core.mjs';
import { defaultIsPidAlive } from '../../conveyor/driver-watchdog.mjs';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import {
  acquireFixDispatchClaim, readFixDispatchClaim, stampBorrowedRunnerPid,
  refreshLiveFixDispatchClaims, releaseFixDispatchClaim,
} from '../../conveyor/fix-dispatch-claim.mjs';

const PID = 424242;
const START = 'Sat Oct 24 12:00:00 2026';
const ARGV = 'node scripts/operations/fix-runner.mjs --pr 42';
const ROW = `S+ ${START} ${ARGV}\n`;
const NOW = Date.parse('2026-10-24T12:02:00.000Z');
afterEach(() => { vi.restoreAllMocks(); });

describe('PID snapshot safety boundaries', () => {
  it('a live worker whose prompt mentions bg-spare is not a recycled spare', () => {
    const argv = 'claude --bg --name fix-1 Investigate bg-spare recycling --bg-spare';
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: true, reason: 'match' });
  });

  it('path-prefixed claude bg-spare is a recycled spare', () => {
    const argv = '/usr/local/bin/claude bg-spare --bg-spare /tmp/x.sock';
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: false, reason: 'recycled-spare' });
  });

  it.each([
    'node /opt/tools/claude.mjs bg-spare --bg-spare /tmp/x.sock',
    '/usr/local/bin/node /opt/tools/claude.mjs bg-spare --bg-spare /tmp/x.sock',
    '/opt/tools/claude-code bg-spare --bg-spare /tmp/x.sock',
  ])('recognizes a Claude spare launcher: %s', argv => {
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: false, reason: 'recycled-spare' });
  });

  it.each([
    'claude --bg-spare=spare.sock',
    'claude bg-spare-worker',
    'other-worker bg-spare --bg-spare /tmp/x.sock',
    '/opt/claude/other-worker bg-spare --bg-spare /tmp/x.sock',
    'node -e script -- claude bg-spare --bg-spare /tmp/x.sock',
    'node worker.mjs claude bg-spare --bg-spare /tmp/x.sock',
  ])('spare words without the Claude subcommand preserve liveness: %s', argv => {
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: true, reason: 'match' });
  });

  it('ps exit 1 with diagnostic stderr preserves a live runner claim', () => {
    const exec = vi.fn(() => { throw Object.assign(new Error('ps'), { status: 1, stderr: 'ps: permission denied' }); });
    expect(pidIdentity(PID, { exec })).toMatchObject({ alive: null });
    const empty = vi.fn(() => { throw Object.assign(new Error('ps'), { status: 1, stderr: '' }); });
    expect(pidIdentity(PID, { exec: empty })).toMatchObject({ alive: false, reason: 'gone' });
  });

  it('bounds the single ps snapshot and pins locale, timezone and captured output', () => {
    const exec = vi.fn(() => ROW);
    expect(pidIdentity(PID, { exec })).toEqual({ alive: true, reason: 'match' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('ps',
      ['-p', String(PID), '-o', 'stat=,lstart=,command='], expect.objectContaining({
        encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
        env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  });

  it.each([
    ['truncated zombie row', 'Z+ Sat Oct 24'],
    ['missing argv', `S ${START}`],
    ['multiple rows', ROW + ROW],
    ['unrecognized output', 'permission denied'],
  ])('malformed ps stays unknown: %s', (_name, output) => {
    expect(pidIdentity(PID, { exec: () => output }))
      .toEqual({ alive: null, reason: 'unreadable' });
  });

  it('identity verdict and launch stamp each use a single ps snapshot', () => {
    const exec = vi.fn(() => ROW);
    expect(pidIdentity(PID, { exec })).toEqual({ alive: true, reason: 'match' });
    expect(pidIdentityStamp(PID, exec)).toEqual({ runnerStart: START, runnerArgv: ARGV });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['timeout', { code: 'ETIMEDOUT', signal: 'SIGTERM' }],
    ['output over maxBuffer', { code: 'ENOBUFS', signal: 'SIGTERM', stdout: 'x'.repeat(64 * 1024 + 1) }],
    ['failed ps', { status: 2 }],
    ['interrupted exit 1', { status: 1, signal: 'SIGTERM' }],
  ])('%s preserves stamped claims and refuses lane reuse even after successful existence probes', (_name, failure) => {
    const exec = () => { throw Object.assign(new Error('unreadable ps'), failure); };
    const identity = (pid, options) => pidIdentity(pid, { ...options, exec });
    expect(identity(PID)).toEqual({ alive: null, reason: 'unreadable' });
    expect(pidIdentityStamp(PID, exec)).toEqual({ runnerStart: null, runnerArgv: null });
    expect(isClaimRunnerDead({ meta: { runnerPid: PID, runnerStart: START, runnerArgv: ARGV } },
      () => true, identity)).toBe(false);
    const [agent] = enrichAgents([{ sessionId: 'bound-fix', pid: PID, pidAlive: true, state: 'working' }], {
      probe: pid => probePid(pid, () => {}, identity),
    });
    expect(agent).not.toHaveProperty('pidAlive');
    expect(assessLiveness([{ agent }])).toMatchObject({ kind: 'liveness-unknown' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(defaultIsPidAlive(PID, identity)).toBeNull();
  });
});

describe('session-bound fixing claim identity safety', () => {
  it.each([
    ['an older dead-pid working row with a different sessionId keeps a newer claim', 'bound-fix',
      [{ sessionId: 'old-fix', startedAt: NOW - 1000 }], false],
    ['an older dead-pid working row keeps a newer claim without a sessionId', null,
      [{ sessionId: 'old-fix', startedAt: NOW - 1000 }], false],
    ['a different sessionId cannot use a newer start time to release a bound claim', 'bound-fix',
      [{ sessionId: 'other-fix', startedAt: NOW + 1 }], false],
    ['a row missing sessionId cannot release a bound claim', 'bound-fix',
      [{ startedAt: NOW + 1 }], false],
    ['a matching sessionId row with a recycled pid releases even when it started before the claim', 'bound-fix',
      [{ sessionId: 'bound-fix', startedAt: NOW - 1000 }], true],
    ['a row starting at the claim releases a legacy claim with a recycled pid', null,
      [{ sessionId: 'legacy-fix', startedAt: NOW }], true],
    ['a row with no start time keeps a legacy claim', null,
      [{ sessionId: 'legacy-fix' }], false],
    ['a row with an unreadable start time keeps a legacy claim', null,
      [{ sessionId: 'legacy-fix', startedAt: 'unreadable' }], false],
    ['a non-associated live sibling keeps the claim despite a matching dead row', 'bound-fix',
      [{ sessionId: 'bound-fix' }, { sessionId: 'other-fix', startedAt: NOW + 1, live: true }], false],
    ['a non-associated unknown sibling keeps the claim despite a matching dead row', 'bound-fix',
      [{ sessionId: 'bound-fix' }, { sessionId: 'other-fix', startedAt: NOW + 1 }], false],
  ])('%s', (_name, sessionId, rows, released) => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'session-identity-association-'));
    const claim = { repo: 'we', pr: 42, kind: 'fixing', lockRoot };
    const agents = rows.map((row, index) => ({ name: 'fix-42', state: 'working', pid: PID + index, ...row }));
    const identity = vi.fn(pid => pid === PID
      ? { alive: false, reason: 'recycled-spare' }
      : { alive: agents.find(row => row.pid === pid)?.live ? true : null });
    try {
      expect(acquireFixClaim({ ...claim, who: 'fix-42', sessionId, nowMs: NOW }).ok).toBe(true);
      const result = refreshLiveFixDispatchClaims({
        lockRoot, identity, listAgentsAll: () => agents,
        hungInfoFor: () => null, awaitingVerifyFor: null,
        nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
      });
      if (released) {
        expect(result.released).toEqual([{ repo: 'we', pr: 42, kind: 'fixing', owner: 'fixer:fix-42',
          reason: 'session-identity-dead (recycled-spare)' }]);
        expect(result.refreshed).toEqual([]);
        expect(readFixDispatchClaim(claim)).toBeNull();
        expect(identity).toHaveBeenCalledWith(PID);
      } else {
        expect(result.released ?? []).toEqual([]);
        expect(result.refreshed).toHaveLength(1);
        expect(readFixDispatchClaim(claim).heartbeatAt).toBe(new Date(NOW + 1000).toISOString());
      }
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['releases a working row with a recycled-spare pid and logs the reason', [], true],
    ['releases when all working rows have dead identities', [{ pid: PID + 1 }], true],
    ['unknown identity keeps the claim', [{ pid: PID, unknown: true }], false],
    ['a second live row keeps the claim', [{ pid: PID + 1, live: true }], false],
    ['a second unknown row keeps the claim', [{ pid: PID + 1, unknown: true }], false],
    ['a throwing identity probe keeps the claim', [{ pid: PID, throws: true }], false],
    ['a row without pid keeps the claim', [{}], false],
    ['a non-integer pid keeps the claim', [{ pid: String(PID) }], false],
    ['terminal rows do not veto dead identity release', [{ state: 'done' }], true],
  ])('%s', (_name, extra, released) => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'session-identity-release-'));
    const claim = { repo: 'we', pr: 42, kind: 'fixing', lockRoot };
    const rows = (extra.some(row => row.pid === PID) ? extra : [{ pid: PID }, ...extra])
      .map(row => ({ name: 'fix-42', state: 'working', sessionId: 'bound-fix', ...row }));
    const exec = vi.fn((_cmd, args) => {
      const row = rows.find(row => row.pid === Number(args[1]));
      if (row?.unknown) throw new Error('unreadable ps');
      return `S ${START} ${row?.live ? ARGV : 'claude bg-spare --bg-spare /tmp/x.sock'}\n`;
    });
    const identity = vi.fn(pid => {
      if (rows.find(row => row.pid === pid)?.throws) throw new Error('identity probe failed');
      return pidIdentity(pid, { exec });
    });
    try {
      expect(acquireFixClaim({ ...claim, who: 'fix-42', sessionId: 'bound-fix', nowMs: NOW }).ok).toBe(true);
      expect(readFixDispatchClaim(claim).meta).not.toHaveProperty('runnerPid');
      const result = refreshLiveFixDispatchClaims({
        lockRoot, identity, listAgentsAll: () => rows,
        hungInfoFor: () => null, awaitingVerifyFor: null,
        nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
      });
      if (released) {
        expect(result.refreshed).toEqual([]);
        expect(result.released).toEqual([{ repo: 'we', pr: 42, kind: 'fixing', owner: 'fixer:fix-42',
          reason: 'session-identity-dead (recycled-spare)' }]);
        expect(readFixDispatchClaim(claim)).toBeNull();
      } else {
        expect(result.released ?? []).toEqual([]);
        expect(result.refreshed).toHaveLength(1);
        expect(readFixDispatchClaim(claim).heartbeatAt).toBe(new Date(NOW + 1000).toISOString());
      }
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it.each(['owner', 'claimedAt'])('does not release a fixing claim whose %s changes during the identity probe', changed => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'session-identity-race-'));
    const claim = { repo: 'we', pr: 42, kind: 'fixing', lockRoot };
    const identity = vi.fn(() => {
      releaseFixDispatchClaim({ ...claim, owner: 'fixer:fix-42' });
      acquireFixClaim({ ...claim, who: changed === 'owner' ? 'new-fixer' : 'fix-42',
        sessionId: 'new-session', nowMs: NOW + 500 });
      return { alive: false, reason: 'recycled-spare' };
    });
    try {
      acquireFixClaim({ ...claim, who: 'fix-42', sessionId: 'bound-fix', nowMs: NOW });
      const result = refreshLiveFixDispatchClaims({
        lockRoot, identity,
        listAgentsAll: () => [{ name: 'fix-42', sessionId: 'bound-fix', state: 'working', pid: PID }],
        hungInfoFor: () => null, awaitingVerifyFor: null,
        nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
      });
      expect(identity).toHaveBeenCalledWith(PID);
      expect(result.refreshed).toEqual([]);
      expect(result.released ?? []).toEqual([]);
      expect(readFixDispatchClaim(claim).meta).toMatchObject({
        sessionId: 'new-session', claimedAt: new Date(NOW + 500).toISOString(),
      });
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});

describe('positive identity evidence controls claim release', () => {
  it.each([
    ['zombie releases claim', 'Z+', START, ARGV, 'zombie'],
    ['recycled-spare subcommand releases claim', 'Ss', START, 'claude bg-spare', 'recycled-spare'],
    ['recycled-spare subcommand with flag releases claim', 'S', START, 'claude bg-spare --bg-spare=spare.sock', 'recycled-spare'],
    ['start mismatch releases claim', 'S', 'Sat Oct 24 12:01:00 2026', ARGV, 'start-mismatch'],
    ['argv mismatch releases claim', 'S', START, 'node scripts/other-runner.mjs', 'argv-mismatch'],
    ['matching identity retains claim', 'S+', START, ARGV, 'match'],
    ['matching argv within launcher retains claim', 'S', START, `launcher ${ARGV} --mode fix`, 'match'],
    ['similar spare subcommand retains claim', 'S', START, `${ARGV} bg-spare-worker`, 'match'],
    ['similar spare flag retains claim', 'S', START, `${ARGV} --bg-spare-count=2`, 'match'],
    ['spare token within filename retains claim', 'S', START, `${ARGV} scripts/bg-spare.mjs`, 'match'],
    ['prompt mentioning spare tokens retains claim', 'S', START, `${ARGV} Investigate bg-spare recycling --bg-spare`, 'match'],
  ])('%s', (_name, stat, start, argv, reason) => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'pid-identity-release-'));
    const claim = { repo: 'we', pr: 42, kind: 'fix', owner: 'fixture-owner', lockRoot };
    const exec = vi.fn(() => `${stat} ${start} ${argv}\n`);
    const identity = vi.fn((pid, options) => pidIdentity(pid, { ...options, exec }));
    const retained = reason === 'match';
    try {
      expect(acquireFixDispatchClaim({ ...claim, pid: 111, nowMs: NOW,
        nowIso: new Date(NOW).toISOString() }).ok).toBe(true);
      expect(stampBorrowedRunnerPid({ ...claim, pid: PID, runnerStart: START, runnerArgv: ARGV,
        nowIso: new Date(NOW).toISOString() })).toBe(true);
      const result = refreshLiveFixDispatchClaims({
        lockRoot, alive: () => true, identity, listAgentsAll: () => [],
        hungInfoFor: () => null, awaitingVerifyFor: null,
        nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
      });
      expect(identity).toHaveBeenCalledTimes(1);
      expect(identity).toHaveBeenCalledWith(PID, { expectStart: START, expectArgv: ARGV });
      expect(identity.mock.results[0].value).toEqual({ alive: retained, reason });
      if (retained) {
        expect(result.released ?? []).toEqual([]);
        expect(result.refreshed).toHaveLength(1);
        expect(readFixDispatchClaim(claim)?.meta).toMatchObject({ runnerPid: PID, runnerStart: START, runnerArgv: ARGV });
      } else {
        expect(result.refreshed).toEqual([]);
        expect(result.released).toEqual([{ repo: 'we', pr: 42, kind: 'fix', owner: claim.owner,
          reason: `runner-identity-dead (${reason})` }]);
        expect(readFixDispatchClaim(claim)).toBeNull();
      }
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});
