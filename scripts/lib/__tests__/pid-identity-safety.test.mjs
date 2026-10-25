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

  it('path-prefixed claude bg-spare can host a live working session', () => {
    const argv = '/usr/local/bin/claude bg-spare --bg-spare /tmp/x.sock';
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: true, reason: 'match' });
  });

  it.each([
    'node /opt/tools/claude.mjs bg-spare --bg-spare /tmp/x.sock',
    '/usr/local/bin/node /opt/tools/claude.mjs bg-spare --bg-spare /tmp/x.sock',
    '/opt/tools/claude-code bg-spare --bg-spare /tmp/x.sock',
  ])('Claude spare launcher argv alone preserves liveness: %s', argv => {
    expect(pidIdentity(PID, { exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: true, reason: 'match' });
    expect(pidIdentity(PID, { expectStart: 'Sat Oct 24 11:59:00 2026', exec: () => `S ${START} ${argv}\n` }))
      .toEqual({ alive: false, reason: 'start-mismatch' });
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
  it.each([false, true])('a live working session on a claimed spare keeps its claim (stamped=%s)', stamped => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'live-claimed-spare-'));
    const claim = { repo: 'we', pr: 42, kind: 'fixing', lockRoot };
    const argv = 'claude bg-spare --bg-spare /tmp/claimed.sock';
    const identity = (pid, options) => pidIdentity(pid, { ...options, exec: () => `S ${START} ${argv}\n` });
    try {
      expect(acquireFixClaim({ ...claim, who: 'fix-42', sessionId: 'working-spare', nowMs: NOW }).ok).toBe(true);
      if (stamped) expect(stampBorrowedRunnerPid({ ...claim, owner: 'fixer:fix-42', pid: PID,
        runnerStart: START, runnerArgv: argv, nowIso: new Date(NOW).toISOString() })).toBe(true);
      const [agent] = enrichAgents([{ name: 'fix-42', sessionId: 'working-spare', state: 'working',
        pid: PID, startedAt: NOW - 1000 }], { probe: pid => probePid(pid, () => {}, identity) });
      expect(agent.pidAlive).toBe(true);
      expect(assessLiveness([{ agent }])).toMatchObject({ kind: 'live-process' });
      const result = refreshLiveFixDispatchClaims({ lockRoot, alive: () => true, identity,
        listAgentsAll: () => [agent], hungInfoFor: () => null, awaitingVerifyFor: null,
        nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString() });
      expect(result.released ?? []).toEqual([]);
      expect(result.refreshed).toHaveLength(1);
      expect(readFixDispatchClaim(claim).meta.sessionId).toBe('working-spare');
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });

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
      ? { alive: false, reason: 'zombie' }
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
          reason: 'session-identity-dead (zombie)' }]);
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
    ['releases a working row with a zombie spare pid and logs the reason', [], true],
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
      return `${row?.live ? 'S' : 'Z+'} ${START} ${row?.live ? ARGV : 'claude bg-spare --bg-spare /tmp/x.sock'}\n`;
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
          reason: 'session-identity-dead (zombie)' }]);
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
      return { alive: false, reason: 'zombie' };
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

describe.each(['runnerPid', 'session-identity'])('%s claim probe fencing', path => {
  it.each(['owner', 'claimedAt', 'runnerPid', 'absent'].flatMap(changed =>
    [true, false, null].map(alive => ({ changed, alive }))))(
    'a claim replaced during the identity probe is not overwritten ($changed, alive=$alive)', ({ changed, alive }) => {
      const lockRoot = mkdtempSync(join(tmpdir(), 'claim-probe-fence-'));
      const claim = { repo: 'we', pr: 42, kind: 'fix', owner: 'original-owner', lockRoot };
      const stamp = { runnerStart: START, runnerArgv: ARGV, nowIso: new Date(NOW).toISOString() };
      let replacement;
      const identity = vi.fn(() => {
        if (changed === 'runnerPid') {
          expect(stampBorrowedRunnerPid({ ...claim, ...stamp, pid: PID + 1 })).toBe(true);
        } else {
          expect(releaseFixDispatchClaim(claim).released).toBe(true);
          if (changed !== 'absent') {
            const next = { ...claim, owner: changed === 'owner' ? 'replacement-owner' : claim.owner };
            expect(acquireFixDispatchClaim({ ...next, headSha: 'replacement-head', sessionId: 'replacement-session',
              nowMs: changed === 'claimedAt' ? NOW + 500 : NOW }).ok).toBe(true);
            if (path === 'runnerPid') {
              expect(stampBorrowedRunnerPid({ ...next, ...stamp, pid: PID })).toBe(true);
            }
          }
        }
        replacement = readFixDispatchClaim(claim);
        return { alive, reason: alive === false ? 'zombie' : 'match' };
      });
      try {
        expect(acquireFixDispatchClaim({ ...claim, sessionId: 'bound-fix', nowMs: NOW }).ok).toBe(true);
        if (path === 'runnerPid') {
          expect(stampBorrowedRunnerPid({ ...claim, ...stamp, pid: PID })).toBe(true);
        }
        const result = refreshLiveFixDispatchClaims({
          lockRoot, alive: () => true, identity,
          listAgentsAll: () => [{ name: 'fix-42', sessionId: 'bound-fix', state: 'working', pid: PID }],
          hungInfoFor: () => null, awaitingVerifyFor: null,
          nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
        });
        expect(identity).toHaveBeenCalledTimes(1);
        expect(result.refreshed).toEqual([]);
        expect(result.released ?? []).toEqual([]);
        expect(readFixDispatchClaim(claim)).toEqual(replacement);
      } finally {
        rmSync(lockRoot, { recursive: true, force: true });
      }
    });
});

describe('borrowed runner stamp probe fencing', () => {
  it.each(['owner', 'claimedAt', 'runnerPid', 'absent'])(
    'a claim replaced during the identity probe is not overwritten (%s)', changed => {
      const lockRoot = mkdtempSync(join(tmpdir(), 'stamp-probe-fence-'));
      const claim = { repo: 'we', pr: 42, owner: 'original-owner', lockRoot };
      const stamp = { runnerStart: START, runnerArgv: ARGV, nowIso: new Date(NOW).toISOString() };
      let replacement;
      const identityOf = vi.fn(() => {
        if (changed === 'runnerPid') {
          expect(stampBorrowedRunnerPid({ ...claim, ...stamp, pid: PID + 1 })).toBe(true);
        } else {
          expect(releaseFixDispatchClaim(claim).released).toBe(true);
          if (changed !== 'absent') {
            const next = { ...claim, owner: changed === 'owner' ? 'replacement-owner' : claim.owner };
            expect(acquireFixDispatchClaim({ ...next, headSha: 'replacement-head',
              nowMs: changed === 'claimedAt' ? NOW + 500 : NOW }).ok).toBe(true);
            expect(stampBorrowedRunnerPid({ ...next, ...stamp, pid: PID })).toBe(true);
          }
        }
        replacement = readFixDispatchClaim(claim);
        return { runnerStart: START, runnerArgv: ARGV };
      });
      try {
        expect(acquireFixDispatchClaim({ ...claim, nowMs: NOW }).ok).toBe(true);
        expect(stampBorrowedRunnerPid({ ...claim, ...stamp, pid: PID })).toBe(true);
        expect(stampBorrowedRunnerPid({ ...claim, pid: PID + 2, identityOf,
          nowIso: new Date(NOW + 1000).toISOString() })).toBe(false);
        expect(identityOf).toHaveBeenCalledWith(PID + 2);
        expect(readFixDispatchClaim(claim)).toEqual(replacement);
      } finally {
        rmSync(lockRoot, { recursive: true, force: true });
      }
    });
});

describe('positive identity evidence controls claim release', () => {
  it.each([
    ['zombie releases claim', 'Z+', START, ARGV, 'zombie'],
    ['spare with different stored argv releases claim', 'Ss', START, 'claude bg-spare', 'argv-mismatch'],
    ['spare with flag and different stored argv releases claim', 'S', START, 'claude bg-spare --bg-spare=spare.sock', 'argv-mismatch'],
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
