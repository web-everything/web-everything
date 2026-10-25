// Tests-first contract: PID existence alone cannot keep a fix claim live.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as pidAlive from '../pid-alive.mjs';
import { isClaimRunnerDead } from '../dispatch-throttle.mjs';
import { probePid } from '../../conveyor/reconcile-pass.mjs';
import { defaultIsPidAlive } from '../../conveyor/driver-watchdog.mjs';
import {
  acquireFixDispatchClaim, readFixDispatchClaim, stampBorrowedRunnerPid,
  refreshLiveFixDispatchClaims, fixDispatchResource,
} from '../../conveyor/fix-dispatch-claim.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';

// Any accidentally un-injected subprocess is a test error, never a real ps.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  execFileSync: vi.fn(() => { throw new Error('unexpected subprocess: inject exec/identityOf'); }),
}));

const PID = 424242;
const START = 'Sat Oct 24 12:00:00 2026';
const OTHER_START = 'Sat Oct 24 12:01:00 2026';
const ARGV = 'node scripts/operations/fix-runner.mjs --pr 42';
const SPARE = 'claude bg-spare --bg-spare /tmp/fake-spare.sock';
const NOW = Date.parse('2026-10-24T12:02:00.000Z');
const psRow = (stat = 'S', start = START, argv = ARGV) => `  ${stat}  ${start} ${argv}\n`;
const errorWith = (properties) => Object.assign(new Error('fake process probe failure'), properties);

function expectEpermIdentity(probe, alive) {
  const kill = vi.fn(() => { throw errorWith({ code: 'EPERM' }); });
  const identity = vi.fn(() => ({ alive, reason: 'fixture' }));
  expect(probe(PID, identity, kill)).toBe(alive);
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith(PID, 0);
  expect(identity).toHaveBeenCalledTimes(1);
  expect(identity).toHaveBeenCalledWith(PID);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('pidIdentity (injected ps only)', () => {
  it.each([
    ['reused pid (start mismatch) is dead', psRow('S', OTHER_START), { expectStart: START }, 'start-mismatch'],
    ['zombie is dead', psRow('Z+'), {}, 'zombie'],
    ['bg-spare with a stored start mismatch is dead', psRow('Ss', OTHER_START, SPARE), { expectStart: START }, 'start-mismatch'],
    ['argv mismatch is dead', psRow(), { expectArgv: 'different-runner.mjs' }, 'argv-mismatch'],
    ['pid gone is dead (no row)', '  \n', {}, 'gone'],
  ])('%s', (_name, output, expectations, reason) => {
    const exec = vi.fn(() => output);
    expect(pidAlive.pidIdentity(PID, { ...expectations, exec })).toEqual({ alive: false, reason });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('ps', ['-p', String(PID), '-o', 'stat=,lstart=,command='], expect.any(Object));
  });

  it('matching start+argv is alive', () => {
    const exec = vi.fn(() => psRow('S+', START, `launcher ${ARGV} --mode fix`));
    expect(pidAlive.pidIdentity(PID, { expectStart: START, expectArgv: ARGV, exec }))
      .toEqual({ alive: true, reason: 'match' });
  });

  it('no expectations accepts an ordinary live process', () => {
    expect(pidAlive.pidIdentity(PID, { exec: () => psRow() })).toEqual({ alive: true, reason: 'match' });
  });

  it.each([{}, { expectStart: START, expectArgv: SPARE }])('claimed spare argv alone cannot prove death: %j', expectations => {
    expect(pidAlive.pidIdentity(PID, { ...expectations, exec: () => psRow('Ss', START, SPARE) }))
      .toEqual({ alive: true, reason: 'match' });
  });

  it('pid gone is dead (ps exit 1)', () => {
    const exec = vi.fn(() => { throw errorWith({ status: 1 }); });
    expect(pidAlive.pidIdentity(PID, { exec })).toEqual({ alive: false, reason: 'gone' });
  });

  it.each([{ status: 2 }, { code: 'EACCES' }, { code: 'ETIMEDOUT' }, { code: 'ENOENT' }])(
    'unreadable ps is unknown rather than evidence of death: %j', (failure) => {
      const exec = vi.fn(() => { throw errorWith(failure); });
      expect(pidAlive.pidIdentity(PID, { exec })).toEqual({ alive: null, reason: expect.any(String) });
    },
  );
});

describe('PID consumers gate successful existence probes on identity', () => {
  for (const [name, probe, implementation] of [
    ['probePid', (pid, identity, kill) => probePid(pid, kill, identity), probePid],
    ['defaultIsPidAlive', (pid, identity, kill) => defaultIsPidAlive(pid, identity, kill), defaultIsPidAlive],
  ]) {
    it.each([true, false, null])(`${name}: EPERM still requires identity (%s)`, (alive) => {
      expectEpermIdentity(probe, alive);
    });

    it.each([true, false, null])(`${name}: EPERM mutation gate rejects unconditional true (%s)`, alive => {
      // Mutate an in-memory function copy only; production files and Git are never written.
      const branch = "if (e?.code !== 'EPERM') return null;";
      const source = implementation.toString();
      expect(source).toContain(branch);
      const mutant = runInNewContext(`(${source.replace(branch,
        `if (e?.code === 'EPERM') return true; ${branch}`)})`, {}, { timeout: 1000 });
      const mutantProbe = name === 'probePid'
        ? (pid, identity, kill) => mutant(pid, kill, identity)
        : (pid, identity, kill) => mutant(pid, identity, kill);
      expect(() => expectEpermIdentity(mutantProbe, alive)).toThrow();
    });

    it.each([
      ['success', PID, null, true, true],
      ['ESRCH', PID, 'ESRCH', false, false],
      ['EINVAL', PID, 'EINVAL', null, false],
      ['unknown error', PID, 'EIO', null, false],
      ['zero pid', 0, null, null, false],
      ['negative pid', -1, null, null, false],
      ['fractional pid', 1.5, null, null, false],
      ['string pid', String(PID), null, null, false],
      ['missing pid', undefined, null, null, false],
      ['NaN pid', NaN, null, null, false],
      ['infinite pid', Infinity, null, null, false],
    ])(`${name}: kill outcome %s`, (_label, pid, code, expected, consultIdentity) => {
      const kill = vi.fn(() => { if (code) throw errorWith({ code }); });
      const identity = vi.fn(() => ({ alive: true, reason: 'match' }));
      expect(probe(pid, identity, kill)).toBe(expected);
      expect(kill).toHaveBeenCalledTimes(Number(Number.isInteger(pid) && pid > 0));
      expect(identity).toHaveBeenCalledTimes(Number(consultIdentity));
    });

    it(`${name}: throwing identity remains unknown`, () => {
      const identity = vi.fn(() => { throw new Error('identity unavailable'); });
      expect(probe(PID, identity, vi.fn())).toBeNull();
      expect(identity).toHaveBeenCalledTimes(1);
      expect(identity).toHaveBeenCalledWith(PID);
    });
  }

  const verdicts = [
    ['reused pid (start mismatch) is dead', false, 'start-mismatch'],
    ['zombie is dead', false, 'zombie'],
    ['bg-spare with an argv mismatch is dead', false, 'argv-mismatch'],
    ['matching start+argv is alive', true, 'match'],
    ['pid gone is dead', false, 'gone'],
    ['undeterminable identity stays unknown', null, 'unreadable'],
  ];

  it.each(verdicts)('probePid: %s', (_name, alive, reason) => {
    const kill = vi.fn();
    const identity = vi.fn(() => ({ alive, reason }));
    expect(probePid(PID, kill, identity)).toBe(alive);
    expect(kill).toHaveBeenCalledWith(PID, 0);
    expect(identity).toHaveBeenCalledWith(PID);
  });

  it('probePid: ESRCH still proves pid gone is dead without identity', () => {
    const kill = vi.fn(() => { throw errorWith({ code: 'ESRCH' }); });
    const identity = vi.fn();
    expect(probePid(PID, kill, identity)).toBe(false);
    expect(identity).not.toHaveBeenCalled();
  });

  it.each(verdicts)('defaultIsPidAlive: %s', (_name, alive, reason) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const identity = vi.fn(() => ({ alive, reason }));
    expect(defaultIsPidAlive(PID, identity)).toBe(alive);
    expect(kill.mock.calls.every(([pid, signal]) => pid === PID && signal === 0)).toBe(true);
    expect(identity).toHaveBeenCalledWith(PID);
  });
});

describe('isClaimRunnerDead', () => {
  it.each([
    ['reused pid (start mismatch) is dead', false, 'start-mismatch', true],
    ['zombie is dead', false, 'zombie', true],
    ['bg-spare with an argv mismatch is dead', false, 'argv-mismatch', true],
    ['matching start+argv is alive', true, 'match', false],
    ['unknown identity preserves the claim for TTL expiry', null, 'unreadable', false],
  ])('%s', (_name, verdict, reason, dead) => {
    const alive = vi.fn(() => true);
    const identity = vi.fn(() => ({ alive: verdict, reason }));
    const claim = { meta: { runnerPid: PID, runnerStart: START, runnerArgv: ARGV } };
    expect(isClaimRunnerDead(claim, alive, identity)).toBe(dead);
    expect(alive).toHaveBeenCalledWith(PID);
    expect(identity).toHaveBeenCalledWith(PID, { expectStart: START, expectArgv: ARGV });
  });

  it('pid gone is dead even if identity cannot be determined', () => {
    expect(isClaimRunnerDead({ meta: { runnerPid: PID } }, () => false,
      () => ({ alive: null, reason: 'unreadable' }))).toBe(true);
  });

  it.each([
    ['legacy claim with undeterminable identity is alive', null, 'unreadable', false],
    ['legacy claim with bg-spare argv alone stays alive', true, 'match', false],
    ['legacy claim with zombie is dead', false, 'zombie', true],
  ])('%s', (_name, verdict, reason, dead) => {
    const identity = vi.fn(() => ({ alive: verdict, reason }));
    expect(isClaimRunnerDead({ meta: { runnerPid: PID } }, () => true, identity)).toBe(dead);
    expect(identity).toHaveBeenCalledTimes(1);
    const [pid, options = {}] = identity.mock.calls[0];
    expect(pid).toBe(PID);
    expect(options.expectStart ?? null).toBeNull();
    expect(options.expectArgv ?? null).toBeNull();
  });

  it.each([{}, { meta: {} }])('unstamped claim stays alive for TTL expiry: %j', (claim) => {
    const alive = vi.fn();
    const identity = vi.fn();
    expect(isClaimRunnerDead(claim, alive, identity)).toBe(false);
    expect(alive).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });
});

describe('fix dispatch claim identity persistence and release', () => {
  let lockRoot;
  let claimOptions;
  beforeEach(() => {
    lockRoot = mkdtempSync(join(tmpdir(), 'pid-identity-test-'));
    claimOptions = { repo: 'we', pr: 42, kind: 'fix', owner: 'fixture-owner', lockRoot };
    expect(acquireFixDispatchClaim({
      ...claimOptions, pid: 111, borrowed: { executor: 'codex' },
      nowMs: NOW, nowIso: new Date(NOW).toISOString(),
    }).ok).toBe(true);
  });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('stamp stores runnerStart and runnerArgv', () => {
    const identityOf = vi.fn(() => { throw new Error('explicit identity must not require ps'); });
    expect(stampBorrowedRunnerPid({
      ...claimOptions, pid: PID, runnerStart: START, runnerArgv: ARGV, identityOf,
      nowIso: new Date(NOW).toISOString(),
    })).toBe(true);
    expect(readFixDispatchClaim(claimOptions).meta).toMatchObject({
      runnerPid: PID, runnerStart: START, runnerArgv: ARGV, repo: 'we', pr: 42,
    });
    expect(identityOf).not.toHaveBeenCalled();
  });

  it('stamp stores runnerStart and runnerArgv from injectable identityOf when omitted', () => {
    const identityOf = vi.fn(() => ({ runnerStart: START, runnerArgv: ARGV }));
    expect(stampBorrowedRunnerPid({ ...claimOptions, pid: PID, identityOf })).toBe(true);
    expect(identityOf).toHaveBeenCalledWith(PID);
    expect(readFixDispatchClaim(claimOptions).meta).toMatchObject({
      runnerPid: PID, runnerStart: START, runnerArgv: ARGV,
    });
  });

  it('stamp cannot overwrite a different owner identity', () => {
    const identityOf = vi.fn();
    expect(stampBorrowedRunnerPid({ ...claimOptions, owner: 'other', pid: PID, identityOf })).toBe(false);
    expect(readFixDispatchClaim(claimOptions).meta.runnerPid).toBeUndefined();
    expect(identityOf).not.toHaveBeenCalled();
  });

  // Seed persisted metadata directly so refresh coverage does not depend on the new stamp API.
  function seedRunner(meta = {}) {
    const current = readFixDispatchClaim(claimOptions);
    expect(heartbeat(lockRoot, fixDispatchResource(claimOptions), current.owner,
      new Date(NOW).toISOString(), current.pid, { ...current.meta, runnerPid: PID, ...meta })).toBe(true);
  }

  function refresh(identity) {
    return refreshLiveFixDispatchClaims({
      lockRoot, alive: () => true, identity, listAgentsAll: () => [],
      hungInfoFor: () => null, awaitingVerifyFor: null,
      nowMs: NOW + 1000, nowIso: () => new Date(NOW + 1000).toISOString(),
    });
  }

  it('refresh releases a start-mismatched claim with a logged reason', () => {
    seedRunner({ runnerStart: START, runnerArgv: ARGV });
    const identity = vi.fn(() => ({ alive: false, reason: 'start-mismatch' }));
    const result = refresh(identity);
    expect(result.released).toEqual([expect.objectContaining({
      repo: 'we', pr: 42, kind: 'fix', owner: 'fixture-owner',
      reason: expect.stringContaining('start-mismatch'),
    })]);
    expect(result.refreshed).toEqual([]);
    expect(readFixDispatchClaim(claimOptions)).toBeNull();
    expect(identity).toHaveBeenCalledWith(PID, { expectStart: START, expectArgv: ARGV });
  });

  it('refresh keeps a legacy claim with undeterminable identity alive for TTL expiry', () => {
    seedRunner();
    const identity = vi.fn(() => ({ alive: null, reason: 'unreadable' }));
    const result = refresh(identity);
    expect(result.released ?? []).toEqual([]);
    expect(result.refreshed).toHaveLength(1);
    expect(readFixDispatchClaim(claimOptions).meta.runnerPid).toBe(PID);
    expect(identity).toHaveBeenCalled();
  });
});
