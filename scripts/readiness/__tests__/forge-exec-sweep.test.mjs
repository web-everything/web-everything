// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect} from 'vitest';
import fs, {mkdtemp, mkdir, writeFile, rm, utimes, stat, symlink, rename} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {vi} from 'vitest';
import {join} from 'node:path';
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

describe('production CLI safety guarantees', () => {
  const cli = fileURLToPath(new URL('../forge-exec-sweep.mjs', import.meta.url));
  const invoke = (...flags) => spawnSync(process.execPath, [cli, `--root=${root}`, `--receipts=${receipts}`, ...flags],
    {encoding: 'utf8', timeout: 30_000});
  it('CLI defaults to dry-run without an apply flag', async () => {
    const old = await runDir(1, 70, 500);
    const result = invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({apply: false, counts: {runDirs: 1}});
    expect(await exists(old)).toBe(true);
  });
  it('CLI emits refusal JSON and exits 1', async () => {
    await rm(join(root, 'presync'), {recursive: true});
    await writeFile(join(root, 'presync'), 'unsafe');
    const result = invoke();
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).refusals).toContainEqual(expect.objectContaining({consumer: 'presync'}));
  });
  it('sweep defaults to dry-run when apply is omitted', async () => {
    const old = await runDir(1, 70, 50);
    const result = await sweep({root, receipts, now, ...free});
    expect(result.apply).toBe(false);
    expect(result.counts.runDirs).toBe(1);
    expect(await exists(old)).toBe(true);
  });
  it('holds the production writer flock during receipt unlink and recursive run deletion', async () => {
    await runDir(1, 71, 500);
    const target = await receipt(run(72) + '.telemetry', 500);
    const guard = join(receipts, '.worker-active-1.writer');
    const marker = join(tmp, 'lease-observed');
    const pythonDuringDelete = `import os, fcntl
original_unlink = os.unlink
def locked_unlink(path, *args, **kwargs):
    with open(${JSON.stringify(guard)}, 'r+') as lease:
        try: fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: pass
        else: raise RuntimeError('slot lease released before deletion')
    with open(${JSON.stringify(marker)}, 'w') as proof: proof.write('held')
    return original_unlink(path, *args, **kwargs)
os.unlink = locked_unlink
`;
    const before = `
const originalUnlink = fs.unlink;
fs.unlink = async path => {
  if (path === ${JSON.stringify(target)}) {
    const probe = childProcess.spawnSync('/usr/bin/python3', ['-I','-c',
      'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', ${JSON.stringify(guard)}]);
    assert.equal(probe.status, 1, 'receipt lease released before unlink');
  }
  return originalUnlink(path);
};`;
    const result = runSweepFixture(tmp, {runs: 'exec', before, pythonDuringDelete});
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.readFile(marker, 'utf8')).toBe('held');
    expect(await exists(target)).toBe(false);
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
    await runDir(1, 40, 50);
    await reserve(1, 41);
    const read = fs.readFile.bind(fs), held = new Set();
    vi.spyOn(fs, 'readFile').mockImplementation(async (path, ...args) => {
      if (String(path) === join(receipts, 'worker-active-1', 'reservation.json')) {
        expect(held.has('worker-active-1')).toBe(true);
        events.push('read worker-active-1');
      }
      return read(path, ...args);
    });
    await go({lock: async name => { held.add(name); events.push('lock ' + name); return {release: async () => { events.push('release ' + name); held.delete(name); }}; }});
    expect(events.indexOf('read worker-active-1')).toBeGreaterThan(events.indexOf('lock worker-active-1'));
    expect(events.indexOf('read worker-active-1')).toBeLessThan(events.indexOf('release worker-active-1'));
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
  it('reclaims a dependency tree larger than the old 20,000-entry scan bound', async () => {
    const dir = await presyncKey(99, 500);
    for (let start = 0; start < 20_010; start += 200) {
      await Promise.all(Array.from({length: Math.min(200, 20_010 - start)}, async (_, i) => {
        const path = join(dir, 'dependency-' + (start + i));
        await writeFile(path, ''); await age(path, 500);
      }));
    }
    await age(dir, 500);
    const result = await go();
    expect(result.refusals).toEqual([]);
    expect(await exists(dir)).toBe(false);
  }, 60_000);
  it('preserves a tree exceeding the depth bound and names manual inspection', async () => {
    const dir = await presyncKey(98, 500);
    let nested = dir;
    for (let i = 0; i < 66; i++) { nested = join(nested, 'd'); await mkdir(nested); }
    const result = await go();
    expect(await exists(dir)).toBe(true);
    expect(result.skips).toContainEqual(expect.objectContaining({consumer: 'presync', reason: expect.stringContaining('inspect manually')}));
  });
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
    const target = await receipt(run(1) + '.telemetry', 100);
    await mkdir(join(receipts, 'worker-active-1')); await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), JSON.stringify({run: run(9), writerGuard: 1}));
    const held = new Set(), seen = [];
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async path => {
      if (path === target) {
        expect([...held].sort()).toEqual(['worker-active-1', 'worker-active-2']);
        seen.push('delete');
      }
      return unlink(path);
    });
    await go({lock: async name => { held.add(name); return {release: async () => { seen.push(name); held.delete(name); }}; }});
    expect(seen).toContain('worker-active-1');
    expect(seen.indexOf('delete')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('delete')).toBeLessThan(seen.lastIndexOf('worker-active-1'));
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
  it('holds a shared 5,000-file cap across execution records and expired receipts', async () => {
    for (let i = 0; i < 5_049; i++) await writeFile(join(receipts, run(i) + '.consumed'), '{}');
    const execution = join(receipts, run(6_000) + '.prepared');
    await writeFile(execution, JSON.stringify({run: run(6_000), slot: 'forge-exec-1', nonce: 'a'.repeat(32)}));
    await mkdir(join(tmp, 'proc'));
    const files = (await import('node:fs/promises')).readdir;
    const t = new Date(now - 100 * H);
    await Promise.all((await files(receipts)).map(f => utimes(join(receipts, f), t, t)));
    await age(execution, 500);
    const result = runSweepFixture(tmp, {runs: 'exec', pythonBefore: idleWorkerEvidence(tmp)});
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary.counts.receiptFiles).toBe(5_000);
    expect(await exists(execution)).toBe(false);
    expect((await files(receipts)).filter(name => /\.(prepared|consumed)$/.test(name)).length).toBe(50);
  }, 60_000);
});

describe('interrupted deletion recovery', () => {
  it('reclaims old run and presync tombstones but preserves recent and malformed tombstones', async () => {
    const oldRun = await runDir(1, 101, 100), oldKey = await presyncKey(101, 100);
    const runTomb = oldRun + '.tomb-deadbeef', keyTomb = oldKey + '.tomb-deadbeef';
    await rename(oldRun, runTomb); await rename(oldKey, keyTomb);
    const young = (await runDir(1, 102, 1)) + '.tomb-deadbeef';
    await rename(young.split('.tomb-')[0], young);
    const odd = join(root, 'slot-1', 'unknown.tomb-deadbeef'); await mkdir(odd);
    await go();
    expect(await exists(runTomb)).toBe(false);
    expect(await exists(keyTomb)).toBe(false);
    expect(await exists(young)).toBe(true);
    expect(await exists(odd)).toBe(true);
  });
  it.each(['inspection', 'deletion'].flatMap(stage => ['symlink', 'directory'].map(kind => [stage, kind])))(
    'preserves outside state and rejects replacement during %s by a %s', async (stage, kind) => {
    const target = await runDir(1, 103, 500);
    const outside = join(tmp, 'outside'), nested = join(target, 'nested');
    await mkdir(outside); await writeFile(join(outside, 'keep'), 'outside');
    await mkdir(nested); await writeFile(join(nested, 'payload'), 'inside');
    for (const path of [join(nested, 'payload'), nested, target]) await age(path, 500);
    const hook = `import os
original_open = os.open
swapped = False
def race_open(path, flags, *args, **kwargs):
    global swapped
    if path == 'nested' and not swapped and 'dir_fd' in kwargs:
        swapped = True
        parent = kwargs['dir_fd']
        os.rename('nested', 'moved', src_dir_fd=parent, dst_dir_fd=parent)
        if ${kind === 'symlink' ? 'True' : 'False'}:
            os.symlink(${JSON.stringify(outside)}, 'nested', dir_fd=parent)
        else:
            os.mkdir('nested', dir_fd=parent)
            replacement = original_open('nested', os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent)
            try:
                marker = original_open('keep', os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=replacement)
                os.close(marker)
            finally: os.close(replacement)
    return original_open(path, flags, *args, **kwargs)
os.open = race_open
`;
    const result = runSweepFixture(tmp, {runs: 'exec',
      ...(stage === 'inspection' ? {pythonDuringInspect: hook} : {pythonDuringDelete: hook})});
    expect(result.status, result.stderr).toBe(1);
    expect(result.summary.refusals).toContainEqual(expect.objectContaining({consumer: 'slots'}));
    expect(await fs.readFile(join(outside, 'keep'), 'utf8')).toBe('outside');
    if (kind === 'directory') {
      const name = (await fs.readdir(join(root, 'slot-1'))).find(name => name.startsWith(run(103)));
      expect(await exists(join(root, 'slot-1', name, 'nested', 'keep'))).toBe(true);
    }
  });
  it.each(['reserved', 'live record', 'busy lock', 'dry-run'])('keeps an old run tombstone with %s protection', async mode => {
    const path = await runDir(1, 105, 500), tomb = path + '.tomb-deadbeef';
    await rename(path, tomb);
    if (mode === 'reserved') await reserve(1, 105);
    if (mode === 'live record') await receipt(run(105) + '.running', 500);
    const result = await go({apply: mode !== 'dry-run', ...(mode === 'busy lock'
      ? {lock: async name => name === 'worker-active-1' ? null : {release: async () => {}}} : {})});
    expect(result.refusals).toEqual([]);
    expect(await exists(tomb)).toBe(true);
  });
  it('retries a tombstone after an interrupted recursive delete', async () => {
    const target = await runDir(1, 104, 500);
    const hook = `import os
original_unlink = os.unlink
def fail_unlink(path, *args, **kwargs):
    if path == 'f': raise OSError('injected interrupted delete')
    return original_unlink(path, *args, **kwargs)
os.unlink = fail_unlink
`;
    const failed = runSweepFixture(tmp, {runs: 'exec', pythonDuringDelete: hook});
    expect(failed.status, failed.stderr).toBe(1);
    expect(await exists(target)).toBe(false);
    const tomb = (await fs.readdir(join(root, 'slot-1'))).find(name => name.startsWith(run(104) + '.tomb-'));
    expect(tomb).toBeDefined();
    // Rename does not refresh the directory mtime; an untouched failed tree is
    // immediately eligible. Partial deletes may refresh it and defer recovery.
    await age(join(root, 'slot-1', tomb), 500);
    const retried = runSweepFixture(tmp, {runs: 'exec'});
    expect(retried.status, retried.stderr).toBe(0);
    expect(await exists(join(root, 'slot-1', tomb))).toBe(false);
  });
});

describe('abandoned execution records', () => {
  it.each(['idle', 'live UID', 'live owner', 'malformed owner', 'conflicting nonce', 'unknown UID', 'young', 'unidentified', 'reserved', 'busy lock', 'dry-run', 'record only'])('reaps old records only on owner-gone proof: %s', async mode => {
    const target = await runDir(1, 110, 500), files = [];
    for (const phase of ['prepared', 'running', 'receipt']) {
      const file = await receipt(run(110) + '.' + phase, mode === 'young' ? 1 : 500);
      await writeFile(file, JSON.stringify(mode === 'unidentified' ? {} : {run: run(110), slot: 'forge-exec-1',
        nonce: (mode === 'conflicting nonce' && phase === 'receipt' ? 'b' : 'a').repeat(32),
        ...(mode === 'live owner' ? {owner: {pid: 123, start: '321'}} : {}),
        ...(mode === 'malformed owner' ? {owner: {pid: 'unknown'}} : {})}));
      await age(file, mode === 'young' ? 1 : 500); files.push(file);
    }
    if (mode === 'reserved') await reserve(1, 110);
    await mkdir(join(tmp, 'proc'));
    if (mode === 'live UID') await mkdir(join(tmp, 'proc', '123'));
    if (mode === 'record only') await rm(join(root, 'slot-1'), {recursive: true});
    const before = mode === 'busy lock' ? `
const lease = await fs.open(${JSON.stringify(join(receipts, '.worker-active-1.writer'))}, 'w', 0o600);
const child = originalSpawn('/usr/bin/python3', ['-I', '-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX)'], {stdio:['ignore','ignore','ignore',lease.fd]});
await new Promise(resolve => child.on('exit', resolve));
` : '';
    const ownerEvidence = mode === 'live owner' ? `
import builtins, io
original_open_file = builtins.open
def owner_open(path, *args, **kwargs):
    if path == '/proc/123/stat': return io.StringIO('123 (owner) S ' + '0 ' * 18 + '321')
    return original_open_file(path, *args, **kwargs)
builtins.open = owner_open
` : mode === 'unknown UID' ? `
pwd.getpwnam = lambda _: (_ for _ in ()).throw(KeyError('unknown worker'))
` : '';
    const result = runSweepFixture(tmp, {runs: 'exec', before, apply: mode !== 'dry-run',
      pythonBefore: idleWorkerEvidence(tmp, {live: mode === 'live UID'}) + ownerEvidence});
    expect(result.status, result.stderr).toBe(mode === 'unknown UID' ? 1 : 0);
    for (const file of [target, ...files]) expect(await exists(file)).toBe(!['idle', 'record only'].includes(mode));
    if (mode === 'dry-run') expect(result.summary.counts).toMatchObject({runDirs: 1, receiptFiles: 3});
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
