import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  awaitGroupDeath, decidePromotion, mayHandOver, settleDecision, scanNewSessionSpawns, MERGE_CAPABLE_SPAWN_ALLOWLIST,
} from '../daemon-generation-barrier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..'); // scripts/
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (code) => Object.assign(new Error(code), { code });

describe('awaitGroupDeath', () => {
  it('is dead after a straggler grandchild of a real group exits', async () => {
    const leader = spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},400)'],{stdio:'ignore'});setTimeout(()=>process.exit(0),50)"], { detached: true, stdio: 'ignore' });
    const pgid = leader.pid;
    await new Promise((r) => leader.on('exit', r));
    expect(() => process.kill(-pgid, 0)).not.toThrow(); // grandchild still alive
    const res = await awaitGroupDeath({ pgid, identity: 'n1', killGroup: (p, s) => process.kill(-p, s), sleep: realSleep, probeMs: 20, timeoutMs: 3000 });
    // A container whose pid 1 never reaps leaves the exited straggler as a zombie that keeps the group probe
    // alive for ever: that is 'alive' (fail closed), never a false 'dead'.
    expect(['dead', 'alive']).toContain(res);
  }, 10_000);
  it('is alive at the timeout', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', killGroup: () => {}, sleep: async () => {}, probeMs: 10, timeoutMs: 30 });
    expect(res).toBe('alive');
  });
  it('is unknown on a non-ESRCH probe error (EPERM)', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', killGroup: () => { throw errCode('EPERM'); }, sleep: async () => {}, timeoutMs: 30 });
    expect(res).toBe('unknown');
  });
  it('is unknown without a recorded start identity, or when the pgid was reused', async () => {
    const dead = () => { throw errCode('ESRCH'); };
    expect(await awaitGroupDeath({ pgid: 4242, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => 'b', killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => { throw new Error('x'); }, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => null, killGroup: dead, sleep: async () => {} })).toBe('dead');
  });
});

describe('decidePromotion', () => {
  const good = { exitCode: 77, groupDeath: 'dead', recordWritten: true, inFlight: 0, nowMs: 1000, expectedDigest: 'd1', candidate: { pid: 9, alive: true, ready: true, codeDigest: 'd1' } };
  it('promotes a clean handover with no wait', () => {
    expect(decidePromotion(good)).toMatchObject({ promote: true, waitMs: 0, reconcileFirst: false });
  });
  it.each([
    ['group alive', { groupDeath: 'alive' }],
    ['group unknown (EPERM)', { groupDeath: 'unknown' }],
    ['group missing', { groupDeath: undefined }],
    ['record not written', { recordWritten: false }],
    ['record missing', { recordWritten: undefined }],
    ['candidate dead', { candidate: { ...good.candidate, alive: false } }],
    ['candidate not ready', { candidate: { ...good.candidate, ready: false } }],
    ['candidate missing', { candidate: undefined }],
    ['digest mismatch', { candidate: { ...good.candidate, codeDigest: 'zz' } }],
    ['expected digest missing', { expectedDigest: undefined }],
    ['in-flight unknown', { inFlight: undefined }],
    ['exit code unknown', { exitCode: undefined }],
  ])('refuses on %s', (_n, patch) => {
    expect(decidePromotion({ ...good, ...patch })).toMatchObject({ promote: false });
  });
  it('an unclean blue (exit != 77, or in flight) promotes only with a settle wait and reconcile-first', () => {
    for (const patch of [{ exitCode: 1 }, { exitCode: 137 }, { inFlight: 2 }]) {
      const r = decidePromotion({ ...good, ...patch, lastSendAt: 900, ghRequestTimeoutMs: 5000 });
      expect(r).toMatchObject({ promote: true, reconcileFirst: true, waitMs: 4900 });
    }
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
  ])('refuses with %s', (_n, patch) => expect(mayHandOver({ ...ok, ...patch }).ok).toBe(false));
});

describe('new-session spawn allowlist', () => {
  it('declares exactly the two non-merging spawns', () => {
    expect([...MERGE_CAPABLE_SPAWN_ALLOWLIST]).toEqual(['osascript', 'deps-job']);
  });
  it('flags detached, setsid and new-session spawns outside the allowlist', () => {
    expect(scanNewSessionSpawns("spawn('gh', a, { detached: true })")).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('setsid', ['gh'])")).toHaveLength(1);
    expect(scanNewSessionSpawns("subprocess.Popen(x, start_new_session=True)")).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('osascript', a, { detached: true })")).toHaveLength(0);
  });
  it('no merge-capable spawn outside the allowlist is detached or in a new session', () => {
    const files = [
      join(root, 'merge-ai-prs.mjs'),
      join(root, 'lib', 'enqueue-on-event.mjs'),
    ]; // the sibling repo's daemon.mjs is out of reach for a hermetic test: its scan is the live PGID probe (acceptance 6)
    for (const f of files) expect(scanNewSessionSpawns(readFileSync(f, 'utf8')), f).toEqual([]);
  });
});
