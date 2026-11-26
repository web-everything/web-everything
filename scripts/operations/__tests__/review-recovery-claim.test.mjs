/** Real filesystem locks and child processes; no daemon or GitHub access. */
import { describe, it, expect, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEAD_OWNER, RECOVERY_OWNER } from '../__fixtures__/stranded-record.fixture.mjs';
import { pidIdentity } from '../../lib/pid-alive.mjs';

const dirs = [], children = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function api() {
  const moduleUrl = new URL('../review-recovery-claim.mjs', import.meta.url);
  expect(existsSync(moduleUrl), 'recovery must have a shared lock-protected claim home').toBe(true);
  const module = await import(/* @vite-ignore */ moduleUrl.href);
  for (const name of ['createRecoveryHandoff', 'acquireRecoveryClaim', 'releaseRecoveryClaim', 'isProvablyDeadOwner'])
    expect(module[name], name).toBeTypeOf('function');
  return module;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'review-recovery-claim-')); dirs.push(dir);
  const runId = '2a0c266d', path = join(dir, `${runId}.recovery.claim`);
  const options = { dir, runId, owner: RECOVERY_OWNER, now: () => Date.parse('2026-11-26T16:00:00Z'),
    pidIdentity: () => ({ alive: false, reason: 'gone' }) };
  return { dir, path, options, read: () => JSON.parse(readFileSync(path, 'utf8')),
    write: c => writeFileSync(path, JSON.stringify(c)) };
}
function message(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('claim child timed out')); }, 10_000);
    const onMessage = m => { cleanup(); resolve(m); };
    const onExit = (code, signal) => { cleanup(); reject(Error(`claim child exited ${code}/${signal}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.once('message', onMessage); child.once('exit', onExit);
  });
}
async function child(f, token) {
  const proc = fork(fileURLToPath(new URL('../__fixtures__/recovery-claim-child.fixture.mjs', import.meta.url)),
    [f.dir, f.options.runId, token], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
  children.push(proc);
  expect(await message(proc)).toMatchObject({ ready: true });
  return proc;
}

describe('exclusive review recovery claims', () => {
  it('two processes, one recovery writer', async () => {
    const m = await api(), f = fixture();
    const handoff = await m.createRecoveryHandoff(f.options);
    expect(handoff).toMatchObject({ ok: true, token: expect.any(String) });
    expect(f.read()).toMatchObject({ holder: 'handoff', token: handoff.token, sweepOwner: RECOVERY_OWNER });
    const a = await child(f, handoff.token), b = await child(f, handoff.token);
    const results = [message(a), message(b)]; a.send('acquire'); b.send('acquire');
    const answers = await Promise.all(results);
    expect(answers.filter(r => r.ok)).toHaveLength(1);
    expect(answers.filter(r => r.ok === false)).toHaveLength(1);
    const winner = answers.find(r => r.ok);
    expect(f.read()).toMatchObject({ token: handoff.token, holder: { pid: winner.owner.pid } });
    expect(f.read().holder).not.toBe('handoff');
  });

  it('handoff holder + token are required and only one child may swap', async () => {
    const m = await api(), f = fixture();
    const h = await m.createRecoveryHandoff(f.options), original = f.read();
    expect((await m.acquireRecoveryClaim({ ...f.options, token: 'wrong-token' })).ok).toBe(false);
    expect(f.read()).toEqual(original);
    expect((await m.acquireRecoveryClaim({ ...f.options, token: h.token })).ok).toBe(true);
    expect(f.read()).toMatchObject({ token: h.token, holder: RECOVERY_OWNER });
    // A matching token alone cannot authorize a second swap, even with dead-holder IO.
    expect((await m.acquireRecoveryClaim({ ...f.options, token: h.token, owner: DEAD_OWNER })).ok).toBe(false);
    expect((await m.releaseRecoveryClaim({ ...f.options, token: 'wrong-token' })).ok).toBe(false);
    expect((await m.releaseRecoveryClaim({ ...f.options, token: h.token, owner: DEAD_OWNER })).ok).toBe(false);
    expect(f.read().holder).toEqual(RECOVERY_OWNER);
    expect((await m.releaseRecoveryClaim({ ...f.options, token: h.token })).ok).toBe(true);
  });

  it.each([0, 600_000, 600_001])('stale handoff replaced only after ten minutes under the lock: age=%s', async age => {
    const m = await api(), f = fixture();
    const old = { holder: 'handoff', token: 'old', sweepOwner: DEAD_OWNER,
      createdAt: new Date(f.options.now() - age).toISOString() }; f.write(old);
    const result = await m.createRecoveryHandoff(f.options);
    expect(result.ok).toBe(age > 600_000);
    if (age <= 600_000) expect(f.read()).toEqual(old);
    else { expect(f.read().token).not.toBe('old'); expect(f.read().holder).toBe('handoff'); }
  });

  it.each([false, true, null])('dead holder replaced, live/unknown holder retained: alive=%s', async alive => {
    const m = await api(), f = fixture();
    const old = { holder: DEAD_OWNER, token: 'held', createdAt: '2026-11-26T12:00:00Z' }; f.write(old);
    const result = await m.createRecoveryHandoff({ ...f.options, pidIdentity: () => ({ alive }) });
    expect(result.ok).toBe(alive === false);
    if (alive !== false) expect(f.read()).toEqual(old);
  });

  it.each([null, {}, { holder: 'handoff' }, { holder: { pid: -1 }, token: 'x' },
    { holder: 'handoff', token: 'x', createdAt: 'invalid' }])('malformed claim refuses: %j', async claim => {
    const m = await api(), f = fixture(); f.write(claim);
    expect((await m.createRecoveryHandoff(f.options)).ok).toBe(false);
    expect((await m.acquireRecoveryClaim({ ...f.options, token: 'x' })).ok).toBe(false);
    expect(f.read()).toEqual(claim);
  });

  it.each([
    undefined, {}, { ...DEAD_OWNER, pid: '1' }, { ...DEAD_OWNER, procStart: null },
    { ...DEAD_OWNER, host: 'foreign' }, { ...DEAD_OWNER, namespace: 'foreign' },
    { ...DEAD_OWNER, namespace: null },
  ])('malformed/unstamped/foreign/null owner is not provably dead: %j', async owner => {
    const m = await api();
    expect(await m.isProvablyDeadOwner(owner, { owner: RECOVERY_OWNER, pidIdentity: () => ({ alive: false }) })).toBe(false);
  });

  it.each([[null, 'pid:[123]'], ['pid:[123]', null], [null, null]])('null namespace on either side refuses (%s, %s)', async (a, b) => {
    const m = await api();
    expect(await m.isProvablyDeadOwner({ ...DEAD_OWNER, namespace: a },
      { owner: { ...RECOVERY_OWNER, namespace: b }, pidIdentity: () => ({ alive: false }) })).toBe(false);
  });

  it('pid reuse with mismatched start time proves the stamped owner dead', async () => {
    const m = await api(); let expected;
    const identity = (pid, options) => {
      expected = options.expectStart;
      return pidIdentity(pid, { ...options, exec: () => 'S Thu Nov 26 15:00:00 2026 node replacement.mjs' });
    };
    expect(await m.isProvablyDeadOwner(DEAD_OWNER, { owner: RECOVERY_OWNER, pidIdentity: identity })).toBe(true);
    expect(expected).toBe(DEAD_OWNER.procStart);
  });

  it('child death while daemon survives permits takeover of the child holder', async () => {
    const m = await api(), f = fixture();
    const h = await m.createRecoveryHandoff(f.options), proc = await child(f, h.token);
    const result = message(proc); proc.send('acquire'); expect((await result).ok).toBe(true);
    const old = f.read();
    const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited;
    expect(process.pid).not.toBe(proc.pid); // the sweep/parent is still executing
    const result2 = await m.createRecoveryHandoff({ ...f.options, pidIdentity });
    expect(result2.ok).toBe(true); expect(f.read().token).not.toBe(old.token);
  });

  it('daemon death while child survives retains the child holder', async () => {
    const m = await api(), f = fixture();
    // A separate real process supplies the daemon identity, then dies after handoff.
    const daemon = await child(f, 'unused');
    const identityMessage = message(daemon); daemon.send('identity'); const { owner } = await identityMessage;
    const h = await m.createRecoveryHandoff({ ...f.options, owner });
    const worker = await child(f, h.token), result = message(worker); worker.send('acquire');
    expect((await result).ok).toBe(true);
    const original = f.read(), exited = once(daemon, 'exit'); daemon.kill('SIGKILL'); await exited;
    expect((await m.createRecoveryHandoff({ ...f.options, pidIdentity })).ok).toBe(false);
    expect(f.read()).toEqual(original);
  });

  it('stale handoff >10 min is replaced only under lock by one of two sweep processes', async () => {
    await api(); const f = fixture();
    f.write({ holder: 'handoff', token: 'abandoned', sweepOwner: DEAD_OWNER, createdAt: '2000-01-01T00:00:00Z' });
    const a = await child(f, 'unused'), b = await child(f, 'unused');
    const results = [message(a), message(b)]; a.send('handoff'); b.send('handoff');
    const answers = await Promise.all(results);
    expect(answers.filter(r => r.ok)).toHaveLength(1);
    expect(answers.filter(r => r.ok === false)).toHaveLength(1);
    expect(f.read().token).toBe(answers.find(r => r.ok).token);
    expect(f.read().token).not.toBe('abandoned');
  });

});
