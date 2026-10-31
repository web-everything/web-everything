#!/usr/bin/env node
import '../lib/tools-root-guard.mjs';
import { spawn } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { constants, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, win32 } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allowedCommand, allowedEnv, digestInput, digestArgv, digestLock, isTestFile, validateTestNames, pathParts, bytePath, splitPaths, manifestWire, digestManifest, readManifestFile, SIBLING_PATHS, siblingShas, sameSiblingShas } from './forge-exec-run.mjs';

import {BASE_RETENTION} from './forge-exec-bases.mjs';

const ROOT = '/srv/forge-exec';
const LIMIT = 4 * 1024 * 1024;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
// @test-only-export-ok: exercise private-directory refusal without touching user state.
export function connectionOptions({directory=join(homedir(),'.forge-cm'),fs={mkdirSync,lstatSync}}={}) {
  try {
    // %C expands to 40 hex bytes. Keep below even the smaller Unix socket limit.
    if(Buffer.byteLength(join(directory,'x'.repeat(40)))>100)return [...SSH_OPTIONS];
    fs.mkdirSync(directory,{mode:0o700});
  } catch(error) {if(error.code!=='EEXIST')return [...SSH_OPTIONS];}
  try {
    const st=fs.lstatSync(directory);
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700||st.uid!==process.getuid())return [...SSH_OPTIONS];
    return [...SSH_OPTIONS,'-o','ControlMaster=auto','-o','ControlPersist=60s','-o',`ControlPath=${join(directory,'%C')}`];
  } catch {return [...SSH_OPTIONS];}
}
const noTiming=()=>()=>{};
// Substages accumulate repeated hashing calls without one timing record per file.
function substageTimer(clock) {
  const values=new Map();
  return {values,begin(stage) {
    const at=clock();
    return ()=>values.set(stage,(values.get(stage)??0)+Math.max(0,clock()-at));
  }};
}
async function timed(begin,stage,work) {
  const done=begin(stage);try{return await work();}finally{done();}
}
const ignoredInventory=(cwd,exec)=>exec({file:'git',args:['ls-files','-o','-i','--exclude-standard','-z'],cwd});
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const newRunId = () => `${new Date().toISOString().replace(/[^0-9tz]/gi, '').toLowerCase()}-${randomBytes(4).toString('hex')}`;

export function isAllowedCommand(argv) {
  // Only task arguments may follow the script name; npm options can skip or replace execution.
  return allowedCommand(argv);
}

export function filterEnv(env = {}) {
  if (Object.hasOwn(env, 'DIFF_COVERAGE_BASE') && !allowedEnv({DIFF_COVERAGE_BASE:env.DIFF_COVERAGE_BASE}))
    throw Object.assign(new Error('Invalid DIFF_COVERAGE_BASE: use local fallback'), {code:'invalid-diff-coverage-base'});
  return Object.fromEntries(Object.entries(env).filter(([key,value]) => allowedEnv({[key]:value})));
}

// Project only verified report bytes; the staged manifest is rehashed below.
function portableCoverage(bytes, cwd) {
  try {
    const report = JSON.parse(bytes.toString('utf8'));
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid report');
    const portable = Object.create(null);
    for (const [key, value] of Object.entries(report)) {
      const path = isAbsolute(key) ? relative(cwd, key) : key;
      if (win32.isAbsolute(key) && !isAbsolute(key) || !path || path === '..' || path.startsWith('../')
        || isAbsolute(path) || Object.hasOwn(portable, path)) throw new Error('Unsafe coverage path');
      portable[path] = value;
    }
    return Buffer.from(JSON.stringify(portable));
  } catch {
    throw Object.assign(new Error('Coverage report is not portable; use local fallback'), {code:'coverage-report-not-portable'});
  }
}

export function validateRunId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{5,63}$/.test(id);
}

// Captures have a hard byte limit; streamed command output is inherited verbatim.
// @test-only-export-ok: the capture boundary suite exercises this process adapter directly.
export function defaultExec({ file, args, cwd, input, inherit = false, sshOptions, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, file === 'ssh' ? [...(sshOptions??connectionOptions()), ...args] : args, {
      cwd, stdio: [input === undefined ? 'inherit' : 'pipe', inherit && !onOutput ? 'inherit' : 'pipe', inherit && !onOutput ? 'inherit' : 'pipe'],
    });
    const stdout = [];
    let bytes = 0;
    let exceeded = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        if (onOutput) onOutput(chunk, stream === child.stdout ? 'stdout' : 'stderr');
        if (inherit) {
          const output = stream === child.stdout ? process.stdout : process.stderr;
          if (!output.write(chunk)) { stream.pause(); output.once('drain',()=>stream.resume()); }
          return;
        }
        bytes += chunk.length;
        if (bytes > LIMIT) { exceeded = true; child.kill('SIGKILL'); return; }
        if (stream === child.stdout) stdout.push(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => exceeded ? reject(new Error('Captured output limit exceeded'))
      : resolve({ code: code ?? 1, stdout: Buffer.concat(stdout) }));
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // A failed SSH may close stdin before reading.
      child.stdin.end(input);
    }
  });
}

export { isTestFile };
// One outstanding request, bounded framing and a deadline keep a broken Git
// process from authorizing partial evidence or hanging delta admission.
export function createGitBlobReader({cwd, timeoutMs=10000}={}) {
  const child=spawn('git',['cat-file','--batch'],{cwd,stdio:['pipe','pipe','pipe']});
  let pending, buffer=Buffer.alloc(0), failure, closing=false, closed=false, stderrBytes=0;
  let resolveClosed;
  const completion=new Promise(resolve=>{resolveClosed=resolve;});
  function fail(reason) {
    failure ??= new Error(`Base blob ${reason}; use full ship`);
    if(pending){clearTimeout(pending.timer);const reject=pending.reject;pending=undefined;reject(failure);}
    buffer=Buffer.alloc(0);
    if(!closed)child.kill('SIGKILL');
    resolveClosed();
  }
  child.on('error',()=>{fail('process failed');closed=true;resolveClosed();});
  child.on('close',code=>{closed=true;if(pending||(!closing&&!failure)||code&&!failure)fail('process closed');resolveClosed();});
  child.stdin.on('error',()=>fail('request failed'));
  child.stdout.on('end',()=>{if(pending)fail('truncated');});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>LIMIT)fail('stderr limit exceeded');});
  child.stdout.on('data',chunk=>{
    if(failure)return;
    if(!pending){fail('unsolicited output');return;}
    if(buffer.length+chunk.length>LIMIT+161){fail('frame limit exceeded');return;}
    buffer=Buffer.concat([buffer,chunk]);
    if(pending.size===undefined) {
      const newline=buffer.indexOf(10);
      if(newline<0){if(buffer.length>160)fail('header too large');return;}
      const match=/^([a-f0-9]{40}(?:[a-f0-9]{24})?) blob (0|[1-9][0-9]*)$/.exec(buffer.subarray(0,newline).toString('latin1'));
      if(newline>160||!match||match[1]!==pending.oid||!Number.isSafeInteger(Number(match[2]))||Number(match[2])>LIMIT){fail('invalid header');return;}
      pending.size=Number(match[2]);buffer=buffer.subarray(newline+1);
    }
    if(buffer.length<pending.size+1)return;
    if(buffer.length!==pending.size+1||buffer[pending.size]!==10){fail('invalid terminator');return;}
    const content=Buffer.from(buffer.subarray(0,pending.size)),resolve=pending.resolve;
    clearTimeout(pending.timer);pending=undefined;buffer=Buffer.alloc(0);resolve(content);
  });
  return {
    read(oid) {
      if(failure||closing||closed||pending||typeof oid!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))
        return Promise.reject(failure??new Error('Invalid or overlapping blob request; use full ship'));
      return new Promise((resolve,reject)=>{
        pending={oid,resolve,reject,timer:setTimeout(()=>fail('deadline exceeded'),timeoutMs)};
        child.stdin.write(oid+'\n');
      });
    },
    async close() {
      if(!closing){closing=true;if(pending)fail('closed during request');else if(!failure&&!closed)child.stdin.end();}
      const timer=setTimeout(()=>fail('close deadline exceeded'),timeoutMs);
      try{await completion;if(failure)throw failure;}finally{clearTimeout(timer);}
    },
  };
}
import {classifyManifestPath, manifestEntry, decodeManifest, parseGitTree, parseGitStatus, nulPaths} from './forge-exec-manifest.mjs';

// Project the committed memory bridge into regular leaves. The wire protocol
// rejects symlinks, so neither rsync nor the worker ever follows a client link.
const MEMORY_LINK = '.claude/agent-memory';
const MEMORY_SOURCE = 'agent-memory-src/';
async function verifyMemoryLink(cwd, oid, fs) {
  const parent = await fs.lstat(join(cwd,'.claude'));
  const link = await fs.lstat(join(cwd,MEMORY_LINK));
  if (parent.isSymbolicLink() || !parent.isDirectory() || !link.isSymbolicLink()) throw new Error('Unsafe memory bridge');
  const target = await fs.readlink(join(cwd,MEMORY_LINK), {encoding:'buffer'});
  if (!oid || !target.equals(Buffer.from('../agent-memory-src'))
    || createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${target.length}\0`).update(target).digest('hex') !== oid)
    throw new Error('Unverified memory bridge; use local fallback');
}

export async function buildManifest({cwd = process.cwd(), exec = defaultExec, fs = filesystem, listFiles, trackedOnly = false, head, reuse, beginSub=noTiming} = {}) {
  if(head!==undefined&&!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))throw new Error('Invalid Git HEAD');
  // Build names are exempt only with evidence that Git ignores the whole directory.
  const ignored = await timed(beginSub,'ignored-file-listing',()=>ignoredInventory(cwd,exec));
  if (ignored.code !== 0 || !Buffer.isBuffer(ignored.stdout)) throw new Error('Ignored byte inventory unavailable');
  const ignoredPaths = splitPaths(ignored.stdout);
  const ignoredTests=ignoredPaths.filter(path=>isTestFile(path)
    && !pathParts(path).slice(0,-1).some(part=>['node_modules','.git'].includes(part.toString('latin1'))));
  const buildNames=new Set(['_site','dist','build','out','coverage','.next','.vite','.cache','storybook-static']);
  const candidates=new Map();
  for(const path of ignoredTests) {
    const parts=pathParts(path);
    for(let i=0;i<parts.length-1;i++)if(buildNames.has(parts[i].toString('latin1'))) {
      const dir=path.subarray(0,parts.slice(0,i+1).reduce((length,part)=>length+part.length+1,0)-1);
      candidates.set(dir.toString('hex'),dir);
    }
  }
  let ignoredDirs=[];
  if(candidates.size) {
    const result=await exec({file:'git',args:['check-ignore','--no-index','-z','--stdin'],cwd,input:nulPaths([...candidates.values()])});
    if(![0,1].includes(result.code))throw new Error('Ignored directory evidence unavailable');
    ignoredDirs=splitPaths(result.stdout);
    if(ignoredDirs.some(dir=>!candidates.has(dir.toString('hex'))))throw new Error('Invalid ignored directory evidence');
  }
  for(const path of ignoredTests) {
    if(ignoredDirs.some(dir=>path[dir.length]===47 && path.subarray(0,dir.length).equals(dir)))continue;
    throw Object.assign(new Error('Ignored test: use local fallback'), {code:'ignored-test-file'});
  }
  const walkDone=beginSub('inventory-walk');
  let files;
  if (listFiles) {
    const names = await listFiles(cwd);
    if (!Array.isArray(names) || names.some(name => !Buffer.isBuffer(name) && typeof name !== 'string')) throw new Error('Invalid inventory');
    files = names.map(name => Buffer.from(name));
  } else {
    const result = await exec({file:'git',args:['ls-files','-co','--exclude-standard','-z'],cwd});
    if (result.code !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('Byte inventory unavailable');
    files = splitPaths(result.stdout);
  }
  // Only this ignored coverage input is transportable; it uses the same leaf
  // safety checks and digests below as ordinary inventory entries.
  if (!trackedOnly) files.push(...ignoredPaths.filter(path => path.equals(Buffer.from('coverage/coverage-final.json'))));
  // Index evidence still rejects unsupported gitlinks, including injected inventories.
  const stage = await exec({file:'git',args:['ls-files','--stage','-z'],cwd});
  if (stage.code !== 0 || !Buffer.isBuffer(stage.stdout) || stage.stdout.length > LIMIT
    || (stage.stdout.length && stage.stdout.at(-1) !== 0)) throw new Error('Git index unavailable');
  const indexBlobs = new Map(), indexLinks = new Map();
  let start = 0;
  for (let i = 0; i < stage.stdout.length; i++) if (stage.stdout[i] === 0) {
    const record = stage.stdout.subarray(start,i), tab = record.indexOf(9);
    if (tab < 0 || !/^[0-7]{6} [a-f0-9]{40,64} [0-3]$/.test(record.subarray(0,tab).toString('latin1'))) throw new Error('Invalid git index record');
    pathParts(record.subarray(tab+1));
    // Gitlinks cannot be transported as directory leaves. Until recursive
    // submodule inventories are supported, use real local heavy admission.
    if (record.subarray(0,6).equals(Buffer.from('160000'))) throw new Error('gitlink-unsupported: use local fallback');
    const key = record.subarray(tab+1).toString('base64');
    const [, oid, indexStage] = record.subarray(0,tab).toString('ascii').split(' ');
    indexBlobs.set(key, indexStage === '0' && !indexBlobs.has(key) ? oid : null);
    if (record.subarray(0,6).equals(Buffer.from('120000'))) indexLinks.set(key,indexBlobs.get(key));
    start = i + 1;
  }
  const memoryKey = Buffer.from(MEMORY_LINK).toString('base64');
  const memoryOid = indexLinks.has(memoryKey) ? indexBlobs.get(memoryKey) : undefined;
  if (indexLinks.has(memoryKey)) {
    await verifyMemoryLink(cwd,memoryOid,fs);
    // An injected inventory cannot omit the tracked bridge or its target corpus.
    files.push(Buffer.from(MEMORY_LINK), ...[...indexBlobs.keys()].map(key=>Buffer.from(key,'base64'))
      .filter(path=>path.subarray(0,MEMORY_SOURCE.length).equals(Buffer.from(MEMORY_SOURCE))));
  }
  // Read public evidence once, only when a credential-named source needs it.
  // Missing, oversized, truncated or malformed evidence leaves the local fallback.
  let publicBlobs;
  async function publicBlob(key) {
    if (publicBlobs === undefined) {
      publicBlobs = new Map();
      try {
        const tree = await exec({file:'git',args:['ls-tree','-r','-z','origin/main'],cwd});
        if (tree.code !== 0 || !Buffer.isBuffer(tree.stdout) || tree.stdout.length > LIMIT
          || (tree.stdout.length && tree.stdout.at(-1) !== 0)) throw new Error('Public tree unavailable');
        let offset = 0;
        for (let i = 0; i < tree.stdout.length; i++) if (tree.stdout[i] === 0) {
          const record = tree.stdout.subarray(offset,i), tab = record.indexOf(9);
          const header = record.subarray(0,tab).toString('latin1');
          if (tab < 0 || !/^[0-7]{6} (?:blob|commit) [a-f0-9]{40,64}$/.test(header)) throw new Error('Invalid public tree');
          const path = record.subarray(tab+1);
          pathParts(path);
          const pathKey = path.toString('base64');
          if (publicBlobs.has(pathKey)) throw new Error('Duplicate public path');
          const [mode, type, oid] = header.split(' ');
          publicBlobs.set(pathKey, /^100(?:644|755)$/.test(mode) && type === 'blob' ? oid : null);
          offset = i + 1;
        }
      } catch { publicBlobs.clear(); }
    }
    return publicBlobs.get(key);
  }
  const excludedSource = () => Object.assign(new Error('Excluded source: use local fallback'), {code:'excluded-source-file'});
  files.sort(Buffer.compare);
  files = files.filter((path,i) => !i || !path.equals(files[i-1]));
  if (files.reduce((size,path) => size + path.length + 3,0) > LIMIT) throw new Error('Inventory limit exceeded; use local fallback');
  validateTestNames(files);
  const rootInfo = await fs.lstat(Buffer.from(cwd));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Invalid inventory root');
  const entries = [], excluded = [];
  let deletedWorktreePaths;
  for (const path of files) {
    if (memoryOid && path.equals(Buffer.from(MEMORY_LINK))) continue;
    const {parts,names,excluded:excludedByPolicy,credentialSource}=classifyManifestPath(path);
    let publicOid;
    if (credentialSource && !names.includes('node_modules')) {
      const key = path.toString('base64');
      const indexedOid = indexBlobs.get(key);
      publicOid = await publicBlob(key);
      if (!indexedOid || indexedOid !== publicOid) throw excludedSource();
    }
    if ((excludedByPolicy && !publicOid) || names.includes('node_modules')) {
      const excludedTest = isTestFile(path) || /\.(test|spec)\./.test(parts.at(-1).toString('latin1'));
      if (!names.includes('node_modules') && excludedByPolicy && excludedTest && /\.(?:mjs|js|ts|tsx|jsx|css|md|html)$/.test(names.at(-1))) {
        throw excludedSource();
      }
      if (excludedTest) throw new Error('Excluded test: use local fallback');
      excluded.push(path); continue;
    }
    if(!listFiles && !trackedOnly && indexBlobs.has(path.toString('base64'))) {
      const missing=await fs.lstat(bytePath(cwd,path)).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});
      if(missing) {
        if(!deletedWorktreePaths) {
          const deleted=await exec({file:'git',args:['diff','--no-ext-diff','--no-textconv','--name-status','-z','--no-renames',head??'HEAD','--'],cwd});
          if(deleted.code!==0)throw new Error('Missing deletion evidence');
          const fields=splitPaths(deleted.stdout);deletedWorktreePaths=new Set();
          for(let i=0;i<fields.length;i+=2) {
            if(!/^[ACDMTUXB]$/.test(fields[i].toString('ascii'))||!fields[i+1])throw new Error('Invalid deletion evidence');
            if(fields[i].equals(Buffer.from('D')))deletedWorktreePaths.add(fields[i+1].toString('hex'));
          }
        }
        if(!deletedWorktreePaths.has(path.toString('hex')))throw new Error('Missing inventory leaf');
        continue;
      }
    }
    let absolute = Buffer.from(cwd), st;
    for (const [i,part] of parts.entries()) {
      absolute = bytePath(absolute,part);
      st = await fs.lstat(absolute);
      if (st.isSymbolicLink() || (i === parts.length-1 ? !st.isFile() : !st.isDirectory())) throw new Error('Unsafe inventory component');
    }
    const previous=!trackedOnly && !credentialSource && reuse?.get(path.toString('hex'));
    const executable=!!(st.mode & 0o111), tracked=indexBlobs.has(path.toString('base64'));
    const stable=previous?.stat && ['dev','ino','size','mode','mtimeMs','ctimeMs'].every(key=>st[key]===previous.stat[key]);
    if(previous && stable && st.size===previous.size && executable===previous.executable) {
      entries.push({path,sha256:previous.sha256,executable,tracked});
      continue;
    }
    const hashDone=beginSub('hashing');
    const content = await readManifestFile(absolute,st,fs);
    if (publicOid || trackedOnly) {
      publicOid ??= indexBlobs.get(path.toString('base64'));
      if (!publicOid) throw new Error('Sibling index unavailable');
      // Index equality alone must not authorize private, unstaged working bytes.
      const oid = createHash(publicOid.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${content.length}\0`).update(content).digest('hex');
      if (oid !== publicOid) throw excludedSource();
    }
    entries.push(manifestEntry(path,content,!!(st.mode & 0o111),indexBlobs.has(path.toString('base64'))));
    hashDone();
  }
  walkDone(); // Includes hashing; the separate hashing counter identifies its share.
  if (memoryOid) {
    if ([...excluded,...ignoredPaths].some(path=>path.subarray(0,MEMORY_SOURCE.length).equals(Buffer.from(MEMORY_SOURCE))))
      throw new Error('Incomplete memory corpus; use local fallback');
    const targets = entries.filter(entry=>entry.path.subarray(0,MEMORY_SOURCE.length).equals(Buffer.from(MEMORY_SOURCE)));
    if (!targets.some(entry=>entry.path.equals(Buffer.from(MEMORY_SOURCE+'MEMORY.md')))) throw new Error('Missing memory index; use local fallback');
    for (const entry of targets) entries.push({...entry,
      path:Buffer.concat([Buffer.from(MEMORY_LINK+'/'),entry.path.subarray(MEMORY_SOURCE.length)]),
      tracked:false,sourcePath:entry.path,memoryOid});
    entries.sort((a,b)=>Buffer.compare(a.path,b.path));
    validateTestNames(entries.map(entry=>entry.path));
  }
  let siblings;
  if (!trackedOnly && entries.some(entry => entry.path.equals(Buffer.from('vitest.shared.ts')))) {
    try {
      const config = await fs.readFile(join(cwd,'vitest.shared.ts'),'utf8');
      if (createHash('sha256').update(config).digest('hex') !== entries.find(entry => entry.path.equals(Buffer.from('vitest.shared.ts'))).sha256)
        throw new Error('Config changed during inventory');
      const dependencies = [...config.matchAll(/["'`]((?:\.\.\/)[^"'`]+)["'`]/g)].map(match => match[1]);
      if (dependencies.some(path => !Object.values(SIBLING_PATHS).includes(path)))
        throw Object.assign(new Error('Unsupported sibling dependency'),{code:'unsupported-sibling-dependency'});
      const siblingRoot = resolve(cwd,'../frontierui');
      const checked = await checkSibling(siblingRoot,exec,fs);
      const result = await exec({file:'git',args:['ls-files','-z','--',...Object.values(SIBLING_PATHS).map(path => path.slice('../frontierui/'.length))],cwd:siblingRoot});
      if (result.code !== 0) throw new Error('Sibling inventory unavailable');
      const files = splitPaths(result.stdout);
      const prefixes = Object.values(SIBLING_PATHS).map(path => Buffer.from(path.slice('../frontierui/'.length)+'/'));
      if (files.some(path => !prefixes.some(prefix => path.subarray(0,prefix.length).equals(prefix)))) throw new Error('Unsupported sibling inventory');
      const snapshot = await buildManifest({cwd:siblingRoot,exec,fs,listFiles:async()=>files,trackedOnly:true});
      if (!sameSiblingEvidence(await checkSibling(siblingRoot,exec,fs),checked)) throw new Error('Sibling HEAD changed');
      siblings = {frontierui:{sha:checked.sha,roots:checked.roots,entries:snapshot.entries,excluded:snapshot.excluded}};
    } catch (error) {
      error.code = ['unsupported-sibling-dependency','excluded-source-file','ignored-test-file'].includes(error.code) ? error.code : 'sibling-inventory-failed';
      throw error;
    }
  }
  const manifest = {entries,excluded,...(siblings ? {siblings} : {})};
  const wire = manifestWire(manifest);
  if (Buffer.byteLength(JSON.stringify(wire)) > LIMIT - 16384) throw new Error('Manifest wire limit exceeded; use local fallback');
  return {...manifest,manifestDigest:digestManifest(wire)};
}

// Bound discovery work to at most four Git calls per advertised base. Missing
// ranking evidence retains advertised (newest-first) order as the safe tie-break.
export async function rankBases({cwd,exec=defaultExec,bases}={}) {
  if(!Array.isArray(bases)||bases.length>BASE_RETENTION)return [];
  if(bases.some(base=>!base||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base.sha)||!/^[a-f0-9]{64}$/.test(base.manifestDigest)))return [];
  const ranked=[];
  for(const [index,base] of bases.entries()) {
    try {
      if((await exec({file:'git',args:['cat-file','-e',base.sha+'^{commit}'],cwd})).code!==0)continue;
      const ancestor=(await exec({file:'git',args:['merge-base','--is-ancestor',base.sha,'HEAD'],cwd})).code===0;
      let distance=Infinity;
      try {
        const result=await exec({file:'git',args:ancestor?['rev-list','--count',base.sha+'..HEAD']:['diff','--name-only','-z',base.sha,'HEAD','--'],cwd});
        const bytes=ancestor?protocolText(result.stdout,128):result.stdout;
        if(!ancestor&&(!Buffer.isBuffer(bytes)||bytes.length>LIMIT))throw new Error('Base diff bound exceeded');
        if(result.code===0) {
          if(ancestor&&/^\d+\s*$/.test(bytes)&&Number.isSafeInteger(Number(bytes)))distance=Number(bytes);
          else if(!ancestor&&(bytes.length===0||bytes.at(-1)===0))distance=bytes.reduce((n,b)=>n+Number(b===0),0);
        }
      }catch { /* Unknown distance retains newest local order. */ }
      ranked.push({base,index,ancestor,distance});
    }catch { /* Unavailable local commit: try the remaining advertised bases. */ }
  }
  return ranked.sort((a,b)=>Number(b.ancestor)-Number(a.ancestor)||a.distance-b.distance||a.index-b.index).map(r=>r.base);
}
export async function selectBase(options={}) {return (await rankBases(options))[0]??null;}
const manifestFailure=error=>String(error?.message??error??'Base evidence unavailable').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,200)||'Base evidence unavailable';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function buildDeltaManifest({cwd,exec=defaultExec,fs=filesystem,base,head,beginSub=noTiming}={}) {
  if(!base || digestManifest(base.manifest)!==base.manifestDigest)throw new Error('Base manifest digest mismatch');
  const snapshot=decodeManifest(base.manifest);
  const git=async (args,input)=>{const result=await timed(beginSub,args[0]==='cat-file'?'base-blob-verification':'git-evidence',()=>exec({file:'git',args,cwd,...(input===undefined?{}:{input})}));if(result.code!==0||!Buffer.isBuffer(result.stdout)||result.stdout.length>LIMIT)throw new Error('Delta git evidence unavailable; use full ship');return result.stdout;};
  const baseEntries=new Map(snapshot.entries.map(entry=>[entry.path.toString('hex'),entry]));
  let blobs=new Map(),reuse,changed,manifestMode='full-scan',manifestReason;
  try {
    // Git cleanliness is byte evidence only with conservative stat checks and
    // no fsmonitor. Missing/invalid config evidence must also disable reuse.
    manifestReason='unsafe stat config or unavailable config evidence';
    const config=async args=>{
      const result=await timed(beginSub,'git-evidence',()=>exec({file:'git',args:['config',...args],cwd}));
      if(![0,1].includes(result.code)||!Buffer.isBuffer(result.stdout)||result.stdout.length>LIMIT
        ||(result.code===1?result.stdout.length:!result.stdout.length))throw new Error('Invalid Git stat config evidence');
      return result.code===1?undefined:result.stdout;
    };
    const settings=new Map();
    const records=(await config(['-z','--get-regexp','^core\\.(trustctime|checkstat|fsmonitor|untrackedcache|splitindex)$']))??Buffer.alloc(0);
    if(records.length&&records.at(-1)!==0)throw new Error('Incomplete Git stat config');
    for(const record of records.toString('utf8').split('\0').slice(0,-1)) {
      const newline=record.indexOf('\n'),key=newline<0?record:record.slice(0,newline);
      if(!/^core\.(trustctime|checkstat|fsmonitor|untrackedcache|splitindex)$/.test(key))throw new Error('Invalid Git stat config key');
      settings.set(key,newline<0?'':record.slice(newline+1));
    }
    // Let Git normalize boolean spellings (including bare keys and numbers);
    // core.trustctime defaults to true only when the key is absent.
    const trustctime=await config(['--type=bool','--get','core.trustctime']);
    if(trustctime!==undefined&&!['true\n','false\n'].includes(trustctime.toString()))throw new Error('Invalid Git trustctime');
    if(settings.has('core.trustctime')!==(trustctime!==undefined))throw new Error('Incomplete Git trustctime');
    if(trustctime?.toString()==='false\n'
      ||(settings.has('core.checkstat')&&settings.get('core.checkstat').toLowerCase()!=='default')
      ||(settings.has('core.fsmonitor')&&!/^(false|no|off|0)$/i.test(settings.get('core.fsmonitor'))))throw new Error('Unsafe Git stat config');
    manifestReason=undefined;
    if(typeof base.sha!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base.sha))throw new Error('invalid base sha');
    const tree=parseGitTree(await git(['ls-tree','-r','-l','-z',base.sha]),{sizes:true});
    blobs=new Map(tree.map(entry=>[entry.path.toString('hex'),entry]));
    // Capture metadata before Git evidence; a subsequent write invalidates reuse.
    const stats=new Map();
    await timed(beginSub,'lstat-pass',async()=>{
      let next=0;
      const workers=Array.from({length:Math.min(16,snapshot.entries.length)},async()=>{
        while(next<snapshot.entries.length) {
          const entry=snapshot.entries[next++];
          try {stats.set(entry.path.toString('hex'),await fs.lstat(bytePath(cwd,entry.path)));}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
      });
      // Drain all workers even on error; never start Git evidence with stats in flight.
      const results=await Promise.allSettled(workers);
      const failed=results.find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
    });
    // Status, flags and attributes remain after the entire capture barrier.
    // Speculating these reads before lstat could authorize stale clean evidence.
    changed=new Set([
      ...splitPaths(await git(['diff','--no-ext-diff','--no-textconv','--name-only','-z','--no-renames',base.sha,head??'HEAD','--'])),
      ...parseGitStatus(await git(['status','--porcelain=v1','-z','--untracked-files=all'])),
    ].map(path=>path.toString('hex')));
    // Filters/encodings and index flags can hide byte changes from status.
    // Such leaves need ordinary hashing, even if their normalized Git blob is clean.
    // -a lists only attributes that are set, keeping output small on large trees.
    const attributes=splitPaths(await git(['check-attr','-a','-z','--stdin'],nulPaths(snapshot.entries.map(entry=>entry.path))));
    if(attributes.length%3)throw new Error('Incomplete Git attributes');
    const sensitive=new Set(['filter','working-tree-encoding','ident','text','eol']);
    for(let i=0;i<attributes.length;i+=3) {
      // A driver may literally be named 'unset'/'set'; any listed attribute is treated as active.
      if(sensitive.has(attributes[i+1].toString('latin1')))changed.add(attributes[i].toString('hex'));
    }
    for(const record of splitPaths(await git(['ls-files','-f','-v','-z']))) {
      if(record.length<3||record[1]!==32)throw new Error('Invalid Git index flags');
      if(record[0]===83 || (record[0]>=97 && record[0]<=122))changed.add(record.subarray(2).toString('hex'));
    }
    reuse=new Map();
    const blobHashes=new Map();
    let reader;
    try {
      for(const entry of snapshot.entries) {
        const key=entry.path.toString('hex'),blob=blobs.get(key),stat=stats.get(key);
        if(changed.has(key) || !blob || !stat || blob.size!==stat.size || blob.size>LIMIT
          || classifyManifestPath(entry.path).credentialSource)continue;
        // Git cleanliness binds the worktree to the Git blob, not to arbitrary
        // warm snapshot bytes. Prove that the snapshot hash names those bytes.
        if(!blobHashes.has(blob.oid)) {
          if(exec===defaultExec)reader ??= createGitBlobReader({cwd});
          const content=reader ? await timed(beginSub,'base-blob-verification',()=>reader.read(blob.oid)) : await git(['cat-file','blob',blob.oid]);
          const oid=createHash(blob.oid.length===64?'sha256':'sha1')
            .update(`blob ${content.length}\0`).update(content).digest('hex');
          if(content.length!==blob.size || oid!==blob.oid)throw new Error('Invalid base blob evidence');
          blobHashes.set(blob.oid,createHash('sha256').update(content).digest('hex'));
        }
        if(blobHashes.get(blob.oid)!==entry.sha256)continue;
        reuse.set(key,{...entry,size:blob.size,stat});
      }
    } finally {await reader?.close();}
    manifestMode='git-delta';
  } catch {manifestReason ??='base or git evidence unavailable';reuse=undefined;}
  const manifest=await buildManifest({cwd,exec,fs,head,reuse,beginSub});
  if (manifest.entries.some(entry=>entry.sourcePath)) throw new Error('Projected memory inputs require full ship');
  // Transfer decisions still compare the complete manifest, including fresh modes.
  const final=new Set(manifest.entries.map(e=>e.path.toString('hex')));
  const deltaPaths=manifest.entries.filter(entry=>{
    const previous=baseEntries.get(entry.path.toString('hex'));
    return !previous || previous.sha256!==entry.sha256 || previous.executable!==entry.executable;
  }).map(e=>e.path).sort(Buffer.compare);
  const deletions=snapshot.entries.filter(e=>!final.has(e.path.toString('hex'))).map(e=>e.path);
  let deltaBytes=0;for(const path of deltaPaths)deltaBytes+=(await fs.lstat(bytePath(cwd,path))).size;
  return {...manifest,manifestMode,...(manifestReason?{manifestReason}:{}),changedCount:changed?.size??0,baseCount:snapshot.entries.length,deltaPaths,deletions,deltaBytes,baseSha:base.sha,baseManifestDigest:base.manifestDigest,baseBlobs:blobs};
}
// Reproduce the legacy length-prefixed input binding without staging base
// files: unchanged content is read from local Git objects, delta from staging.
async function digestDeltaInput(delta,stage,cwd,exec) {
  const reader=exec===defaultExec?createGitBlobReader({cwd}):null;
  const changed=new Set(delta.deltaPaths.map(p=>p.toString('hex'))),hash=createHash('sha256'),nodes=new Map();
  const field=data=>{const b=Buffer.from(data);hash.update(String(b.length)+':');hash.update(b);};
  for(const entry of delta.entries){nodes.set(entry.path.toString('hex'),entry);for(let i=0;i<entry.path.length;i++)if(entry.path[i]===47){const path=entry.path.subarray(0,i);nodes.set(path.toString('hex'),{path,directory:true});}}
  const directories=new Map();
  for(const entry of nodes.values()) {
    const slash=entry.path.lastIndexOf(47),parent=entry.path.subarray(0,slash<0?0:slash).toString('hex');
    if(!directories.has(parent))directories.set(parent,[]);
    directories.get(parent).push(entry);
  }
  const walk=async prefix=>{
    const children=(directories.get(prefix.toString('hex'))??[]).sort((a,b)=>Buffer.compare(a.path,b.path));
    for(const entry of children){field(entry.path);if(entry.directory){field('dir');await walk(entry.path);continue;}
      let content;
      if(changed.has(entry.path.toString('hex')))content=await filesystem.readFile(bytePath(stage,entry.path));
      else {const blob=delta.baseBlobs.get(entry.path.toString('hex'));if(reader)content=await reader.read(blob.oid);else {const result=await exec({file:'git',args:['cat-file','blob',blob.oid],cwd});if(result.code!==0||!Buffer.isBuffer(result.stdout)||result.stdout.length>LIMIT)throw new Error('Base blob unavailable; use full ship');content=result.stdout;}}
      if(createHash('sha256').update(content).digest('hex')!==entry.sha256)throw new Error('Base content differs from manifest');
      field('file');field(entry.executable?'73':'0');field(String(content.length));hash.update(content);
    }
  };
  try{await walk(Buffer.alloc(0));return hash.digest('hex');}finally{await reader?.close();}
}

// All sibling evidence is local Git evidence; never ask Forge to resolve a revision.
async function checkSibling(root, exec, fs) {
  const roots = [];
  for (const path of [root,...Object.values(SIBLING_PATHS).map(path => resolve(root,'..',path.slice(3)))]) {
    const info = await fs.lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe or missing sibling directory');
    roots.push({dev:info.dev,ino:info.ino});
  }
  const git = async args => {
    const result = await exec({file:'git',args,cwd:root});
    if (result.code !== 0) throw new Error('Sibling Git evidence unavailable');
    return protocolText(result.stdout,LIMIT);
  };
  if (await fs.realpath(root) !== (await git(['rev-parse','--show-toplevel'])).trim()) throw new Error('Unresolvable sibling worktree');
  const sha = (await git(['rev-parse','HEAD'])).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) throw new Error('Invalid sibling HEAD');
  if ((await git(['status','--porcelain=v1','-z','--untracked-files=normal'])).length) throw new Error('Dirty sibling worktree');
  return {sha,roots};
}
const sameSiblingEvidence = (actual, expected) => actual.sha === expected.sha && JSON.stringify(actual.roots) === JSON.stringify(expected.roots);

// Only protocol JSON is decoded, never inventory bytes.
function protocolText(stdout, limit) {
  if ((!Buffer.isBuffer(stdout) && typeof stdout !== 'string') || Buffer.byteLength(stdout) > limit) throw new Error('Invalid protocol output');
  if (Buffer.isBuffer(stdout)) {
    const text = stdout.toString('utf8');
    if (!Buffer.from(text).equals(stdout)) throw new Error('Invalid protocol UTF-8');
    return text;
  }
  return stdout;
}

export function easternTimestamp(ms) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(new Date(ms).getUTCMilliseconds()).padStart(3,'0')}${parts.timeZoneName.replace('GMT','')}`;
}
export async function runRemote(options={}) {
  const clock=options.clock??Date.now,timings=[],start=clock();
  const pending=new Map();
  const begin=stage=>{
    const at=clock(),item={stage,startedAtET:easternTimestamp(at),ms:0};
    timings.push(item);pending.set(item,at);
    return extra=>{pending.delete(item);Object.assign(item,{ms:Math.max(0,Math.round(clock()-at)),...extra});};
  };
  const result=await executeRemote({...options,clock,timings,begin});
  for(const [item,at] of pending)item.ms=Math.max(0,Math.round(clock()-at));
  timings.push({stage:'total',startedAtET:easternTimestamp(start),ms:Math.max(0,Math.round(clock()-start))});
  return {...result,timings};
}

async function executeRemote({ argv, cwd = process.cwd(), env = process.env, runId = newRunId(), host = 'forge', exec = defaultExec, listFiles, fs = filesystem, clock, timings, begin, disableDelta=false, sshOptions, log = text=>process.stderr.write(text) } = {}) {
  const fallback = (reason) => ({ mode: 'not-started', terminated: true, reason });
  if (!isAllowedCommand(argv)) return fallback('command-not-allowed');
  let executionEnv;
  try { executionEnv = filterEnv(env); } catch (error) { return fallback(error.code); }
  const needsGit=argv[2]==='check:standards'||Object.hasOwn(executionEnv,'DIFF_COVERAGE_BASE');
  if (!validateRunId(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return fallback('invalid-parameters');
  sshOptions ??= connectionOptions();
  const start=work=>Promise.resolve().then(work);
  const initial=await Promise.allSettled([
    start(()=>exec({file:'ssh',args:[host,'true'],cwd,sshOptions})),
    start(()=>needsGit?exec({file:'git',args:['rev-parse','HEAD'],cwd}):undefined),
    start(()=>disableDelta?undefined:exec({file:'ssh',args:[host,'sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs bases'],input:'{}',cwd,sshOptions})),
  ]);
  // All speculative children are drained and all rejections observed before fallback.
  if(initial[0].status==='rejected'||initial[0].value.code!==0)return fallback('forge-unreachable');
  const unwrap=result=>{if(result.status==='rejected')throw result.reason;return result.value;};
  const nonce = randomBytes(16).toString('hex');
  const tails = {stdout:'',stderr:''};
  let incompleteStandards = false;
  const observeStandards = (chunk, stream = 'stdout') => {
    const text = tails[stream] + String(chunk);
    if (/\bskipp(?:ing|ed)\b|\bno-scope\b|\bENOENT\b|no changed tier lines; nothing to attribute/i.test(text)) incompleteStandards = true;
    tails[stream] = text.slice(-128);
  };
  const ssh = (command, request, inherit = false) => exec({file:'ssh',
    args:[host, `sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs ${command}`],
    input:JSON.stringify(request), cwd, inherit, sshOptions,
    ...(command === 'run' && argv[2] === 'check:standards' ? {onOutput:observeStandards} : {})});
  let run;
  let staging;
  let finished = false;
  const finish = async () => {
    if (!run || finished) return null;
    finished = true;
    const done=begin('finish-receipt');
    try{return await ssh('finish', {nonce,run});}finally{done();}
  };
  try {
    let expected, expectedManifest, delta, transferBytes=0, transferCount=0;
    try {
      const manifestDone=begin('manifest-build');
      const substages=substageTimer(clock),beginSub=stage=>substages.begin(stage);
      let manifest, manifestReason='no usable warm base';
      let logicalHead;
      if(needsGit){
        const evidence=unwrap(initial[1]);
        logicalHead=protocolText(evidence.stdout,128).trim();
        if(evidence.code!==0||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(logicalHead))throw new Error('Missing Git evidence');
      }
      if (Object.hasOwn(executionEnv,'DIFF_COVERAGE_BASE')) {
        try {
          const evidence=await exec({file:'git',args:['rev-parse','--verify','--end-of-options',executionEnv.DIFF_COVERAGE_BASE+'^{commit}'],cwd});
          const sha=protocolText(evidence.stdout,128).trim();
          if(evidence.code!==0||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))throw new Error('Invalid coverage base SHA');
          executionEnv=filterEnv({...executionEnv,DIFF_COVERAGE_BASE:sha});
        } catch {throw Object.assign(new Error('Coverage base unavailable; use local fallback'),{code:'diff-coverage-base-unavailable'});}
      }
      // Discovery is read-only. Older separately installed wrappers reject this
      // subcommand; their full-ship path retains its existing admission order.
      try {
        if(disableDelta)throw new Error('Full ship selected');
        const discovery=unwrap(initial[2]);
        if(discovery.code!==0)throw new Error('No base capabilities');
        const caps=JSON.parse(protocolText(discovery.stdout,8192));
        if(caps.delta!==1)throw new Error('Delta unavailable');
        const candidates=await rankBases({cwd,exec,bases:caps.bases});
        if(!candidates.length)throw new Error('No local ready base');
        let selected,lastError;
        for(const base of candidates) {
          for(let attempt=0;attempt<2;attempt++) {
            try {
              const response=await ssh('base-manifest',{sha:base.sha});
              if(response.code!==0)throw new Error('Base manifest unavailable');
              const wire=JSON.parse(protocolText(response.stdout,LIMIT));
              if(digestManifest(wire)!==base.manifestDigest)throw new Error('Base manifest digest mismatch');
              decodeManifest(wire);
              selected={...base,manifest:wire};break;
            }catch(error){lastError=error;if(attempt===0)await delay(300);}
          }
          if(selected)break;
        }
        if(!selected)throw lastError;
        delta=await buildDeltaManifest({cwd,exec,fs,base:selected,head:logicalHead,beginSub});
        // Warm-leaf assembly recreates mtimes; coverage freshness needs full ship.
        if (delta.entries.some(entry => entry.path.equals(Buffer.from('coverage/coverage-final.json')))) throw new Error('Coverage inputs require full ship');
        manifest=delta;
        if(delta.manifestMode==='full-scan'){manifestReason=manifestFailure(delta.manifestReason);delta=undefined;}
      } catch(error) {manifestReason=manifestFailure(error);delta=undefined;}

      manifest ??= await buildManifest({cwd,exec,listFiles,fs,head:logicalHead,beginSub});
      log(`manifest: ${delta ? `git-delta (${delta.changedCount} changed of ${delta.baseCount})` : `full-scan (${manifestReason})`}\n`);
      manifestDone({...(!delta?{manifestReason}:{}),substages:[...substages.values].map(([stage,ms])=>({stage,ms:Math.round(ms)}))});
      const selected = (delta ? delta.deltaPaths : manifest.entries.map(entry => entry.path));
      const selectedKeys=new Set(selected.map(path=>path.toString('hex')));
      const stageDone=begin('mac-stage-and-rehash');
      let workStage;
      try {
        staging = await fs.mkdtemp(join(tmpdir(), 'forge-exec-stage-'));
        workStage = manifest.siblings ? join(staging,'work') : staging;
        const stageDirectory = async path => {
          const mode = path === staging ? 0o700 : 0o755;
          await fs.mkdir(path,{recursive:true,mode});
          await fs.chmod(path,mode);
          const st = await fs.lstat(path);
          if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o7777) !== mode)
            throw new Error('Invalid staging directory mode');
        };
        await stageDirectory(staging);
        const snapshots = [{source:cwd,destination:workStage,entries:manifest.entries.filter(entry=>selectedKeys.has(entry.path.toString('hex')))}];
        if (manifest.siblings) snapshots.push({source:resolve(cwd,'../frontierui'),destination:join(staging,'frontierui'),entries:manifest.siblings.frontierui.entries});
        for (const snapshot of snapshots) {
          await stageDirectory(snapshot.destination);
          const rootInfo = await fs.lstat(snapshot.source);
          if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Unsafe staging root');
          for (const entry of snapshot.entries) {
            const parts = pathParts(entry.path);
            let source = Buffer.from(snapshot.source), destination = Buffer.from(snapshot.destination);
            if (entry.sourcePath) await verifyMemoryLink(snapshot.source,entry.memoryOid,fs);
            const sourceParts = pathParts(entry.sourcePath ?? entry.path);
            for (const [i, part] of sourceParts.entries()) {
              source = bytePath(source, part);
              const st = await fs.lstat(source);
              if (st.isSymbolicLink() || (i === sourceParts.length - 1 ? !st.isFile() : !st.isDirectory())) throw new Error('Unsafe staging source');
            }
            for (const [i, part] of parts.entries()) {
              destination = bytePath(destination, part);
              if (i < parts.length - 1) await stageDirectory(destination);
            }
            // Pin the leaf and reject special files before reading; NONBLOCK also
            // prevents a raced-in FIFO from hanging admission before fstat.
            const fd = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
            try {
              const st = await fd.stat();
              if (!st.isFile() || !!(st.mode & 0o111) !== entry.executable) throw new Error('Invalid staging source');
              const mode = entry.executable ? 0o755 : 0o644;
              await fs.writeFile(destination, await fd.readFile(), {flag:'wx', mode});
              await fs.chmod(destination, mode);
              await fs.utimes(destination, st.atime, st.mtime);
              const staged = await fs.lstat(destination);
              if (!staged.isFile() || staged.isSymbolicLink() || (staged.mode & 0o7777) !== mode)
                throw new Error('Invalid staging file mode');
            } finally {await fd.close();}
            // Node has no openat: an ancestor can race the leaf open. Re-hashing
            // every staged byte against the verified public-content manifest
            // confines swaps to identical bytes or not-started, before any rsync.
            const stagedContent=await fs.readFile(destination);
            transferBytes+=stagedContent.length;transferCount++;
            const hash = createHash('sha256').update(stagedContent).digest('hex');
            if (hash !== entry.sha256) throw new Error('Staged bytes differ from manifest');
            if (snapshot.source === cwd && entry.path.equals(Buffer.from('coverage/coverage-final.json'))) {
              const portable=portableCoverage(stagedContent,cwd);
              const stamp=await fs.lstat(destination);
              await fs.writeFile(destination,portable);
              await fs.utimes(destination,stamp.atime,stamp.mtime);
              transferBytes+=portable.length-stagedContent.length;
              entry.sha256=createHash('sha256').update(portable).digest('hex');
            }
          }
          const after = await fs.lstat(snapshot.source);
          if (after.isSymbolicLink() || after.ino !== rootInfo.ino || after.dev !== rootInfo.dev) throw new Error('Staging root swapped');
        }
        if (manifest.siblings && !sameSiblingEvidence(await checkSibling(resolve(cwd,'../frontierui'),exec,fs),manifest.siblings.frontierui))
          throw new Error('Sibling HEAD changed');
      } catch(error) {
        if(error.code==='coverage-report-not-portable')throw error;
        if(delta)throw error;
        return {mode:'not-started', terminated:true, reason:'snapshot-staging-failed'};
      }
      // Anchor comment-like and option-like names for both rsync implementations.
      const inventory = Buffer.concat(selected.flatMap(path => [Buffer.from('./'),path,Buffer.from([0])]));
      if(needsGit){
        const current=await exec({file:'git',args:['rev-parse','HEAD'],cwd});
        if(current.code!==0||protocolText(current.stdout,128).trim()!==logicalHead)throw new Error('Git HEAD changed during snapshot; use local fallback');
      }
      const wire = {...manifestWire(manifest),...(needsGit?{git:{head:logicalHead,...(executionEnv.DIFF_COVERAGE_BASE?{diffCoverageBase:executionEnv.DIFF_COVERAGE_BASE}:{})}}:{})};
      const wireDigest=digestManifest(wire);
      // Preserve local lockfile-precedence admission even when an injected
      // inventory omits shrinkwrap; only the staged digest is transmitted.
      await digestLock(cwd);
      const lock = delta ? await digestLock(cwd) : await digestLock(workStage);
      // Reject incomplete or linked input before transmitting any file bytes.
      const inputDigest = delta ? await digestDeltaInput(delta,workStage,cwd,exec) : await digestInput(workStage, selected);
      stageDone();
      const prepareDone=begin('forge-prepare');
      const prepared = await ssh('prepare',{nonce,label:runId,...(delta ? {baseSha:delta.baseSha,baseManifestDigest:delta.baseManifestDigest}:{}),...(manifest.siblings ? {siblings:true} : {})});
      prepareDone();
      if(prepared.code !== 0) {
        // Prepare precedes every byte transfer and cannot have started work.
        try {if(protocolText(prepared.stdout,4096).trim()===JSON.stringify({reason:'forge-busy'}))return {mode:'not-started',terminated:true,reason:'forge-busy'};}catch { /* malformed prepare stays a safe pre-transfer failure */ }
        throw new Error('Prepare failed');
      }
      const preparation = JSON.parse(protocolText(prepared.stdout,4096));
      run = preparation.run;
      if(typeof run !== 'string' || !/^r-[a-f0-9]{32}$/.test(run)) {run=undefined; throw new Error('Invalid server run');}
      const slot=preparation.slot??'forge-exec';
      if(slot!=='forge-exec'&&(!/^forge-exec-[1-9]\d*$/.test(slot)||!Array.isArray(preparation.capabilities?.workers)||!preparation.capabilities.workers.includes(slot)))throw new Error('Invalid server slot');
      const runRoot=slot==='forge-exec'?ROOT:ROOT+'/'+slot.replace('forge-exec-','slot-');
      if(needsGit&&preparation.capabilities?.gitWorktree!==2)return {mode:'not-started',terminated:true,reason:'forge-runner-too-old'};
      // forge-exec-run.mjs is separately installed by forge-setup.sh. Redeploy
      // that fixed wrapper before siblings can run; old runners stay local.
      if (manifest.siblings && preparation.capabilities?.siblings !== 1)
        return {mode:'not-started',terminated:true,reason:'forge-runner-too-old'};
      if (!(argv[0] === 'npm' && argv[2] === 'test:unit') && preparation.capabilities?.commandClasses !== 1)
        return {mode:'not-started',terminated:true,reason:'forge-runner-too-old'};
      if(delta && (preparation.capabilities?.delta!==1 || !preparation.capabilities.bases?.some(base=>base.sha===delta.baseSha && base.manifestDigest===delta.baseManifestDigest)))throw new Error('Base changed during prepare');
      const rsyncDone=begin('rsync');
      // Transfer only staged leaves, retaining non-recursive rsync safeguards.
      // prepare creates a fresh work tree; deletion is unnecessary and requires
      // directory transfer on older rsync implementations. Normalize directory
      // attributes (including './') so the private 0700 staging root cannot
      // close the pre-created Forge work directory to the ops runner. Staging
      // already normalizes every mode; additive directory access avoids Apple
      // openrsync's '=' parser corrupting file permission masks.
      const copied = await exec({file:'rsync',args:['-a','--chmod=Da+rx','--no-recursive','--no-dirs','--no-links','--safe-links','--exclude=.exit-code',
        '--from0','--files-from=-',`--rsync-path=sudo -u ${slot} rsync`,'-e',`ssh ${sshOptions.map(quote).join(' ')}`,
        './',`${host}:${runRoot}/${run}/work/`],cwd:workStage,input:inventory});
      if(copied.code !== 0) throw new Error('Copy failed');
      if (manifest.siblings) {
        const inventory = Buffer.concat(manifest.siblings.frontierui.entries.flatMap(entry => [Buffer.from('./'),entry.path,Buffer.from([0])]));
        const siblingsCopied = await exec({file:'rsync',args:['-a','--chmod=Da+rx','--no-recursive','--no-dirs','--no-links','--safe-links','--exclude=.exit-code',
          '--from0','--files-from=-',`--rsync-path=sudo -u ${slot} rsync`,'-e',`ssh ${sshOptions.map(quote).join(' ')}`,
          './',`${host}:${runRoot}/${run}/frontierui/`],cwd:join(staging,'frontierui'),input:inventory});
        if (siblingsCopied.code !== 0) throw new Error('Sibling copy failed');
      }
      rsyncDone({shipMode:delta?'delta':'full',fileCount:transferCount,bytesSent:transferBytes,deltaFileCount:delta?selected.length:0,deltaBytes:delta?delta.deltaBytes:0});
      expected = {v:1,nonce,run,inputDigest,argvDigest:digestArgv(argv),lock,manifestDigest:wireDigest,...(manifest.siblings ? {siblingShas:siblingShas(wire)} : {})};
      expectedManifest = wire;
    } catch (error) {
      if(delta) {
        await finish();
        if(staging){await fs.rm(staging,{recursive:true,force:true});staging=undefined;}
        return executeRemote({argv,cwd,env,runId,host,exec,listFiles,fs,clock,timings,begin,disableDelta:true,sshOptions,log});
      }
      if (error.code === 'sibling-inventory-failed') return {mode:'not-started',terminated:true,reason:error.code};
      if (error.code === 'unsupported-sibling-dependency') return fallback(error.code);
      if (['coverage-report-not-portable','diff-coverage-base-unavailable'].includes(error.code)) return fallback(error.code);
      if (error.code === 'excluded-source-file') return {mode:'not-started', terminated:true, reason:error.code};
      return fallback(error.code === 'ignored-test-file' ? 'ignored-test-file' : 'copy-failed');
    }
    try {
      const runAt=clock(),runDone=begin('forge-run');
      let result;
      try {
        result = await ssh('run',{...expected,manifest:expectedManifest,argv,env:executionEnv,...(delta ? {baseSha:delta.baseSha,baseManifestDigest:delta.baseManifestDigest,deletions:nulPaths(delta.deletions).toString('base64')}: {})},true);
      } catch { /* Only a protected finish response can resolve lost run output. */ }
      finally {runDone();}
      const receipt = await finish();
      if(!receipt || receipt.code!==0) return {mode:'unconfirmed',reason:'ambiguous-result'};
      const text = protocolText(receipt.stdout,4096);
      const reply = JSON.parse(text);
      // Only the fixed wrapper's protected prepared state can certify no execution.
      if (reply && (Object.keys(reply).sort().join(',') === 'nonce,phase,reason,run,siblings,started,v' || (delta && reply.delta===true && Object.keys(reply).sort().join(',') === 'delta,nonce,phase,reason,run,siblings,started,v'))
        && reply.v === 1 && reply.nonce === nonce && reply.run === run
        && reply.phase === 'rejected' && ['snapshot-rejected','forge-busy','git-head-unavailable','diff-coverage-base-unavailable'].includes(reply.reason)
        && (!['git-head-unavailable','diff-coverage-base-unavailable'].includes(reply.reason)||needsGit)
        && (reply.reason === 'forge-busy' || (needsGit && ['git-head-unavailable','diff-coverage-base-unavailable'].includes(reply.reason) && reply.siblings===!!expectedManifest.siblings) || reply.siblings === true || (delta && reply.delta===true && reply.siblings===!!expectedManifest.siblings)) && reply.started === false)
      {
        if(reply.reason === 'forge-busy')return {mode:'not-started',terminated:true,reason:'forge-busy'};
        if(needsGit&&reply.reason==='git-head-unavailable')return {mode:'not-started',terminated:true,reason:'git-head-unavailable'};
        if(needsGit&&reply.reason==='diff-coverage-base-unavailable')return {mode:'not-started',terminated:true,reason:reply.reason};
        if(delta && reply.delta===true) {
          // finish consumed protected prepared state and proved started=false.
          // A fresh full prepare is safe once; disableDelta bounds the retry.
          if(staging){await fs.rm(staging,{recursive:true,force:true});staging=undefined;}
          const retried=await executeRemote({argv,cwd,env,runId,host,exec,listFiles,fs,clock,timings,begin,disableDelta:true,sshOptions,log});
          for(const timing of timings)if(timing.stage==='rsync')timing.shipMode='delta-then-full';
          return retried;
        }
        return {mode:'not-started',terminated:true,reason:'forge-rejected:'+reply.reason};
      }
      if(!result || !verifyReceipt(text,expected,result.code)) return {mode:'unconfirmed',reason:'ambiguous-result'};
      if (argv[2] === 'check:standards') {
        observeStandards(result.stdout ?? '', 'stdout');
        observeStandards(result.stderr ?? '', 'stderr');
        // Only a matching protected receipt proves it is safe to rerun locally.
        if (incompleteStandards) return {mode:'cancelled',terminated:true,code:1,reason:'incomplete-standards-inputs'};
      }
      if(reply.timings) {
        timings.splice(timings.findLastIndex(t=>t.stage==='forge-run'),1);
        const index=timings.findLastIndex(t=>t.stage==='finish-receipt');
        timings.splice(index,0,{stage:'forge-install',startedAtET:easternTimestamp(runAt),ms:reply.timings.installMs},{stage:'forge-run',startedAtET:easternTimestamp(runAt+reply.timings.installMs),ms:reply.timings.runMs});
      }
      return {mode:'remote',code:result.code};
    } catch {return {mode:'unconfirmed',reason:'ambiguous-result'};}
  } finally {
    try {await finish();} catch { /* Pruning is the cleanup backstop; never retry execution. */ }
    finally {if (staging) await fs.rm(staging, {recursive:true, force:true});}
  }
}

export function verifyReceipt(text, expected, code) {
  try {
    const receipt=JSON.parse(text);
    return receipt && typeof expected?.manifestDigest === 'string' && /^[a-f0-9]{64}$/.test(expected.manifestDigest)
      && Object.keys(receipt).filter(key=>key!=='timings'&&key!=='resources').sort().join(',') === (expected.siblingShas ? 'argvDigest,code,inputDigest,lock,manifestDigest,nonce,phase,run,siblingShas,v' : 'argvDigest,code,inputDigest,lock,manifestDigest,nonce,phase,run,v')
      && (!Object.hasOwn(receipt,'resources') || (receipt.resources && !Array.isArray(receipt.resources)
        && Object.keys(receipt.resources).sort().join(',')==='cpuUsec,memoryPeakBytes,oomKills,slotCpus'
        && ['cpuUsec','memoryPeakBytes','oomKills'].every(key=>receipt.resources[key]===null || Number.isSafeInteger(receipt.resources[key])&&receipt.resources[key]>=0)
        && Number.isSafeInteger(receipt.resources.slotCpus)&&receipt.resources.slotCpus>=1))
      && (!Object.hasOwn(receipt,'timings') || (!!receipt.timings && Object.keys(receipt.timings).sort().join(',')==='installMs,runMs' && [receipt.timings.installMs,receipt.timings.runMs].every(ms=>Number.isSafeInteger(ms)&&ms>=0)))
      && Object.entries(expected).every(([key,value])=>key === 'siblingShas' ? sameSiblingShas(receipt[key],value) : receipt[key]===value)
      && receipt.phase==='test' && Number.isInteger(code) && code>=0 && code<255 && receipt.code===code;
  } catch {return false;}
}

/** Explicit remote CLI request; the shared decision contract owns safe local admission. */
export async function main(options = {}) {
  if (!isAllowedCommand(options.argv)) throw new Error('command-not-allowed: use npm run <allowed-task> -- <task-args>');
  // Import at invocation time: heavy-admission's default executor imports us.
  const { runWithRemoteDecision, loadAdmissionPolicy, adaptLegacyRemoteResult } = await import('./heavy-admission.mjs');
  const loaded = loadAdmissionPolicy({env:options.env,checkoutRoot:options.cwd});
  const policy = {...loaded,settings:{...loaded.settings,remote:{...loaded.settings.remote,enabled:true,mode:'always'}},sources:{...loaded.sources}};
  policy.sources['remote.enabled'] = 'explicit remote CLI request';
  policy.sources['remote.mode'] = 'explicit remote CLI request';
  let capturedTimings;
  const remoteExecutor=options.remoteExec ?? (async decisionOptions=>adaptLegacyRemoteResult(await runRemote({...options,...decisionOptions})));
  const result = await runWithRemoteDecision({
    argv:options.argv, cwd:options.cwd, env:options.env, policy,
    timeoutMs:options.timeoutMs, log:options.log,
    host:options.host, readTelemetry:options.readTelemetry, lockRoot:options.lockRoot, clock:options.clock,
    remoteExec:async decisionOptions=>{const value=await remoteExecutor(decisionOptions);capturedTimings=value?.timings;return value;},
  });
  if(capturedTimings?.length)(options.stderr??(text=>process.stderr.write(text)))(['forge stages (Eastern) | ms | transfer',...capturedTimings.map(t=>`${t.stage} ${t.startedAtET} | ${t.ms}${t.shipMode ? ` | ${t.shipMode} ${t.fileCount} files ${t.bytesSent} bytes`:''}${t.substages?.length ? `\n${t.substages.map(s=>`  ${s.stage} | ${s.ms}`).join('\n')}`:''}`)].join('\n')+'\n');
  if (result.handled) return result.exitCode;
  const local = options.local ?? (async (argv) => (await defaultExec({ file: process.execPath,
    args: ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=600000', '--', ...argv], cwd: options.cwd, inherit: true })).code);
  return local(options.argv);
}

export function parseArgs(args) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new Error('Usage: remote-exec.mjs [--host=forge] [--run-id=<id>] -- <command...>');
  const options = { host: 'forge', runId: newRunId(), argv: args.slice(separator + 1) };
  for (const arg of args.slice(0, separator)) {
    if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg.startsWith('--run-id=')) options.runId = arg.slice(9);
    else throw new Error('Unknown remote-exec option');
  }
  if (!validateRunId(options.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.host)) throw new Error('Invalid host or run id');
  return options;
}

const cliPath = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (process.argv[1] && cliPath === realpathSync(fileURLToPath(import.meta.url))) {
  (async () => {
  try { process.exitCode = await main(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`remote-exec: ${error.message}\n`); process.exitCode = 1; }
  })();
}
