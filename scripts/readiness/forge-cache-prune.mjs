#!/usr/bin/env node
// Standalone Forge installation: keep every dependency a Node builtin.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const HOUR = 3_600_000;
const HEX = /^[a-f0-9]{64}(?![\s\S])/;
const WORKER = /^worker-active(?:-[1-9][0-9]*)?(?![\s\S])/;
const RUN = /^(?:r-|warm-)[a-f0-9]{32}(?![\s\S])/;
const LIMIT = 4 * 1024 * 1024;
const repair = 'preserving cache; inspect evidence and repair it before retrying';

export function resolveSettings(env = process.env) {
  const sources = {};
  const setting = (key, variable, valid, transform = x => x) => {
    const raw = env[variable];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    const accepted = Number.isFinite(n) && valid(n);
    if (!accepted) throw new Error(`Missing or invalid ${variable}; set a valid service Environment= value before retrying; ${repair}`);
    sources[key] = `environment:${variable}`;
    return transform(n);
  };
  return {
    maxAgeHours: setting('maxAgeHours', 'FORGE_CACHE_MAX_AGE_HOURS', () => true,
      n => Math.max(6, Math.min(24, n))),
    maxBytes: setting('maxBytes', 'FORGE_CACHE_MAX_BYTES',
      n => n > 0 && n <= Number.MAX_SAFE_INTEGER),
    highWaterPct: setting('highWaterPct', 'FORGE_CACHE_HIGH_WATER_PCT', n => n >= 0 && n <= 100),
    minAgeMs: HOUR,
    sources,
  };
}

function validEntry(root, e) {
  return typeof root === 'string' && root === resolve(root) && HEX.test(e.lock)
    && typeof e.name === 'string' && e.name.length > 0 && !['.', '..'].includes(e.name)
    && !e.name.includes('/') && !e.name.includes('\0') && e.path === join(root, e.lock, e.name)
    && Number.isFinite(e.mtimeMs) && Number.isSafeInteger(e.bytes) && e.bytes >= 0;
}

function liveProtects(live, lock, name) {
  if (live.locks?.has(lock) || live.profiles.has(`${lock}/${name}`)) return true;
  // Evidence uses a canonical v5 key, but the digest may be active in any
  // profile layout. Older wrappers do not participate in our writer leases.
  const profile = /^dev-v[0-9]+-([a-f0-9]{64})(?![\s\S])/.exec(name);
  return !!profile && live.profiles.has(`${lock}/dev-v5-${profile[1]}`);
}

export function planPrune({root, entries, now = Date.now(), settings = resolveSettings(), disk, live}) {
  const result = {prune: [], keep: [], now, minAgeMs: Math.max(HOUR, settings.minAgeMs)};
  if (live?.complete !== true || !(live.profiles instanceof Set)) {
    result.refused = `Incomplete live evidence; ${repair}`;
  } else if (!Number.isFinite(now) || !disk || !Number.isFinite(disk.usedPct)
    || disk.usedPct < 0 || disk.usedPct > 100 || !(disk.totalBytes > 0)
    || !Number.isFinite(disk.totalBytes) || !Number.isFinite(disk.usedBytes) || disk.usedBytes < 0
    || !Number.isFinite(settings.maxAgeHours) || settings.maxAgeHours <= 0
    || !Number.isFinite(settings.maxBytes) || settings.maxBytes <= 0
    || !Number.isFinite(settings.highWaterPct) || settings.highWaterPct < 0 || settings.highWaterPct > 100
    || !Number.isFinite(result.minAgeMs)) {
    result.refused = `Invalid pruning bounds; ${repair}`;
  }
  let retained = entries.reduce((sum, e) => sum + (validEntry(root, e) ? e.bytes : 0), 0);
  let reclaimed = 0;
  const protectedProfiles = new Set(live?.profiles);
  for (const e of entries) {
    if (validEntry(root, e) && now - e.mtimeMs < result.minAgeMs) {
      protectedProfiles.add(`${e.lock}/${e.name}`);
      if (e.indexProfile) protectedProfiles.add(`${e.lock}/${e.indexProfile}`);
    }
  }
  const retainedProfiles = new Set();
  const prunedProfiles = new Set();
  const pressure = disk?.usedPct > settings.highWaterPct;
  const target = Math.max(0, settings.highWaterPct - 5) / 100 * (disk?.totalBytes ?? 0);
  // Decide profiles first: an index belongs to its full profile name, and
  // cannot be selected independently while that profile is retained.
  for (const e of [...entries].sort((a, b) => Number(!!a.indexProfile) - Number(!!b.indexProfile)
    || a.mtimeMs - b.mtimeMs || String(a.path).localeCompare(String(b.path)))) {
    let reason;
    let prune = false;
    if (result.refused) reason = result.refused;
    else if (!validEntry(root, e)) reason = 'Invalid cache boundary or metadata';
    else if (liveProtects(live, e.lock, e.name)) reason = 'Protected by live reservation';
    else if (protectedProfiles.has(`${e.lock}/${e.name}`)) reason = 'Protected by minimum age or young index';
    else if (e.indexProfile && (liveProtects(live, e.lock, e.indexProfile)
      || protectedProfiles.has(`${e.lock}/${e.indexProfile}`)
      || retainedProfiles.has(`${e.lock}/${e.indexProfile}`))) reason = 'Index of protected profile';
    else if (now - e.mtimeMs < result.minAgeMs) reason = 'Younger than minimum age';
    else if (e.indexProfile && prunedProfiles.has(`${e.lock}/${e.indexProfile}`)) {
      reason = 'Index of pruned profile'; prune = true;
    }
    else if (now - e.mtimeMs > settings.maxAgeHours * HOUR) { reason = 'Expired age'; prune = true; }
    else if (retained > settings.maxBytes) { reason = 'Cache size cap'; prune = true; }
    else if (pressure && disk.usedBytes - reclaimed > target) { reason = 'Disk high-water hysteresis'; prune = true; }
    else reason = 'Within retention bounds';
    (prune ? result.prune : result.keep).push({...e, reason});
    (prune ? prunedProfiles : retainedProfiles).add(`${e.lock}/${e.name}`);
    if (prune) { retained -= e.bytes; reclaimed += e.bytes; }
  }
  return result;
}

async function directory(path) {
  const st = await fs.lstat(path);
  if (!st.isDirectory()) throw new Error(`Unsafe directory: ${path}; ${repair}`);
  return st;
}

async function readJson(path) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > LIMIT) throw new Error(`Invalid or oversized evidence; ${repair}`);
    // Bound the read even if the file grows after stat.
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMIT) throw new Error(`Oversized evidence; ${repair}`);
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence object');
    return value;
  } finally { await handle.close(); }
}

export async function readLiveEvidence({receipts}) {
  const profiles = new Set(), locks = new Set();
  try {
    await directory(receipts);
    const names = await fs.readdir(receipts);
    if (names.length > 100_000) throw new Error(`Receipt directory exceeds 100000 entries; ${repair}`);
    for (const name of names.filter(n => WORKER.test(n))) {
      const worker = join(receipts, name);
      await directory(worker);
      const {run, writerGuard} = await readJson(join(worker, 'reservation.json'));
      if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid reserved run');
      let found = false;
      for (const suffix of ['prepared', 'running', 'receipt']) {
        let record;
        try { record = await readJson(join(receipts, `${run}.${suffix}`)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (typeof record.lock !== 'string' || !HEX.test(record.lock)) throw new Error('Invalid reserved lock evidence');
        const manifestKnown = record.manifest && typeof record.manifest === 'object' && !Array.isArray(record.manifest);
        const digest = manifestKnown ? (record.manifest.siblings ? record.manifestDigest : record.inputDigest) : undefined;
        const profileKnown = typeof digest === 'string' && HEX.test(digest);
        // A legacy writer can change profiles without taking a lease. Missing
        // profile evidence is likewise safe only at the whole-lock boundary.
        if (writerGuard !== 1 || !profileKnown) locks.add(record.lock);
        // Keep refusing corrupt digests, even though the known lock is protected.
        if (digest !== undefined && !profileKnown) throw new Error('Invalid reserved profile evidence');
        if (profileKnown) profiles.add(`${record.lock}/dev-v5-${digest}`);
        found = true;
      }
      if (!found) throw new Error('Missing reserved run record');
    }
    return {complete: true, profiles, locks};
  } catch (error) {
    return {complete: false, profiles, locks, refused: `${error.message}; ${repair}`};
  }
}

export async function scanCache(root) {
  await directory(root);
  const entries = [];
  let visited = 0;
  async function bytes(path) {
    if (++visited > 1_000_000) throw new Error(`Cache scan exceeds 1000000 entries; ${repair}`);
    const st = await fs.lstat(path);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    await directory(path);
    let size = 0;
    for (const name of await fs.readdir(path)) size += await bytes(join(path, name));
    if (!Number.isSafeInteger(size)) throw new Error(`Cache size overflow; ${repair}`);
    return size;
  }
  for (const lock of await fs.readdir(root)) {
    if (!HEX.test(lock)) continue;
    const parent = join(root, lock);
    if (!(await fs.lstat(parent)).isDirectory()) continue;
    await directory(parent);
    for (const name of await fs.readdir(parent)) {
      const path = join(parent, name), st = await fs.lstat(path);
      const indexProfile = await readIndexProfile(path, name, st);
      entries.push({lock, name, path, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino,
        bytes: st.isDirectory() ? await bytes(path) : st.size, ...(indexProfile ? {indexProfile} : {})});
    }
  }
  return entries;
}

// Warm-input indexes store digests under canonical v5 keys. Live protection
// spans all versions; deletion ownership remains specific to the v5 profile.
async function readIndexProfile(path, name, st) {
  if (!name.startsWith('.warm-inputs-') || !st.isFile()) return undefined;
  try {
    const marker = await readJson(path);
    return typeof marker.profile === 'string' && HEX.test(marker.profile) ? `dev-v5-${marker.profile}` : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error.message === 'Invalid evidence object'
      || error.message.startsWith('Invalid or oversized evidence') || error.message.startsWith('Oversized evidence')) return undefined;
    throw error;
  }
}

// The child starts in the parent's directory, then compares its actual cwd to
// the inherited O_NOFOLLOW descriptor BEFORE any mutation. Renaming the lock
// directory thereafter cannot redirect relative operations. Recursion uses
// single-component names and repeats this descriptor/cwd check on every descent
// and return; rm(recursive) would reintroduce races inside the profile tree.
const DELETE_TREE = String.raw`
import * as fs from 'node:fs';
const e = JSON.parse(process.argv[1]);
const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
function cwd(fd) {
  if (!same(fs.statSync('.'), fs.fstatSync(fd))) throw new Error('Directory substituted; preserving cache');
}
function empty(fd, depth = 0) {
  if (depth > 256) throw new Error('Cache depth exceeds 256; inspect remaining cache manually');
  cwd(fd);
  for (const name of fs.readdirSync('.')) {
    const st = fs.lstatSync(name);
    if (!st.isDirectory()) { fs.unlinkSync(name); continue; }
    const child = fs.openSync(name, flags);
    try {
      if (!same(st, fs.fstatSync(child))) throw new Error('Directory changed; preserving remaining cache');
      process.chdir(name);
      cwd(child);
      empty(child, depth + 1);
      process.chdir('..');
      cwd(fd);
      if (!same(fs.lstatSync(name), fs.fstatSync(child))) throw new Error('Directory changed before removal');
      fs.rmdirSync(name);
    } finally { fs.closeSync(child); }
  }
}
cwd(3);
if (!same(fs.statSync('..'), fs.fstatSync(4))) throw new Error('Cache root substituted; preserving cache');
const st = fs.lstatSync(e.name);
if ((e.name.startsWith('.warm-inputs-') && !st.isFile())
  || st.mtimeMs !== e.mtimeMs
  || (e.ino !== undefined && (st.ino !== e.ino || st.dev !== e.dev))
  || e.now - st.mtimeMs < e.minAgeMs) {
  process.stdout.write('skipped');
} else {
  if (!st.isDirectory()) fs.unlinkSync(e.name);
  else {
  const fd = fs.openSync(e.name, flags);
  try {
    if (!same(st, fs.fstatSync(fd))) throw new Error('Profile changed before removal');
    process.chdir(e.name);
    cwd(fd);
    empty(fd);
    process.chdir('..');
    cwd(3);
    if (!same(fs.lstatSync(e.name), fs.fstatSync(fd))) throw new Error('Profile changed before removal');
    fs.rmdirSync(e.name);
  } finally { fs.closeSync(fd); }
  }
  process.stdout.write('deleted');
}
`;

async function childResult(spawnProcess, command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    let output = '', bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error(`Cache prune child timed out; ${repair}`);
      child.kill('SIGKILL');
    }, 120_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        failure = new Error(`Cache prune child output exceeds 64KiB; ${repair}`);
        child.kill('SIGKILL');
      } else if (stream === child.stdout) output += chunk;
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Cache prune child refused (exit ${code}); ${repair}`));
      else resolve(output);
    });
  });
}

async function writerLeases(receipts, spawnProcess) {
  const handles = [];
  try {
    const owner = await directory(receipts);
    // Setup supports at most 128 slots. Lock even absent slots, so publishing a
    // new slot/reservation after enumeration cannot bypass this exclusion.
    const names = ['worker-active', ...Array.from({length: 128}, (_, i) => `worker-active-${i + 1}`)];
    for (const name of names) {
      const handle = await fs.open(join(receipts, `.${name}.writer`),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      handles.push(handle);
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || ![0, owner.uid].includes(st.uid)) {
        throw new Error(`Unsafe reservation writer guard; ${repair}`);
      }
      // Keep existing guards on the same inode, accessible to the ops writers.
      if (st.uid === 0 && owner.uid !== 0) await handle.chown(owner.uid, owner.gid);
      // flock is already used by forge-setup's services. Its lock belongs to the
      // inherited open file description and remains held by handle after exit.
      await childResult(spawnProcess, '/usr/bin/flock', ['--exclusive', '--nonblock', '3'],
        {stdio: ['ignore', 'pipe', 'pipe', handle.fd]});
    }
    return handles;
  } catch (error) {
    await Promise.all(handles.map(handle => handle.close()));
    throw error;
  }
}

export async function executePrune(plan, {root, apply = false, receipts, spawnProcess = spawn} = {}) {
  const result = {deleted: [], skipped: []};
  if (plan.refused) throw new Error(plan.refused);
  if (!apply) return result;
  if (!receipts) throw new Error(`Apply requires receipts for writer leases and live evidence; ${repair}`);
  const leases = await writerLeases(receipts, spawnProcess);
  let rootHandle;
  try {
    rootHandle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    // Also enforce order for externally supplied plans or changed index data.
    for (const e of [...plan.prune].sort((a, b) => Number(a.name.startsWith('.warm-inputs-'))
      - Number(b.name.startsWith('.warm-inputs-')))) {
      if (!validEntry(root, e)) throw new Error(`Invalid planned path; ${repair}`);
      const parent = join(root, e.lock);
      const parentHandle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        // The child verifies cwd and '..' against both inherited descriptors;
        // this pathname check is only an early refusal, not authorization.
        const expected = await rootHandle.stat(), actual = await fs.stat(join(parent, '..'));
        if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error(`Cache root changed; ${repair}`);
        const live = await readLiveEvidence({receipts});
        if (!live.complete) throw new Error(live.refused);
        if (liveProtects(live, e.lock, e.name)) { result.skipped.push(e); continue; }
        let st;
        try { st = await fs.lstat(e.path); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          result.skipped.push(e); continue;
        }
        // Indexes must be planned, and retain their scan-time metadata.
        if ((e.name.startsWith('.warm-inputs-') && !st.isFile())
          || st.mtimeMs !== e.mtimeMs
          || (e.ino !== undefined && (st.ino !== e.ino || st.dev !== e.dev))
          || (plan.now ?? Date.now()) - st.mtimeMs < Math.max(HOUR, plan.minAgeMs ?? HOUR)) {
          result.skipped.push(e); continue;
        }
        const indexProfile = await readIndexProfile(e.path, e.name, st);
        if (indexProfile) {
          let protectedProfile = liveProtects(live, e.lock, indexProfile);
          try {
            await fs.lstat(join(parent, indexProfile));
            // Any remaining profile (including a skipped deletion) owns its index.
            protectedProfile = true;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (protectedProfile) { result.skipped.push(e); continue; }
        }
        // A warm input can be published/refreshed after planning. Re-read all
        // sibling indexes under the writer leases before removing this profile.
        let youngIndex = false;
        for (const name of await fs.readdir(parent)) {
          if (!name.startsWith('.warm-inputs-')) continue;
          const path = join(parent, name), index = await fs.lstat(path);
          if ((plan.now ?? Date.now()) - index.mtimeMs < Math.max(HOUR, plan.minAgeMs ?? HOUR)
            && await readIndexProfile(path, name, index) === e.name) {
            youngIndex = true; break;
          }
        }
        if (youngIndex) { result.skipped.push(e); continue; }
        const outcome = await childResult(spawnProcess, process.execPath,
          ['--input-type=module', '-e', DELETE_TREE, JSON.stringify({...e,
            now: plan.now ?? Date.now(), minAgeMs: Math.max(HOUR, plan.minAgeMs ?? HOUR)})],
          {cwd: parent, stdio: ['ignore', 'pipe', 'pipe', parentHandle.fd, rootHandle.fd]});
        if (!['deleted', 'skipped'].includes(outcome)) throw new Error(`Unknown delete result; ${repair}`);
        result[outcome].push(e);
      } finally { await parentHandle.close(); }
    }
    return result;
  } finally {
    await Promise.all([rootHandle?.close(), ...leases.map(handle => handle.close())]);
  }
}

async function acquireLock(root) {
  await directory(root);
  const path = join(root, '.forge-cache-prune.pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const st = await fs.lstat(path);
      if (!st.isFile()) throw new Error('Unsafe prune pid lock; inspect lock manually');
      const raw = await fs.readFile(path, 'utf8');
      if (!/^[1-9][0-9]*\n?(?![\s\S])/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error('Unreadable prune pid; inspect lock manually');
      }
      try { process.kill(Number(raw), 0); throw new Error('Cache pruner is already running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      const current = await fs.lstat(path);
      if (current.ino !== st.ino || current.dev !== st.dev) throw new Error('Prune lock changed; retry later');
      await fs.unlink(path);
      continue;
    }
    try { await handle.writeFile(`${process.pid}\n`); }
    catch (error) { await handle.close(); await fs.unlink(path); throw error; }
    const owned = await handle.stat();
    return async () => {
      try {
        const st = await fs.lstat(path);
        if (st.ino === owned.ino && st.dev === owned.dev) await fs.unlink(path);
      } finally { await handle.close(); }
    };
  }
  throw new Error('Cannot acquire prune lock');
}

export async function main(argv = process.argv.slice(2)) {
  let root = '/srv/forge-cache', receipts = '/srv/forge-receipts', apply = false;
  const json = argv.includes('--json');
  let release;
  try {
    for (const arg of argv) {
      if (arg.startsWith('--root=')) root = resolve(arg.slice(7));
      else if (arg.startsWith('--receipts=')) receipts = resolve(arg.slice(11));
      else if (arg === '--apply') apply = true;
      else if (arg !== '--json') throw new Error(`Unknown argument: ${arg}`);
    }
    const settings = resolveSettings();
    // Always emit effective bounds and provenance, even if the subsequent scan refuses.
    process[json ? 'stderr' : 'stdout'].write(`${JSON.stringify({settings, root, receipts, apply})}\n`);
    release = await acquireLock(root);
    const {stdout} = await promisify(execFile)('df', ['-Pk', '/'],
      {encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 10_000, env: {...process.env, LC_ALL: 'C'}});
    const lines = stdout.trim().split('\n');
    const fields = lines.at(-1).trim().split(/\s+/);
    if (lines.length < 2 || fields.length !== 6 || fields[5] !== '/'
      || !/^\d+%$/.test(fields[4]) || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2])) {
      throw new Error(`Invalid df evidence; ${repair}`);
    }
    const disk = {totalBytes: Number(fields[1]) * 1024, usedBytes: Number(fields[2]) * 1024,
      usedPct: Number(fields[4].slice(0, -1))};
    const live = await readLiveEvidence({receipts});
    const entries = await scanCache(root);
    const plan = planPrune({root, entries, settings, disk, live});
    if (plan.refused) throw new Error(live.refused ?? plan.refused);
    const execution = await executePrune(plan, {root, receipts, apply});
    process.stdout.write(`${JSON.stringify({settings, root, receipts, apply, disk, ...plan, execution}, null, json ? 0 : 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({refused: error.message})}\n`);
    return 1;
  } finally { if (release) await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
