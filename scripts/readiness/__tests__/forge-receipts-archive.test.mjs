// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join, normalize, basename, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planArchive, validateRoot, runArchive, main} from '../forge-receipts-archive.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 16);
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const archiveName = day => `receipts-${day}.jsonl.gz`;
const hash = data => createHash('sha256').update(data).digest('hex');
const entry = (name, mtimeMs = now - 8 * DAY, kind = 'file') => ({name, kind, mtimeMs, size: 3});
const bucket = (time, files) => ({day: dayOf(time), archiveName: archiveName(dayOf(time)), files});
const decode = bytes => gunzipSync(bytes).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const runId = digit => `r-${digit.repeat(32)}`;
// Encode readable fixture labels as producer-shaped ids, preserving lexical order.
const receiptName = label => `r-${Buffer.from(label.replace(/\.receipt$/, '')).toString('hex').padEnd(32, '0')}.receipt`;

describe('receipt ownership and unfinished run retention', () => {
  it.each(['prepared', 'running'])('preserves every member of a run with a %s marker regardless of listing order', phase => {
    const run = runId('a'), completed = `${runId('b')}.receipt`;
    const members = ['receipt', 'rejected', 'cancel', 'consumed', 'telemetry', 'base'].map(suffix => `${run}.${suffix}`);
    for (const [kind, time] of [['file', now], ['file', now - 90 * DAY], ['symlink', now], ['dir', now]]) {
      const marker = entry(`${run}.${phase}`, time, kind);
      const listing = [...members.map(name => entry(name)), entry(completed), marker];
      for (const entries of [listing, [...listing].reverse()]) {
        const plan = planArchive(entries, now);
        expect(plan.archive).toEqual([bucket(now - 8 * DAY, [completed])]);
        for (const name of members) expect(plan.skipped).toContainEqual({name, reason: 'unfinished-run'});
      }
    }
    expect(planArchive(members.map(name => entry(name)), now).archive)
      .toEqual([bucket(now - 8 * DAY, [...members].sort())]);
  });

  it.each([
    'notes.txt', 'passwd', '.env', 'telemetry.json', 'reap-audit.log', 'unrelated.receipt', '.receipt',
    '--apply', "quote'.receipt", '`command`.receipt', `${runId('a')}\u200b.receipt`,
    `r-${'a'.repeat(31)}.receipt`, `r-${'a'.repeat(33)}.receipt`,
    `r-${'A'.repeat(32)}.receipt`, `${runId('a')}.receipt.bak`, `${runId('a')}.unknown`,
    `${runId('a')}.receipt\u2028`, `prefix-${runId('a')}.receipt`,
    'receipts-2026-01-01.jsonl.gz\u2028', 'receipts-2026-01-01.jsonl.gz\u2029',
    'receipts-2026-02-30.jsonl.gz', 'receipts-2026-01-01-0.jsonl.gz',
  ])('skips foreign or malformed filename %j as unrecognized', name => {
    expect(planArchive([entry(name, now - 90 * DAY)], now)).toEqual({
      archive: [], deleteArchives: [], skipped: [{name, reason: 'unrecognized'}],
    });
  });

  it('archives recognized completed run records', () => {
    const names = ['receipt', 'rejected', 'cancel', 'consumed', 'telemetry', 'base'].map(suffix => `${runId('c')}.${suffix}`).sort();
    expect(planArchive(names.map(name => entry(name)), now)).toEqual({
      archive: [bucket(now - 8 * DAY, names)], deleteArchives: [], skipped: [],
    });
  });
});

describe('planArchive', () => {
  it.each(['.tmp-x', '.tmp-receipts-2026-11-08.jsonl.gz', '.tmp-receipts-2026-11-08.jsonl.gz-uuid'])
  ('skips aged temporary file %s before applying receipt retention', name => {
    expect(planArchive([entry(name, now - 90 * DAY)], now)).toEqual({
      archive: [], deleteArchives: [], skipped: [{name, reason: 'temporary-file'}],
    });
  });

  it('archives a receipt exactly 7 days old but skips one just under 7 days', () => {
    expect(planArchive([entry(receiptName('exact'), now - 7 * DAY), entry(receiptName('under'), now - 7 * DAY + 1)], now)).toEqual({
      archive: [bucket(now - 7 * DAY, [receiptName('exact')])], deleteArchives: [],
      skipped: [{name: receiptName('under'), reason: 'recent'}],
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

  it.each(['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-11-00'])
  ('rejects invalid calendar date %s as an archive day', day => {
    const name = archiveName(day);
    const plan = planArchive([entry(name)], now);
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.archive).toEqual([]);
    expect(plan.skipped).toEqual([{name, reason: 'unrecognized'}]);
  });

  it('recognizes a valid leap-day archive', () => {
    const name = archiveName('2024-02-29');
    expect(planArchive([entry(name)], now)).toEqual({archive: [], deleteArchives: [name], skipped: []});
  });

  it.each([
    {suffixes: [''], next: '-1'},
    {suffixes: ['', '-1', '-2'], next: '-3'},
    {suffixes: ['-1'], next: ''},
  ])('plans a new batch without re-archiving existing batches: $suffixes', ({suffixes, next}) => {
    const time = now - 8 * DAY, day = dayOf(time);
    const archives = suffixes.map(suffix => entry(`receipts-${day}${suffix}.jsonl.gz`, time));
    const plan = planArchive([entry(receiptName('receipt'), time), ...archives], now);
    expect(plan.archive).toEqual([{day, archiveName: `receipts-${day}${next}.jsonl.gz`, files: [receiptName('receipt')]}]);
    expect(plan.deleteArchives).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('groups mixed file names by day, sorts names, and leaves the listing unchanged', () => {
    const listing = [entry(receiptName('z.receipt')), entry(receiptName('recent'), now - DAY), entry(receiptName('a.receipt')),
      entry(receiptName('another-day'), now - 9 * DAY), entry('directory', now - 8 * DAY, 'dir')];
    const before = structuredClone(listing);
    const plan = planArchive(listing, now);
    expect(plan.archive).toHaveLength(2);
    expect(plan.archive).toEqual(expect.arrayContaining([
      bucket(now - 8 * DAY, [receiptName('a.receipt'), receiptName('z.receipt')]), bucket(now - 9 * DAY, [receiptName('another-day')]),
    ]));
    expect(plan.skipped).toEqual(expect.arrayContaining([
      {name: receiptName('recent'), reason: 'recent'}, {name: 'directory', reason: 'not-file'},
    ]));
    expect(listing).toEqual(before);
  });

  it('refuses symlinks, including a symlink named like an existing archive', () => {
    const name = archiveName(dayOf(now - 8 * DAY));
    const plan = planArchive([entry('link', undefined, 'symlink'), entry(name, undefined, 'symlink'), entry(receiptName('receipt'))], now);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      {name: 'link', reason: 'symlink'}, {name, reason: 'symlink'},
    ]));
    expect(plan.archive).toEqual([bucket(now - 8 * DAY, [receiptName('receipt')])]);
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
    expect(planArchive([entry(receiptName('active'), now - HOUR + 1)], now).skipped)
      .toEqual([{name: receiptName('active'), reason: 'active'}]);
  });

  it('stops treating a file as active at exactly one hour', () => {
    expect(planArchive([entry(receiptName('hour'), now - HOUR)], now).skipped)
      .toEqual([{name: receiptName('hour'), reason: 'recent'}]);
  });

  it('buckets opposite sides of UTC midnight into different archive days', () => {
    const midnight = Date.UTC(2026, 10, 7);
    const plan = planArchive([entry(receiptName('before'), midnight - 1), entry(receiptName('after'), midnight)], now);
    expect(plan.archive).toHaveLength(2);
    expect(plan.archive).toEqual(expect.arrayContaining([
      bucket(midnight - 1, [receiptName('before')]), bucket(midnight, [receiptName('after')]),
    ]));
  });

  it('honors custom keepDays and archiveDays', () => {
    const expired = archiveName(dayOf(now - 5 * DAY));
    const plan = planArchive([entry(receiptName('receipt'), now - 2 * DAY), entry(expired)], now, {keepDays: 2, archiveDays: 5});
    expect(plan.archive).toEqual([bucket(now - 2 * DAY, [receiptName('receipt')])]);
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

  it('apply preserves unfinished runs and foreign files while archiving a completed run', async () => {
    const protectedFiles = [];
    for (const [digit, phase] of [['a', 'prepared'], ['b', 'running']]) {
      for (const suffix of [phase, 'receipt', 'rejected', 'cancel', 'consumed', 'telemetry', 'base']) {
        protectedFiles.push(await receipt(`${runId(digit)}.${suffix}`));
      }
    }
    for (const name of ['notes.txt', 'passwd', '.env', 'foreign.receipt', 'receipts-2026-02-30.jsonl.gz']) {
      protectedFiles.push(await receipt(name));
    }
    const completed = await receipt(`${runId('c')}.receipt`);
    const result = await runArchive({root, now, apply: true});
    expect(result.ok).toBe(true);
    expect(result.counts.archivedFiles).toBe(1);
    await expectOriginals(protectedFiles);
    const records = decode(await fs.readFile(join(root, archiveName(dayOf(completed.mtimeMs)))));
    expect(records.map(record => record.name)).toEqual([completed.name]);
    await expect(fs.lstat(join(root, completed.name))).rejects.toThrow(/ENOENT/);
  });

  it.each([false, true])('continues after an entry vanishes during listing (apply=%s)', async apply => {
    const gone = await receipt(receiptName('gone.receipt'));
    const survivor = await receipt(receiptName('survivor.receipt'), Buffer.from('survivor'), now - 9 * DAY);
    const io = {...fs,
      // Snapshot the names so the race does not depend on filesystem iteration order.
      async opendir() { return [{name: gone.name}, {name: survivor.name}]; },
      async lstat(path) {
        if (path === join(root, gone.name)) await fs.unlink(path);
        return fs.lstat(path);
      },
    };
    const result = await runArchive({root, now, apply, io});
    expect(result.ok).toBe(true);
    expect(result.plan.archive).toEqual([bucket(survivor.mtimeMs, [survivor.name])]);
    expect(result.counts.archivedFiles).toBe(apply ? 1 : 0);
    if (apply) {
      const records = decode(await fs.readFile(join(root, archiveName(dayOf(survivor.mtimeMs)))));
      expect(records).toEqual([expect.objectContaining({name: survivor.name, sha256: hash(survivor.data)})]);
      await expect(fs.lstat(join(root, survivor.name))).rejects.toMatchObject({code: 'ENOENT'});
    } else await expectOriginals([survivor]);
  });

  it.each(['EACCES', 'EIO'])('refuses a listing stat failure other than ENOENT: %s', async code => {
    const original = await receipt(receiptName('unreadable.receipt'));
    const error = Object.assign(new Error('listing stat failed'), {code});
    const io = {...fs, async lstat(path) {
      if (path === join(root, original.name)) throw error;
      return fs.lstat(path);
    }};
    await expect(runArchive({root, now, apply: true, io})).rejects.toBe(error);
    await expectOriginals([original]);
    expect(await fs.readdir(root)).toEqual([original.name]);
  });

  it('refuses a missing root rather than treating it as an empty listing', async () => {
    await expect(runArchive({root: join(tmp, 'missing'), now, apply: true}))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('requires an explicit CLI root when neither argv nor env supplies one', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await main(['--json'], {})).toBe(2);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      ok: false, errors: [{message: 'Root must be an absolute nonempty path'}],
    });
  });

  it.each(['already-present', 'late-arrival'])
  ('archives later same-day receipts on a second run: %s', async variant => {
    const earlyTime = now - 7 * DAY, lateTime = earlyTime + 12 * HOUR;
    const early = await receipt(receiptName('early.receipt'), Buffer.from('early'), earlyTime);
    const lateBytes = Buffer.from('late');
    if (variant === 'already-present') await receipt(receiptName('late.receipt'), lateBytes, lateTime);
    const first = await runArchive({root, now: now + 3 * HOUR, apply: true});
    expect(first.ok).toBe(true);
    expect(first.counts.archivedFiles).toBe(1);
    const firstName = archiveName(dayOf(earlyTime));
    const firstBytes = await fs.readFile(join(root, firstName));
    expect(decode(firstBytes).map(record => record.name)).toEqual([early.name]);
    if (variant === 'late-arrival') await receipt(receiptName('late.receipt'), lateBytes, lateTime);

    const second = await runArchive({root, now: now + DAY, apply: true});
    expect(second.ok).toBe(true);
    expect(second.counts.archivedFiles).toBe(1);
    const secondName = `receipts-${dayOf(earlyTime)}-1.jsonl.gz`;
    expect((await fs.readdir(root)).sort()).toEqual([firstName, secondName].sort());
    expect(await fs.readFile(join(root, firstName))).toEqual(firstBytes);
    expect(decode(await fs.readFile(join(root, secondName)))).toEqual([
      expect.objectContaining({name: receiptName('late.receipt'), data: lateBytes.toString('base64'), sha256: hash(lateBytes)}),
    ]);
    const third = await runArchive({root, now: now + DAY, apply: true});
    expect(third.plan.archive).toEqual([]);
    expect(third.counts.archivedFiles).toBe(0);
  });

  it('archives remaining originals on retry after partial deletion without replacing the first archive', async () => {
    await receipt(receiptName('a'));
    const remaining = await receipt(receiptName('z'));
    const first = await runArchive({root, now, apply: true, io: {...fs,
      async unlink(path) {
        if (path === join(root, receiptName('z'))) throw new Error('simulated unlink failure');
        return fs.unlink(path);
      },
    }});
    expect(first.ok).toBe(false);
    expect(first.counts.archivedFiles).toBe(1);
    const firstName = archiveName(dayOf(remaining.mtimeMs));
    const firstBytes = await fs.readFile(join(root, firstName));
    const retry = await runArchive({root, now, apply: true});
    expect(retry.ok).toBe(true);
    expect(retry.counts.archivedFiles).toBe(1);
    expect(await fs.readFile(join(root, firstName))).toEqual(firstBytes);
    const retryName = `receipts-${dayOf(remaining.mtimeMs)}-1.jsonl.gz`;
    expect((await fs.readdir(root)).sort()).toEqual([firstName, retryName].sort());
    expect(decode(await fs.readFile(join(root, retryName))).map(record => record.name)).toEqual([receiptName('z')]);
  });

  it('retains numbered archives until the same UTC-day retention boundary as the first archive', async () => {
    const day = dayOf(now - 8 * DAY);
    const names = [archiveName(day), `receipts-${day}-1.jsonl.gz`, `receipts-${day}-2.jsonl.gz`];
    for (const name of names) await receipt(name, Buffer.from('archive bytes'), now - 8 * DAY);
    const retained = await runArchive({root, now: now + 22 * DAY - 1, apply: true});
    expect(retained.ok).toBe(true);
    expect(retained.plan.archive).toEqual([]);
    expect(retained.plan.deleteArchives).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual([...names].sort());
    const expired = await runArchive({root, now: now + 22 * DAY, apply: true});
    expect(expired.ok).toBe(true);
    expect(expired.plan.archive).toEqual([]);
    expect(expired.counts.archivesDeleted).toBe(3);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('round-trips binary and text receipts, reads back the final archive, then deletes originals', async () => {
    const originals = [await receipt(receiptName('z.receipt'), Buffer.from([0, 255, 10, 128])), await receipt(receiptName('a.receipt'))];
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

  it('fsyncs the staged file before publication and the directory before every unlink', async () => {
    const originals = [await receipt(receiptName('one')), await receipt(receiptName('two'))];
    const events = [];
    const io = {...fs,
      async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        const kind = path === root ? 'directory' : 'file';
        events.push(`open:${kind}`);
        return {
          async sync() { await handle.sync(); events.push(`sync:${kind}`); },
          async close() { await handle.close(); events.push(`close:${kind}`); },
        };
      },
      async link(from, to) { await fs.link(from, to); events.push('publish'); },
      async unlink(path) { events.push(`unlink:${basename(path)}`); await fs.unlink(path); },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(result.ok).toBe(true);
    expect(result.counts.archivedFiles).toBe(originals.length);
    expect(events.slice(2, 9)).toEqual([
      'open:file', 'sync:file', 'close:file', 'publish',
      'open:directory', 'sync:directory', 'close:directory',
    ]);
    for (const [index, event] of events.entries()) {
      if (event.startsWith('unlink:')) {
        expect(events.indexOf('sync:file')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('sync:directory')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('sync:file')).toBeLessThan(index);
        expect(events.indexOf('sync:directory')).toBeLessThan(index);
      }
    }
  });

  it.each(['file', 'directory'])('keeps originals and closes the handle when %s fsync fails', async kind => {
    const originals = [await receipt(receiptName('one')), await receipt(receiptName('two'))];
    const closed = [], originalUnlinks = [];
    const io = {...fs,
      async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        return {
          async sync() {
            if ((path === root ? 'directory' : 'file') === kind) throw new Error(`simulated ${kind} fsync failure`);
            await handle.sync();
          },
          async close() { await handle.close(); closed.push(path); },
        };
      },
      async unlink(path) {
        if (originals.some(original => path === join(root, original.name))) originalUnlinks.push(path);
        await fs.unlink(path);
      },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({message: `simulated ${kind} fsync failure`})]);
    expect(result.counts).toMatchObject({archivedFiles: 0, archivesWritten: 0});
    expect(closed.filter(path => kind === 'directory' ? path === root : path !== root).length)
      .toBe(kind === 'directory' ? 1 : 2);
    expect(originalUnlinks).toEqual([]);
    await expectOriginals(originals);
    expect((await fs.readdir(root)).sort()).toEqual([receiptName('one'), receiptName('two')]);
  });

  it.each(['write', 'rename'])('preserves originals and removes temp files after archive %s failure', async stage => {
    const originals = [await receipt(receiptName('one')), await receipt(receiptName('two'))];
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
    expect((await fs.readdir(root)).sort()).toEqual([receiptName('one'), receiptName('two')]);
  });

  it.each(['invalid-gzip', 'entry-count', 'sha256', 'replaced-data-and-hash'])('fails closed on corrupted read-back: %s', async corruption => {
    const originals = [await receipt(receiptName('one')), await receipt(receiptName('two'))];
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
    expect((await fs.readdir(root)).sort()).toEqual([receiptName('one'), receiptName('two')]);
    const retry = await runArchive({root, now, apply: true});
    expect(retry.ok).toBe(true);
    expect(retry.counts.archivedFiles).toBe(2);
  });

  it('preserves a pre-existing temp file owned by another writer', async () => {
    const original = await receipt(receiptName('one'));
    const tempName = `.tmp-${archiveName(dayOf(original.mtimeMs))}`;
    const competingBytes = Buffer.from('another writer is still working');
    await fs.writeFile(join(root, tempName), competingBytes);
    const result = await runArchive({root, now, apply: true});
    expect(result.ok).toBe(false);
    expect(result.counts.archivedFiles).toBe(0);
    expect(await fs.readFile(join(root, original.name))).toEqual(original.data);
    expect(await fs.readFile(join(root, tempName))).toEqual(competingBytes);
    expect((await fs.readdir(root)).sort()).toEqual([tempName, receiptName('one')].sort());
  });

  it.each(['destination-check', 'link'])('preserves an archive published by a competing writer at %s', async stage => {
    const original = await receipt(receiptName('one'));
    const finalPath = join(root, archiveName(dayOf(original.mtimeMs)));
    const competingBytes = Buffer.from('competing archive bytes');
    let published = false;
    const io = {...fs,
      async lstat(path) {
        if (stage === 'destination-check' && path === finalPath && !published) {
          await fs.writeFile(finalPath, competingBytes);
          published = true;
        }
        return fs.lstat(path);
      },
      async link(from, to) {
        if (stage === 'link') {
          await fs.writeFile(to, competingBytes);
          published = true;
        }
        return fs.link(from, to);
      },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(published).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({archivesWritten: 0, archivedFiles: 0});
    expect(result.errors[0].message).toMatch(stage === 'link' ? /EEXIST/ : /destination already exists/);
    await expectOriginals([original]);
    expect(await fs.readFile(finalPath)).toEqual(competingBytes);
    expect((await fs.readdir(root)).sort()).toEqual([basename(finalPath), receiptName('one')].sort());
  });

  it.each(['append', 'same-size-content', 'stat-error', 'before-first-unlink'])
  ('validates the entire batch before deleting any original and permits retry after %s', async change => {
    const originals = [await receipt(receiptName('a')), await receipt(receiptName('z'))];
    const finalPath = join(root, archiveName(dayOf(originals[0].mtimeMs)));
    const changedPath = join(root, change === 'before-first-unlink' ? receiptName('a') : receiptName('z'));
    let verified = false, changed = false, checks = 0;
    const originalUnlinks = [];
    const io = {...fs,
      async readFile(path, ...args) {
        const bytes = await fs.readFile(path, ...args);
        if (path === finalPath) verified = true;
        return bytes;
      },
      async lstat(path) {
        if (verified && path === changedPath) {
          checks++;
          if (!changed && checks === (change === 'before-first-unlink' ? 2 : 1)) {
            changed = true;
            if (change === 'stat-error') throw new Error('simulated original stat failure');
            await fs.writeFile(path, change === 'same-size-content' ? Buffer.from('changed\n') : Buffer.from('appended receipt\n'));
          }
        }
        const stat = await fs.lstat(path);
        // Keep metadata identical to isolate the content-hash guard.
        if (changed && change === 'same-size-content' && path === changedPath) {
          return {...stat, isFile: () => true, isSymbolicLink: () => false,
            mtimeMs: originals[1].mtimeMs, ctimeMs: listedStat.ctimeMs};
        }
        return stat;
      },
      async unlink(path) {
        if (originals.some(original => path === join(root, original.name))) originalUnlinks.push(path);
        return fs.unlink(path);
      },
    };
    const listedStat = await fs.lstat(changedPath);
    const result = await runArchive({root, now, apply: true, io});
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({day: dayOf(originals[0].mtimeMs),
      message: change === 'stat-error' ? 'simulated original stat failure' : 'Original changed before deletion'})]);
    expect(result.counts).toMatchObject({archivesWritten: 0, archivedFiles: 0});
    expect(originalUnlinks).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual([receiptName('a'), receiptName('z')]);
    expect(await fs.readFile(join(root, receiptName('a')))).toEqual(change === 'before-first-unlink' ? Buffer.from('appended receipt\n') : originals[0].data);
    expect(await fs.readFile(join(root, receiptName('z')))).toEqual(change === 'stat-error' || change === 'before-first-unlink'
      ? originals[1].data : Buffer.from(change === 'same-size-content' ? 'changed\n' : 'appended receipt\n'));
    // Allow the modified receipt to age before retrying with the real filesystem adapter.
    await fs.utimes(changedPath, originals[0].mtimeMs / 1000, originals[0].mtimeMs / 1000);
    const retry = await runArchive({root, now, apply: true});
    expect(retry.ok).toBe(true);
    expect(retry.counts.archivedFiles).toBe(2);
    expect((await fs.readdir(root)).sort()).toEqual([basename(finalPath)]);
    const records = decode(await fs.readFile(finalPath));
    expect(Buffer.from(records.find(record => record.name === basename(changedPath)).data, 'base64'))
      .toEqual(change === 'stat-error' ? originals[1].data : Buffer.from(change === 'same-size-content' ? 'changed\n' : 'appended receipt\n'));
  });

  it('reports failed archive rollback and still processes an independent day', async () => {
    const original = await receipt(receiptName('one'));
    const other = await receipt(receiptName('other-day'), Buffer.from('other receipt\n'), now - 7 * DAY);
    const finalPath = join(root, archiveName(dayOf(original.mtimeMs)));
    const otherPath = join(root, archiveName(dayOf(other.mtimeMs)));
    let verified = false;
    const io = {...fs,
      async readFile(path, ...args) {
        const bytes = await fs.readFile(path, ...args);
        if (path === finalPath) verified = true;
        return bytes;
      },
      async lstat(path) {
        if (verified && path === join(root, original.name)) throw new Error('original unreadable');
        return fs.lstat(path);
      },
      async unlink(path) {
        if (path === finalPath) throw new Error('rollback denied');
        return fs.unlink(path);
      },
    };
    const result = await runArchive({root, now, apply: true, io});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {day: dayOf(original.mtimeMs), message: 'original unreadable'},
      {day: dayOf(original.mtimeMs), message: 'Archive cleanup failed: rollback denied'},
    ]);
    expect(result.counts).toMatchObject({archivesWritten: 2, archivedFiles: 1});
    expect((await fs.readdir(root)).sort()).toEqual([basename(finalPath), basename(otherPath), receiptName('one')].sort());
    expect(await fs.readFile(join(root, original.name))).toEqual(original.data);
    expect(decode(await fs.readFile(otherPath))[0].name).toBe(other.name);
  });

  it('retains the verified archive after a partial unlink failure so deleted originals remain recoverable', async () => {
    const originals = [await receipt(receiptName('a')), await receipt(receiptName('z'))];
    const finalPath = join(root, archiveName(dayOf(originals[0].mtimeMs)));
    const io = {...fs, async unlink(path) {
      if (path === join(root, receiptName('z'))) throw new Error('simulated unlink failure');
      return fs.unlink(path);
    }};
    const result = await runArchive({root, now, apply: true, io});
    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({archivesWritten: 1, archivedFiles: 1});
    expect((await fs.readdir(root)).sort()).toEqual([basename(finalPath), receiptName('z')].sort());
    expect(await fs.readFile(join(root, receiptName('z')))).toEqual(originals[1].data);
    expect(decode(await fs.readFile(finalPath)).map(record => record.name)).toEqual([receiptName('a'), receiptName('z')]);
  });

  it('dry-run defaults to no writes, renames or deletions and returns a plan and counts', async () => {
    const original = await receipt(receiptName('one'));
    const expired = archiveName(dayOf(now - 30 * DAY));
    await fs.writeFile(join(root, expired), 'existing archive');
    const names = (await fs.readdir(root)).sort();
    const before = await fs.lstat(join(root, original.name));
    const mutation = vi.fn(async () => { throw new Error('dry-run attempted mutation'); });
    const result = await runArchive({root, now, io: {...fs, writeFile: mutation, rename: mutation, unlink: mutation, rm: mutation}});
    expect(result.mode).toBe('dry-run');
    expect(result.plan.archive).toEqual([bucket(original.mtimeMs, [receiptName('one')])]);
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
    const original = await receipt(receiptName('one'));
    const link = join(tmp, 'root-link');
    await fs.symlink(root, link);
    await expect(runArchive({root: link, now, apply: true})).rejects.toThrow();
    await expectOriginals([original]);
    expect(await fs.readdir(root)).toEqual([receiptName('one')]);
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
    const original = await receipt(receiptName('one'));
    const output = captureOutput();
    const argv = ['--json', `--now=${new Date(now).toISOString()}`];
    if (source === 'flag') argv.push(`--root=${root}`);
    const code = await main(argv, {FORGE_RECEIPTS_DIR: source === 'environment' ? root : join(tmp, 'missing')});
    expect(code).toBe(0);
    const result = JSON.parse(output());
    expect(result.mode).toBe('dry-run');
    expect(result.plan.archive).toEqual([bucket(original.mtimeMs, [receiptName('one')])]);
    await expectOriginals([original]);
    expect(await fs.readdir(root)).toEqual([receiptName('one')]);
  });

  it.each(['apply-first', 'now-first', 'dry-run'])('CLI permits --now only for dry-run: %s', async mode => {
    const wallNow = Date.now();
    const original = await receipt(receiptName('fresh.receipt'), Buffer.from('fresh receipt'), wallNow);
    const recentArchive = archiveName(dayOf(wallNow - DAY));
    await fs.writeFile(join(root, recentArchive), 'recent archive');
    const nowFlag = `--now=${new Date(wallNow + 60 * DAY).toISOString()}`;
    const flags = mode === 'apply-first' ? ['--apply', nowFlag]
      : mode === 'now-first' ? [nowFlag, '--apply'] : [nowFlag];
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../forge-receipts-archive.mjs', import.meta.url)),
      `--root=${root}`, '--json', ...flags], {encoding: 'utf8', timeout: 10_000});
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(mode === 'dry-run' ? 0 : 2);
    const result = JSON.parse(child.stdout);
    if (mode === 'dry-run') {
      expect(result.mode).toBe('dry-run');
      expect(result.plan.archive).toEqual([bucket(original.mtimeMs, [original.name])]);
      expect(result.plan.deleteArchives).toEqual([recentArchive]);
    } else {
      expect(result).toEqual({ok: false, errors: [{message: '--now is only allowed in dry-run mode'}]});
    }
    await expectOriginals([original]);
    expect(await fs.readFile(join(root, recentArchive), 'utf8')).toBe('recent archive');
    expect((await fs.readdir(root)).sort()).toEqual([original.name, recentArchive].sort());
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
