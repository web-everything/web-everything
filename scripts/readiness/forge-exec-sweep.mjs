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
const TOMB = /\.tomb-[a-f0-9]+(?![\s\S])/;
const originalName = name => name.replace(TOMB, '');

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

async function hasLiveRecord(receipts, run, cleared = new Set()) {
  for (const phase of ['prepared', 'running', 'receipt']) {
    const name = `${run}.${phase}`;
    if (cleared.has(name)) continue;
    try { await fs.lstat(join(receipts, name)); return true; }
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
def same(a, b):
    if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
        raise RuntimeError('directory replaced; preserve state and inspect before retrying')
def descend(fd, parts):
    for part in parts:
        if not part or part in ('.', '..'): raise RuntimeError('unsafe component')
        st = os.stat(part, dir_fd=fd, follow_symlinks=False)
        child = os.open(part, FLAGS, dir_fd=fd)
        try: same(st, os.fstat(child))
        except BaseException:
            os.close(child)
            raise
        os.close(fd)
        fd = child
    return fd
removed = 0
def empty(fd, depth=0):
    global removed
    with os.scandir(fd) as children:
        for entry in children:
            removed += 1
            if removed > 2000000 or depth > 64:
                raise RuntimeError('removal bound exceeded; retry tombstone or inspect manually')
            st = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                child = os.open(entry.name, FLAGS, dir_fd=fd)
                try:
                    same(st, os.fstat(child))
                    empty(child, depth + 1)
                finally: os.close(child)
                same(st, os.stat(entry.name, dir_fd=fd, follow_symlinks=False))
                os.rmdir(entry.name, dir_fd=fd)
            else: os.unlink(entry.name, dir_fd=fd)
`;

async function pythonJSON(code, args, maxOutput = 65536) {
  return new Promise((accept, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', code, ...args],
      {stdio: ['ignore', 'pipe', 'ignore']});
    let output = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > maxOutput) { overflow = true; child.kill('SIGKILL'); }
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
            if entries > 2000000:
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
fd = descend(pinned(sys.argv[1]), sys.argv[2].split('/'))
st = os.fstat(fd)
result.update(dev=str(st.st_dev), ino=str(st.st_ino))
try: walk(fd, 0)
finally: os.close(fd)
print(json.dumps(result))
`, [resolve(root), relative(root, path)]);
}

// Every lookup, rename and recursive delete stays relative to a pinned parent.
// A crash leaves a recognised tombstone for the next age/lease-checked sweep.
async function removeTree(path, root, tree) {
  return pythonJSON(PINNED_DIRECTORY + `
parts = sys.argv[2].split('/')
name = parts.pop()
parent = descend(pinned(sys.argv[1]), parts)
try:
    original = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if str(original.st_dev) != sys.argv[3] or str(original.st_ino) != sys.argv[4]:
        raise RuntimeError('tree replaced since inspection')
    if '.tomb-' not in name:
        tomb = name + '.tomb-' + os.urandom(16).hex()
        os.rename(name, tomb, src_dir_fd=parent, dst_dir_fd=parent)
        name = tomb
    fd = os.open(name, FLAGS, dir_fd=parent)
    try:
        same(original, os.fstat(fd))
        empty(fd)
    finally: os.close(fd)
    same(original, os.stat(name, dir_fd=parent, follow_symlinks=False))
    os.rmdir(name, dir_fd=parent)
finally: os.close(parent)
print('{}')
`, [resolve(root), relative(root, path), tree.dev, tree.ino]);
}

// Called only under the matching exclusive writer lease. Historical writers
// lacking writerGuard proof stay for operator repair, as do unknown/live UIDs.
async function reclaimReservation(receipts, worker, now, apply) {
  return pythonJSON(PINNED_DIRECTORY + `
import pwd
parent = pinned(sys.argv[1])
name, now, apply = sys.argv[2], float(sys.argv[3]), sys.argv[4] == 'true'
result = dict(reason=None, eligible=False)
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

// Seven days is a grace period, never owner-death evidence. Only a numbered
// worker with no UID processes and no matching live owner may lose old records.
async function reapRecords(receipts, worker, reserved, now, apply, maxFiles) {
  return pythonJSON(PINNED_DIRECTORY + `
import pwd, re
parent = pinned(sys.argv[1])
worker, reserved, now, apply = sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5] == 'true'
limit = int(sys.argv[6])
slot = 'forge-exec' + worker[len('worker-active'):]
groups = {}
def read(name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd) as stream:
        st = os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 4 * 1024 * 1024:
            raise RuntimeError('unsafe record; inspect before retrying')
        return st, json.loads(stream.read(4 * 1024 * 1024 + 1))
try:
    for name in os.listdir(parent):
        match = re.fullmatch(r'(r-[a-f0-9]{32})[.](prepared|running|receipt)', name)
        if match and match[1] != reserved: groups.setdefault(match[1], []).append(name)
    candidates = []
    for run, names in sorted(groups.items()):
        records = [(*read(name), name) for name in names]
        if any(not isinstance(r, dict) or r.get('run') != run or r.get('slot') != slot
               or not isinstance(r.get('nonce'), str) or not re.fullmatch('[a-f0-9]{32}', r['nonce'])
               or now - st.st_mtime * 1000 <= 7 * 24 * 3600000 for st, r, name in records): continue
        if len({r['nonce'] for st, r, name in records}) != 1: continue
        gone = True
        for st, r, name in records:
            owner = r.get('owner')
            if owner is None: continue
            if not isinstance(owner, dict) or type(owner.get('pid')) is not int or owner['pid'] <= 0 or not isinstance(owner.get('start'), str):
                gone = False
                break
            try:
                with open('/proc/' + str(owner['pid']) + '/stat') as process:
                    start = process.read(65536).rsplit(')', 1)[1].split()[19]
                if start == owner['start']: gone = False
            except FileNotFoundError: pass
        if gone and len(candidates) + len(records) <= limit: candidates.extend(records)
    reason = None
    if candidates:
        uid = pwd.getpwnam(slot).pw_uid
        if uid == 0 or uid == os.fstat(parent).st_uid: raise RuntimeError('unsafe worker UID')
        with os.scandir('/proc') as processes:
            for count, process in enumerate(processes):
                if count >= 20000: raise RuntimeError('process scan bound exceeded; inspect manually')
                if not process.name.isdigit(): continue
                try:
                    if os.stat(process.path).st_uid == uid:
                        reason = 'worker UID still has processes; preserving execution records'
                        break
                except FileNotFoundError: pass
    files = []
    if reason is None:
        for st, record, name in candidates:
            same(st, os.stat(name, dir_fd=parent, follow_symlinks=False))
            if apply: os.unlink(name, dir_fd=parent)
            files.append(dict(name=name, bytes=st.st_size))
finally: os.close(parent)
print(json.dumps(dict(files=files, reason=reason)))
`, [resolve(receipts), worker, reserved ?? '', String(now), String(apply), String(maxFiles)], 1024 * 1024);
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
  const clearedRecords = new Set(); // dry-run must plan the same subsequent work
  const skip = (consumer, reason, slot) => summary.skips.push({consumer, ...(slot ? {slot} : {}), reason});
  const refuse = (consumer, error) => summary.refusals.push({consumer, error: String(error.message ?? error)});
  async function remove(path, category, byteCategory, size, base, tree = null) {
    if (apply) {
      if (tree) {
        await removeTree(path, base, tree);
      } else await fs.unlink(path);
    }
    summary.counts[category]++;
    summary.bytes[byteCategory] += size;
    summary.candidates[category].push(relative(base, path));
  }
  async function slots() {
    const names = await directory(root);
    const workers = (await directory(receipts)).filter(name => WORKER.test(name));
    // Include record-only workers after their last run directory was removed.
    for (const name of await directory(receipts)) {
      if (!/^r-[a-f0-9]{32}\.(prepared|running|receipt)$/.test(name)) continue;
      let record;
      let handle;
      try {
        handle = await fs.open(join(receipts, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = await handle.stat();
        if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
        const buffer = Buffer.alloc(st.size + 1);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > st.size) continue;
        record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      }
      catch { continue; } // unreadable evidence still protects its run
      finally { if (handle) await handle.close(); }
      const match = /^forge-exec-([1-9][0-9]*)$/.exec(record?.slot);
      if (match && !workers.includes(`worker-active-${match[1]}`)) workers.push(`worker-active-${match[1]}`);
    }
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
        if (/^worker-active-[1-9][0-9]*$/.test(worker)) {
          const reaped = await reapRecords(receipts, worker, reserved, now, apply, effective.receipts.maxFiles - summary.counts.receiptFiles);
          if (reaped.reason) skip('slots', reaped.reason, slot);
          for (const file of reaped.files) {
            if (!apply) clearedRecords.add(file.name);
            summary.counts.receiptFiles++;
            summary.bytes.receipts += file.bytes;
            summary.candidates.receiptFiles.push(file.name);
          }
        }
        for (const name of parent ? await directory(parent) : []) {
          const run = originalName(name);
          if (!RUN_DIR.test(run) || run === reserved) continue;
          const path = join(parent, name);
          const st = await fs.lstat(path);
          if (!st.isDirectory() || await hasLiveRecord(receipts, run, clearedRecords)) continue;
          const tree = await inspectTree(path, root);
          if (!tree.complete) { skip('slots', `scan bound exceeded; preserving ${name}; inspect manually`, slot); continue; }
          if (now - tree.newest > effective.slots.leakAgeHours * HOUR) {
            await remove(path, 'runDirs', 'runDirs', tree.bytes, root, tree);
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
    if (names.some(name => RUN_DIR.test(originalName(name))) || workers.includes('worker-active')) await clean(root, 'worker-active');
  }
  async function presync() {
    const parent = join(root, 'presync');
    const keys = [];
    for (const name of await directory(parent)) {
      const path = join(parent, name);
      if (!KEY.test(originalName(name)) || !(await fs.lstat(path)).isDirectory()) continue;
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
        await remove(key.path, 'presyncKeys', 'presync', key.bytes, parent, key);
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
      if (!match || reserved.has(match[1]) || await hasLiveRecord(receipts, match[1], clearedRecords)) continue;
      const path = join(receipts, name), st = await fs.lstat(path);
      if (st.isFile() && now - st.mtimeMs > effective.receipts[`${match[2]}AgeHours`] * HOUR) {
        candidates.push({path, mtime: st.mtimeMs, bytes: st.size});
      }
    }
    candidates.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    for (const entry of candidates.slice(0, effective.receipts.maxFiles - summary.counts.receiptFiles)) {
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
