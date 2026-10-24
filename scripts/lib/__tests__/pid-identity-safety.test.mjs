import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidIdentity, pidIdentityStamp } from '../pid-alive.mjs';
import { isClaimRunnerDead } from '../dispatch-throttle.mjs';
import { enrichAgents, probePid } from '../../conveyor/reconcile-pass.mjs';
import { assessLiveness } from '../../conveyor/reconcile-core.mjs';
import { defaultIsPidAlive } from '../../conveyor/driver-watchdog.mjs';
import {
  acquireFixDispatchClaim, readFixDispatchClaim, stampBorrowedRunnerPid,
  refreshLiveFixDispatchClaims,
} from '../../conveyor/fix-dispatch-claim.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  execFileSync: vi.fn(() => { throw new Error('unexpected subprocess'); }),
}));

const PID = 424242;
const START = 'Sat Oct 24 12:00:00 2026';
const ARGV = 'node scripts/operations/fix-runner.mjs --pr 42';
const ROW = `S+ ${START} ${ARGV}\n`;
const NOW = Date.parse('2026-10-24T12:02:00.000Z');
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); });

describe('PID snapshot safety boundaries', () => {
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

describe('positive identity evidence controls claim release', () => {
  it.each([
    ['zombie releases claim', 'Z+', START, ARGV, 'zombie'],
    ['recycled-spare subcommand releases claim', 'Ss', START, 'claude bg-spare', 'recycled-spare'],
    ['recycled-spare flag releases claim', 'S', START, 'claude --bg-spare=spare.sock', 'recycled-spare'],
    ['start mismatch releases claim', 'S', 'Sat Oct 24 12:01:00 2026', ARGV, 'start-mismatch'],
    ['argv mismatch releases claim', 'S', START, 'node scripts/other-runner.mjs', 'argv-mismatch'],
    ['matching identity retains claim', 'S+', START, ARGV, 'match'],
    ['matching argv within launcher retains claim', 'S', START, `launcher ${ARGV} --mode fix`, 'match'],
    ['similar spare subcommand retains claim', 'S', START, `${ARGV} bg-spare-worker`, 'match'],
    ['similar spare flag retains claim', 'S', START, `${ARGV} --bg-spare-count=2`, 'match'],
    ['spare token within filename retains claim', 'S', START, `${ARGV} scripts/bg-spare.mjs`, 'match'],
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
