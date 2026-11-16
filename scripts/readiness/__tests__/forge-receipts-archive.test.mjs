// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join, normalize, basename, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {planArchive, validateRoot, runArchive, main} from '../forge-receipts-archive.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 16);
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const archiveName = day => `receipts-${day}.jsonl.gz`;
const hash = data => createHash('sha256').update(data).digest('hex');
const entry = (name, mtimeMs = now - 8 * DAY, kind = 'file') => ({name, kind, mtimeMs, size: 3});
const bucket = (time, files) => ({day: dayOf(time), archiveName: archiveName(dayOf(time)), files});
const decode = bytes => gunzipSync(bytes).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));

describe('planArchive', () => {
  it('archives a receipt exactly 7 days old but skips one just under 7 days', () => {
    expect(planArchive([entry('exact', now - 7 * DAY), entry('under', now - 7 * DAY + 1)], now)).toEqual({
      archive: [bucket(now - 7 * DAY, ['exact'])], deleteArchives: [],
      skipped: [{name: 'under', reason: 'recent'}],
    });
  });

  it('deletes the archive day exactly 30 days old but retains the day just under 30 days', () => {
    const exact = archiveName(dayOf(now - 30 * DAY));
    const under = archiveName(dayOf(now - 29 * DAY));
    // Retention uses the date in the archive name, independently of its filesystem mtime.
    const plan = planArchive([entry(exact, now), entry(under, now - 90 * DAY)], now);
    expect(plan.deleteArchives).toEqual([exact]);
    expect(plan.archive).toEqual([]);
  });

  it('skips receipts for an already-archived day and never re-archives archive files', () => {
    const time = now - 8 * DAY, name = archiveName(dayOf(time));
    const plan = planArchive([entry('receipt', time), entry(name, time)], now);
    expect(plan.archive).toEqual([]);
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.skipped).toContainEqual({name: 'receipt', reason: 'day-already-archived'});
  });

  it('groups mixed file names by day, sorts names, and leaves the listing unchanged', () => {
    const listing = [entry('z.receipt'), entry('recent', now - DAY), entry('a.receipt'),
      entry('another-day', now - 9 * DAY), entry('directory', now - 8 * DAY, 'dir')];
    const before = structuredClone(listing);
    const plan = planArchive(listing, now);
    expect(plan.archive).toHaveLength(2);
    expect(plan.archive).toEqual(expect.arrayContaining([
      bucket(now - 8 * DAY, ['a.receipt', 'z.receipt']), bucket(now - 9 * DAY, ['another-day']),
    ]));
    expect(plan.skipped).toEqual(expect.arrayContaining([
      {name: 'recent', reason: 'recent'}, {name: 'directory', reason: 'not-file'},
    ]));
    expect(listing).toEqual(before);
  });

  it('refuses symlinks, including a symlink named like an existing archive', () => {
    const name = archiveName(dayOf(now - 8 * DAY));
    const plan = planArchive([entry('link', undefined, 'symlink'), entry(name, undefined, 'symlink'), entry('receipt')], now);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      {name: 'link', reason: 'symlink'}, {name, reason: 'symlink'},
    ]));
    expect(plan.archive).toEqual([bucket(now - 8 * DAY, ['receipt'])]);
    expect(plan.deleteArchives).toEqual([]);
  });

  it.each(['dir', 'other'])('skips a %s entry as not-file', kind => {
    expect(planArchive([entry('non-file', undefined, kind)], now)).toEqual({
      archive: [], deleteArchives: [], skipped: [{name: 'non-file', reason: 'not-file'}],
    });
  });

  it.each(['', '../escape', 'sub/file', 'receipt..json'])('refuses unsafe file name %j', name => {
    expect(planArchive([entry(name)], now)).toEqual({
      archive: [], deleteArchives: [], skipped: [{name, reason: 'unsafe-name'}],
    });
  });

  it('marks a file younger than one hour active even though it is also recent', () => {
    expect(planArchive([entry('active', now - HOUR + 1)], now).skipped)
      .toEqual([{name: 'active', reason: 'active'}]);
  });

  it('stops treating a file as active at exactly one hour', () => {
    expect(planArchive([entry('hour', now - HOUR)], now).skipped)
      .toEqual([{name: 'hour', reason: 'recent'}]);
  });

  it('buckets opposite sides of UTC midnight into different archive days', () => {
    const midnight = Date.UTC(2026, 10, 7);
    const plan = planArchive([entry('before', midnight - 1), entry('after', midnight)], now);
    expect(plan.archive).toHaveLength(2);
    expect(plan.archive).toEqual(expect.arrayContaining([
      bucket(midnight - 1, ['before']), bucket(midnight, ['after']),
    ]));
  });

  it('honors custom keepDays and archiveDays', () => {
    const expired = archiveName(dayOf(now - 5 * DAY));
    const plan = planArchive([entry('receipt', now - 2 * DAY), entry(expired)], now, {keepDays: 2, archiveDays: 5});
    expect(plan.archive).toEqual([bucket(now - 2 * DAY, ['receipt'])]);
    expect(plan.deleteArchives).toEqual([expired]);
  });
});

describe('validateRoot', () => {
  it.each(['', '/', 'relative/path', '   ', undefined, null, 42, {}])('refuses bad root %j', root => {
    expect(() => validateRoot(root)).toThrow();
  });

  it('returns a normalized absolute path', () => {
    const root = join(process.env.TMPDIR, 'receipts') + '/child/../';
    expect(validateRoot(root)).toBe(normalize(root));
  });
});

describe('runArchive and CLI with real filesystem fixtures', () => {
  let tmp, root;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(process.env.TMPDIR, 'forge-receipts-archive-'));
    root = join(tmp, 'receipts');
    await fs.mkdir(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) await fs.rm(tmp, {recursive: true, force: true});
  });

  async function receipt(name, data = Buffer.from('receipt\n'), mtimeMs = now - 8 * DAY) {
    const path = join(root, name);
    await fs.writeFile(path, data);
    await fs.utimes(path, mtimeMs / 1000, mtimeMs / 1000);
    const stat = await fs.lstat(path);
    return {name, data, mtimeMs: stat.mtimeMs, size: stat.size};
  }

  async function expectOriginals(originals) {
    for (const original of originals) expect(await fs.readFile(join(root, original.name))).toEqual(original.data);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.tmp-'))).toEqual([]);
  }

  it('round-trips binary and text receipts, reads back the final archive, then deletes originals', async () => {
    const originals = [await receipt('z.receipt', Buffer.from([0, 255, 10, 128])), await receipt('a.receipt')];
    const finalPath = join(root, archiveName(dayOf(now - 8 * DAY)));
    let readBack = false, unlinks = 0;
    const writes = [];
    const io = {
      ...fs,
      async writeFile(path, data, ...args) {
        writes.push(path);
        expect(dirname(path)).toBe(root);
        expect(basename(path)).toBe(`.tmp-${basename(finalPath)}`);
        return fs.writeFile(path, data, ...args);
      },
      async readFile(path, ...args) {
        const bytes = await fs.readFile(path, ...args);
        if (String(path) === finalPath) {
          expect(decode(bytes)).toHaveLength(originals.length);
          await expectOriginals(originals);
          readBack = true;
        }
        return bytes;
      },
      async unlink(path) {
        if (originals.some(original => join(root, original.name) === String(path))) {
          expect(readBack).toBe(true);
          expect(decode(await fs.readFile(finalPath))).toHaveLength(originals.length);
          unlinks++;
        }
        return fs.unlink(path);
      },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(result).toMatchObject({mode: 'apply', ok: true, errors: [],
      counts: {archivedFiles: 2, archivesWritten: 1, archivesDeleted: 0, skipped: 0}});
    expect(writes).toHaveLength(1);
    expect(readBack).toBe(true);
    expect(unlinks).toBe(2);
    expect(await fs.readdir(root)).toEqual([basename(finalPath)]);
    const records = decode(await fs.readFile(finalPath));
    expect(records).toHaveLength(originals.length);
    for (const original of originals) {
      const record = records.find(item => item.name === original.name);
      expect(record).toEqual({name: original.name, mtimeMs: original.mtimeMs, size: original.size,
        sha256: hash(original.data), data: original.data.toString('base64')});
    }
  });

  it.each(['write', 'rename'])('preserves originals and removes temp files after archive %s failure', async stage => {
    const originals = [await receipt('one'), await receipt('two')];
    const io = {...fs,
      async writeFile(path, data, ...args) {
        await fs.writeFile(path, data, ...args);
        if (stage === 'write') throw new Error('simulated archive-write failure');
      },
      async rename() { throw new Error('simulated rename failure'); },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(result).toMatchObject({mode: 'apply', ok: false, counts: {archivedFiles: 0, archivesWritten: 0}});
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({day: dayOf(now - 8 * DAY)})]));
    await expectOriginals(originals);
    expect((await fs.readdir(root)).sort()).toEqual(['one', 'two']);
  });

  it.each(['invalid-gzip', 'entry-count', 'sha256', 'replaced-data-and-hash'])('fails closed on corrupted read-back: %s', async corruption => {
    const originals = [await receipt('one'), await receipt('two')];
    let corrupted = false;
    const io = {...fs, async rename(from, to) {
      await fs.rename(from, to);
      const records = decode(await fs.readFile(to));
      if (corruption === 'entry-count') records.pop();
      if (corruption === 'sha256') records[0].sha256 = '0'.repeat(64);
      if (corruption === 'replaced-data-and-hash') {
        const replacement = Buffer.from('not the original receipt');
        records[0].data = replacement.toString('base64');
        records[0].sha256 = hash(replacement);
      }
      await fs.writeFile(to, corruption === 'invalid-gzip' ? Buffer.from('corrupt')
        : gzipSync(records.map(record => JSON.stringify(record)).join('\n') + '\n'));
      corrupted = true;
    }};
    const result = await runArchive({root, now, apply: true, io});
    expect(corrupted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.counts.archivedFiles).toBe(0);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({day: dayOf(now - 8 * DAY)})]));
    await expectOriginals(originals);
  });

  it('dry-run defaults to no writes, renames or deletions and returns a plan and counts', async () => {
    const original = await receipt('one');
    const expired = archiveName(dayOf(now - 30 * DAY));
    await fs.writeFile(join(root, expired), 'existing archive');
    const names = (await fs.readdir(root)).sort();
    const before = await fs.lstat(join(root, original.name));
    const mutation = vi.fn(async () => { throw new Error('dry-run attempted mutation'); });
    const result = await runArchive({root, now, io: {...fs, writeFile: mutation, rename: mutation, unlink: mutation, rm: mutation}});
    expect(result.mode).toBe('dry-run');
    expect(result.plan.archive).toEqual([bucket(original.mtimeMs, ['one'])]);
    expect(result.plan.deleteArchives).toEqual([expired]);
    expect(result.counts).toEqual(expect.any(Object));
    expect(mutation).not.toHaveBeenCalled();
    expect((await fs.readdir(root)).sort()).toEqual(names);
    expect(await fs.readFile(join(root, expired), 'utf8')).toBe('existing archive');
    await expectOriginals([original]);
    const after = await fs.lstat(join(root, original.name));
    expect({mtimeMs: after.mtimeMs, size: after.size}).toEqual({mtimeMs: before.mtimeMs, size: before.size});
  });

  it('skips a real symlink and directory without following or changing its outside target', async () => {
    const outside = join(tmp, 'outside');
    await fs.writeFile(outside, 'outside target');
    await fs.utimes(outside, (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000);
    await fs.symlink(outside, join(root, 'link'));
    await fs.mkdir(join(root, 'directory'));
    const targetBefore = await fs.lstat(outside);
    const readFile = vi.fn((...args) => fs.readFile(...args));
    const result = await runArchive({root, now, apply: true, io: {...fs, readFile}});
    expect(result.ok).toBe(true);
    expect(result.plan.archive).toEqual([]);
    expect(result.plan.skipped).toEqual(expect.arrayContaining([
      {name: 'link', reason: 'symlink'}, {name: 'directory', reason: 'not-file'},
    ]));
    expect(result.counts.skipped).toBe(2);
    expect(readFile).not.toHaveBeenCalled();
    expect((await fs.lstat(join(root, 'link'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside target');
    expect((await fs.lstat(outside)).mtimeMs).toBe(targetBefore.mtimeMs);
  });

  it('refuses a root that is itself a symlink and preserves the real root', async () => {
    const original = await receipt('one');
    const link = join(tmp, 'root-link');
    await fs.symlink(root, link);
    await expect(runArchive({root: link, now, apply: true})).rejects.toThrow();
    await expectOriginals([original]);
    expect(await fs.readdir(root)).toEqual(['one']);
  });

  it('deletes expired archives in apply while retaining younger archives', async () => {
    const expired = archiveName(dayOf(now - 30 * DAY));
    const retained = archiveName(dayOf(now - 29 * DAY));
    await fs.writeFile(join(root, expired), 'expired');
    await fs.writeFile(join(root, retained), 'retained');
    const result = await runArchive({root, now, apply: true});
    expect(result).toMatchObject({ok: true, plan: {archive: [], deleteArchives: [expired]},
      counts: {archivedFiles: 0, archivesWritten: 0, archivesDeleted: 1}});
    expect(await fs.readdir(root)).toEqual([retained]);
    expect(await fs.readFile(join(root, retained), 'utf8')).toBe('retained');
  });

  function captureOutput() {
    const chunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return () => chunks.join('');
  }

  it.each(['flag', 'environment'])('CLI main dry-run --json prints parseable output using the %s root', async source => {
    const original = await receipt('one');
    const output = captureOutput();
    const argv = ['--json', `--now=${new Date(now).toISOString()}`];
    if (source === 'flag') argv.push(`--root=${root}`);
    const code = await main(argv, {FORGE_RECEIPTS_DIR: source === 'environment' ? root : join(tmp, 'missing')});
    expect(code).toBe(0);
    const result = JSON.parse(output());
    expect(result.mode).toBe('dry-run');
    expect(result.plan.archive).toEqual([bucket(original.mtimeMs, ['one'])]);
    await expectOriginals([original]);
    expect(await fs.readdir(root)).toEqual(['one']);
  });

  it('CLI --apply reports errors with exit code 1 when the root cannot be read', async () => {
    captureOutput();
    expect(await main([`--root=${join(tmp, 'missing')}`, '--apply', '--json'], {})).toBe(1);
  });

  it.each(['--root=', '--root=/', '--root=relative', '--unknown', '--now=not-a-date'])
  ('CLI refuses bad roots or arguments with exit code 2: %s', async arg => {
    captureOutput();
    expect(await main([arg, '--json'], {FORGE_RECEIPTS_DIR: root})).toBe(2);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe('protected lock and run-state files', () => {
  it('never archives writer locks or .prepared/.running run state, however old', async () => {
    const { planArchive } = await import('../forge-receipts-archive.mjs');
    const now = Date.parse('2026-11-16T12:00:00Z');
    const old = now - 20 * 86400000;
    const plan = planArchive([
      { name: '.worker-active-1.writer', kind: 'file', mtimeMs: old, size: 1 },
      { name: 'job.prepared', kind: 'file', mtimeMs: old, size: 1 },
      { name: 'job.running', kind: 'file', mtimeMs: old, size: 1 },
    ], now);
    expect(plan.archive).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(Array(3).fill('protected-lock-or-run-state'));
  });
});
