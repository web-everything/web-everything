import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { keepAliveScript } from '../test-keepalive.mjs';
import * as barrier from '../daemon-generation-barrier.mjs';
import {
  awaitGroupDeath, decidePromotion, mayHandOver, settleDecision,
} from '../daemon-generation-barrier.mjs';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (code) => Object.assign(new Error(code), { code });

it('exports only the group probe and evidence-gated handover API', () => {
  expect(Object.keys(barrier).sort()).toEqual([
    'DEFAULT_GH_REQUEST_TIMEOUT_MS', 'GROUP_DEATH_TIMEOUT_MS', 'GROUP_PROBE_MS', 'HANDOVER_EXIT_CODE',
    'awaitGroupDeath', 'decidePromotion', 'mayHandOver', 'settleDecision',
  ]);
});

// Host capability, measured with raw kill(-pgid, 0) and NOT with the code under test: a container whose pid 1 never
// reaps leaves an exited orphan as a zombie, so a real group never reads ESRCH there (the Forge exec container).
const canReap = await (async () => {
  const childScript = keepAliveScript({ maxLifetimeMs: 3000, postlude: 'setTimeout(() => process.exit(0), 50);' });
  const l = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});process.exit(0)`], { detached: true, stdio: 'ignore' });
  await new Promise((r) => l.on('exit', r));
  for (let i = 0; i < 100; i++) {
    try { process.kill(-l.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') return true;
      if (e.code !== 'EPERM') return false;
    }
    await realSleep(20);
  }
  return false;
})();

describe('awaitGroupDeath', () => {
  it.each([undefined, null, -2, 0, 1, 1.5, NaN, Infinity, '4242'])(
    'refuses unsafe pgid %s before probing', async (pgid) => {
      let probes = 0;
      expect(await awaitGroupDeath({ pgid, identity: 'n', probeIdentity: () => { probes++; return null; },
        killGroup: () => { probes++; throw errCode('ESRCH'); }, sleep: async () => {} })).toBe('unknown');
      expect(probes).toBe(0);
    });
  it.each([
    { probeMs: 0 }, { probeMs: -1 }, { probeMs: NaN }, { probeMs: '10' },
    { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: '10' },
    { identity: '' },
  ])('refuses invalid proof inputs %j before probing', async (patch) => {
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => { probes++; return null; },
      killGroup: () => { probes++; throw errCode('ESRCH'); }, sleep: async () => {}, ...patch })).toBe('unknown');
    expect(probes).toBe(0);
  });
  it.skipIf(!canReap)('is dead after a straggler grandchild of a real group exits', async () => {
    const childScript = keepAliveScript({ maxLifetimeMs: 3000, postlude: 'setTimeout(() => process.exit(0), 400);' });
    const leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),50)`], { detached: true, stdio: 'ignore' });
    const pgid = leader.pid;
    await new Promise((r) => leader.on('exit', r));
    expect(() => process.kill(-pgid, 0)).not.toThrow(); // grandchild still alive
    const res = await awaitGroupDeath({ pgid, identity: 'n1', probeIdentity: () => null, killGroup: (p, s) => process.kill(-p, s), sleep: realSleep, probeMs: 20, timeoutMs: 3000 });
    expect(res).toBe('dead');
  }, 10_000);
  it('is alive at the timeout', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null, killGroup: () => {}, sleep: async () => {}, probeMs: 10, timeoutMs: 30 });
    expect(res).toBe('alive');
  });
  it('is unknown on a non-ESRCH probe error (EPERM)', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null, killGroup: () => { throw errCode('EPERM'); }, sleep: async () => {}, timeoutMs: 30 });
    expect(res).toBe('unknown');
  });
  it('keeps polling through EPERM then confirms ESRCH', async () => {
    const probes = ['EPERM', 'ESRCH'];
    let sleeps = 0;
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw errCode(probes.shift()); },
      sleep: async () => { sleeps++; }, probeMs: 10, timeoutMs: 30 });
    expect(res).toBe('dead');
    expect(sleeps).toBe(1);
    expect(probes).toEqual([]);
  });
  it('bounds persistent EPERM at the timeout', async () => {
    const waits = [];
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { probes++; throw errCode('EPERM'); },
      sleep: async (ms) => { waits.push(ms); }, probeMs: 10, timeoutMs: 25 })).toBe('unknown');
    expect(waits).toEqual([10, 10, 5]);
    expect(probes).toBe(4);
  });
  it.each([['reused', 'other'], ['unreadable', undefined]])('refuses %s identity after EPERM', async (_name, observed) => {
    const identities = [null, observed];
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => identities.shift(),
      killGroup: () => { probes++; throw errCode('EPERM'); }, sleep: async () => {},
      probeMs: 10, timeoutMs: 30 })).toBe('unknown');
    expect(probes).toBe(1);
  });
  it('returns unknown immediately for an unexpected probe error', async () => {
    let sleeps = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw errCode('EIO'); }, sleep: async () => { sleeps++; } })).toBe('unknown');
    expect(sleeps).toBe(0);
  });
  it.each([{ probeMs: Infinity }, { timeoutMs: Infinity }])('refuses an unbounded retry interval %j', async (patch) => {
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw new Error('must not probe'); }, sleep: async () => {}, ...patch })).toBe('unknown');
  });
  it.each([['recorded live leader', 'n'], ['undefined identity evidence', undefined]])(
    'refuses ESRCH with %s', async (_name, observed) => {
      expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => observed,
        killGroup: () => { throw errCode('ESRCH'); }, sleep: async () => {} })).toBe('unknown');
    });
  it('is unknown without a recorded start identity, or when the pgid was reused', async () => {
    const dead = () => { throw errCode('ESRCH'); };
    expect(await awaitGroupDeath({ pgid: 4242, probeIdentity: () => null, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', killGroup: dead, sleep: async () => {} })).toBe('unknown'); // no identity probe
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => 'b', killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => { throw new Error('x'); }, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => null, killGroup: dead, sleep: async () => {} })).toBe('dead');
  });
});

describe('decidePromotion', () => {
  const good = { exitCode: 77, groupDeath: 'dead', escapeEvidence: 'confirmed', recordWritten: true, inFlight: 0, nowMs: 1000, expectedDigest: 'd1', candidate: { pid: 9, alive: true, ready: true, codeDigest: 'd1' } };
  const clean = { ...good, nowMs: 0, expectedDigest: 'd', candidate: { pid: 4242, alive: true, ready: true, codeDigest: 'd' } };
  it('promotes a clean handover with no wait', () => {
    expect(decidePromotion(good)).toMatchObject({ promote: true, waitMs: 0, reconcileFirst: false });
  });
  it.each([undefined, null, 'unknown', 'Confirmed', true, 'confirmed '])('refuses without confirmed escape evidence (%s)', (escapeEvidence) => {
    expect(decidePromotion({ ...clean, escapeEvidence })).toEqual({ promote: false, reason: 'escape-unconfirmed' });
  });
  it('promotes a clean handover only with confirmed escape evidence', () => {
    expect(decidePromotion(clean)).toEqual({ promote: true, to: clean.candidate, waitMs: 0, reconcileFirst: false });
  });
  it('checks group death before escape evidence', () => {
    expect(decidePromotion({ ...good, groupDeath: 'alive', escapeEvidence: undefined })).toEqual({ promote: false, reason: 'group-alive' });
  });
  it.each([
    ['group alive', { groupDeath: 'alive' }, 'group-alive'],
    ['group unknown (EPERM)', { groupDeath: 'unknown' }, 'group-death-unknown'],
    ['group missing', { groupDeath: undefined }, 'group-death-unknown'],
    ['record not written', { recordWritten: false }, 'record-not-written'],
    ['record missing', { recordWritten: undefined }, 'record-not-written'],
    ['candidate dead', { candidate: { ...good.candidate, alive: false } }, 'candidate-dead'],
    ['candidate not ready', { candidate: { ...good.candidate, ready: false } }, 'candidate-not-ready'],
    ['candidate missing', { candidate: undefined }, 'candidate-dead'],
    ['digest mismatch', { candidate: { ...good.candidate, codeDigest: 'zz' } }, 'digest-mismatch'],
    ['expected digest missing', { expectedDigest: undefined }, 'digest-mismatch'],
    ['in-flight unknown', { inFlight: undefined }, 'in-flight-unknown'],
    ['in-flight negative', { inFlight: -1 }, 'in-flight-unknown'],
    ['exit code unknown', { exitCode: undefined }, 'exit-code-unknown'],
    ['exit code NaN', { exitCode: NaN }, 'exit-code-unknown'],
    ['candidate pid 0', { candidate: { ...good.candidate, pid: 0 } }, 'candidate-dead'],
    ['candidate pid negative', { candidate: { ...good.candidate, pid: -5 } }, 'candidate-dead'],
  ])('refuses on %s', (_n, patch, reason) => {
    expect(decidePromotion({ ...good, ...patch })).toEqual({ promote: false, reason });
  });
  it('an unclean blue (exit != 77, or in flight) promotes only with a settle wait and reconcile-first', () => {
    for (const patch of [{ exitCode: 1 }, { exitCode: 137 }, { inFlight: 2 }]) {
      const r = decidePromotion({ ...good, ...patch, lastSendAt: 900, ghRequestTimeoutMs: 5000 });
      expect(r).toMatchObject({ promote: true, reconcileFirst: true, waitMs: 4900 });
    }
  });
  it('forwards a caller settle wait longer than the gh timeout', () => {
    expect(decidePromotion({ ...good, exitCode: 1, lastSendAt: 900, ghRequestTimeoutMs: 5000, settleMs: 9000 }))
      .toMatchObject({ promote: true, reconcileFirst: true, waitMs: 8900 });
  });
});

describe('settleDecision', () => {
  it('is clean only on exit 77 with inFlight 0', () => {
    expect(settleDecision({ exitCode: 77, inFlight: 0, nowMs: 1 })).toMatchObject({ clean: true, waitMs: 0 });
    expect(settleDecision({ exitCode: 77, inFlight: 1, nowMs: 1 }).clean).toBe(false);
    expect(settleDecision({ exitCode: 77, nowMs: 1 }).clean).toBe(false);
  });
  it('waits at least the gh timeout after the last send, never less than the settle bound', () => {
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 3000, ghRequestTimeoutMs: 5000 }).waitMs).toBe(2000);
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 3000, ghRequestTimeoutMs: 5000, settleMs: 9000 }).waitMs).toBe(6000);
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 99999, ghRequestTimeoutMs: 5000 }).waitMs).toBe(0);
  });
  it('a zero, negative or NaN gh timeout falls back to the default bound', () => {
    for (const t of [0, -1, NaN, null]) expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 0, ghRequestTimeoutMs: t }).waitMs).toBe(120000);
  });
  it('an unknown last-send time waits the full bound from now, and reconciles first', () => {
    expect(settleDecision({ exitCode: null, inFlight: 1, nowMs: 3000, ghRequestTimeoutMs: 5000 })).toEqual({ waitMs: 5000, reconcileFirst: true, clean: false });
  });
});

describe('mayHandOver', () => {
  const ok = { holdingLease: true, paused: false, currentChild: null, eoeIdle: true, sourcesStopped: true };
  it('allows only at a clean boundary', () => expect(mayHandOver(ok)).toEqual({ ok: true }));
  it.each([
    ['a child', { currentChild: { pid: 1 } }],
    ['eoe busy', { eoeIdle: false }],
    ['sources live', { sourcesStopped: false }],
    ['paused', { paused: true }],
    ['lease not held', { holdingLease: false }],
    ['absent state', { holdingLease: undefined }],
    ['paused field missing', { paused: undefined }],
    ['currentChild field missing', { currentChild: undefined }],
  ])('refuses with %s', (_n, patch) => expect(mayHandOver({ ...ok, ...patch }).ok).toBe(false));
});
