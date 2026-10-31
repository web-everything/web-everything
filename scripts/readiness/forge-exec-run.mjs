#!/usr/bin/env node
// Installed root:root 0755. No executable source or configuration comes from the task.
import {spawn} from 'node:child_process';
import {readLimits, slotCpus, scopeLauncherArgv} from './forge-exec-limits.mjs';
import {constants, realpathSync} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import {open, mkdir, readdir, writeFile, rename, rm, rmdir, lstat} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus, loadavg, freemem, totalmem} from 'node:os';
import {baseGuard, readyBases, readBase, copyLeaves, baseFile, createBasePin, materializeWorktree} from './forge-exec-bases.mjs';
import {decodeManifest} from './forge-exec-manifest.mjs';
const LIMIT = 4 * 1024 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runName = value => typeof value === 'string' && /^r-[a-f0-9]{32}$/.test(value);
const nonceOK = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
export const digestArgv = argv => sha(JSON.stringify(argv));
import {SIBLING_PATHS} from './forge-exec-siblings.mjs';
export {SIBLING_PATHS};
const siblingPrefixes = Object.values(SIBLING_PATHS).map(path => Buffer.from(path.slice('../frontierui/'.length)+'/'));
export const siblingShas = manifest => manifest.siblings ? {frontierui:manifest.siblings.frontierui.sha} : undefined;
export const sameSiblingShas = (actual, expected) => expected !== undefined && actual !== undefined
  && Object.keys(actual).join(',') === 'frontierui' && Object.keys(expected).join(',') === 'frontierui'
  && typeof expected.frontierui === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expected.frontierui) && actual.frontierui === expected.frontierui;

// Shared by the client and fixed wrapper through allowedCommand. Match spellings exactly.
export const VITEST_ALLOWED_OPTIONS = Object.freeze([
  '--run', '--silent', '--no-color',
  '--reporter=default', '--reporter=dot', '--reporter=verbose', '--reporter=basic', '--reporter=tap',
  '-t', '--testNamePattern=',
]);
export function allowedCommand(argv) {
  if (!(Array.isArray(argv) && argv.length >= 3 && argv.every(a => typeof a === 'string' && !a.includes('\0')))) return false;
  if(argv[0]==='npm' && argv[1]==='run' && argv[2]==='check:standards')
    return argv.length===3 || (argv[3]==='--' && argv.slice(4).every(arg=>arg==='--local'||/^--files=[^\x00-\x1f]+$/.test(arg)));
  const npm = argv[0] === 'npm' && argv[1] === 'run'
    && ['test:unit','test:integration:vitest','test:coverage'].includes(argv[2])
    && (argv.length === 3 || argv[3] === '--');
  const npx = argv[0] === 'npx' && argv[1] === 'vitest' && ['run','related'].includes(argv[2]);
  if (!npm && !npx) return false;
  const files=[];
  for (let i = npm ? 4 : 3; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      try {
        // Backslashes can be separators on the client even though Forge is Unix.
        if (/\\|^[A-Za-z]:/.test(arg)) return false;
        pathParts(Buffer.from(arg));
        files.push(Buffer.from(arg));
      } catch { return false; }
      continue;
    }
    const option = arg.startsWith('--testNamePattern=') ? '--testNamePattern=' : arg;
    if (!VITEST_ALLOWED_OPTIONS.includes(option)) return false;
    // Vitest consumes a following boolean-looking token as the flag's value,
    // even when that token could also be a valid positional file filter.
    if (['--run','--silent','--no-color'].includes(arg) && /^(?:true|false)/i.test(argv[i+1] ?? '')) return false;
    // Vitest reparses dash-prefixed -t values as options (including --help).
    if (arg === '-t' && (++i >= argv.length || argv[i].startsWith('-'))) return false;
  }
  try { validateTestNames(files); } catch { return false; }
  if (npx && (!files.length || (argv[2] === 'related' && !argv.includes('--run')))) return false;
  return true;
}
// Each class fixes the executable and mode; never execute npx or interpolate a shell command.
// The original test:unit class retains its installed npm-script contract.
export function executionArgv(argv) {
  if (!allowedCommand(argv)) throw new Error('Invalid execution parameters');
  if(argv[2]==='check:standards')return ['npm','run','check:standards',...argv.slice(3)];
  if (argv[0] === 'npm' && argv[2] === 'test:unit') return ['npm','run','test:unit',...argv.slice(3)];
  const options=argv.slice(argv[0] === 'npm' ? 4 : 3);
  return ['node','node_modules/vitest/vitest.mjs',argv[0] === 'npx' ? argv[2] : 'run',
    ...(argv[2] === 'test:integration:vitest' ? ['--config','vitest.integration.config.ts'] : []),
    ...(argv[2] === 'test:coverage' ? ['--coverage'] : []),...options];
}

export function easternTimestamp(ms) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(new Date(ms).getUTCMilliseconds()).padStart(3,'0')}${parts.timeZoneName.replace('GMT','')}`;
}
const exactKeys = (v,keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
const validET = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-0[45]:00$/.test(value)
  && Number.isFinite(Date.parse(value)) && easternTimestamp(Date.parse(value)) === value;
const duration = n => Number.isSafeInteger(n) && n >= 0;
export function parseTelemetry(text) {
  if ((!Buffer.isBuffer(text) && typeof text !== 'string') || Buffer.byteLength(text)>65536
    || (Buffer.isBuffer(text) && !Buffer.from(text.toString('utf8')).equals(text))) throw new Error('Invalid telemetry size or encoding');
  const v=JSON.parse(text.toString());
  if (!exactKeys(v,'activeRuns,cores,loadPerCore,memFreePct,recent,sampledAtET') || !validET(v.sampledAtET)
    || !Number.isSafeInteger(v.cores) || v.cores<1 || !Number.isFinite(v.loadPerCore) || v.loadPerCore<0
    || !Number.isFinite(v.memFreePct) || v.memFreePct<0 || v.memFreePct>100 || !duration(v.activeRuns)
    || !Array.isArray(v.recent) || v.recent.length>50 || v.recent.some(r=>!(exactKeys(r,'code,runId,stageMs,startedAtET')
      || (exactKeys(r,'code,prewarmed,runId,stageMs,startedAtET') && typeof r.prewarmed==='boolean'))
      || !runName(r.runId) || !validET(r.startedAtET) || !exactKeys(r.stageMs,'install,run')
      || !duration(r.stageMs.install) || !duration(r.stageMs.run) || !(r.code===null || (duration(r.code)&&r.code<=255))))
    throw new Error('Invalid telemetry schema');
  return v;
}
export function formatTelemetry(value,host='forge') {
  const v=parseTelemetry(JSON.stringify(value));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw new Error('Invalid host');
  const last=v.recent.find(r=>r.code!==null);
  return `${host} ${v.sampledAtET.slice(11,16)} ET load/core ${v.loadPerCore.toFixed(2)} ram free ${Math.round(v.memFreePct)}% runs ${v.activeRuns} last-run ${last ? Math.round((last.stageMs.install+last.stageMs.run)/1000)+'s' : 'none'}`;
}
const ENV_KEYS = ['CI','NODE_ENV','TZ','LANG','LC_ALL','FORCE_COLOR','NO_COLOR','DIFF_COVERAGE_BASE','WE_VITEST_MAX_WORKERS'];
export function allowedEnv(env) {
  return env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([key,value]) =>
    ENV_KEYS.includes(key) && !/secret|token|password|credential|auth|key/i.test(key)
    && typeof value === 'string' && !value.includes('\0')
    && (key !== 'WE_VITEST_MAX_WORKERS' || /^[1-9]\d*$/.test(value))
    && (key !== 'DIFF_COVERAGE_BASE' || (/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
      && !/\s/.test(value) && !value.includes('..') && !value.includes('//') && !/(?:^|\/)\.|\.lock(?:\/|$)|[/.]$/.test(value))));
}
async function directory(path, trusted = false, operator = {uid:process.getuid(),gid:process.getgid()}) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const info = await fd.stat();
  await fd.close();
  if (!info.isDirectory() || (trusted && ((info.uid !== operator.uid && info.uid !== 0) || (info.mode & 0o002) || ((info.mode & 0o020) && info.gid !== operator.gid)))) throw new Error('Untrusted directory');
}
async function readPinned(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > LIMIT) throw new Error('Invalid bounded file');
    return await fd.readFile();
  } finally {await fd.close();}
}
// This protocol supports package-lock only. npm gives shrinkwrap precedence,
// so refuse its presence (including links) rather than certify the wrong lock.
export async function digestLock(root) {
  const shrinkwrap = await lstat(join(root,'npm-shrinkwrap.json')).then(()=>true,error=>{
    if(error.code==='ENOENT') return false;
    throw error;
  });
  if(shrinkwrap) throw new Error('npm-shrinkwrap.json is unsupported; use local fallback');
  return sha(await readPinned(join(root,'package-lock.json')));
}
async function archiveDigest(path) {
  const fd=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st=await fd.stat();
    if(!st.isFile() || st.size>2*1024*1024*1024) throw new Error('Cache archive exceeds 2 GiB; use local fallback');
    const hash=createHash('sha256');
    for await(const chunk of fd.createReadStream({autoClose:false})) hash.update(chunk);
    return hash.digest('hex');
  } finally {await fd.close();}
}
import {pathParts, bytePath, isTestFile, validateTestNames, splitPaths, nulPaths, manifestWire, digestManifest} from './forge-exec-manifest.mjs';
export {pathParts, bytePath, isTestFile, validateTestNames, splitPaths, nulPaths, manifestWire, digestManifest};

// No-follow opens pin file identity while reading. Injected IO supports byte-path
// fixtures on filesystems which cannot create arbitrary Unix filenames.
export async function readManifestFile(path, st, fs = filesystem) {
  if (fs !== filesystem) return fs.readFile(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = await fd.stat();
    if (!pinned.isFile() || pinned.ino !== st.ino || pinned.dev !== st.dev || pinned.mode !== st.mode)
      throw new Error('Manifest file swapped');
    return await fd.readFile();
  } finally {await fd.close();}
}

export async function verifyManifest(root, manifest, manifestDigest, {fs = filesystem, sibling = false} = {}) {
  const {git,...content}=manifest??{};
  if(git!==undefined && (sibling || !git || !['head','diffCoverageBase,head'].includes(Object.keys(git).sort().join(','))
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(git.head)
    || Object.hasOwn(git,'diffCoverageBase')&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(git.diffCoverageBase)))throw new Error('Invalid Git evidence');
  const keys = manifest && Object.keys(content).sort().join(',');
  if (!manifest || manifest.v!==2 || !['excluded,executable,hashes,paths,tracked,v', ...(!sibling ? ['excluded,executable,hashes,paths,siblings,tracked,v'] : [])].includes(keys)
    || !hex(manifestDigest) || Buffer.byteLength(JSON.stringify(manifest)) > LIMIT
    || digestManifest(manifest) !== manifestDigest) throw new Error('Manifest digest mismatch or limit exceeded; use local fallback');
  const decode = value => {
    if (typeof value !== 'string') throw new Error('Invalid manifest base64');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Non-canonical manifest base64');
    const paths = splitPaths(bytes);
    for (let i = 1; i < paths.length; i++) if (Buffer.compare(paths[i-1], paths[i]) >= 0) throw new Error('Manifest paths must be strictly increasing');
    return paths;
  };
  const paths = decode(manifest.paths), excluded = decode(manifest.excluded);
  if (!Array.isArray(manifest.hashes) || !Array.isArray(manifest.executable) || !Array.isArray(manifest.tracked)
    || manifest.hashes.length !== paths.length || manifest.executable.length !== paths.length || manifest.tracked.length !== paths.length
    || !manifest.hashes.every(hex) || !manifest.executable.every(v => typeof v === 'boolean')
    || !manifest.tracked.every(v => typeof v === 'boolean')) throw new Error('Invalid manifest hashes, executable bits or tracking evidence');
  validateTestNames(paths);
  if (sibling && [...paths,...excluded].some(path => !siblingPrefixes.some(prefix => path.subarray(0,prefix.length).equals(prefix))))
    throw new Error('Unsupported sibling manifest path');
  const expected = new Map(paths.map((path, i) => [path.toString('hex'), {path, sha256:manifest.hashes[i], executable:manifest.executable[i],tracked:manifest.tracked[i]}]));
  for (const path of excluded) if (expected.has(path.toString('hex')) || isTestFile(path) || /\.(test|spec)\./.test(pathParts(path).at(-1).toString('latin1')))
    throw new Error('Manifest excluded test or overlapping path');
  const parents = new Set();
  for (const path of paths) for (let i = 0; i < path.length; i++) if (path[i] === 47) parents.add(path.subarray(0, i).toString('hex'));
  const rootInfo = await fs.lstat(Buffer.from(root));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Invalid manifest root directory');
  const observed = [], tests = [];
  let budget = 0;
  async function walk(prefix, depth = 0) {
    if (depth > 128) throw new Error('Manifest depth limit exceeded; use local fallback');
    const dir = prefix.length ? bytePath(root, prefix) : Buffer.from(root);
    for (const name of await fs.readdir(dir, {encoding:'buffer'})) {
      if (!Buffer.isBuffer(name) || name.includes(47)) throw new Error('Invalid manifest directory name');
      const path = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name;
      pathParts(path);
      budget += path.length + 1;
      if (budget > LIMIT) throw new Error('Manifest inventory limit exceeded; use local fallback');
      const st = await fs.lstat(bytePath(root, path));
      if (st.isSymbolicLink()) throw new Error('Manifest symlink');
      if (st.isDirectory()) {
        if (!parents.has(path.toString('hex'))) throw new Error('Extra manifest directory');
        await walk(path, depth + 1);
      } else {
        if (!st.isFile()) throw new Error('Manifest non-regular file');
        const entry = expected.get(path.toString('hex'));
        if (!entry || entry.executable !== !!(st.mode & 0o111)
          || entry.sha256 !== sha(await readManifestFile(bytePath(root, path), st, fs))) throw new Error('Input digest mismatch: manifest snapshot digest or mode mismatch');
        observed.push(path);
        if (isTestFile(path)) tests.push(path);
      }
    }
  }
  await walk(Buffer.alloc(0));
  observed.sort(Buffer.compare); tests.sort(Buffer.compare);
  const same = (a,b) => a.length === b.length && a.every((p,i) => p.equals(b[i]));
  if (!same(paths, observed) || !same(paths.filter(isTestFile), tests)) throw new Error('Manifest inventory or test set mismatch');
  if (Object.hasOwn(manifest,'siblings')) {
    if (!manifest.siblings || typeof manifest.siblings !== 'object' || Object.keys(manifest.siblings).join(',') !== 'frontierui') throw new Error('Unsupported sibling manifest');
    const section = manifest.siblings.frontierui;
    if (!section || Object.keys(section).sort().join(',') !== 'excluded,executable,hashes,paths,sha,tracked,v'
      || !sameSiblingShas({frontierui:section.sha},{frontierui:section.sha})) throw new Error('Invalid sibling SHA or manifest');
    const {sha:revision,...snapshot} = section;
    await verifyManifest(join(root,'../frontierui'),snapshot,digestManifest(snapshot),{fs,sibling:true});
  }
  return {entries:paths.map(path => expected.get(path.toString('hex'))), testPaths:tests};
}

// Length-prefixed records retain the existing digest protocol, with raw names.
export async function digestInput(root, files) {
  const selected = files && new Set(files.flatMap(file => {
    const path = Buffer.isBuffer(file) ? file : Buffer.from(file);
    pathParts(path);
    return [path.toString('hex'), ...Array.from(path.keys()).filter(i => path[i] === 47).map(i => path.subarray(0,i).toString('hex'))];
  }));
  await directory(root);
  const seen = new Set(), hash = createHash('sha256');
  const field = data => {const b = Buffer.from(data); hash.update(String(b.length)+':'); hash.update(b);};
  let budget = 0;
  async function walk(prefix, depth = 0) {
    if (depth > 128) throw new Error('Input depth limit exceeded; use local fallback');
    const dir = prefix.length ? bytePath(root,prefix) : Buffer.from(root);
    for (const name of (await readdir(dir,{encoding:'buffer'})).sort(Buffer.compare)) {
      const path = prefix.length ? Buffer.concat([prefix,Buffer.from('/'),name]) : name;
      const key = path.toString('hex');
      if (selected && !selected.has(key)) continue;
      pathParts(path);
      budget += path.length + 1;
      if (budget > LIMIT) throw new Error('Input inventory limit exceeded; use local fallback');
      const absolute = bytePath(root,path), st = await lstat(absolute);
      seen.add(key); field(path);
      if (st.isSymbolicLink()) throw new Error('Input symlink');
      if (st.isDirectory()) {field('dir'); await walk(path, depth + 1);}
      else if (st.isFile()) {
        field('file'); field(String(st.mode & 0o111));
        const fd = await open(absolute,constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const pinned = await fd.stat();
          if (!pinned.isFile() || pinned.ino !== st.ino || pinned.dev !== st.dev || pinned.mode !== st.mode) throw new Error('Input swapped');
          field(String(pinned.size));
          for await (const chunk of fd.createReadStream({autoClose:false})) hash.update(chunk);
        } finally {await fd.close();}
      } else throw new Error('Unsupported input');
    }
  }
  await walk(Buffer.alloc(0));
  if (selected && [...selected].some(name => !seen.has(name))) throw new Error('Input inventory incomplete');
  return hash.digest('hex');
}
// Ownership handoffs pin every path component. A worker can modify its work
// tree, but cannot replace the operator-owned slot/container ancestors. Refuse
// symlinks, foreign owners and hardlinks rather than chown an unverified inode.
export const ownershipSource = String.raw`
import os, sys, json, stat
cfg = json.loads(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
trusted = {0, cfg['operator']['uid']}
worker = cfg['worker']
def unsafe():
    raise RuntimeError('Unsafe ownership handoff; use local fallback and inspect slot setup')
def check(fd, directory=True, worker_parent=False):
    st = os.fstat(fd)
    owners = trusted | ({worker['uid']} if worker_parent else set())
    if st.st_uid not in owners or (directory and not stat.S_ISDIR(st.st_mode)):
        unsafe()
    if not worker_parent and st.st_mode & 0o022: unsafe()
    if not directory and (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1): unsafe()
    return st
def transfer(fd, depth=0):
    if depth > 128: unsafe()
    check(fd)
    if cfg['recursive']:
        for name in os.listdir(fd):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            directory = stat.S_ISDIR(info.st_mode)
            if not directory and not stat.S_ISREG(info.st_mode): unsafe()
            child = os.open(name, flags if directory else os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                pinned = check(child, directory)
                if (pinned.st_dev, pinned.st_ino) != (info.st_dev, info.st_ino): unsafe()
                if directory: transfer(child, depth+1)
                else: os.fchown(child, worker['uid'], worker['gid'])
            finally: os.close(child)
    # Hand directories over last; no worker can replace entries before their
    # descriptors have been verified and all privileged recursion has finished.
    os.fchown(fd, worker['uid'], worker['gid'])
parts = cfg['parts']
if not parts or len(parts) > 128 or any(not isinstance(p, str) or p in ('', '.', '..') or '/' in p or '\x00' in p for p in parts): unsafe()
parent = os.open(cfg['root'], flags)
try:
    check(parent)
    for i, name in enumerate(parts):
        child = os.open(name, flags, dir_fd=parent)
        try:
            worker_parent = cfg.get('workerParent', False) and i == len(parts)-2 and name == 'work'
            check(child, worker_parent=worker_parent)
        except:
            os.close(child)
            raise
        os.close(parent)
        parent = child
    transfer(parent)
except (OSError, RuntimeError):
    unsafe()
finally:
    os.close(parent)
`;
// A root supervisor is a subreaper: children which call setsid/double-fork are
// adopted here, and killed before the ops process publishes any evidence.
export const supervisorSource = String.raw`
import os, sys, json, signal, subprocess, ctypes, time, fcntl, stat
PR_SET_CHILD_SUBREAPER = 36
if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise RuntimeError('subreaper unavailable')
cfg = json.loads(sys.argv[1])
uid, gid = cfg['uid'], cfg['gid']
writer = cfg['writer']
writer_fd = os.open(writer['guard'], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
st = os.fstat(writer_fd)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & 0o077:
    raise RuntimeError('unsafe worker writer guard; use local fallback')
fcntl.flock(writer_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
fd = os.open(writer['reservation'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd) as stream:
    st = os.fstat(stream.fileno())
    if not stat.S_ISREG(st.st_mode) or st.st_size > 4*1024*1024:
        raise RuntimeError('unsafe worker reservation; use local fallback')
    reservation = json.load(stream)
if any(reservation.get(key) != writer.get(key) for key in ('run', 'nonce', 'slot')):
    raise RuntimeError('Reservation mismatch; use local fallback')
# Keep the lease in a root child even if the supervisor is killed mid-fork.
# Close its copy only AFTER UID drop, before exposing any task-controlled code.
writer_fds = (writer_fd,)
def drop():
    os.setsid()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    elif os.getuid() != uid or os.getgid() != gid:
        raise RuntimeError('cannot drop identity')
    os.close(writer_fd)
if 'archive' in cfg:
    # Only the fixed cache-extraction command receives an archive descriptor.
    # It runs as the worker; neither tar nor the task can write the cache.
    archive = os.open(cfg['archive'], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        child = subprocess.Popen(cfg['argv'], cwd=cfg['cwd'], env=cfg['env'], stdin=archive, preexec_fn=drop, pass_fds=writer_fds)
    finally: os.close(archive)
else:
    child = subprocess.Popen(cfg['argv'], cwd=cfg['cwd'], env=cfg['env'], stdin=subprocess.DEVNULL, preexec_fn=drop, pass_fds=writer_fds)
code = child.wait()
# All descendants run as the dedicated uid. Include live descendants before
# killing their parents, then reap orphans adopted by this subreaper.
def children():
    parents = {}
    for entry in os.listdir('/proc'):
        if not entry.isdigit(): continue
        try:
            # comm is arbitrary bytes and may itself contain spaces or ')'.
            with open('/proc/' + entry + '/stat', 'rb') as stat:
                data = stat.read()
            parents[int(entry)] = int(data[data.rfind(b')')+2:].split()[1])
        except (FileNotFoundError, ProcessLookupError): pass
    found, frontier = set(), {os.getpid()}
    while frontier:
        frontier = {pid for pid, ppid in parents.items() if ppid in frontier} - found
        found.update(frontier)
    return found
def uid_processes():
    found = set()
    if not cfg.get('reapUid', False): return found
    for entry in os.listdir('/proc'):
        if not entry.isdigit(): continue
        try:
            if int(entry) == os.getpid() or os.stat('/proc/' + entry).st_uid != uid: continue
            with open('/proc/' + entry + '/stat', 'rb') as stat:
                data = stat.read()
            if data[data.rfind(b')')+2:].split()[0] != b'Z': found.add(int(entry))
        except (FileNotFoundError, ProcessLookupError): pass
    return found
deadline = time.monotonic() + 30
while True:
    # Escaped sessions and externally reparented children still belong only to
    # this slot UID. Re-scan after killing to close the fork-during-scan race.
    if time.monotonic() > deadline: raise RuntimeError('uid cleanup unconfirmed; operator must stop reserved uid')
    for pid in children() | uid_processes():
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    try: os.waitpid(-1, 0)
    except ChildProcessError:
        if not uid_processes(): break
# Read this scope's counters only after every descendant has been reaped.
# Missing kernel counters are unknown, not a measured zero.
if 'usage' in cfg:
    usage = {'memoryPeakBytes': None, 'cpuUsec': None, 'oomKills': None}
    try:
        with open('/proc/self/cgroup') as stream:
            path = next(line.strip().split(':', 2)[2] for line in stream if line.startswith('0::'))
        base = '/sys/fs/cgroup/' + path.lstrip('/')
        def counter(name, key=None):
            try:
                with open(base + '/' + name) as stream:
                    data = stream.read()
                return int(data) if key is None else int(dict(line.split() for line in data.splitlines())[key])
            except (OSError, ValueError, KeyError): return None
        usage = {'memoryPeakBytes': counter('memory.peak'), 'cpuUsec': counter('cpu.stat', 'usage_usec'), 'oomKills': counter('memory.events', 'oom_kill')}
    except (OSError, StopIteration): pass
    fd = os.open(cfg['usage'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'w') as result: json.dump(usage, result)
fd = os.open(cfg['status'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
with os.fdopen(fd, 'w') as result: result.write(str(code if 0 <= code <= 255 else 255))
sys.exit(0)
`;
function execute(file,args,{cwd,env,input,inherit=false,detached=false,passFd}={}) {
  return new Promise((resolve,reject) => {
    const child = spawn(file,args,{cwd,env,detached,stdio:[input === undefined ? 'ignore':'pipe',inherit?'inherit':'pipe',inherit?'inherit':'pipe',...(passFd===undefined?[]:[passFd])]});
    const stdout=[],stderr=[];
    let bytes=0,overflow=false;
    for (const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]) stream?.on('data',chunk => {
      bytes += chunk.length;
      if (bytes > LIMIT) {overflow=true; child.kill('SIGKILL'); return;}
      if(name==='stdout') stdout.push(chunk); else stderr.push(chunk);
    });
    child.on('error',reject);
    // exit rather than close: detached children must not hold the output pipes open.
    child.on('exit',code => {
      if (detached) {try {process.kill(-child.pid,'SIGKILL');} catch { /* group already gone */ }}
    });
    child.on('close',code => overflow ? reject(new Error('Output limit exceeded')) : resolve({code:code??254,
      stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));
    if(input!==undefined) {child.stdin.on('error',()=>{}); child.stdin.end(input);}
  });
}
// testRoot/testPath/testCleanupExec/testIdExec are explicit dependency injection only. CLI never reads them
// from its environment, nor transports them in requests.
export function createRunner({testRoot, testPath, testCleanupExec, testIdExec, testWorkerIdentity, testSlotStat, testWorkerExec, testOwnershipExec, testGitExec, clock=Date.now} = {}) {
  const bases=testRoot ? join(testRoot,'bases') : '/srv/forge-base';
  const runs = testRoot ? join(testRoot,'runs') : '/srv/forge-exec';
  const receipts = testRoot ? join(testRoot,'receipts') : '/srv/forge-receipts';
  const cache = testRoot ? join(testRoot,'cache') : '/srv/forge-cache';
  const path = testRoot ? testPath : '/usr/local/bin:/usr/bin:/bin';
  const idExec=testRoot&&testIdExec?testIdExec:execute;
  // Only the legacy, same-UID test harness omits isolation evidence. Production
  // and either explicit isolation injection always use the production checks.
  const isolatedWorkers=!testRoot||testWorkerIdentity!==undefined||testSlotStat!==undefined;
  let operator={uid:process.getuid(),gid:process.getgid()};
  const statePath = (run,phase) => join(receipts,run+'.'+phase);
  const busy=()=>Object.assign(new Error('Worker execution busy or interrupted; use local fallback. Operator must stop the reserved UID before removing its worker-active lock'),{code:'forge-busy'});
  async function identity(user) {
    if(!isolatedWorkers)return {uid:process.getuid(),gid:process.getgid()};
    let ids;
    if(testWorkerIdentity)ids=await testWorkerIdentity(user);
    else {
      const uid=await idExec('/usr/bin/id',['-u',user]),gid=await idExec('/usr/bin/id',['-g',user]);
      if(uid.code||gid.code||!/^\d+\n$/.test(uid.stdout)||!/^\d+\n$/.test(gid.stdout))throw new Error('Unknown worker identity');
      ids={uid:Number(uid.stdout),gid:Number(gid.stdout)};
      if(/^forge-exec-[1-9]\d*$/.test(user)){
        const groups=await idExec('/usr/bin/id',['-G',user]);
        if(groups.code||!/^\d+(?: \d+)*\n$/.test(groups.stdout))throw new Error('Worker groups must be private');
        ids.groups=groups.stdout.trim().split(' ').map(Number);
      }
    }
    if(!ids||!Number.isSafeInteger(ids.uid)||ids.uid<0||!Number.isSafeInteger(ids.gid)||ids.gid<0)throw new Error('Unknown worker identity');
    if(/^forge-exec-[1-9]\d*$/.test(user)&&(ids.uid===operator.uid||ids.gid===operator.gid))throw new Error('Worker must not share the operator identity');
    if(ids.uid===0)throw new Error('Unknown worker identity');
    if(/^forge-exec-[1-9]\d*$/.test(user)&&(!Array.isArray(ids.groups)||ids.groups.length!==1||ids.groups[0]!==ids.gid))throw new Error('Worker groups must be private');
    return {uid:ids.uid,gid:ids.gid};
  }
  async function workers() {
    const names=(await readdir(runs)).filter(name=>/^slot-[1-9]\d*$/.test(name)).sort((a,b)=>Number(a.slice(5))-Number(b.slice(5)));
    if(names.length>128)throw new Error('Worker pool exceeds 128 slots; use local fallback and inspect setup');
    const found=[];
    for(const name of names) {
      const user='forge-exec-'+name.slice(5),ids=await identity(user),root=join(runs,name),st=await (testSlotStat??lstat)(root);
      if(st.isSymbolicLink()||!st.isDirectory()||(st.mode&0o7777)!==0o710
        ||(isolatedWorkers&&(st.uid!==operator.uid||st.gid!==ids.gid)))throw new Error('Untrusted slot directory; redeploy forge-setup and use local fallback');
      if(isolatedWorkers&&found.some(w=>w.uid===ids.uid||w.gid===ids.gid))throw new Error('Duplicate worker identity');
      found.push({user,root,active:join(receipts,'worker-active-'+name.slice(5)),...ids});
    }
    return found;
  }
  async function workerFor(record,request=record) {
    if(request.slot!==undefined&&request.slot!==record.slot)throw new Error('Slot mismatch');
    if(record.slot===undefined)return {user:'forge-exec',root:runs};
    const worker=(await workers()).find(w=>w.user===record.slot);
    if(!worker)throw new Error('Invalid slot');
    const reservation=JSON.parse(await readPinned(join(worker.active,'reservation.json')));
    if(reservation.run!==record.run||reservation.nonce!==record.nonce||reservation.slot!==record.slot)throw new Error('Reservation mismatch');
    return {...worker,reservation:record};
  }
  const writerName=record=>record?.slot?'worker-active-'+record.slot.slice('forge-exec-'.length):'worker-active';
  async function withWorkerWriter(name,action) {
    // Stable inode shared with cron's exclusive prune lock. Never unlink it:
    // the shared lease excludes reclamation through the last possible launch.
    const guard=await open(join(receipts,'.'+name+'.writer'),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try {
      const st=await guard.stat();
      if(!st.isFile()||st.nlink!==1||(st.mode&0o077)||![0,operator.uid].includes(st.uid))throw new Error('Untrusted worker writer guard; use local fallback and inspect slot setup');
      const locked=await execute('/usr/bin/python3',['-I','-c','import fcntl; fcntl.flock(3, fcntl.LOCK_SH | fcntl.LOCK_NB)'],{passFd:guard.fd});
      if(locked.code)throw busy();
      return await action();
    }finally{await guard.close();}
  }
  async function reserveWorker(run,nonce,slot) {
    const pool=await workers();
    if(slot!==undefined&&!pool.some(w=>w.user===slot))throw new Error('Invalid slot');
    if(!pool.length)return {user:'forge-exec',root:runs};
    for(const worker of pool) {
      try {return await withWorkerWriter(writerName({slot:worker.user}),async()=>{
        await mkdir(worker.active,{mode:0o700});
        // If persistence fails, retain the empty lock: incomplete evidence is busy.
        await writeFile(join(worker.active,'reservation.json'),JSON.stringify({run,nonce,slot:worker.user,writerGuard:1}),{flag:'wx',mode:0o600});
        return worker;
      });}catch(error){if(error.code==='EEXIST'||error.code==='forge-busy')continue;throw error;}
    }
    throw busy();
  }
  async function releaseWorker(record) {
    return withWorkerWriter(writerName(record),async()=>{
    const worker=await workerFor(record);
    if(worker.active){
      if(await lstat(join(worker.active,'executing')).catch(e=>{if(e.code!=='ENOENT')throw e;}))throw new Error('Worker execution unconfirmed; operator must stop the reserved UID');
      await rm(join(worker.active,'reservation.json'));await rmdir(worker.active);
    }
    });
  }
  async function atomicJSON(file,value) {
    const pending=file+'-'+randomBytes(8).toString('hex');
    try {await writeFile(pending,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(pending,file);}
    finally {await rm(pending,{force:true});}
  }
  async function publishTelemetry(record) {
    if(record)await atomicJSON(statePath(record.runId,'telemetry'),record);
    const names=await readdir(receipts);
    const recent=[];
    for(const name of names.filter(n=>/^r-[a-f0-9]{32}\.telemetry$/.test(n)))
      recent.push(JSON.parse(await readPinned(join(receipts,name))));
    recent.sort((a,b)=>Date.parse(b.startedAtET)-Date.parse(a.startedAtET)||a.runId.localeCompare(b.runId));
    const cores=cpus().length;
    const value={sampledAtET:easternTimestamp(clock()),cores,loadPerCore:loadavg()[0]/cores,
      memFreePct:freemem()/totalmem()*100,
      activeRuns:names.filter(n=>/^r-[a-f0-9]{32}\.(prepared|running)$/.test(n)).length,recent:recent.slice(0,50)};
    parseTelemetry(JSON.stringify(value));
    await atomicJSON(join(receipts,'telemetry.json'),value);
    return value;
  }
  async function init() {
    if(!testRoot&&process.getuid()===0)operator=await identity('ops');
    if(testRoot) for(const dir of [runs,receipts,cache]) await mkdir(dir,{recursive:true,mode:0o700});
    for(const dir of [runs,receipts,cache]) await directory(dir,true,operator);
    if((await lstat(receipts)).mode&0o077)throw new Error('Receipts must be ops-only 0700');
  }
  async function state(request,phase) {
    await init();
    if(!runName(request.run) || !nonceOK(request.nonce)) throw new Error('Invalid run');
    const value=JSON.parse(await readPinned(statePath(request.run,phase)));
    if(value.nonce!==request.nonce || value.run!==request.run) throw new Error('State mismatch');
    if(request.slot!==undefined&&request.slot!==value.slot)throw new Error('Slot mismatch');
    return value;
  }
  async function handoff(worker,target,{recursive=false,workerParent=false}={}) {
    if(testRoot&&!testOwnershipExec)return;
    const ids=worker.uid===undefined?await identity(worker.user):worker;
    const cfg={root:runs,parts:relative(runs,target).split('/'),operator,worker:{uid:ids.uid,gid:ids.gid},recursive,workerParent};
    const call={file:'/usr/bin/sudo',args:['-n','/usr/bin/python3','-I','-c',ownershipSource,JSON.stringify(cfg)]};
    const result=testRoot?await testOwnershipExec(call):await execute(call.file,call.args,{env:{PATH:path,LANG:'C'}});
    if(result.code!==0)throw new Error('Worker ownership handoff refused; use local fallback and inspect slot setup');
  }
  async function pinBase(run,baseSha) {
    // Pool metadata runs as root, but the anonymous warmer runs as ops and
    // must read every active pin before deciding which public bases to prune.
    await createBasePin(bases,run,baseSha,!testRoot&&process.getuid()===0?operator:undefined);
  }
  async function workCommand(worker,argv,work,env,archive) {
    const slot=Number(/^forge-exec-([1-9]\d*)$/.exec(worker.user)?.[1]??(testRoot?1:NaN));
    if(!testRoot && process.getuid()!==0) throw new Error('Scoped execution requires the root wrapper; use local fallback');
    if(!Number.isSafeInteger(slot)||slot<1) throw new Error('Scoped execution requires a numbered slot; rerun Forge setup or use local fallback');
    const {limits,warnings}=testRoot?{limits:{},warnings:[]}:await readLimits();
    for(const warning of warnings) process.stderr.write('forge-exec-run: '+warning.replace(/[\x00-\x1f\x7f]/g,' ')+'\n');
    const cpus=slotCpus(limits,slot);
    env={WE_VITEST_MAX_WORKERS:String(cpus),...env,FORGE_SLOT_CPUS:String(cpus)};
    if(testRoot) return {...await (testWorkerExec?testWorkerExec({worker,argv,cwd:work,env,archive}):execute(argv[0],archive ? ['-xf',archive] : argv.slice(1),{cwd:work,env,detached:true})),slotCpus:cpus};
    const ids=await identity(worker.user);
    const status=join(receipts,'supervisor-'+randomBytes(16).toString('hex'));
    const usage=status+'.usage';
    const name=writerName(worker.reservation),writer={...worker.reservation,guard:join(receipts,'.'+name+'.writer'),reservation:join(receipts,name,'reservation.json')};
    try {
      const launcher=scopeLauncherArgv({slot,unit:'forge-exec-run-'+randomBytes(16).toString('hex'),sudo:false,source:supervisorSource,
        json:JSON.stringify({argv,cwd:work,env,status,usage,writer,reapUid:true,...(archive?{archive}:{}),...ids})});
      const result=await execute(launcher[0],launcher.slice(1),{inherit:true});
      if(result.code!==0) throw new Error('Supervisor failed');
      const code=Number((await readPinned(status)).toString());
      if(!Number.isInteger(code) || code<0 || code>255) throw new Error('Invalid supervisor status');
      let measured;
      try {measured=JSON.parse((await readPinned(usage)).toString());} catch(error) {if(error.code!=='ENOENT')throw error;}
      return {...result,code,usage:measured,slotCpus:cpus};
    } finally {await Promise.all([rm(status,{force:true}),rm(usage,{force:true})]);}
  }
  async function exclusiveWorker(action,record) {
    return withWorkerWriter(writerName(record),async()=>{
    if(record?.slot) {
      const worker=await workerFor(record),executing=join(worker.active,'executing');
      await mkdir(executing,{mode:0o700}).catch(error=>{if(error.code==='EEXIST')throw busy();throw error;});
      let settled=true;
      const command=async(...args)=>{settled=false;const result=await workCommand(worker,...args);settled=true;return result;};
      try{return await action(command,worker);}
      finally{if(settled)await rmdir(executing);}
    }
    // All work still shares one uid. Serialize across ALL profiles and runners,
    // before hashing input, until the supervisor has reaped every descendant.
    // An atomic directory persists across wrapper/supervisor death. Never age
    // it out: an orphan could still modify another run under the shared uid.
    const active=join(receipts,'worker-active');
    await mkdir(active,{mode:0o700}).catch(error=>{
      if(error.code==='EEXIST') throw Object.assign(new Error('Worker execution busy or interrupted; use local fallback. Operator must stop all forge-exec processes before removing /srv/forge-receipts/worker-active'),{code:'forge-busy'});
      throw error;
    });
    await writeFile(join(active,'reservation.json'),JSON.stringify({...record,writerGuard:1}),{flag:'wx',mode:0o600});
    let settled=true;
    const command=async (...args)=>{
      settled=false;
      const result=await workCommand({user:'forge-exec',reservation:record},...args);
      settled=true;
      return result;
    };
    try {return await action(command);}
    finally {if(settled){await rm(join(active,'reservation.json'));await rmdir(active);}}
    });
  }
  async function cacheCommand(args,work,input) {
    const result=await execute('/usr/bin/tar',args,{cwd:work,env:{PATH:path,LANG:'C'},input});
    if(result.code) throw new Error('Cache archive command failed');
  }
  async function dependencies(dir) {
    const found=[];
    async function walk(base) {
      for(const name of await readdir(base)) {
        const child=join(base,name),st=await lstat(child);
        if(st.isDirectory()) {
          if(name==='node_modules') found.push('./'+relative(dir,child));
          else await walk(child);
        }
      }
    }
    await walk(dir);return found;
  }
  // Cross-main reuse is available only for registry-only installs. Workspaces,
  // local packages/tarballs, unknown lock formats and unproven resolutions keep
  // the existing complete-snapshot cache key and install normally.
  async function registryInstallSignature(work,request) {
    try {
      const root=JSON.parse(await readPinned(join(work,'package.json'))),lock=JSON.parse(await readPinned(join(work,'package-lock.json')));
      if(root.workspaces||lock.lockfileVersion!==3||!lock.packages||typeof lock.packages!=='object')return null;
      if(/(?:file:|link:|workspace:)/i.test(JSON.stringify([root,lock])))return null;
      for(const [name,pkg] of Object.entries(lock.packages)) {
        if(!pkg||typeof pkg!=='object'||pkg.link)return null;
        if(name&&(!/^https:\/\//.test(pkg.resolved)||typeof pkg.integrity!=='string'||!pkg.integrity))return null;
      }
      const inputs=decodeManifest((({siblings,git,...rest})=>rest)(request.manifest)).entries.filter(e=>e.path.toString('latin1').split('/').at(-1)==='package.json');
      return sha(JSON.stringify({lock:request.lock,packages:inputs.map(e=>[e.path.toString('base64'),e.sha256,e.executable]),node:process.version,platform:process.platform,arch:process.arch,install:['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']}));
    }catch{return null;}
  }
  async function copyCacheArchive(source,destination,expected) {
    if(await archiveDigest(source)!==expected)throw new Error('Warm cache digest mismatch');
    const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW),output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {for await(const chunk of input.createReadStream({autoClose:false}))await output.writeFile(chunk);}
    finally{await input.close();await output.close();}
    if(await archiveDigest(destination)!==expected)throw new Error('Warm copied cache digest mismatch');
  }
  async function reuseWarmProfile(signature,request) {
    const parent=join(cache,request.lock),profile=join(parent,'dev-v5-'+(request.manifest.siblings?request.manifestDigest:request.inputDigest));
    const index=signature?join(parent,'.warm-inputs-'+signature):null;
    const record=index?await readPinned(index).then(bytes=>JSON.parse(bytes),error=>{if(error.code!=='ENOENT')throw error;return null;}):null;
    if(!record)return false;
    if(Object.keys(record).sort().join(',')!=='archiveDigest,profile'||!hex(record.profile)||!hex(record.archiveDigest))throw new Error('Invalid warm install evidence');
    const source=join(parent,'dev-v5-'+record.profile);await directory(parent,true,operator);await directory(source,true,operator);
    if((await readPinned(join(source,'sha256'))).toString()!==record.archiveDigest||await archiveDigest(join(source,'dependencies.tar'))!==record.archiveDigest)throw new Error('Warm cache digest mismatch');
    if(source!==profile) {
      await mkdir(profile,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(profile,true,operator);
      const target=join(profile,'dependencies.tar');
      const exists=await lstat(target).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;});
      if(exists){if(await archiveDigest(target)!==record.archiveDigest||(await readPinned(join(profile,'sha256'))).toString()!==record.archiveDigest)throw new Error('Warm target cache mismatch');}
      else {const pending=join(profile,'pending-'+randomBytes(8).toString('hex'));await copyCacheArchive(join(source,'dependencies.tar'),pending,record.archiveDigest);await writeFile(join(profile,'sha256'),record.archiveDigest,{flag:'wx',mode:0o600});await rename(pending,target);}
    }
    return true;
  }
  async function installDependencies(request,work,command) {
    let result;
      // npm accepts some manifest changes without lock changes. Key the entire
      // validated snapshot, including workspace manifests and local dependency
      // contents, so a warm archive represents the same install inputs. Earlier
      // profiles lack this binding (v3 also allowed an unkeyed shrinkwrap).
      const profile=join(cache,request.lock,'dev-v5-'+(request.manifest.siblings ? request.manifestDigest : request.inputDigest));
      const installEnv={PATH:path,HOME:join(work,'.forge-home'),LANG:'C',CI:'true',NODE_ENV:'development'};
        // These parents are inaccessible to forge-exec; reject symlinked cache state.
        await mkdir(join(cache,request.lock),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST') throw e;});
        await directory(join(cache,request.lock),true,operator);
        await mkdir(profile,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST') throw e;});
        await directory(profile,true,operator);
        const guard=await open(join(profile,'.lock'),constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,0o600);
        try {
          if(!(await guard.stat()).isFile()) throw new Error('Invalid cache lock; use local fallback');
          // flock belongs to the shared open file description. Python exits
          // after locking its inherited fd; our fd keeps the lock until close
          // or process death. Never unlink the lock file (that splits waiters).
          // Historical .busy directories are inert, including abandoned ones.
          const locked=await execute('/usr/bin/python3',['-I','-c','import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],{passFd:guard.fd});
          if(locked.code) throw new Error('Cache profile lock unavailable; use local fallback');
          await reuseWarmProfile(await registryInstallSignature(work,request),request);
          const archive=join(profile,'dependencies.tar');
          const warm=await lstat(archive).then(()=>true,e=>{if(e.code==='ENOENT') return false; throw e;});
          const ci=['npm','ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'];
          if(warm) {
            const expected=(await readPinned(join(profile,'sha256'))).toString();
            if(!hex(expected) || await archiveDigest(archive)!==expected) throw new Error('Cache sha256 mismatch');
            result=await command([...ci,'--dry-run','--offline'],work,installEnv);
            if(result.code) throw new Error('npm ci validation failed: '+result.stderr);
            const extracted=await command(['/usr/bin/tar','-xf','-'],work,installEnv,archive);
            if(extracted.code) throw new Error('Cache extraction failed');
          } else {
            result=await command(ci,work,installEnv);
            if(result.code) throw new Error('npm ci failed: '+result.stderr);
            const temp=join(profile,'pending-'+randomBytes(8).toString('hex'));
            await cacheCommand(['-cf',temp,'--null','-T','-'],work,(await dependencies(work)).map(name=>name+'\0').join(''));
            await writeFile(join(profile,'sha256'),await archiveDigest(temp),{flag:'wx',mode:0o600});
            await rename(temp,archive);
          }
        } finally {await guard.close();}
    return result;
  }
  return {
    async telemetry() {
      // Idle hosts and fresh installs have no background sampler. Sample the
      // actual host on every SSH request; the Mac health cache bounds reads.
      await init();
      return publishTelemetry();
    },
    async bases() {
      try{return {delta:1,bases:(await readyBases(bases)).slice(0,4).map(({sha,manifestDigest})=>({sha,manifestDigest}))};}
      catch{return {delta:1,bases:[]};}
    },
    async ['base-manifest']({sha}) {
      return baseGuard(bases,async()=>{
        const ready=(await readyBases(bases)).find(base=>base.sha===sha);
        if(!ready)throw new Error('Unknown READY base');
        return (await readBase(bases,sha,ready.manifestDigest)).manifest;
      });
    },
    // Called by the fixed warmer; the privileged CLI restricts its source root.
    async warmInstall(source,manifest) {
      await init();
      const run='warm-'+randomBytes(16).toString('hex'),nonce=randomBytes(16).toString('hex');
      const worker=await reserveWorker(run,nonce),record={run,nonce,...(worker.active?{slot:worker.user}:{})};
      try{return await exclusiveWorker(async command=>{
        const work=join(worker.root,run);
        await mkdir(work,{mode:0o755});
        try {
          const entries=decodeManifest(manifest).entries;
          await copyLeaves(source,work,entries);
          await verifyManifest(work,manifest,digestManifest(manifest));
          await handoff(worker,work,{recursive:true});
          const request={lock:await digestLock(work),inputDigest:await digestInput(work),manifest,manifestDigest:digestManifest(manifest)};
          const signature=await registryInstallSignature(work,request),parent=join(cache,request.lock),profile=join(parent,'dev-v5-'+request.inputDigest);
          const index=signature?join(parent,'.warm-inputs-'+signature):null;
          if(!await reuseWarmProfile(signature,request)) {
            await installDependencies(request,work,command);
            if(index) {
              const archiveDigestValue=await archiveDigest(join(profile,'dependencies.tar'));
              const pending=index+'-'+randomBytes(8).toString('hex');
              await writeFile(pending,JSON.stringify({profile:request.inputDigest,archiveDigest:archiveDigestValue}),{flag:'wx',mode:0o600});await rename(pending,index);
            }
          }
          return {code:0};
        } finally {
          if(testRoot)await rm(work,{recursive:true,force:true});
          else if((await execute('/usr/bin/sudo',['-n','/usr/bin/rm','-rf','--',work])).code)throw new Error('Warm cleanup failed');
        }
      },record);
      }finally{if(worker.active)await releaseWorker(record);}
    },
    async prepare({nonce,label,siblings,baseSha,baseManifestDigest,slot}) {
      await init();
      if(!nonceOK(nonce) || (label!==undefined && (typeof label!=='string' || !/^[a-z0-9][a-z0-9-]{5,63}$/.test(label)))) throw new Error('Invalid prepare');
      const run='r-'+randomBytes(16).toString('hex');
      const worker=await reserveWorker(run,nonce,slot),record={v:1,nonce,run,...(worker.active?{slot:worker.user}:{})};
      const prepare=async()=>{
      if(worker.active)await workerFor(record);
      const container=join(worker.root,run);
      try {
      await mkdir(container,{mode:0o755}); // exclusive server-generated name
      const work=join(container,'work');
      await mkdir(work,{mode:0o755});
      await handoff(worker,work);
      if (siblings === true) {
        const sibling = join(container,'frontierui');
        await mkdir(sibling,{mode:0o755});
        await handoff(worker,sibling);
      }
      await writeFile(statePath(run,'prepared'),JSON.stringify(record),{flag:'wx',mode:0o600});
      await publishTelemetry({runId:run,startedAtET:easternTimestamp(clock()),stageMs:{install:0,run:0},code:null});
      if(baseSha!==undefined)await baseGuard(bases,async()=>{
        await readBase(bases,baseSha,baseManifestDigest);
        await pinBase(run,baseSha);
        await writeFile(statePath(run,'base'),JSON.stringify({baseSha,baseManifestDigest}),{flag:'wx',mode:0o600});
      });
      return {run,...(worker.active?{slot:worker.user,worker:{user:worker.user,uid:worker.uid,gid:worker.gid}}:{}),capabilities:{siblings:1,commandClasses:1,gitWorktree:2,...(worker.active?{workers:(await workers()).map(w=>w.user)}:{}),...await this.bases()}};
      }catch(error){
        await rm(container,{recursive:true,force:true});
        await rm(statePath(run,'prepared'),{force:true});
        await rm(statePath(run,'base'),{force:true});
        await rm(join(bases,'active',run),{force:true});
        if(worker.active)await releaseWorker(record);
        throw error;
      }
      };
      return worker.active?withWorkerWriter(writerName(record),prepare):prepare();
    },
    async run(request) {
      const prepared=await state(request,'prepared');
      try {
      if(!allowedCommand(request.argv) || !allowedEnv(request.env) || !hex(request.lock) || !hex(request.inputDigest)
        || request.argvDigest!==digestArgv(request.argv)) throw new Error('Invalid execution parameters');
      return await exclusiveWorker(async (executeCommand,selected) => {
      const resources={memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:8};
      const command=async(...args)=>{
        const value=await executeCommand(...args);
        resources.slotCpus=value.slotCpus??resources.slotCpus;
        for(const key of ['memoryPeakBytes','cpuUsec','oomKills']) {
          const n=value.usage?.[key];
          if(Number.isSafeInteger(n)&&n>=0) resources[key]=key==='memoryPeakBytes'?Math.max(resources[key]??0,n):(resources[key]??0)+n;
        }
        return value;
      };
      const worker=selected??{user:'forge-exec',root:runs};
      const container=join(worker.root,request.run),work=join(container,'work');
      await directory(container,true,operator); await directory(work);
      if(request.baseSha!==undefined) {
        await baseGuard(bases,async()=>{
          const base=await readBase(bases,request.baseSha,request.baseManifestDigest);
          // Direct run requests pin before reading, as do prepared delta clients.
          await pinBase(request.run,request.baseSha);
          await verifyManifest(base.tree,base.manifest,request.baseManifestDigest);
          if(typeof request.deletions!=='string'||Buffer.from(request.deletions,'base64').toString('base64')!==request.deletions)throw new Error('Invalid deletion list');
          const deletions=splitPaths(Buffer.from(request.deletions,'base64'));
          const baseEntries=decodeManifest(base.manifest).entries,finalEntries=decodeManifest((({siblings,git,...rest})=>rest)(request.manifest)).entries;
          const finalKeys=new Set(finalEntries.map(e=>e.path.toString('hex')));
          const deleted=new Set(deletions.map(p=>p.toString('hex')));
          if(deleted.size!==deletions.length||deletions.some(p=>!baseEntries.some(e=>e.path.equals(p))||finalKeys.has(p.toString('hex'))))throw new Error('Invalid deletion path');
          // Walk every incoming delta leaf before overlay: reject unknown files,
          // symlinks and special nodes, even when final verification would omit it.
          const incoming=[];
          const walk=async prefix=>{for(const name of await readdir(prefix.length?bytePath(work,prefix):work,{encoding:'buffer'})){const p=prefix.length?Buffer.concat([prefix,Buffer.from('/'),name]):name;pathParts(p);const st=await lstat(bytePath(work,p));if(st.isSymbolicLink())throw new Error('Delta symlink');if(st.isDirectory())await walk(p);else {if(!st.isFile())throw new Error('Delta special file');const entry=finalEntries.find(e=>e.path.equals(p));if(!entry)throw new Error('Unlisted delta leaf');incoming.push(entry);}}};
          await walk(Buffer.alloc(0));
          const overlay=new Set(incoming.map(e=>e.path.toString('hex'))),assembled=join(container,'assembled');
          await mkdir(assembled,{mode:0o755});
          await copyLeaves(base.tree,assembled,baseEntries.filter(e=>!deleted.has(e.path.toString('hex'))&&!overlay.has(e.path.toString('hex'))));
          await copyLeaves(work,assembled,incoming);
          // Verify primary full M before installing and before exposing any of
          // the reconstructed bytes to the worker. Siblings remain Mac-shipped.
          await verifyManifest(assembled,(({siblings,git,...rest})=>rest)(request.manifest),digestManifest((({siblings,git,...rest})=>rest)(request.manifest)));
          await handoff(worker,assembled,{recursive:true});
          await rename(work,join(container,'delta'));await rename(assembled,work);
        });
      } else if(request.deletions!==undefined||request.baseManifestDigest!==undefined)throw new Error('Unexpected delta evidence');
      // Preserve the dual-lock refusal before inspecting snapshot differences.
      const lock = await digestLock(work);
      // Verify before npm or cache extraction can add generated files.
      await verifyManifest(work,request.manifest,request.manifestDigest);
      if (request.manifest.siblings) {
        if (!sameSiblingShas(request.siblingShas,siblingShas(request.manifest))) throw new Error('Sibling SHA mismatch');
      } else {
        if (request.siblingShas !== undefined) throw new Error('Unexpected sibling SHA');
        const sibling = join(container,'frontierui');
        const info = await lstat(sibling).catch(error => {if(error.code !== 'ENOENT') throw error;});
        if (info && (info.isSymbolicLink() || !info.isDirectory() || (await readdir(sibling)).length)) throw new Error('Extra sibling snapshot');
      }
      if(await digestInput(work)!==request.inputDigest || lock!==request.lock) throw new Error('Input digest mismatch');
      if(request.argv[2]==='check:standards'||request.env.DIFF_COVERAGE_BASE!==undefined) {
        if(!request.manifest.git)throw new Error('Missing Git evidence');
        if(request.env.DIFF_COVERAGE_BASE!==request.manifest.git.diffCoverageBase)throw new Error('Coverage base mismatch');
        try {
          await materializeWorktree({work,root:bases,baseSha:request.baseSha,head:request.manifest.git.head,manifest:request.manifest,manifestDigest:request.manifestDigest,
            ...(testRoot&&testGitExec?{exec:testGitExec}:{})});
          await handoff(worker,join(work,'.git'),{recursive:true,workerParent:true});
        } catch(error) {throw Object.assign(error,{code:error.code==='diff-coverage-base-unavailable'?error.code:'git-head-unavailable'});}
      }
      await rename(statePath(request.run,'prepared'),statePath(request.run,'running'));
      let phase='install',result={code:97,stdout:'',stderr:''};
      const installAt=clock();let installMs=0,runMs=0,runAt;
      const startedAtET=easternTimestamp(installAt);
      let telemetryError;
      let updates=Promise.resolve();
      const update=()=>{
        const record={runId:request.run,startedAtET,stageMs:{install:runAt===undefined?Math.max(0,Math.round(clock()-installAt)):installMs,
          run:runAt===undefined?0:Math.max(0,Math.round(clock()-runAt))},code:null};
        updates=updates.then(()=>publishTelemetry(record)).catch(error=>{telemetryError=error;});
        return updates;
      };
      await update();
      if(telemetryError)throw telemetryError;
      const telemetryTimer=setInterval(update,5000);
      telemetryTimer.unref();
      try {
        result=await installDependencies(request,work,command);
        installMs=Math.max(0,Math.round(clock()-installAt));
        phase='test';
        runAt=clock();
        await update();
        if(telemetryError)throw telemetryError;
        result=await command(executionArgv(request.argv),work,{PATH:path,HOME:join(work,'.forge-home'),...request.env});
      } catch(error) {const code=phase==='install'?97:254; if(phase==='test') phase='supervisor'; result={code,stdout:result.stdout,stderr:String(error.message)};}
      finally {clearInterval(telemetryTimer);await updates;}
      if(runAt!==undefined)runMs=Math.max(0,Math.round(clock()-runAt));else installMs=Math.max(0,Math.round(clock()-installAt));
      const {slot:reservedSlot,...receiptState}=prepared;
      const receipt={...receiptState,resources,timings:{installMs,runMs},...(request.manifest.siblings ? {siblingShas:siblingShas(request.manifest)} : {}),manifestDigest:request.manifestDigest,inputDigest:request.inputDigest,argvDigest:request.argvDigest,lock:request.lock,phase,code:result.code};
      await writeFile(statePath(request.run,'receipt'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
      await publishTelemetry({runId:request.run,startedAtET,stageMs:{install:installMs,run:runMs},code:result.code});
      if(telemetryError)throw telemetryError;
      return result;
      },prepared);
      } catch (error) {
        // A separately installed runner must publish pre-execution rejection in
        // protected ops state. Never infer not-started from worker-owned files.
        const stillPrepared = await lstat(statePath(request.run,'prepared')).catch(e => {if(e.code !== 'ENOENT') throw e;});
        if (stillPrepared) {
          const reason=['git-head-unavailable','diff-coverage-base-unavailable'].includes(error.code) ? error.code
            : error.code==='forge-busy' && !(request.argv?.[0]==='npm' && request.argv?.[2]==='test:unit') ? 'forge-busy' : 'snapshot-rejected';
          await writeFile(statePath(request.run,'rejected'),JSON.stringify({v:prepared.v,nonce:prepared.nonce,run:prepared.run,phase:'rejected',reason,siblings:!!request.manifest?.siblings,...(request.baseSha!==undefined?{delta:true}:{})}),{flag:'wx',mode:0o600}).catch(async e => {if (e.code !== 'EEXIST') throw e; await state(request,'rejected');});
        }
        throw error;
      }
    },
    async finish(request) {
      let phase='running',record;
      try{record=await state(request,phase);}catch{record=await state(request,'prepared');}
      return withWorkerWriter(writerName(record),async()=>{
      let finishingWorker,settled=true;
      try {
      // Only the protected state is evidence; receipt-like files in work are data.
      let phase='running';
      try {await state(request,phase);} catch {phase='prepared'; await state(request,phase);}
      let receipt;
      try {receipt=JSON.parse(await readPinned(statePath(request.run,'receipt')));} catch(e) {if(e.code!=='ENOENT') throw e;}
      const record=await state(request,phase),worker=await workerFor(record,request);
      if(worker.active){
        await mkdir(join(worker.active,'executing'),{mode:0o700}).catch(error=>{if(error.code==='EEXIST')throw new Error('Worker execution unconfirmed; operator must stop the reserved UID');throw error;});
        finishingWorker=worker;
      }
      const container=join(worker.root,request.run);
      await directory(container,true,operator);
      if(worker.active){
        // Includes cancelled rsync and children left before task execution.
        settled=false;
        const reaped=await workCommand(worker,['/usr/bin/true'],container,{PATH:path,HOME:'/nonexistent'});
        if(reaped.code!==0)throw new Error('Worker cleanup unconfirmed');
        settled=true;
      }
      // The worker owns work and may remove ops' write permission. Only the
      // ops-owned container is a cleanup authority: it is validated above, and
      // its parent is protected by init(), so the worker cannot swap this path.
      // rm removes links inside the tree without following their targets.
      const command={file:'/usr/bin/sudo',args:['-n','/usr/bin/rm','-rf','--',container]};
      const cleaned=testRoot
        ? testCleanupExec ? await testCleanupExec(command) : (await rm(container,{recursive:true,force:true}),{code:0})
        : await execute(command.file,command.args);
      if(cleaned?.code!==0) throw new Error('Run cleanup failed; use local fallback and inspect protected run state');
      const remaining=await lstat(container).then(()=>true,error=>{if(error.code==='ENOENT') return false; throw error;});
      if(remaining) throw new Error('Run cleanup incomplete; use local fallback and inspect protected run state');
      await rename(statePath(request.run,phase),statePath(request.run,'consumed'));
      await rm(statePath(request.run,'receipt'),{force:true});
      const rejected = await readPinned(statePath(request.run,'rejected')).then(bytes => JSON.parse(bytes),error => {if(error.code !== 'ENOENT') throw error;});
      await rm(statePath(request.run,'rejected'),{force:true});
      await rm(join(bases,'active',request.run),{force:true});
      await rm(statePath(request.run,'base'),{force:true});
      if(worker.active){await rmdir(join(worker.active,'executing'));finishingWorker=undefined;await releaseWorker(record);}
      await publishTelemetry();
      // Legacy callers retain their null finish response for non-sibling failures.
      // Never certify rejection once the protected run phase has started.
      return receipt ?? (phase === 'prepared' && (rejected?.siblings||rejected?.delta||['forge-busy','git-head-unavailable','diff-coverage-base-unavailable'].includes(rejected?.reason)) ? {...rejected,started:false} : null) ?? null;
      }finally{if(finishingWorker&&settled)await rmdir(join(finishingWorker.active,'executing'));}
      });
    },
  };
}
const cliPath = (()=>{try{return realpathSync(process.argv[1]);}catch{return '';}})();
if(process.argv[1] && cliPath === realpathSync(fileURLToPath(import.meta.url))) {
  (async()=>{
  try {
    if(process.argv.length!==3 || !['prepare','run','finish','bases','base-manifest','telemetry','warm-install'].includes(process.argv[2])) throw new Error('Invalid subcommand');
    // Pool roots are deliberately 0700 worker-owned. Only this installed,
    // root-owned fixed wrapper may cross identities for metadata operations.
    const pool=(await readdir('/srv/forge-exec').catch(e=>{if(e.code!=='ENOENT')throw e;return [];})).some(name=>/^slot-[1-9]\d*$/.test(name));
    if(pool&&process.getuid()!==0) {
      const child=spawn('/usr/bin/sudo',['-n','/usr/local/libexec/forge-exec-run.mjs',process.argv[2]],{stdio:'inherit',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent'}});
      process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code??254));});
    } else {
    let input='';
    process.stdin.setEncoding('utf8');
    if(process.argv[2]!=='telemetry')for await(const chunk of process.stdin) {input+=chunk; if(Buffer.byteLength(input)>LIMIT) throw new Error('Request limit exceeded');}
    const request=process.argv[2]==='telemetry'?undefined:JSON.parse(input);
    if(process.argv[2]==='warm-install' && (!request||!/^\/srv\/forge-base\/[a-f0-9]{40}(?:[a-f0-9]{24})?\.tmp\/tree$/.test(request.source)))throw new Error('Invalid warm source');
    const runner=createRunner();
    const result=process.argv[2]==='warm-install'?await runner.warmInstall(request.source,request.manifest):await runner[process.argv[2]](request);
    if(process.argv[2]==='run') process.exitCode=result.code;
    else process.stdout.write(JSON.stringify(result)+'\n');
    }
  } catch(error) {
    if(process.argv[2]==='prepare'&&error.code==='forge-busy')process.stdout.write(JSON.stringify({reason:'forge-busy'})+'\n');
    process.stderr.write('forge-exec-run: '+String(error.message).replace(/[\x00-\x1f\x7f]/g,' ')+'\n'); process.exitCode=254;
  }
  })();
}
