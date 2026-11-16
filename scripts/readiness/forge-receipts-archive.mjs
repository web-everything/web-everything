/**
 * Receipt retention: node scripts/readiness/forge-receipts-archive.mjs --root=/path --json
 * Defaults to dry-run; --apply writes verified daily archives and removes originals.
 * FORGE_RECEIPTS_DIR supplies the root when omitted. Timer wiring is a later slice.
 */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, normalize, parse, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => typeof name === 'string' && name.length > 0
  && !name.includes('..') && !/[\\/\x00-\x1f\x7f]/.test(name);
const archiveDay = name => {
  const match = /^receipts-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(name);
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
    .map(e => archiveDay(e.name)).filter(Boolean));
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
      if (!Number.isFinite(mtimeMs) || !Number.isFinite(new Date(mtimeMs).getTime())) reason = 'invalid-mtime';
      else if (now - mtimeMs < HOUR) reason = 'active';
      else if (now - mtimeMs < keepDays * DAY) reason = 'recent';
      else {
        // utc-day-slice-ok: retention buckets use receipt mtimes at UTC midnight, independent of operator timezone.
        const day = new Date(mtimeMs).toISOString().slice(0, 10);
        if (existing.has(day)) reason = 'day-already-archived';
        else {
          if (!buckets.has(day)) buckets.set(day, []);
          buckets.get(day).push(name);
        }
      }
    }
    if (reason) result.skipped.push({name, reason});
  }
  result.archive = [...buckets].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, files]) => ({day, archiveName: `receipts-${day}.jsonl.gz`, files: files.sort()}));
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
  const entries = [], stats = new Map();
  const directory = await io.opendir(root);
  for await (const entry of directory) {
    const stat = await io.lstat(join(root, entry.name));
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
      const handle = await io.open(temp, 'wx', 0o600);
      ownsTemp = true;
      await handle.close();
      await io.writeFile(temp, gzipSync(originals.map(record => JSON.stringify(record)).join('\n') + '\n'),
        {flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW});
      // Rename privately, then publish with link's atomic no-replace semantics.
      // A destination check alone cannot protect against another publisher winning the race.
      ownsStage = true;
      await io.rename(temp, staged);
      ownsTemp = false;
      await io.link(staged, target);
      published = true;
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  let root = env.FORGE_RECEIPTS_DIR, now = Date.now(), apply = false;
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
    root = validateRoot(root);
    options(now);
  } catch (error) {
    output({ok: false, errors: [{message: error.message}]});
    return 2;
  }
  try {
    const result = await runArchive({root, now, apply});
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
