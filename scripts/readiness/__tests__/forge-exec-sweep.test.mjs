// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm, utimes, stat, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sweep, DEFAULT_BUDGET} from '../forge-exec-sweep.mjs';
import {runSweepFixture, idleWorkerEvidence} from './fixtures/forge-sweep.mjs';

// R951c S3: per-RUN cleaning of slot run dirs, presync keys and receipts.
const H = 3_600_000, now = Date.UTC(2026, 10, 15, 12);
const run = n => 'r-' + String(n).padStart(32, '0');
const key = n => String(n).padStart(32, 'a');
const exists = p => stat(p).then(() => true, () => false);
let tmp, root, receipts;
const age = async (path, hours) => { const t = new Date(now - hours * H); await utimes(path, t, t); };
async function runDir(slot, n, hours, bytes = 100) {
  const dir = join(root, 'slot-' + slot, run(n));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'f'), 'x'.repeat(bytes));
  await age(join(dir, 'f'), hours); await age(dir, hours);
  return dir;
}
async function reserve(slot, n) {
  const dir = join(receipts, 'worker-active-' + slot);
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'reservation.json'), JSON.stringify({run: run(n), writerGuard: 1, slot: 'forge-exec-' + slot}));
}
async function receipt(name, hours) {
  const file = join(receipts, name); await writeFile(file, '{}'); await age(file, hours); return file;
}
async function presyncKey(n, hours) {
  const dir = join(root, 'presync', key(n));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'blob'), 'y'.repeat(50));
  await age(join(dir, 'blob'), hours); await age(dir, hours);
  return dir;
}
const free = {lock: async () => ({release: async () => {}})};
const go = (extra = {}) => sweep({root, receipts, now, apply: true, ...free, ...extra});
beforeEach(async () => {
  tmp = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'forge-exec-sweep-'));
  root = join(tmp, 'exec'); receipts = join(tmp, 'receipts');
  await mkdir(join(root, 'slot-1'), {recursive: true}); await mkdir(join(root, 'slot-2'), {recursive: true});
  await mkdir(join(root, 'presync'), {recursive: true}); await mkdir(receipts, {recursive: true});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(tmp, {recursive: true, force: true}); });

describe('production CLI safety defaults', () => {
  const cli = fileURLToPath(new URL('../forge-exec-sweep.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath,
    [cli, `--root=${root}`, `--receipts=${receipts}`, ...args], {encoding: 'utf8', timeout: 30_000});
  it('CLI defaults to dry-run without mode flags', async () => {
    const old = await runDir(1, 71, 500);
    const result = invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({apply: false, counts: {runDirs: 1}});
    expect(await exists(old)).toBe(true);
  });
  it('sweep defaults to dry-run when apply is omitted', async () => {
    const old = await runDir(1, 72, 50);
    expect(await sweep({root, receipts, now, ...free})).toMatchObject({apply: false, counts: {runDirs: 1}});
    expect(await exists(old)).toBe(true);
  });
  it('CLI emits refusal JSON and exits 1 while other consumers progress', async () => {
    const old = await runDir(1, 73, 500);
    await rm(join(root, 'presync'), {recursive: true});
    await writeFile(join(root, 'presync'), 'unsafe');
    const result = invoke('--apply');
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).refusals).toEqual([expect.objectContaining({consumer: 'presync'})]);
    expect(await exists(old)).toBe(false);
  });
  it('CLI rejects unknown flags with status 2', () => {
    const result = invoke('--unexpected');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('bad argument');
  });
});

describe('slot run dirs are cleaned per run, not per slot', () => {
  it('keeps the reserved run while other old runs in the same slot are deleted', async () => {
    const reserved = await runDir(1, 1, 50), old = await runDir(1, 2, 50), other = await runDir(2, 3, 50);
    await reserve(1, 1); await reserve(2, 9); // worker-active-K exists for every slot
    const summary = await go();
    expect(await exists(reserved)).toBe(true);
    expect(await exists(old)).toBe(false);
    expect(await exists(other)).toBe(false);
    expect(summary.counts.runDirs).toBe(2);
    expect(summary.bytes.runDirs).toBeGreaterThanOrEqual(200);
  });
  it('keeps a run with a live .prepared, .running or .receipt record', async () => {
    const dirs = [];
    for (const [i, phase] of ['prepared', 'running', 'receipt'].entries()) {
      dirs.push(await runDir(1, 10 + i, 50)); await receipt(run(10 + i) + '.' + phase, 50);
    }
    await go();
    for (const d of dirs) expect(await exists(d)).toBe(true);
  });
  it('keeps runs younger than the leak age (default 3 h) and deletes older', async () => {
    const young = await runDir(1, 20, 2), older = await runDir(1, 21, 4);
    await go();
    expect(await exists(young)).toBe(true);
    expect(await exists(older)).toBe(false);
    expect(DEFAULT_BUDGET.slots.leakAgeHours).toBe(3);
  });
  it('skips a slot whose lock is busy (a skip, not a refusal) and still cleans the others', async () => {
    const busy = await runDir(1, 30, 50), clean = await runDir(2, 31, 50);
    const summary = await go({lock: async name => name === 'worker-active-1' ? null : {release: async () => {}}});
    expect(await exists(busy)).toBe(true);
    expect(await exists(clean)).toBe(false);
    expect(summary.skips.filter(s => s.consumer === 'slots')).toEqual([expect.objectContaining({consumer: 'slots', slot: 'slot-1'})]);
    expect(summary.refusals).toEqual([]);
  });
  it('reads the reservation under the lock and releases it afterwards', async () => {
    const events = [];
    const old = await runDir(1, 40, 50);
    await reserve(1, 9);
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (path, ...args) => {
      if (path === join(receipts, 'worker-active-1', 'reservation.json')) events.push('read worker-active-1');
      return read(path, ...args);
    });
    await go({lock: async name => { events.push('lock ' + name); return {release: async () => { events.push('release ' + name); }}; }});
    expect(await exists(old)).toBe(false);
    expect(events.slice(0, 4)).toEqual(['lock worker-active-1', 'read worker-active-1', 'read worker-active-1', 'release worker-active-1']);
    for (let i = 0; i < events.length; i++) if (events[i] === 'read worker-active-1') {
      expect(events.slice(0, i).lastIndexOf('lock worker-active-1')).toBeGreaterThan(events.slice(0, i).lastIndexOf('release worker-active-1'));
    }
    expect(events.filter(e => e.startsWith('lock')).length).toBe(events.filter(e => e.startsWith('release')).length);
  });
  it('keeps everything in a slot whose reservation is unreadable', async () => {
    const dir = await runDir(1, 50, 50);
    await mkdir(join(receipts, 'worker-active-1'));
    await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), '{not json');
    const summary = await go();
    expect(await exists(dir)).toBe(true);
    expect(summary.skips.concat(summary.refusals).length).toBeGreaterThan(0);
  });
  it('does not follow a symlinked run entry', async () => {
    const outside = join(tmp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'k');
    await symlink(outside, join(root, 'slot-1', run(60)));
    await go();
    expect(await exists(join(outside, 'keep'))).toBe(true);
  });
  it('also cleans old unreserved warm- run dirs (previous cron namespace) and keeps a reserved one', async () => {
    const warm = n => join(root, 'slot-1', 'warm-' + String(n).padStart(32, '0'));
    await mkdir(warm(1)); await mkdir(warm(2)); await age(warm(1), 50); await age(warm(2), 50);
    await mkdir(join(receipts, 'worker-active-1'), {recursive: true});
    await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), JSON.stringify({run: 'warm-' + '2'.padStart(32, '0'), writerGuard: 1}));
    await go();
    expect(await exists(warm(1))).toBe(false);
    expect(await exists(warm(2))).toBe(true);
  });
  it('keeps a slot whose worker-active dir has no reservation.json or no writerGuard', async () => {
    const a = await runDir(1, 90, 50), b = await runDir(2, 91, 50);
    await mkdir(join(receipts, 'worker-active-1'));
    await mkdir(join(receipts, 'worker-active-2'));
    await writeFile(join(receipts, 'worker-active-2', 'reservation.json'), JSON.stringify({run: run(5)}));
    await go();
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });
  it('--dry-run (apply false) deletes nothing but reports the same candidates', async () => {
    const old = await runDir(1, 70, 50);
    const summary = await go({apply: false});
    expect(await exists(old)).toBe(true);
    expect(summary.apply).toBe(false);
    expect(summary.counts.runDirs).toBe(1);
    expect(summary.candidates.runDirs).toEqual([old.slice(root.length + 1)]);
  });
});

describe('presync keys', () => {
  it('deletes keys idle more than 72 h, keeps younger ones, never touches keys under 24 h', async () => {
    const stale = await presyncKey(1, 80), mid = await presyncKey(2, 30), young = await presyncKey(3, 5);
    const summary = await go();
    expect(await exists(stale)).toBe(false);
    expect(await exists(mid)).toBe(true);
    expect(await exists(young)).toBe(true);
    expect(summary.counts.presyncKeys).toBe(1);
  });
  it('with a byte cap, deletes oldest first but only keys idle at least 24 h', async () => {
    const a = await presyncKey(1, 60), b = await presyncKey(2, 40), c = await presyncKey(3, 2);
    await go({budget: {presync: {capBytes: 1}}});
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
    expect(await exists(c)).toBe(true);
  });
  it('a key with a recently written file inside stays even if its dir mtime is old', async () => {
    const dir = await presyncKey(4, 100);
    await age(join(dir, 'blob'), 1);
    await go();
    expect(await exists(dir)).toBe(true);
  });
  it('ignores entries that are not 32-hex keys', async () => {
    const odd = join(root, 'presync', 'not-a-key'); await mkdir(odd); await age(odd, 500);
    await go();
    expect(await exists(odd)).toBe(true);
  });
});

describe('receipts', () => {
  it('deletes .telemetry older than 48 h and .consumed older than 24 h only', async () => {
    const oldT = await receipt(run(1) + '.telemetry', 49), newT = await receipt(run(2) + '.telemetry', 30);
    const oldC = await receipt(run(3) + '.consumed', 25), newC = await receipt(run(4) + '.consumed', 10);
    await go();
    expect([await exists(oldT), await exists(newT), await exists(oldC), await exists(newC)]).toEqual([false, true, false, true]);
  });
  it('never touches the reserved run records, worker-active dirs or .writer locks', async () => {
    await reserve(1, 7);
    const mine = await receipt(run(7) + '.telemetry', 100);
    const writer = join(receipts, '.worker-active-1.writer'); await writeFile(writer, ''); await age(writer, 500);
    await go();
    expect(await exists(mine)).toBe(true);
    expect(await exists(writer)).toBe(true);
    expect(await exists(join(receipts, 'worker-active-1', 'reservation.json'))).toBe(true);
  });
  it('holds each free worker lease while it deletes receipts', async () => {
    const old = await receipt(run(1) + '.telemetry', 100);
    await mkdir(join(receipts, 'worker-active-1')); await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), JSON.stringify({run: run(9), writerGuard: 1}));
    const held = new Set(), seen = [], unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async path => {
      if (path === old) {
        expect([...held].sort()).toEqual(['worker-active-1', 'worker-active-2']);
        seen.push('delete');
      }
      return unlink(path);
    });
    await go({lock: async name => { seen.push('lock ' + name); held.add(name); return {release: async () => { seen.push('release ' + name); held.delete(name); }}; }});
    expect(seen.slice(seen.lastIndexOf('lock worker-active-1'))).toEqual(['lock worker-active-1', 'lock worker-active-2', 'delete', 'release worker-active-1', 'release worker-active-2']);
    expect(held.size).toBe(0);
  });
  it('preserves receipts while a slot lock is busy and has no published reservation, and keeps a malformed reserved run id', async () => {
    const old = await receipt(run(1) + '.telemetry', 100);
    await go({lock: async name => name === 'worker-active-1' ? null : {release: async () => {}}});
    expect(await exists(old)).toBe(true);
    const dir = await runDir(2, 5, 50);
    await mkdir(join(receipts, 'worker-active-2')); await writeFile(join(receipts, 'worker-active-2', 'reservation.json'), JSON.stringify({run: 'garbage', writerGuard: 1}));
    await go();
    expect(await exists(dir)).toBe(true);
  });
  it('holds a 5,000-file cap per sweep', async () => {
    for (let i = 0; i < 5_050; i++) await writeFile(join(receipts, run(i) + '.consumed'), '{}');
    const files = (await import('node:fs/promises')).readdir;
    const t = new Date(now - 100 * H);
    await Promise.all((await files(receipts)).map(f => utimes(join(receipts, f), t, t)));
    const summary = await go();
    expect(summary.counts.receiptFiles).toBe(5_000);
    expect((await files(receipts)).length).toBe(50);
  }, 60_000);
});

describe('reservation recovery process credentials', () => {
  const workerUid = process.getuid() + 1000;
  async function recoveryFixture(status, {apply = true, fault = ''} = {}) {
    const path = await runDir(1, 82, 500);
    await reserve(1, 82);
    const reservation = join(receipts, 'worker-active-1');
    await age(reservation, 500);
    const proc = join(tmp, 'proc');
    await mkdir(join(proc, '123'), {recursive: true});
    if (status !== null) await writeFile(join(proc, '123', 'status'), status);
    const pythonBefore = idleWorkerEvidence(tmp) + `
# Model the proc-directory ownership of a non-dumpable worker.
fixture_original_stat = os.stat
def root_owned_proc(path, *args, **kwargs):
    st = fixture_original_stat(path, *args, **kwargs)
    if isinstance(path, str) and path.startswith(${JSON.stringify(proc + '/')}):
        values = list(st)
        values[4] = 0
        return os.stat_result(values)
    return st
os.stat = root_owned_proc
${fault}
`;
    const result = runSweepFixture(tmp, {runRoot: root, apply, pythonBefore});
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary.refusals).toEqual([]);
    return {result, path, reservation};
  }
  it.each([0, 1, 2, 3].flatMap(field => [false, true].map(apply => [field, apply])))(
    'preserves a root-owned proc worker with credential field %s matching (apply=%s)', async (field, apply) => {
      const ids = [0, 0, 0, 0]; ids[field] = workerUid;
      // Non-UTF-8 task names are valid Linux process evidence.
      const status = Buffer.concat([Buffer.from([0xff]), Buffer.from(`\nUid:\t${ids.join('\t')}\n`)]);
      const {result, path, reservation} = await recoveryFixture(status, {apply});
      expect(result.summary.skips).toContainEqual(expect.objectContaining({reason: 'worker UID still has processes'}));
      expect(result.summary.candidates.runDirs).toEqual([]);
      expect(await exists(reservation)).toBe(true);
      expect(await exists(path)).toBe(true);
    });
  it.each([
    ['missing', 'Name:\tworker\n'],
    ['truncated', 'Uid:\t0\t0\t0\n'],
    ['malformed', 'Uid:\t0\t0\tunknown\t0\n'],
    ['extra field', 'Uid:\t0\t0\t0\t0\t1\n'],
    ['malformed label', 'Uid:invalid\t0\t0\t0\t0\n'],
    ['duplicate', 'Uid:\t0\t0\t0\t0\nUid:\t0\t0\t0\t0\n'],
    ['oversized', 'Uid:\t0\t0\t0\t0\n' + 'x'.repeat(64 * 1024)],
    ['vanished', null],
  ])('preserves reservations with %s process credential evidence', async (_label, status) => {
    const {result, path, reservation} = await recoveryFixture(status);
    expect(result.summary.skips).toContainEqual(expect.objectContaining({reason: expect.stringContaining('incomplete reservation or UID evidence')}));
    expect(await exists(reservation)).toBe(true);
    expect(await exists(path)).toBe(true);
  });
  it('preserves reservations when process status is unreadable', async () => {
    const fault = `import builtins
original_open = builtins.open
def unreadable_status(path, *args, **kwargs):
    if path.endswith('/status'): raise PermissionError('injected unreadable status')
    return original_open(path, *args, **kwargs)
builtins.open = unreadable_status
`;
    const {result, path, reservation} = await recoveryFixture('Uid:\t0\t0\t0\t0\n', {fault});
    expect(result.summary.skips).toContainEqual(expect.objectContaining({reason: expect.stringContaining('incomplete reservation or UID evidence')}));
    expect(await exists(reservation)).toBe(true);
    expect(await exists(path)).toBe(true);
  });
  it.each([false, true])('recovers an idle UID with complete unrelated process credentials (apply=%s)', async apply => {
    const {result, path, reservation} = await recoveryFixture('Uid:\t0\t0\t0\t0\n', {apply});
    expect(result.summary.skips).toContainEqual(expect.objectContaining({reason: expect.stringContaining('worker UID has no processes')}));
    expect(await exists(reservation)).toBe(!apply);
    expect(await exists(path)).toBe(!apply);
  });
});

describe('descriptor-pinned tree deletion and recovery', () => {
  it('reports oversized trees as refusals with an operator fallback', async () => {
    const path = await runDir(1, 77, 50), names = Array.from({length: 20_001}, (_, i) => join(path, 'entry-' + i));
    for (let i = 0; i < names.length; i += 100) {
      await Promise.all(names.slice(i, i + 100).map(name => writeFile(name, '')));
    }
    const summary = await go();
    expect(summary.refusals).toEqual([expect.objectContaining({consumer: 'slots', error: expect.stringContaining('stop worker UID and inspect manually')})]);
    expect(await exists(path)).toBe(true);
  }, 60_000);
  it('holds the production flock during reservation reads, slot deletion and receipt unlink', async () => {
    const old = await runDir(1, 76, 500), oldReceipt = await receipt(run(76) + '.telemetry', 500);
    await reserve(1, 9);
    const guard = join(receipts, '.worker-active-1.writer');
    const probeCode = 'import os, fcntl, sys\nfd = os.open(sys.argv[1], os.O_RDWR)\ntry: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(1)';
    const before = `
const events = [];
const competingLock = () => {
  const probe = childProcess.spawnSync('/usr/bin/python3', ['-I', '-c',
    ${JSON.stringify(probeCode)}, ${JSON.stringify(guard)}], {timeout: 5000});
  assert.equal(probe.status, 0, 'competing process acquired protected writer lease');
};
const read = fs.readFile, unlink = fs.unlink, spawn = childProcess.spawn;
fs.readFile = async (path, ...args) => {
  if (path === ${JSON.stringify(join(receipts, 'worker-active-1', 'reservation.json'))}) {
    competingLock(); events.push('read');
  }
  return read(path, ...args);
};
fs.unlink = async (path, ...args) => {
  if (path === ${JSON.stringify(oldReceipt)}) { competingLock(); events.push('unlink'); }
  return unlink(path, ...args);
};
childProcess.spawn = (file, args, options) => {
  if (args?.[2]?.includes('import secrets')) { competingLock(); events.push('tree-delete'); }
  return spawn(file, args, options);
};`;
    const result = runSweepFixture(tmp, {runRoot: root, before,
      after: "assert(events.includes('read')); assert(events.includes('unlink')); assert(events.includes('tree-delete'));"});
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary.refusals).toEqual([]);
    expect(await exists(old)).toBe(false);
    expect(await exists(oldReceipt)).toBe(false);
  });
  it.each(['slot', 'warm', 'legacy', 'presync'])('retries a stale %s tombstone left after interrupted deletion', async kind => {
    let path = kind === 'presync' ? await presyncKey(74, 100) : await runDir(1, 74, 100);
    if (kind === 'warm' || kind === 'legacy') {
      const target = kind === 'warm' ? join(root, 'slot-1', run(74).replace('r-', 'warm-')) : join(root, run(74));
      await fs.rename(path, target); path = target;
    }
    const tomb = path + '.tomb-123abc';
    await fs.rename(path, tomb);
    const summary = await go();
    expect(summary.refusals).toEqual([]);
    expect(await exists(tomb)).toBe(false);
  });
  it('retains dry-run, reservation and live-record protections for tombstones', async () => {
    const tombs = [];
    for (const n of [78, 79, 80]) {
      const path = await runDir(1, n, 100), tomb = path + '.tomb-123abc';
      await fs.rename(path, tomb); tombs.push(tomb);
    }
    await reserve(1, 78); await receipt(run(79) + '.running', 100);
    const dry = await go({apply: false});
    expect(dry.candidates.runDirs).toEqual([tombs[2].slice(root.length + 1)]);
    for (const tomb of tombs) expect(await exists(tomb)).toBe(true);
    await go();
    expect(await exists(tombs[0])).toBe(true); expect(await exists(tombs[1])).toBe(true);
    expect(await exists(tombs[2])).toBe(false);
  });
  it('recovers the actual tombstone after an injected recursive unlink failure', async () => {
    const path = await runDir(1, 81, 500);
    const result = runSweepFixture(tmp, {runRoot: root, pythonMatch: 'import secrets', pythonBefore: `import os
original_unlink = os.unlink
def fail_unlink(path, *args, **kwargs):
    raise OSError('injected unlink failure')
os.unlink = fail_unlink
`});
    expect(result.status, result.stderr).toBe(1);
    expect(result.summary.refusals).toEqual([expect.objectContaining({consumer: 'slots'})]);
    const names = await fs.readdir(join(root, 'slot-1'));
    expect(names).toHaveLength(1); expect(names[0]).toMatch(new RegExp(run(81) + '\\.tomb-[a-f0-9]+$'));
    expect(await exists(path)).toBe(false);
    const tomb = join(root, 'slot-1', names[0]); await age(tomb, 500);
    expect((await go()).refusals).toEqual([]);
    expect(await exists(tomb)).toBe(false);
  });
  it.each([['scan', 'symlink'], ['delete', 'symlink'], ['scan', 'directory'], ['delete', 'directory']])(
    'preserves outside state and refuses a checked child replaced during %s by a %s', async (phase, replacement) => {
    const path = await runDir(1, 75, 500);
    const child = join(path, 'nested'), outside = join(tmp, 'outside'), marker = join(tmp, 'race-fired');
    await mkdir(child); await mkdir(outside); await writeFile(join(outside, 'keep'), 'outside');
    await writeFile(join(child, 'payload'), 'inside');
    for (const p of [join(child, 'payload'), child, path]) await age(p, 500);
    const pythonBefore = `import os, inspect
original_open = os.open
def racing_open(path, flags, *args, **kwargs):
    if path == 'nested' and any(frame.function == ${JSON.stringify(phase === 'scan' ? 'walk' : 'empty')} for frame in inspect.stack()):
        fd = kwargs['dir_fd']
        os.rename('nested', 'detached', src_dir_fd=fd, dst_dir_fd=fd)
        ${replacement === 'symlink' ? `os.symlink(${JSON.stringify(outside)}, 'nested', dir_fd=fd)` : "os.mkdir('nested', dir_fd=fd)"}
        with open(${JSON.stringify(marker)}, 'w') as stream: stream.write('fired')
    return original_open(path, flags, *args, **kwargs)
os.open = racing_open
`;
    const result = runSweepFixture(tmp, {runRoot: root, pythonBefore, pythonMatch: 'FLAGS ='});
    expect(await exists(marker)).toBe(true);
    expect(result.status, result.stderr).toBe(1);
    expect(result.summary.refusals).toEqual(expect.arrayContaining([expect.objectContaining({consumer: 'slots'})]));
    expect(await fs.readFile(join(outside, 'keep'), 'utf8')).toBe('outside');
  });
});

describe('consumers are independent', () => {
  it('a refusal in one consumer does not stop the others and is reported', async () => {
    await rm(join(root, 'presync'), {recursive: true}); await writeFile(join(root, 'presync'), 'not a directory');
    const old = await runDir(1, 80, 50), oldR = await receipt(run(81) + '.telemetry', 100);
    const summary = await go();
    expect(summary.refusals).toEqual([expect.objectContaining({consumer: 'presync'})]);
    expect(await exists(old)).toBe(false);
    expect(await exists(oldR)).toBe(false);
  });
});
