#!/usr/bin/env node
// Installed root:root 0755. No executable source or configuration comes from the task.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import {open, mkdir, readdir, writeFile, rename, rm, rmdir, lstat, realpath} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const LIMIT = 4 * 1024 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runName = value => typeof value === 'string' && /^r-[a-f0-9]{32}$/.test(value);
const nonceOK = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
export const digestArgv = argv => sha(JSON.stringify(argv));
// Shared by the client and fixed wrapper through allowedCommand. Match spellings exactly.
export const VITEST_ALLOWED_OPTIONS = Object.freeze([
  '--run', '--silent', '--no-color',
  '--reporter=default', '--reporter=dot', '--reporter=verbose', '--reporter=basic', '--reporter=tap',
  '-t', '--testNamePattern=',
]);
export function allowedCommand(argv) {
  if (!(Array.isArray(argv) && argv.length >= 3 && argv.every(a => typeof a === 'string' && !a.includes('\0'))
    && argv[0] === 'npm' && argv[1] === 'run' && argv[2] === 'test:unit'
    && (argv.length === 3 || argv[3] === '--'))) return false;
  for (let i = 4; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    const option = arg.startsWith('--testNamePattern=') ? '--testNamePattern=' : arg;
    if (!VITEST_ALLOWED_OPTIONS.includes(option)) return false;
    // Vitest reparses dash-prefixed -t values as options (including --help).
    if (arg === '-t' && (++i >= argv.length || argv[i].startsWith('-'))) return false;
  }
  return true;
}
const ENV_KEYS = ['CI','NODE_ENV','TZ','LANG','LC_ALL','FORCE_COLOR','NO_COLOR'];
export function allowedEnv(env) {
  return env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([key,value]) =>
    ENV_KEYS.includes(key) && !/secret|token|password|credential|auth|key/i.test(key)
    && typeof value === 'string' && !value.includes('\0'));
}
async function directory(path, trusted = false) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const info = await fd.stat();
  await fd.close();
  if (!info.isDirectory() || (trusted && ((info.uid !== process.getuid() && info.uid !== 0) || (info.mode & 0o002) || ((info.mode & 0o020) && info.gid !== process.getgid())))) throw new Error('Untrusted directory');
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
// Paths remain bytes throughout inventory, transport, hashing and verification.
export function pathParts(path) {
  if (!Buffer.isBuffer(path) || !path.length || path[0] === 47 || path.some(b => b === 0 || b === 10 || b === 13))
    throw new Error('Unsafe manifest path');
  const parts = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) if (i === path.length || path[i] === 47) {
    const part = path.subarray(start, i);
    if (!part.length || part.equals(Buffer.from('.')) || part.equals(Buffer.from('..'))) throw new Error('Unsafe manifest path component');
    parts.push(part); start = i + 1;
  }
  return parts;
}
export const bytePath = (root, path) => Buffer.concat([Buffer.from(root), Buffer.from('/'), path]);
// latin1 preserves bytes while matching ASCII suffixes and directory names.
export function isTestFile(path) {
  const parts = path.toString('latin1').split('/');
  const basename = parts.pop();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename)
    || (/\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(basename)
      && parts.some(part => /^(?:__tests__|__test__|test|tests|spec|specs|e2e)$/.test(part)));
}

// Test discovery consumes Unicode strings. Refuse names it could merge or lose;
// non-test assets retain the byte-path transport contract.
export function validateTestNames(paths) {
  const normalized = new Set(), folded = new Set();
  for (const path of paths.filter(isTestFile)) {
    let name;
    try { name = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(path); }
    catch { throw new Error('Input digest mismatch: undecodable test name; use local fallback'); }
    if (!Buffer.from(name).equals(path)) throw new Error('Input digest mismatch: undecodable test name; use local fallback');
    const nfc = name.normalize('NFC');
    // Upper then lower also detects expanding case pairs such as ß / SS.
    const fold = nfc.toUpperCase().toLowerCase().normalize('NFC');
    if (normalized.has(nfc) || folded.has(fold)) throw new Error('Input digest mismatch: test name collision; use local fallback');
    normalized.add(nfc); folded.add(fold);
  }
}
export function splitPaths(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || (bytes.length && bytes.at(-1) !== 0)) throw new Error('Invalid manifest inventory framing');
  const paths = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) {
    const path = bytes.subarray(start, i); pathParts(path); paths.push(path); start = i + 1;
  }
  return paths;
}
export const nulPaths = paths => Buffer.concat(paths.flatMap(path => [path, Buffer.from([0])]));
export const manifestWire = ({entries, excluded}) => ({
  paths:nulPaths(entries.map(entry => entry.path)).toString('base64'),
  hashes:entries.map(entry => entry.sha256),
  executable:entries.map(entry => entry.executable),
  excluded:nulPaths(excluded).toString('base64'),
});
export const digestManifest = manifest => sha(JSON.stringify(manifest));

// No-follow opens pin file identity while reading. Injected IO supports byte-path
// fixtures on filesystems which cannot create arbitrary Unix filenames.
export async function readManifestFile(path, st, fs = filesystem) {
  if (fs !== filesystem) return fs.readFile(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await fd.stat();
    if (!pinned.isFile() || pinned.ino !== st.ino || pinned.dev !== st.dev || pinned.mode !== st.mode)
      throw new Error('Manifest file swapped');
    return await fd.readFile();
  } finally {await fd.close();}
}

export async function verifyManifest(root, manifest, manifestDigest, {fs = filesystem} = {}) {
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'excluded,executable,hashes,paths'
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
  if (!Array.isArray(manifest.hashes) || !Array.isArray(manifest.executable)
    || manifest.hashes.length !== paths.length || manifest.executable.length !== paths.length
    || !manifest.hashes.every(hex) || !manifest.executable.every(v => typeof v === 'boolean')) throw new Error('Invalid manifest hashes or executable bits');
  validateTestNames(paths);
  const expected = new Map(paths.map((path, i) => [path.toString('hex'), {path, sha256:manifest.hashes[i], executable:manifest.executable[i]}]));
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
// A root supervisor is a subreaper: children which call setsid/double-fork are
// adopted here, and killed before the ops process publishes any evidence.
export const supervisorSource = String.raw`
import os, sys, json, signal, subprocess, ctypes
PR_SET_CHILD_SUBREAPER = 36
if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise RuntimeError('subreaper unavailable')
cfg = json.loads(sys.argv[1])
uid, gid = cfg['uid'], cfg['gid']
def drop():
    os.setsid()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    elif os.getuid() != uid or os.getgid() != gid:
        raise RuntimeError('cannot drop identity')
if 'archive' in cfg:
    # Only the fixed cache-extraction command receives an archive descriptor.
    # It runs as the worker; neither tar nor the task can write the cache.
    archive = os.open(cfg['archive'], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        child = subprocess.Popen(cfg['argv'], cwd=cfg['cwd'], env=cfg['env'], stdin=archive, preexec_fn=drop)
    finally: os.close(archive)
else:
    child = subprocess.Popen(cfg['argv'], cwd=cfg['cwd'], env=cfg['env'], stdin=subprocess.DEVNULL, preexec_fn=drop)
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
while True:
    for pid in children():
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    try: os.waitpid(-1, 0)
    except ChildProcessError: break
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
// testRoot/testPath/testCleanupExec are explicit dependency injection only. CLI never reads them
// from its environment, nor transports them in requests.
export function createRunner({testRoot, testPath, testCleanupExec} = {}) {
  const runs = testRoot ? join(testRoot,'runs') : '/srv/forge-exec';
  const receipts = testRoot ? join(testRoot,'receipts') : '/srv/forge-receipts';
  const cache = testRoot ? join(testRoot,'cache') : '/srv/forge-cache';
  const path = testRoot ? testPath : '/usr/local/bin:/usr/bin:/bin';
  const statePath = (run,phase) => join(receipts,run+'.'+phase);
  async function init() {
    if(testRoot) for(const dir of [runs,receipts,cache]) await mkdir(dir,{recursive:true,mode:0o700});
    for(const dir of [runs,receipts,cache]) await directory(dir,true);
  }
  async function state(request,phase) {
    await init();
    if(!runName(request.run) || !nonceOK(request.nonce)) throw new Error('Invalid run');
    const value=JSON.parse(await readPinned(statePath(request.run,phase)));
    if(value.nonce!==request.nonce || value.run!==request.run) throw new Error('State mismatch');
    return value;
  }
  async function workCommand(argv,work,env,archive) {
    if(testRoot) return execute(argv[0],archive ? ['-xf',archive] : argv.slice(1),{cwd:work,env,detached:true});
    const identity = await execute('/usr/bin/id',['-u','forge-exec']);
    const group = await execute('/usr/bin/id',['-g','forge-exec']);
    if(identity.code || group.code || !/^\d+\n$/.test(identity.stdout) || !/^\d+\n$/.test(group.stdout)) throw new Error('Unknown worker identity');
    const status=join(receipts,'supervisor-'+randomBytes(16).toString('hex'));
    try {
      const result=await execute('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-c',supervisorSource,JSON.stringify({argv,cwd:work,env,status,...(archive?{archive}:{}),uid:Number(identity.stdout),gid:Number(group.stdout)})],{inherit:true});
      if(result.code!==0) throw new Error('Supervisor failed');
      const code=Number((await readPinned(status)).toString());
      if(!Number.isInteger(code) || code<0 || code>255) throw new Error('Invalid supervisor status');
      return {...result,code};
    } finally {await rm(status,{force:true});}
  }
  async function exclusiveWorker(action) {
    // All work still shares one uid. Serialize across ALL profiles and runners,
    // before hashing input, until the supervisor has reaped every descendant.
    // An atomic directory persists across wrapper/supervisor death. Never age
    // it out: an orphan could still modify another run under the shared uid.
    const active=join(receipts,'worker-active');
    await mkdir(active,{mode:0o700}).catch(error=>{
      if(error.code==='EEXIST') throw new Error('Worker execution busy or interrupted; use local fallback. Operator must stop all forge-exec processes before removing /srv/forge-receipts/worker-active');
      throw error;
    });
    let settled=true;
    const command=async (...args)=>{
      settled=false;
      const result=await workCommand(...args);
      settled=true;
      return result;
    };
    try {return await action(command);}
    finally {if(settled) await rmdir(active);}
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
  return {
    async prepare({nonce,label}) {
      await init();
      if(!nonceOK(nonce) || (label!==undefined && (typeof label!=='string' || !/^[a-z0-9][a-z0-9-]{5,63}$/.test(label)))) throw new Error('Invalid prepare');
      const run='r-'+randomBytes(16).toString('hex');
      await mkdir(join(runs,run),{mode:0o755}); // exclusive server-generated name
      const work=join(runs,run,'work');
      await mkdir(work,{mode:0o755});
      if(!testRoot) {
        const result=await execute('/usr/bin/sudo',['-n','/usr/bin/chown','forge-exec:forge-exec',work]);
        if(result.code) throw new Error('Worker ownership failed');
      }
      await writeFile(statePath(run,'prepared'),JSON.stringify({v:1,nonce,run}),{flag:'wx',mode:0o600});
      return {run};
    },
    async run(request) {
      const prepared=await state(request,'prepared');
      if(!allowedCommand(request.argv) || !allowedEnv(request.env) || !hex(request.lock) || !hex(request.inputDigest)
        || request.argvDigest!==digestArgv(request.argv)) throw new Error('Invalid execution parameters');
      return exclusiveWorker(async command => {
      const container=join(runs,request.run),work=join(container,'work');
      await directory(container,true); await directory(work);
      // Preserve the dual-lock refusal before inspecting snapshot differences.
      const lock = await digestLock(work);
      // Verify before npm or cache extraction can add generated files.
      await verifyManifest(work,request.manifest,request.manifestDigest);
      if(await digestInput(work)!==request.inputDigest || lock!==request.lock) throw new Error('Input digest mismatch');
      await rename(statePath(request.run,'prepared'),statePath(request.run,'running'));
      let phase='install',result={code:97,stdout:'',stderr:''};
      // npm accepts some manifest changes without lock changes. Key the entire
      // validated snapshot, including workspace manifests and local dependency
      // contents, so a warm archive represents the same install inputs. Earlier
      // profiles lack this binding (v3 also allowed an unkeyed shrinkwrap).
      const profile=join(cache,request.lock,'dev-v5-'+request.inputDigest);
      const installEnv={PATH:path,HOME:join(work,'.forge-home'),LANG:'C',CI:'true',NODE_ENV:'development'};
      try {
        // These parents are inaccessible to forge-exec; reject symlinked cache state.
        await mkdir(join(cache,request.lock),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST') throw e;});
        await directory(join(cache,request.lock),true);
        await mkdir(profile,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST') throw e;});
        await directory(profile,true);
        const guard=await open(join(profile,'.lock'),constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,0o600);
        try {
          if(!(await guard.stat()).isFile()) throw new Error('Invalid cache lock; use local fallback');
          // flock belongs to the shared open file description. Python exits
          // after locking its inherited fd; our fd keeps the lock until close
          // or process death. Never unlink the lock file (that splits waiters).
          // Historical .busy directories are inert, including abandoned ones.
          const locked=await execute('/usr/bin/python3',['-I','-c','import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],{passFd:guard.fd});
          if(locked.code) throw new Error('Cache profile lock unavailable; use local fallback');
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
        phase='test';
        result=await command(request.argv,work,{PATH:path,HOME:join(work,'.forge-home'),...request.env});
      } catch(error) {const code=phase==='install'?97:254; if(phase==='test') phase='supervisor'; result={code,stdout:result.stdout,stderr:String(error.message)};}
      const receipt={...prepared,manifestDigest:request.manifestDigest,inputDigest:request.inputDigest,argvDigest:request.argvDigest,lock:request.lock,phase,code:result.code};
      await writeFile(statePath(request.run,'receipt'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
      return result;
      });
    },
    async finish(request) {
      // Only the protected state is evidence; receipt-like files in work are data.
      let phase='running';
      try {await state(request,phase);} catch {phase='prepared'; await state(request,phase);}
      let receipt;
      try {receipt=JSON.parse(await readPinned(statePath(request.run,'receipt')));} catch(e) {if(e.code!=='ENOENT') throw e;}
      const container=join(runs,request.run);
      await directory(container,true);
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
      return receipt??null;
    },
  };
}
if(process.argv[1] && await realpath(process.argv[1]).catch(()=> '') === await realpath(fileURLToPath(import.meta.url))) {
  try {
    if(process.argv.length!==3 || !['prepare','run','finish'].includes(process.argv[2])) throw new Error('Invalid subcommand');
    let input='';
    process.stdin.setEncoding('utf8');
    for await(const chunk of process.stdin) {input+=chunk; if(Buffer.byteLength(input)>LIMIT) throw new Error('Request limit exceeded');}
    const result=await createRunner()[process.argv[2]](JSON.parse(input));
    if(process.argv[2]==='run') process.exitCode=result.code;
    else process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {process.stderr.write('forge-exec-run: '+String(error.message).replace(/[\x00-\x1f\x7f]/g,' ')+'\n'); process.exitCode=254;}
}
