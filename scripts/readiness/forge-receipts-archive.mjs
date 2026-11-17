/**
 * Receipt retention: node scripts/readiness/forge-receipts-archive.mjs --root=/path --json
 * Defaults to dry-run; --apply writes verified daily archives and removes originals.
 * Later batches for a day use receipts-DAY-N.jsonl.gz; all batches expire by UTC day.
 * --now=<date> overrides the clock for dry-run only; it cannot be used with --apply.
 * Root: --root > FORGE_RECEIPTS_DIR > /srv/forge-receipts. Timer wiring is a later slice.
 * Apply holds exclusive Forge worker-writer leases from listing through deletion.
 * Requires /usr/bin/python3 (fcntl); busy or untrusted leases refuse the apply.
 */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, normalize, parse, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => typeof name === 'string' && name.length > 0
  && !name.includes('..') && !/[\\/\x00-\x1f\x7f]/.test(name);
// Match the run ids and record families emitted by forge-exec-run.mjs.
// An absolute end assertion rejects Unicode line separators as well as suffixes.
const runRecord = name => /^(r-[a-f0-9]{32})\.(receipt|rejected|cancel|consumed|telemetry|base|prepared|running)(?![\s\S])/.exec(name);
const archiveDay = name => {
  const match = /^receipts-(\d{4}-\d{2}-\d{2})(?:-[1-9]\d*)?\.jsonl\.gz(?![\s\S])/.exec(name);
  if (!match) return null;
  const time = Date.parse(`${match[1]}T00:00:00Z`);
  // utc-day-slice-ok: archive names encode UTC days; reject invalid calendar dates by round-trip.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === match[1]
    ? match[1] : null;
};

function options(now, {keepDays = 7, archiveDays = 30} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid now');
  for (const value of [keepDays, archiveDays]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Retention days must be nonnegative numbers');
  }
  return {keepDays, archiveDays};
}

/** Pure planner; accepts listing metadata, never reads or mutates the filesystem. */
export function planArchive(entries, now = Date.now(), settings = {}) {
  const {keepDays, archiveDays} = options(now, settings);
  const existing = new Set(entries.filter(e => safeName(e.name) && e.kind === 'file')
    .map(e => e.name));
  const unfinished = new Set();
  // Inspect the entire listing first, independent of marker age, kind or order.
  // A malformed marker object still means its run is unsafe to collect.
  for (const {name} of entries) {
    const record = safeName(name) && runRecord(name);
    if (record && ['prepared', 'running'].includes(record[2])) unfinished.add(record[1]);
  }
  const buckets = new Map();
  const result = {archive: [], deleteArchives: [], skipped: []};
  for (const entry of entries) {
    const {name, kind, mtimeMs} = entry;
    let reason;
    if (!safeName(name)) reason = 'unsafe-name';
    else if (kind === 'symlink') reason = 'symlink';
    else if (kind !== 'file') reason = 'not-file';
    else if (name.startsWith('.tmp-')) reason = 'temporary-file';
    else if (/^\.worker-active.*\.writer$/.test(name) || /\.(prepared|running)$/.test(name)) reason = 'protected-lock-or-run-state';
    else {
      const day = archiveDay(name);
      if (day) {
        if (now - Date.parse(`${day}T00:00:00Z`) >= archiveDays * DAY) result.deleteArchives.push(name);
        continue;
      }
      const record = runRecord(name);
      if (!record) reason = 'unrecognized';
      else if (unfinished.has(record[1])) reason = 'unfinished-run';
      else if (!Number.isFinite(mtimeMs) || !Number.isFinite(new Date(mtimeMs).getTime())) reason = 'invalid-mtime';
      else if (now - mtimeMs < HOUR) reason = 'active';
      else if (now - mtimeMs < keepDays * DAY) reason = 'recent';
      else {
        // utc-day-slice-ok: retention buckets use receipt mtimes at UTC midnight, independent of operator timezone.
        const day = new Date(mtimeMs).toISOString().slice(0, 10);
        if (!buckets.has(day)) buckets.set(day, []);
        buckets.get(day).push(name);
      }
    }
    if (reason) result.skipped.push({name, reason});
  }
  result.archive = [...buckets].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, files]) => {
      // A day can have newly eligible receipts or survivors of a partial unlink.
      // Keep previous batches intact; publication still refuses a concurrent winner.
      let archiveName = `receipts-${day}.jsonl.gz`, batch = 0;
      while (existing.has(archiveName)) archiveName = `receipts-${day}-${++batch}.jsonl.gz`;
      return {day, archiveName, files: files.sort()};
    });
  result.deleteArchives.sort();
  return result;
}

export function validateRoot(root) {
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) throw new Error('Root must be an absolute nonempty path');
  const normalized = normalize(root);
  if (normalized === parse(normalized).root) throw new Error('Refusing filesystem root');
  return normalized;
}

async function assertDirectory(root, io) {
  const stat = await io.lstat(root.replace(/\/+$/, ''));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Root must be a real directory');
}

async function regularStat(path, io) {
  const stat = await io.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file');
  return stat;
}

const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const readNoFollow = (path, io) => io.readFile(path, {flag: constants.O_RDONLY | constants.O_NOFOLLOW});

const workerName = name => /^(?:\.(worker-active(?:-[1-9]\d*)?)\.writer|(worker-active(?:-[1-9]\d*)?))(?![\s\S])/.exec(name);
async function writerNames(root, io) {
  const names = new Set(['worker-active']);
  for await (const {name} of await io.opendir(root)) {
    const match = workerName(name);
    if (match) names.add(match[1] ?? match[2]);
    if (names.size > 129) throw new Error('Writer lease scan exceeds 129 workers; inspect worker configuration before retrying');
  }
  return [...names].sort();
}

async function ownReceiptWriters(root, io) {
  const handles = [];
  try {
    const owner = await io.lstat(root), names = await writerNames(root, io);
    for (const name of names) {
      const path = join(root, `.${name}.writer`);
      const guard = await io.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      handles.push(guard);
      const stat = await guard.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || ![0, owner.uid].includes(stat.uid)) {
        throw new Error('Untrusted writer lease; inspect ownership, links and permissions before retrying');
      }
      // Match forge-exec-run's withWorkerWriter and the sweeper's stable-inode
      // flock protocol. The parent's fd keeps the exclusive lease after Python exits.
      // A privileged first run must leave the guard usable by the receipt owner.
      if (stat.uid === 0 && owner.uid !== 0) await guard.chown(owner.uid, owner.gid);
      const locked = spawnSync('/usr/bin/python3', ['-I', '-c',
        'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],
      {stdio: ['ignore', 'ignore', 'ignore', guard.fd], timeout: 5000});
      if (locked.error || locked.status !== 0) throw new Error('Writer lease unavailable; retry after Forge writers settle and inspect /usr/bin/python3 if persistent');
      const current = await io.lstat(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Writer lease replaced; stop writers and inspect before retrying');
    }
    // Guard discovery precedes the receipt snapshot. Refuse if the worker set
    // changed while acquiring leases; the next apply will acquire the new set.
    if ((await writerNames(root, io)).some(name => !names.includes(name))) {
      throw new Error('Writer set changed while acquiring leases; retry with the new worker set');
    }
    return async () => {
      const closed = await Promise.allSettled(handles.map(handle => handle.close()));
      if (closed.some(result => result.status === 'rejected')) throw new Error('Writer lease release failed; inspect before retrying');
    };
  } catch (error) {
    await Promise.allSettled(handles.map(handle => handle.close()));
    throw error;
  }
}

async function syncPath(path, io, flags = 0) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | flags);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

// Called only while ownReceiptWriters holds every exclusive writer lease.
// All archive applies hold the legacy lease, even before reserving a temp, so
// acquiring it proves no cooperating live owner remains (including a paused one).
// Kernel leases release on crash; persistent guard files are never age-deleted.
async function reserveTemp(temp, snapshot, now, io) {
  try { return await io.open(temp, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    const current = await regularStat(temp, io);
    if (!snapshot || !sameFile(current, snapshot) || current.nlink !== 1
      || !Number.isFinite(current.mtimeMs) || now - current.mtimeMs <= HOUR) {
      throw new Error('Temp is not provably abandoned');
    }
    // Only the exact fixed temp for this bucket is eligible. Never scan/delete
    // originals, published archives, UUID stages or any ownership guard here.
    await io.unlink(temp);
    return await io.open(temp, 'wx', 0o600); // One retry; never remove a new winner.
  } catch (error) {
    throw new Error(`Cannot recover temp ${JSON.stringify(temp)}: ${error.message}. `
      + `Recovery: stop archive applies and Forge writers; inspect ${JSON.stringify(temp)} `
      + 'and its ownership; remove only that temp if confirmed abandoned, then retry --apply.');
  }
}

function verifyArchive(bytes, originals) {
  const lines = gunzipSync(bytes).toString('utf8').trimEnd().split('\n');
  if (lines.length !== originals.length) throw new Error('Archive entry count mismatch');
  for (let i = 0; i < lines.length; i++) {
    const actual = JSON.parse(lines[i]), expected = originals[i];
    if (actual.name !== expected.name || actual.mtimeMs !== expected.mtimeMs
      || actual.size !== expected.size || actual.sha256 !== expected.sha256
      || actual.data !== expected.data || hash(Buffer.from(actual.data, 'base64')) !== expected.sha256) {
      throw new Error('Archive content or sha256 mismatch');
    }
  }
}

export async function runArchive({root, now = Date.now(), apply = false, io = fs, ...settings} = {}) {
  root = validateRoot(root);
  options(now, settings);
  await assertDirectory(root, io);
  // Ownership, rather than another stat/unlink check, excludes cooperating
  // receipt writers from the final-check window. Always take a fresh snapshot
  // under the leases, and keep stable guard inodes even on failure or a crash.
  const release = apply ? await ownReceiptWriters(root, io) : null;
  try {
    return await archiveOwned({root, now, apply, io, settings});
  } finally { if (release) await release(); }
}

async function archiveOwned({root, now, apply, io, settings}) {
  const entries = [], stats = new Map();
  const directory = await io.opendir(root);
  for await (const entry of directory) {
    let stat;
    try { stat = await io.lstat(join(root, entry.name)); }
    catch (error) {
      // The exec sweeper can remove a receipt after opendir yields its name.
      // Only absence during listing is benign; later validation still fails closed.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other';
    entries.push({name: entry.name, kind, mtimeMs: stat.mtimeMs, size: stat.size});
    stats.set(entry.name, stat);
  }
  const plan = planArchive(entries, now, settings);
  const result = {mode: apply ? 'apply' : 'dry-run', ok: true, plan, errors: [],
    counts: {archivedFiles: 0, archivesWritten: 0, archivesDeleted: 0, skipped: plan.skipped.length}};
  if (!apply) return result;

  for (const bucket of plan.archive) {
    const target = join(root, bucket.archiveName), temp = join(root, `.tmp-${bucket.archiveName}`);
    const staged = `${temp}-${randomUUID()}`;
    let ownsTemp = false, ownsStage = false, published = false, verified = false, deletionStarted = false;
    try {
      const originals = [];
      for (const name of bucket.files) {
        const path = join(root, name), before = await regularStat(path, io);
        if (!sameFile(before, stats.get(name))) throw new Error('Receipt changed since listing');
        const data = await readNoFollow(path, io);
        if (!sameFile(before, await regularStat(path, io)) || data.length !== before.size) throw new Error('Receipt changed during read');
        originals.push({name, mtimeMs: before.mtimeMs, size: data.length, sha256: hash(data), data: data.toString('base64')});
      }
      try {
        await io.lstat(target);
        throw new Error('Archive destination already exists');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Exclusively reserve the temp path so cleanup cannot remove another writer's temp.
      const handle = await reserveTemp(temp, stats.get(`.tmp-${bucket.archiveName}`), now, io);
      ownsTemp = true;
      await handle.close();
      await io.writeFile(temp, gzipSync(originals.map(record => JSON.stringify(record)).join('\n') + '\n'),
        {flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW});
      // Rename privately, then publish with link's atomic no-replace semantics.
      // A destination check alone cannot protect against another publisher winning the race.
      ownsStage = true;
      await io.rename(temp, staged);
      ownsTemp = false;
      // Persist the archive bytes before publishing, then persist its directory entry.
      // Read-back alone can succeed from page cache without making either durable.
      await syncPath(staged, io);
      await io.link(staged, target);
      published = true;
      await syncPath(root, io, constants.O_DIRECTORY);
      await io.unlink(staged);
      ownsStage = false;
      await regularStat(target, io);
      verifyArchive(await readNoFollow(target, io), originals);
      verified = true;
      // Validate the entire batch before beginning deletion.
      for (const original of originals) {
        const path = join(root, original.name);
        if (!sameFile(await regularStat(path, io), stats.get(original.name))
          || hash(await readNoFollow(path, io)) !== original.sha256) throw new Error('Original changed before deletion');
      }
      for (const original of originals) {
        const path = join(root, original.name);
        if (!sameFile(await regularStat(path, io), stats.get(original.name))) throw new Error('Original changed before deletion');
        // Once an unlink is attempted, keep the archive: it may be the only copy of deleted data.
        deletionStarted = true;
        await io.unlink(path);
        result.counts.archivedFiles++;
      }
    } catch (error) {
      result.errors.push({day: bucket.day, message: error.message});
      if (published && !deletionStarted) {
        // Read-back or original validation failed before any deletion: unblock a complete retry.
        try { await io.unlink(target); published = false; }
        catch (cleanupError) {
          if (cleanupError.code === 'ENOENT') published = false;
          else result.errors.push({day: bucket.day, message: `Archive cleanup failed: ${cleanupError.message}`});
        }
      }
    } finally {
      if (published && verified) result.counts.archivesWritten++;
      for (const path of [ownsTemp && temp, ownsStage && staged].filter(Boolean)) {
        try { await io.unlink(path); }
        catch (error) {
          if (error.code !== 'ENOENT') result.errors.push({day: bucket.day, message: `Temp cleanup failed: ${error.message}`});
        }
      }
    }
  }
  for (const name of plan.deleteArchives) {
    try {
      const path = join(root, name);
      if (!sameFile(await regularStat(path, io), stats.get(name))) throw new Error('Archive changed since listing');
      await io.unlink(path);
      result.counts.archivesDeleted++;
    } catch (error) { result.errors.push({name, message: error.message}); }
  }
  result.ok = result.errors.length === 0;
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env, {io = fs} = {}) {
  let root = env.FORGE_RECEIPTS_DIR ?? '/srv/forge-receipts', now = Date.now(), apply = false;
  const json = argv.includes('--json');
  const output = result => process.stdout.write(json ? `${JSON.stringify(result)}\n`
    : `${result.mode ?? 'error'}: ${JSON.stringify(result)}\n`);
  try {
    for (const arg of argv) {
      if (arg === '--apply') apply = true;
      else if (arg === '--json') continue;
      else if (arg.startsWith('--root=')) root = arg.slice(7);
      else if (arg.startsWith('--now=')) now = Date.parse(arg.slice(6));
      else throw new Error(`Unknown argument: ${arg}`);
    }
    if (apply && argv.some(arg => arg.startsWith('--now='))) throw new Error('--now is only allowed in dry-run mode');
    root = validateRoot(root);
    options(now);
  } catch (error) {
    output({ok: false, errors: [{message: error.message}]});
    return 2;
  }
  try {
    const result = await runArchive({root, now, apply, io});
    output(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    output({mode: apply ? 'apply' : 'dry-run', ok: false, errors: [{message: error.message}]});
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint === undefined || entrypoint === '-' || import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main();
}
