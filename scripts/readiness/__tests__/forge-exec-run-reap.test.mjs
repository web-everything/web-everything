// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, readdir, utimes, realpath, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createRunner, uidBusy} from '../forge-exec-run.mjs';
// R333: the runner reaps leaked reservations/receipts only on proof the owner is gone.
let root, receipts, probe, calls;
const nonce = 'a'.repeat(32);
const runId = n => 'r-' + String(n).padStart(32, '0');
const exists = path => stat(path).then(() => true, () => false);
function makeRunner() {
  return createRunner({testRoot: root, testPath: '/usr/bin:/bin', testReapProbe: probe,
    testWorkerIdentity: async user => ({uid: 20000 + Number(user.slice(11)), gid: 30000 + Number(user.slice(11)), groups: [30000 + Number(user.slice(11))]}),
    testSlotStat: async path => ({isSymbolicLink: () => false, isDirectory: () => true, mode: 0o40710, uid: process.getuid(), gid: 30000 + Number(path.slice(-1))})});
}
// Writes one reservation lock plus its protected run record, like a run that leaked.
async function leak(slot, n, {owner, phase = 'running', ageMs = 0} = {}) {
  const run = runId(n), lock = join(receipts, 'worker-active-' + slot);
  await mkdir(lock, {mode: 0o700});
  await writeFile(join(lock, 'reservation.json'), JSON.stringify({run, nonce, slot: 'forge-exec-' + slot, writerGuard: 1}));
  const file = join(receipts, run + '.' + phase);
  await writeFile(file, JSON.stringify({v: 1, nonce, run, slot: 'forge-exec-' + slot, ...(owner ? {owner} : {})}));
  if (ageMs) for (const path of [file, join(lock, 'reservation.json'), lock]) await utimes(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return {run, lock, file};
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.TMPDIR, 'forge-reap-')));
  receipts = join(root, 'receipts');
  calls = {unit: 0};
  probe = {start: async () => undefined, uidBusy: async () => false, unitActive: async () => { calls.unit++; return undefined; }};
  for (const slot of [1, 2]) await mkdir(join(root, 'runs', 'slot-' + slot), {recursive: true, mode: 0o710});
  await mkdir(receipts, {mode: 0o700});
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
const owner = {pid: 4242, start: '777'};
describe('forge leaked-state reaper', () => {
  it('reaps a run whose pid is dead, logs it, and reports zero live runs', async () => {
    const dead = await leak(1, 1, {owner});
    probe.start = async () => null;
    const telemetry = await makeRunner().telemetry();
    expect(telemetry.activeRuns).toBe(0);
    expect(await exists(dead.lock)).toBe(false);
    expect(await exists(dead.file)).toBe(false);
    expect((await readdir(receipts)).filter(n => n.includes('.tomb-'))).toEqual([]);
    expect(await readFile(join(receipts, 'reap-audit.log'), 'utf8')).toContain('worker-active-1 run=' + dead.run);
  });
  it('reaps a run whose pid was reused by a process with a different start time', async () => {
    const reused = await leak(1, 2, {owner});
    probe.start = async () => '999';
    expect((await makeRunner().telemetry()).activeRuns).toBe(0);
    expect(await exists(reused.lock)).toBe(false);
  });
  it('reaps a run whose unit is inactive when the pid cannot be read', async () => {
    const unit = 'forge-exec-run-' + 'b'.repeat(32);
    const gone = await leak(1, 3, {owner: {...owner, unit}});
    probe.unitActive = async () => false;
    expect((await makeRunner().telemetry()).activeRuns).toBe(0);
    expect(await exists(gone.lock)).toBe(false);
  });
  it('keeps a live run even when its unit looks inactive between commands', async () => {
    const live = await leak(1, 4, {owner: {...owner, unit: 'forge-exec-run-' + 'c'.repeat(32)}});
    probe.start = async () => owner.start;
    probe.unitActive = async () => false;
    expect((await makeRunner().telemetry()).activeRuns).toBe(1);
    expect(await exists(live.lock)).toBe(true);
    expect(await exists(live.file)).toBe(true);
  });
  it('fails closed: unprovable entries stay and still count', async () => {
    const unreadable = await leak(1, 5, {owner: {...owner, unit: 'forge-exec-run-' + 'd'.repeat(32)}});
    const young = await leak(2, 6, {});
    const telemetry = await makeRunner().telemetry();
    expect(telemetry.activeRuns).toBe(2);
    for (const entry of [unreadable, young]) expect(await exists(entry.lock)).toBe(true);
    expect(await exists(join(receipts, 'reap-audit.log'))).toBe(false);
  });
  it('keeps an aged ownerless entry while its slot uid still has processes', async () => {
    const busy = await leak(1, 7, {ageMs: 3600e3});
    probe.uidBusy = async () => true;
    expect((await makeRunner().telemetry()).activeRuns).toBe(1);
    expect(await exists(busy.lock)).toBe(true);
  });
  it('reaps the Oct 31 shape: an aged ownerless lock and receipt with a quiet slot', async () => {
    const old = await leak(1, 8, {ageMs: 3600e3});
    expect((await makeRunner().telemetry()).activeRuns).toBe(0);
    expect(await exists(old.lock)).toBe(false);
    expect(await exists(old.file)).toBe(false);
  });
  it('never reaps a run whose reservation lease is held', async () => {
    const held = await leak(1, 9, {owner});
    probe.start = async () => null;
    const runner = makeRunner();
    await runner.telemetry().catch(() => {});
    const again = await leak(2, 10, {owner});
    // A lease holder (shared flock) makes the exclusive reap attempt back off.
    const {spawn} = await import('node:child_process');
    await writeFile(join(receipts, '.worker-active-2.writer'), '', {mode: 0o600});
    const holder = spawn('/usr/bin/python3', ['-I', '-c', 'import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_SH); print("ok", flush=True); sys.stdin.read()', join(receipts, '.worker-active-2.writer')], {stdio: ['pipe', 'pipe', 'inherit']});
    await new Promise(resolve => holder.stdout.once('data', resolve));
    try {
      expect((await runner.telemetry()).activeRuns).toBe(1);
      expect(await exists(again.lock)).toBe(true);
    } finally { holder.stdin.end(); }
    expect(held.run).toBeTruthy();
  });
  it('lets a new run start during a reap and keeps it', async () => {
    const dead = await leak(1, 11, {owner});
    let release, blocked;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { blocked = resolve; });
    let first = true;
    probe.start = async () => { if (first) { first = false; blocked(); await gate; } return null; };
    const runner = makeRunner();
    const reaping = runner.telemetry();
    await entered;
    const fresh = await runner.prepare({nonce: 'e'.repeat(32), label: 'abcdef-1'});
    release();
    await reaping;
    expect(await exists(dead.file)).toBe(false);
    expect(fresh.slot).toBeTruthy();
    const slot = fresh.slot.slice('forge-exec-'.length);
    expect(JSON.parse(await readFile(join(receipts, 'worker-active-' + slot, 'reservation.json'), 'utf8')).run).toBe(fresh.run);
    expect(await exists(join(receipts, fresh.run + '.prepared'))).toBe(true);
    expect((await runner.telemetry()).activeRuns).toBe(1);
  });
  it('reaps an orphan record with no reservation, but keeps it when the reservation is unreadable or the slot is busy', async () => {
    const orphan = join(receipts, runId(12) + '.running');
    await writeFile(orphan, JSON.stringify({v: 1, nonce, run: runId(12), slot: 'forge-exec-1', owner}));
    probe.start = async () => null;
    probe.uidBusy = async () => true;
    await makeRunner().telemetry();
    expect(await exists(orphan)).toBe(true); // slot uid busy: keep
    probe.uidBusy = async () => false;
    await mkdir(join(receipts, 'worker-active-1'), {mode: 0o700});
    await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), '{not json');
    await makeRunner().telemetry();
    expect(await exists(orphan)).toBe(true); // unreadable reservation: keep
    await rm(join(receipts, 'worker-active-1'), {recursive: true});
    expect((await makeRunner().telemetry()).activeRuns).toBe(0);
    expect(await exists(orphan)).toBe(false);
  });
  it('never reaps a slotless lock: a dead owner does not prove its descendants gone', async () => {
    const lock = join(receipts, 'worker-active');
    await mkdir(lock, {mode: 0o700});
    await writeFile(join(lock, 'reservation.json'), JSON.stringify({run: runId(13), nonce, writerGuard: 1}));
    await writeFile(join(receipts, runId(13) + '.running'), JSON.stringify({v: 1, nonce, run: runId(13), owner}));
    probe.start = async () => null;
    expect((await makeRunner().telemetry()).activeRuns).toBe(1);
    expect(await exists(lock)).toBe(true);
  });
  it.runIf(process.platform === 'linux')('sees a live process by its credentials, and a uid with none as idle', async () => {
    expect(await uidBusy(process.getuid())).toBe(true);
    expect(await uidBusy(4000000123)).toBe(false);
  });
  it('keeps empty, malformed and pre-lease reservations even when old and idle', async () => {
    const old = new Date(Date.now() - 3600e3);
    const empty = join(receipts, 'worker-active-1'), preLease = join(receipts, 'worker-active-2');
    await mkdir(empty, {mode: 0o700});
    await mkdir(preLease, {mode: 0o700});
    await writeFile(join(preLease, 'reservation.json'), JSON.stringify({run: runId(14), nonce, slot: 'forge-exec-2'}));
    for (const path of [join(preLease, 'reservation.json'), empty, preLease]) await utimes(path, old, old);
    await makeRunner().telemetry();
    expect(await exists(empty)).toBe(true);
    expect(await exists(preLease)).toBe(true);
  });
});
