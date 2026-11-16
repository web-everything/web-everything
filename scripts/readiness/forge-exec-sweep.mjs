#!/usr/bin/env node
// Standalone: the setup bundler installs this file without repository dependencies.
import fs from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const DEFAULT_BUDGET = {
  slots: {leakAgeHours: 3},
  presync: {maxAgeHours: 72, minAgeHours: 24, capBytes: null},
  receipts: {maxFiles: 5000, telemetryAgeHours: 48, consumedAgeHours: 24},
};
const HOUR = 3_600_000;
const RUN = /^r-[a-f0-9]{32}(?![\s\S])/;
const RUN_DIR = /^(?:r-|warm-)[a-f0-9]{32}(?![\s\S])/;
const SLOT = /^slot-[1-9][0-9]*(?![\s\S])/;
const WORKER = /^worker-active(?:-[1-9][0-9]*)?(?![\s\S])/;
const KEY = /^[a-f0-9]{32}(?![\s\S])/;

function makeLock(receipts) {
  return async name => {
    const c = fs.constants;
    const owner = await fs.lstat(receipts);
    if (!owner.isDirectory()) throw new Error('unsafe receipts directory; inspect before retrying');
    const guard = await fs.open(join(receipts, `.${name}.writer`),
      c.O_RDWR | c.O_CREAT | c.O_NOFOLLOW | c.O_NONBLOCK, 0o600);
    try {
      const st = await guard.stat();
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || ![0, owner.uid].includes(st.uid)) {
        throw new Error('unsafe writer guard; inspect ownership, links and permissions');
      }
      // Root sweeps can create guards before the controller does. Hand the
      // validated inode to the receipts owner without replacing the flock file.
      if (st.uid === 0 && owner.uid !== 0) await guard.chown(owner.uid, owner.gid);
      const code = await new Promise((accept, reject) => {
        const child = spawn('/usr/bin/python3', ['-I', '-c',
          'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],
        {stdio: ['ignore', 'ignore', 'ignore', guard.fd]});
        child.once('error', reject);
        child.once('exit', (status, signal) => signal
          ? reject(new Error(`lock helper terminated by ${signal}`)) : accept(status));
      });
      if (code !== 0) { await guard.close(); return null; }
      return {release: () => guard.close()};
    } catch (error) { await guard.close(); throw error; }
  };
}

async function directory(path) {
  try {
    if (!(await fs.lstat(path)).isDirectory()) throw new Error(`not a real directory: ${path}`);
    return (await fs.readdir(path)).sort();
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function reservation(receipts, worker) {
  try {
    const path = join(receipts, worker, 'reservation.json');
    const st = await fs.lstat(path);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) throw new Error('unsafe or oversized reservation');
    const value = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!value || typeof value.run !== 'string') throw new Error('reservation run is not a string');
    return value.run;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function hasLiveRecord(receipts, run) {
  for (const phase of ['prepared', 'running', 'receipt']) {
    try { await fs.lstat(join(receipts, `${run}.${phase}`)); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

// Node has no openat API. Below each trusted root, Python's dir_fd operations
// pin every component, including when a checked child is replaced by a symlink.
const PINNED_DIRECTORY = `
import os, stat, json, sys
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
def pinned(path):
    return os.open(path, FLAGS)
`;

async function pythonJSON(code, args) {
  return new Promise((accept, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', code, ...args],
      {stdio: ['ignore', 'pipe', 'ignore']});
    let output = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 65536) { overflow = true; child.kill('SIGKILL'); }
      else output += chunk.toString();
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (status !== 0 || signal || overflow) {
        reject(new Error('bounded filesystem probe failed; preserve state and inspect before retrying'));
      } else {
        try { accept(JSON.parse(output)); } catch (error) { reject(error); }
      }
    });
  });
}

async function inspectTree(path, root) {
  return pythonJSON(PINNED_DIRECTORY + `
result = dict(newest=0, bytes=0, complete=True)
entries = 0
def walk(fd, depth):
    global entries
    result['newest'] = max(result['newest'], os.fstat(fd).st_mtime * 1000)
    with os.scandir(fd) as children:
        for entry in children:
            entries += 1
            if entries > 20000:
                result['complete'] = False
                return
            st = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            result['newest'] = max(result['newest'], st.st_mtime * 1000)
            if stat.S_ISREG(st.st_mode): result['bytes'] += st.st_size
            if stat.S_ISDIR(st.st_mode):
                if depth >= 64:
                    result['complete'] = False
                    return
                child = os.open(entry.name, FLAGS, dir_fd=fd)
                try:
                    current = os.fstat(child)
                    if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
                        raise RuntimeError('directory replaced during scan')
                    walk(child, depth + 1)
                finally: os.close(child)
                if not result['complete']: return
fd = pinned(sys.argv[1])
try:
    for part in sys.argv[2].split('/'):
        child = os.open(part, FLAGS, dir_fd=fd)
        os.close(fd)
        fd = child
except BaseException:
    os.close(fd)
    raise
try: walk(fd, 0)
finally: os.close(fd)
print(json.dumps(result))
`, [resolve(root), relative(root, path)]);
}

// Called only under the matching exclusive writer lease. Historical writers
// lacking writerGuard proof stay for operator repair, as do unknown/live UIDs.
async function reclaimReservation(receipts, worker, now, apply) {
  return pythonJSON(PINNED_DIRECTORY + `
import pwd
parent = pinned(sys.argv[1])
name, now, apply = sys.argv[2], float(sys.argv[3]), sys.argv[4] == 'true'
result = dict(reason=None, eligible=False)
removed = 0
def empty(fd, depth=0):
    global removed
    with os.scandir(fd) as children:
        for entry in children:
            removed += 1
            if removed > 20000 or depth > 64: raise RuntimeError('reservation removal bound exceeded')
            st = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                child = os.open(entry.name, FLAGS, dir_fd=fd)
                try:
                    current = os.fstat(child)
                    if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
                        raise RuntimeError('reservation child replaced')
                    empty(child, depth + 1)
                finally: os.close(child)
                current = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
                    raise RuntimeError('reservation child replaced')
                os.rmdir(entry.name, dir_fd=fd)
            else: os.unlink(entry.name, dir_fd=fd)
def reclaim():
    fd = os.open(name, FLAGS, dir_fd=parent)
    try:
        original = os.fstat(fd)
        if now - original.st_mtime * 1000 <= 7 * 24 * 3600000: return None
        record = os.open('reservation.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(record) as stream:
            st = os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > 4 * 1024 * 1024:
                return 'unsafe reservation; inspect before retrying'
            value = json.loads(stream.read(4 * 1024 * 1024 + 1))
        if not isinstance(value, dict) or value.get('writerGuard') != 1:
            return 'historical reservation lacks writerGuard; inspect after stopping its UID'
        uid = pwd.getpwnam('forge-exec' + name[len('worker-active'):]).pw_uid
        if uid == 0 or uid == os.fstat(parent).st_uid:
            return 'unsafe worker UID; inspect before retrying'
        with os.scandir('/proc') as processes:
            for count, process in enumerate(processes):
                if count >= 20000: return 'process scan bound exceeded; inspect worker UID manually'
                if not process.name.isdigit(): continue
                try:
                    if os.stat(process.path).st_uid == uid: return 'worker UID still has processes'
                except FileNotFoundError: continue
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
            return 'reservation replaced; inspect before retrying'
        if apply:
            empty(fd)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                return 'reservation replaced; inspect before retrying'
            os.rmdir(name, dir_fd=parent)
        result['eligible'] = True
        return None
    finally: os.close(fd)
try:
    try: reason = reclaim()
    except Exception: reason = 'incomplete reservation or UID evidence; preserve and inspect before retrying'
    result['reason'] = reason
    print(json.dumps(result))
finally: os.close(parent)
`, [resolve(receipts), worker, String(now), String(apply)]);
}

function settings(budget, budgetSource) {
  const result = {};
  for (const [section, defaults] of Object.entries(DEFAULT_BUDGET)) {
    result[section] = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const supplied = budget?.[section]?.[key];
      const valid = (key === 'capBytes' && supplied === null)
        || (typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0
          && (key !== 'maxFiles' || Number.isSafeInteger(supplied)));
      result[section][key] = valid ? supplied : fallback;
      budgetSource[`${section}.${key}`] = valid ? 'budget' : supplied === undefined
        ? 'default' : 'default (invalid budget value)';
    }
  }
  if (result.presync.maxAgeHours < result.presync.minAgeHours) {
    for (const key of ['maxAgeHours', 'minAgeHours']) {
      result.presync[key] = DEFAULT_BUDGET.presync[key];
      budgetSource[`presync.${key}`] = 'default (invalid age range)';
    }
  }
  return result;
}

export async function sweep({root = '/srv/forge-exec', receipts = '/srv/forge-receipts',
  apply = false, now = Date.now(), budget = {}, lock} = {}) {
  const summary = {apply, budgetSource: {}, counts: {runDirs: 0, presyncKeys: 0, receiptFiles: 0},
    bytes: {runDirs: 0, presync: 0, receipts: 0},
    candidates: {runDirs: [], presyncKeys: [], receiptFiles: []}, skips: [], refusals: []};
  const effective = settings(budget, summary.budgetSource);
  const acquire = lock ?? makeLock(receipts);
  const recoveredWorkers = new Set();
  const skip = (consumer, reason, slot) => summary.skips.push({consumer, ...(slot ? {slot} : {}), reason});
  const refuse = (consumer, error) => summary.refusals.push({consumer, error: String(error.message ?? error)});
  async function remove(path, category, byteCategory, size, base, tree = true) {
    if (apply) {
      if (tree) {
        const tomb = `${path}.tomb-${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        await fs.rename(path, tomb);
        await fs.rm(tomb, {recursive: true});
      } else await fs.unlink(path);
    }
    summary.counts[category]++;
    summary.bytes[byteCategory] += size;
    summary.candidates[category].push(relative(base, path));
  }
  async function slots() {
    const names = await directory(root);
    const workers = (await directory(receipts)).filter(name => WORKER.test(name));
    async function clean(parent, worker, slot) {
      const held = await acquire(worker);
      if (!held) { skip('slots', 'lock busy', slot); return; }
      try {
        try {
          const st = await fs.lstat(join(receipts, worker));
          if (!st.isDirectory()) throw new Error('unsafe reservation directory');
          if (now - st.mtimeMs > 7 * 24 * HOUR) {
            const recovery = await reclaimReservation(receipts, worker, now, apply);
            if (recovery.reason) skip('slots', recovery.reason, slot);
            if (recovery.eligible) {
              recoveredWorkers.add(worker);
              skip('slots', `${apply ? 'reclaimed' : 'would reclaim'} abandoned ${worker}; worker UID has no processes`, slot);
            }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let reserved;
        try {
          reserved = recoveredWorkers.has(worker) ? null : await reservation(receipts, worker);
          if (!recoveredWorkers.has(worker) && await fs.lstat(join(receipts, worker)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
            if (reserved === null) throw new Error('reservation.json missing');
            if (!RUN_DIR.test(reserved)) throw new Error('reservation run is not a recognised run id');
            const guard = JSON.parse(await fs.readFile(join(receipts, worker, 'reservation.json'), 'utf8')).writerGuard;
            if (guard !== 1) throw new Error('reservation lacks writerGuard evidence');
          }
        } catch (error) { skip('slots', `unreadable reservation; inspect before retrying: ${error.message}`, slot); return; }
        for (const name of parent ? await directory(parent) : []) {
          if (!RUN_DIR.test(name) || name === reserved) continue;
          const path = join(parent, name);
          const st = await fs.lstat(path);
          if (!st.isDirectory() || await hasLiveRecord(receipts, name)) continue;
          const tree = await inspectTree(path, root);
          if (!tree.complete) { skip('slots', `scan bound exceeded; preserving ${name}; inspect manually`, slot); continue; }
          if (now - tree.newest > effective.slots.leakAgeHours * HOUR) {
            await remove(path, 'runDirs', 'runDirs', tree.bytes, root);
          }
        }
      } finally { await held.release(); }
    }
    for (const name of names) {
      if (!SLOT.test(name) || !(await fs.lstat(join(root, name))).isDirectory()) continue;
      try { await clean(join(root, name), `worker-active-${name.slice(5)}`, name); }
      catch (error) { refuse('slots', error); }
    }
    for (const worker of workers) {
      if (worker === 'worker-active' || names.includes(`slot-${worker.slice(14)}`)) continue;
      try { await clean(null, worker, `slot-${worker.slice(14)}`); }
      catch (error) { refuse('slots', error); }
    }
    if (names.some(name => RUN_DIR.test(name)) || workers.includes('worker-active')) await clean(root, 'worker-active');
  }
  async function presync() {
    const parent = join(root, 'presync');
    const keys = [];
    for (const name of await directory(parent)) {
      const path = join(parent, name);
      if (!KEY.test(name) || !(await fs.lstat(path)).isDirectory()) continue;
      const tree = await inspectTree(path, root);
      if (!tree.complete) skip('presync', `scan bound exceeded; preserving ${name}; inspect manually`);
      keys.push({path, ...tree});
    }
    let total = keys.reduce((sum, key) => sum + key.bytes, 0);
    const b = effective.presync;
    for (const key of keys.sort((a, b) => a.newest - b.newest || a.path.localeCompare(b.path))) {
      const idle = (now - key.newest) / HOUR;
      if (!key.complete || idle < b.minAgeHours) continue;
      if (idle > b.maxAgeHours || (b.capBytes !== null && total > b.capBytes)) {
        await remove(key.path, 'presyncKeys', 'presync', key.bytes, parent);
        total -= key.bytes;
      }
    }
  }
  async function receiptFiles() {
    const names = await directory(receipts), reserved = new Set(), candidates = [];
    let incomplete = false;
    const leases = [];
    try {
    const slotWorkers = (await directory(root)).filter(n => /^slot-[1-9][0-9]*$/.test(n)).map(n => `worker-active-${n.slice(5)}`);
    for (const name of [...new Set([...names.filter(name => WORKER.test(name)), ...slotWorkers])].filter(name => !recoveredWorkers.has(name))) {
      const lease = await acquire(name);
      if (lease) leases.push(lease); // busy: its reservation is read below and its run protected
      if (!names.includes(name)) {
        if (!lease) { incomplete = true; skip('receipts', `${name} is busy and has not published a reservation; preserving expired receipts`); }
        continue;
      }
      try {
        const run = await reservation(receipts, name);
        if (run === null || !RUN_DIR.test(run)) throw new Error('missing or unidentified reservation run');
        reserved.add(run);
      } catch (error) {
        incomplete = true;
        skip('receipts', `unreadable ${name} reservation: ${error.message}; preserving expired receipts; inspect and repair before retrying`);
      }
    }
    if (incomplete) return;
    for (const name of names) {
      const match = /^(r-[a-f0-9]{32})\.(telemetry|consumed)(?![\s\S])/.exec(name);
      if (!match || reserved.has(match[1]) || await hasLiveRecord(receipts, match[1])) continue;
      const path = join(receipts, name), st = await fs.lstat(path);
      if (st.isFile() && now - st.mtimeMs > effective.receipts[`${match[2]}AgeHours`] * HOUR) {
        candidates.push({path, mtime: st.mtimeMs, bytes: st.size});
      }
    }
    candidates.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    for (const entry of candidates.slice(0, effective.receipts.maxFiles)) {
      await remove(entry.path, 'receiptFiles', 'receipts', entry.bytes, receipts, false);
    }
    } finally { for (const lease of leases) await lease.release(); }
  }
  for (const [consumer, action] of [['slots', slots], ['presync', presync], ['receipts', receiptFiles]]) {
    try {
      if (!Number.isFinite(now)) throw new Error('invalid sweep time; supply a finite timestamp');
      await action();
    } catch (error) { refuse(consumer, error); }
  }
  return summary;
}

if (process.argv[1] && (process.argv[1] === '-' || import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  const options = {};
  try {
    for (const arg of process.argv.slice(2)) {
      if (arg === '--apply') options.apply = true;
      else if (arg === '--dry-run') options.apply = false;
      else if (arg.startsWith('--root=') && arg.length > 7) options.root = arg.slice(7);
      else if (arg.startsWith('--receipts=') && arg.length > 11) options.receipts = arg.slice(11);
      else throw new Error(`bad argument: ${arg}`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  if (!process.exitCode) {
    const result = await sweep(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.refusals.length) process.exitCode = 1; // systemd must see a refused consumer
  }
}
