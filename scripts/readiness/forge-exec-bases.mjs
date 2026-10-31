import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {pathParts,bytePath,decodeManifest,digestManifest} from './forge-exec-manifest.mjs';
const revision=sha=>typeof sha==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha);
export const BASE_RETENTION=12;
export const PUBLIC_REPOSITORY='https://github.com/chalbert/web-everything.git';
export const anonymousGitEnv=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',
  GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0'});
const stderrTail=value=>String(value??'').replace(/[\x00-\x1f\x7f-\x9f]/g,'').slice(-300);
function gitExec({file='git',args,cwd,env,input}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd,env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    const chunks=[];let size=0,overflow=false,stderr='';
    const timer=setTimeout(()=>{overflow=true;child.kill('SIGKILL');},120000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
      size+=chunk.length;if(size>4*1024*1024){overflow=true;child.kill('SIGKILL');}
      else if(stream===child.stdout)chunks.push(chunk);
      if(stream===child.stderr)stderr=(stderr+chunk.toString('utf8')).slice(-600);
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);overflow?reject(Object.assign(new Error('Git bound exceeded; use local fallback'),{stderr})):resolve({code,stdout:Buffer.concat(chunks).toString('utf8'),stderr});});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
  });
}
// Trusted wrapper only: never clone client remotes/configuration or fetch a
// client-supplied URL. The warm mirror is only an object cache: public origin
// must supply both current main and the exact, manifest-bound Mac HEAD.
export async function materializeWorktree({work,root,baseSha,head,manifest,manifestDigest,exec=gitExec}) {
  if(!revision(head)||manifest?.git?.head!==head||baseSha!==undefined&&!revision(baseSha)||digestManifest(manifest)!==manifestDigest)throw new Error('Invalid Git evidence');
  const {siblings,git:logical,...primary}=manifest;
  if(logical.diffCoverageBase!==undefined&&!revision(logical.diffCoverageBase))throw new Error('Invalid coverage base SHA');
  for(const entry of decodeManifest(primary).entries) {
    let leaf=Buffer.from(work);
    for(const part of pathParts(entry.path)){leaf=bytePath(leaf,part);if((await fs.lstat(leaf)).isSymbolicLink())throw new Error('Unsafe Git snapshot');}
    const bytes=await baseFile(leaf);
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Git snapshot digest mismatch');
  }
  await baseDirectory(root);
  const pending=await fs.mkdtemp(join(root,'.git-run-'));
  const cloned=join(pending,'clone');
  const env=anonymousGitEnv();
  const git=async(args,cwd=cloned,input,allowMissing=false)=>{
    try {
      const result=await exec({file:'git',args:['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
        '-c','protocol.ext.allow=never','-c','http.followRedirects=false',
        '-c','safe.directory='+join(root,'repo.git'),'-c','safe.directory='+cloned,...args],cwd,env,input});
      if(result.code!==0){if(allowMissing)return null;throw Object.assign(new Error('Anonymous Git unavailable; use local fallback'),{stderr:result.stderr});}
      return result.stdout.toString().trim();
    } catch(error) {
      throw new Error(`${args[0]}: ${stderrTail(error.stderr??error.message)}`,{cause:error});
    }
  };
  try {
    const mirror=join(root,'repo.git');
    const local=await fs.lstat(mirror).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;});
    if(local) {
      await baseDirectory(mirror);
      // upload-pack does not inherit command-line -c settings. Its protected
      // global config must explicitly trust only this mirror and run's clone.
      const config=join(pending,'gitconfig');
      const quote=value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\t/g,'\\t').replace(/\r/g,'\\r')+'"';
      await fs.writeFile(config,`[safe]\n\tdirectory = ${quote(mirror)}\n\tdirectory = ${quote(cloned)}\n`,{flag:'wx',mode:0o600});
      env.GIT_CONFIG_GLOBAL=config;
    }
    await fs.mkdir(cloned);
    // Mirror cloning works even with the warmer's unborn bare HEAD and copies
    // no client configuration. A cached object never proves public availability.
    await git(['clone','--no-local','--no-hardlinks','--mirror','--template=',local?mirror:PUBLIC_REPOSITORY,join(cloned,'.git')],root);
    await git(['config','core.bare','false'],cloned);
    await git(['config','remote.origin.mirror','false'],cloned);
    await git(['config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*'],cloned);
    await git(['remote','set-url','origin',PUBLIC_REPOSITORY],cloned);
    await git(['fetch','--no-tags','--no-write-fetch-head','origin',
      '+refs/heads/main:refs/remotes/origin/main',head],cloned);
    await git(['rev-parse','--verify','refs/remotes/origin/main^{commit}'],cloned);
    await git(['cat-file','-e',head+'^{commit}'],cloned);
    if(logical.diffCoverageBase!==undefined
      && await git(['merge-base','--is-ancestor',logical.diffCoverageBase,head],cloned,undefined,true)===null
      && await git(['merge-base','--is-ancestor',logical.diffCoverageBase,'refs/remotes/origin/main'],cloned,undefined,true)===null)
      throw Object.assign(new Error('Coverage base unavailable; use local fallback'),{code:'diff-coverage-base-unavailable'});
    // Detach without checking files out over the verified Mac snapshot.
    await git(['update-ref','--no-deref','HEAD',head],cloned);
    if(await git(['rev-parse','--verify','HEAD'],cloned)!==head)throw new Error('Git HEAD mismatch; use local fallback');
    // Finish every privileged Git command behind the operator-owned 0700
    // parent. A surviving worker can replace anything beneath work, including
    // a root-owned .git directory, and Git config can execute commands.
    await git(['read-tree','--empty']);
    const index=[];
    for(const entry of decodeManifest(primary).entries) {
      const content=await baseFile(bytePath(work,entry.path));
      if(createHash('sha256').update(content).digest('hex')!==entry.sha256)throw new Error('Git snapshot changed');
      if(!entry.tracked)continue;
      // Plumbing bypasses .gitattributes clean filters and newline conversion:
      // stage exact Mac bytes, including opaque filenames. The empty index also
      // stages deletions of HEAD paths absent from the tracked Mac snapshot.
      const oid=await git(['hash-object','-w','--stdin'],cloned,content);
      index.push(Buffer.from(`${entry.executable?'100755':'100644'} ${oid}\t`),entry.path,Buffer.from([0]));
    }
    await git(['update-index','-z','--index-info'],cloned,Buffer.concat(index));
    // HEAD-based gates see exactly the working delta from the Mac's HEAD.
    // Warm-base ancestry never changes this scope; no snapshot commit is made.
    // Publication is the final operation: no privileged Git may follow it.
    await fs.rename(join(cloned,'.git'),join(work,'.git'));
  } catch(error) {
    if(error.code==='diff-coverage-base-unavailable')throw error;
    throw Object.assign(new Error('Git HEAD unavailable; use local fallback: '+error.message,{cause:error}),{code:'git-head-unavailable'});
  } finally {await fs.rm(pending,{recursive:true,force:true});}
}
function validReady(ready,sha) {
  return ready && ready.sha===sha
    && ['manifestDigest','lockDigest'].every(k=>typeof ready[k]==='string'&&/^[a-f0-9]{64}$/.test(ready[k]))
    && ['readyAtMs','fetchedAtMs'].every(k=>Number.isSafeInteger(ready[k])&&ready[k]>=0);
}
export async function baseFile(path,io=fs) {
  const handle=await io.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const st=await handle.stat();if(!st.isFile()||st.size>4*1024*1024)throw new Error('Invalid base metadata');return await handle.readFile();}finally{await handle.close();}
}
export async function baseDirectory(path,io=fs) {
  const st=await io.lstat(path);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022))throw new Error('Unsafe base directory');
}
export async function baseGuard(root,action,io=fs,{clock=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  kill=(pid,signal)=>process.kill(pid,signal),waitMs=5000,retryMs=25,maxAgeMs=86400000}={}) {
  await baseDirectory(root,io);
  const guard=join(root,'.guard'),deadline=clock()+waitMs,token=randomBytes(16).toString('hex');
  const ownerName='owner-'+token,pending=join(root,'.guard-pending-'+token);
  const bounded=()=>new Error('Base guard wait exceeded; use local fallback and inspect the guard owner');
  await io.mkdir(pending,{mode:0o700});
  try {
    // Publish a nonempty owner directory atomically. An initializer delayed
    // past maxAge may lose its empty mkdir placeholder, but its rename cannot
    // replace a successor's nonempty lock, so it cannot enter the action.
    await io.writeFile(join(pending,ownerName),JSON.stringify({pid:process.pid,timestamp:clock()}),{flag:'wx',mode:0o600});
    for(;;) {
      if(clock()>deadline)throw bounded();
      try {await io.mkdir(guard,{mode:0o700});await io.rename(pending,guard);break;}
      catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
      try {
        const st=await io.lstat(guard);
        if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe base guard');
        const names=await io.readdir(guard);
        if(names.length===1&&/^owner-[a-f0-9]{32}$/.test(names[0])) {
          const file=join(guard,names[0]),owner=JSON.parse(await baseFile(file,io));
          let dead=false;
          if(Number.isSafeInteger(owner.pid)&&owner.pid>0) {
            try{kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;else if(error.code!=='EPERM')throw error;}
          } else if(clock()-st.mtimeMs>maxAgeMs)dead=true;
          // Age alone never authorizes stealing from a live holder. Unlink
          // only this generation's owner; losing reapers cannot remove a
          // successor's owner. rmdir can only remove an empty placeholder.
          if(dead){await io.unlink(file);await io.rmdir(guard);continue;}
        } else if(!names.length&&clock()-st.mtimeMs>maxAgeMs) {
          await io.rmdir(guard);continue;
        }
      }catch(error){
        // A different identity's private guard is held, never stale evidence.
        // Keep waiting within the same bound when its owner cannot be read.
        if(!(error instanceof SyntaxError)&&!['ENOENT','ENOTEMPTY','EEXIST','EACCES','EPERM'].includes(error.code))throw error;
      }
      if(clock()>=deadline)throw bounded();
      await sleep(Math.min(retryMs,deadline-clock()));
    }
    try{return await action();}finally{await io.unlink(join(guard,ownerName));await io.rmdir(guard);}
  }finally{await io.rm(pending,{recursive:true,force:true});}
}

export async function readyBases(root,io=fs) {
  await baseDirectory(root,io);
  const records=[];
  for(const sha of await io.readdir(root)) {
    if(!revision(sha))continue;
    try {
      await baseDirectory(join(root,sha),io);
      const ready=JSON.parse(await baseFile(join(root,sha,'READY'),io));
      if(!validReady(ready,sha))continue;
      records.push(ready);
    }catch{ /* Unready or corrupt bases are never advertised. */ }
  }
  return records.sort((a,b)=>b.readyAtMs-a.readyAtMs||b.sha.localeCompare(a.sha));
}
export async function readBase(root,sha,expected,io=fs) {
  if(!revision(sha))throw new Error('Unknown base SHA');
  await baseDirectory(root,io);await baseDirectory(join(root,sha),io);
  const ready=JSON.parse(await baseFile(join(root,sha,'READY'),io));
  if(!validReady(ready,sha)||ready.manifestDigest!==expected)throw new Error('Unknown or mismatched READY base');
  const manifest=JSON.parse(await baseFile(join(root,sha,'manifest.json'),io));
  if(digestManifest(manifest)!==expected)throw new Error('Base manifest digest mismatch');
  decodeManifest(manifest);
  return {ready,manifest,tree:join(root,sha,'tree')};
}
// Privileged snapshot copies must never resolve a source through a mutable ancestor.
// Keep directory descriptors through every open, including the absolute source
// ancestors, and verify pinned file bytes before creating a destination leaf.
export const verifiedCopySource = String.raw`
import os, sys, json, stat, base64, hashlib
cfg = json.load(sys.stdin)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
def unsafe():
    raise RuntimeError('Invalid copy source; use full shipping and inspect the source tree')
def parts(path):
    values = path.split(b'/')
    if not values or len(values) > 128 or any(p in (b'', b'.', b'..') or b'\x00' in p for p in values): unsafe()
    return values
def descend(parent, values, create=False):
    fd = os.dup(parent)
    try:
        for name in values:
            if create:
                try: os.mkdir(name, 0o755, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
def absolute(path):
    if not isinstance(path, str) or not path.startswith('/'): unsafe()
    root = os.open('/', flags)
    try: return descend(root, parts(os.fsencode(path)[1:]))
    finally: os.close(root)
source = absolute(cfg['source'])
try:
    destination = absolute(cfg['destination'])
    try:
        for entry in cfg['entries']:
            names = parts(base64.b64decode(entry['path'], validate=True))
            parent = descend(source, names[:-1])
            try: leaf = os.open(names[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            finally: os.close(parent)
            with os.fdopen(leaf, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or bool(info.st_mode & 0o111) != entry['executable']: unsafe()
                content = stream.read(info.st_size + 1)
                if len(content) != info.st_size or hashlib.sha256(content).hexdigest() != entry['sha256']: unsafe()
            parent = descend(destination, names[:-1], create=True)
            try:
                mode = 0o755 if entry['executable'] else 0o644
                leaf = os.open(names[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
                with os.fdopen(leaf, 'wb') as stream:
                    os.fchmod(stream.fileno(), mode)
                    stream.write(content)
            finally: os.close(parent)
    finally: os.close(destination)
finally: os.close(source)
`;
export async function copyLeaves(source,destination,entries) {
  const result=await gitExec({file:'/usr/bin/python3',args:['-I','-c',verifiedCopySource],
    env:{PATH:'/usr/bin:/bin',LANG:'C'},
    input:JSON.stringify({source,destination,entries:entries.map(entry=>({...entry,path:entry.path.toString('base64')}))}),
  });
  if(result.code!==0)throw new Error('Invalid copy source; use full shipping and inspect the source tree');
}
// Root-created pins must be readable by the ops warmer. The privileged caller
// supplies the operator identity; unprivileged creation needs no transfer.
export async function createBasePin(root,run,baseSha,operator,io=fs) {
  const active=join(root,'active'),pin=join(active,run);
  await io.mkdir(active,{recursive:true,mode:0o700});
  if(operator){
    const fd=await io.open(active,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{
      const st=await fd.stat();
      if(![0,operator.uid].includes(st.uid)||(st.mode&0o022))throw new Error('Unsafe base pin directory');
      await fd.chown(operator.uid,operator.gid);
    }finally{await fd.close();}
  }
  try{await io.writeFile(pin,baseSha,{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST'||(await baseFile(pin,io)).toString()!==baseSha)throw error;}
  if(operator){
    const fd=await io.open(pin,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const st=await fd.stat();
      if(!st.isFile()||st.nlink!==1||![0,operator.uid].includes(st.uid)||st.size!==baseSha.length
        ||(await fd.readFile()).toString()!==baseSha)throw new Error('Unsafe base pin');
      await fd.chown(operator.uid,operator.gid);
    }finally{await fd.close();}
  }
}
export async function pruneBases(root,io=fs) {
  const ready=await readyBases(root,io),active=new Set();
  await io.mkdir(join(root,'active'),{recursive:true,mode:0o700});await baseDirectory(join(root,'active'),io);
  for(const name of await io.readdir(join(root,'active'))) {
    const sha=(await baseFile(join(root,'active',name),io)).toString();
    if(!revision(sha))throw new Error('Unreadable active base pin: pruning refused');
    active.add(sha);
  }
  const keep=new Set([...ready.slice(0,BASE_RETENTION).map(r=>r.sha),...active]);
  for(const name of await io.readdir(root)) {
    if((revision(name)&&!keep.has(name))||/^[a-f0-9]{40,64}\.tmp$/.test(name)||name.endsWith('.tmp'))await io.rm(join(root,name),{recursive:true,force:true});
  }
}

// Prewarm metadata and trees live exclusively below ops-owned, non-writable
// parents. Callers hold baseGuard throughout publication, pruning or claim.
export async function prewarmDirectory(path,io=fs,uid=process.getuid()) {
  await baseDirectory(path,io);
  if((await io.lstat(path)).uid!==uid)throw new Error('Untrusted prewarm owner');
}
// Cheap publication evidence for reuse. Content is still fully verified after
// an exclusive claim, before any worker can access the tree.
export async function prewarmEntry(root,sha,slot,manifestDigest,io=fs,uid=process.getuid()) {
  if(!revision(sha)||!/^[1-9]\d*$/.test(slot))throw new Error('Invalid prewarm identity');
  const parent=join(root,'prewarm',sha),source=join(parent,slot),marker=source+'.json';
  for(const path of [join(root,'prewarm'),parent,source])await prewarmDirectory(path,io,uid);
  if(((await io.lstat(source)).mode&0o077)!==0)throw new Error('Prewarm tree is not private');
  const st=await io.lstat(marker);
  if(st.uid!==uid||(st.mode&0o022)||!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new Error('Untrusted prewarm marker');
  if((await baseFile(marker,io)).toString()!==JSON.stringify({sha,manifestDigest}))throw new Error('Invalid prewarm marker');
}
export async function claimPrewarm(root,sha,slot,destination,manifest,manifestDigest,verify,io=fs,uid=process.getuid()) {
  if(!revision(sha)||!/^[1-9]\d*$/.test(slot))return false;
  const parent=join(root,'prewarm',sha),source=join(parent,slot),marker=source+'.json';
  let claimed=false;
  try {
    await prewarmEntry(root,sha,slot,manifestDigest,io,uid);
    const existing=await io.lstat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(existing)throw new Error('Prewarm destination already exists');
    await io.rename(source,destination);claimed=true;
    await verify(destination,manifest,manifestDigest,{fs:io});
    await io.chmod(destination,0o755);
    await io.rm(marker,{force:true});
    return true;
  }catch {
    if(claimed)await io.rm(destination,{recursive:true,force:true});
    return false; // Uncertain or corrupt optimization: ordinary verified copy.
  }
}
