import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathParts,bytePath,decodeManifest,digestManifest} from './forge-exec-manifest.mjs';
const revision=sha=>typeof sha==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha);
export const PUBLIC_REPOSITORY='https://github.com/chalbert/web-everything.git';
export const anonymousGitEnv=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',
  GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'0'});
function gitExec({args,cwd,env,input}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('git',args,{cwd,env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    const chunks=[];let size=0,overflow=false;
    const timer=setTimeout(()=>{overflow=true;child.kill('SIGKILL');},120000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
      size+=chunk.length;if(size>4*1024*1024){overflow=true;child.kill('SIGKILL');}
      else if(stream===child.stdout)chunks.push(chunk);
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);overflow?reject(new Error('Git bound exceeded; use local fallback')):resolve({code,stdout:Buffer.concat(chunks).toString('utf8')});});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
  });
}
// Trusted wrapper only: never clone client remotes/configuration or fetch a
// client-supplied URL. The warm mirror is only an object cache: public origin
// must supply both current main and the exact, manifest-bound Mac HEAD.
export async function materializeWorktree({work,root,baseSha,head,manifest,manifestDigest,exec=gitExec}) {
  if(!revision(head)||manifest?.git?.head!==head||baseSha!==undefined&&!revision(baseSha)||digestManifest(manifest)!==manifestDigest)throw new Error('Invalid Git evidence');
  const {siblings,git:logical,...primary}=manifest;
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
    const result=await exec({file:'git',args:['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
      '-c','protocol.ext.allow=never','-c','http.followRedirects=false',
      '-c','safe.directory='+join(root,'repo.git'),'-c','safe.directory='+cloned,...args],cwd,env,input});
    if(result.code!==0){if(allowMissing)return null;throw new Error('Anonymous Git unavailable; use local fallback');}
    return result.stdout.toString().trim();
  };
  try {
    const mirror=join(root,'repo.git');
    const local=await fs.lstat(mirror).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;});
    if(local)await baseDirectory(mirror);
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
    throw Object.assign(new Error('Git HEAD unavailable; use local fallback',{cause:error}),{code:'git-head-unavailable'});
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
export async function baseGuard(root,action,io=fs) {
  await baseDirectory(root,io);
  const guard=join(root,'.guard');
  await io.mkdir(guard,{mode:0o700});
  try{return await action();}finally{await io.rmdir(guard);}
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
// Copy regular, verified leaves only; no reflinks or hardlinks and no inherited
// writable metadata. Each destination is new inside an ops-owned tree.
export async function copyLeaves(source,destination,entries,io=fs) {
  const root=await io.lstat(source);if(root.isSymbolicLink()||!root.isDirectory())throw new Error('Unsafe copy root');
  for(const entry of entries) {
    let from=Buffer.from(source),to=Buffer.from(destination);
    const parts=pathParts(entry.path);
    for(const [i,part] of parts.entries()) {
      from=bytePath(from,part);to=bytePath(to,part);
      const st=await io.lstat(from);
      if(st.isSymbolicLink()||(i===parts.length-1?!st.isFile():!st.isDirectory()))throw new Error('Unsafe copy component');
      if(i<parts.length-1)await io.mkdir(to,{recursive:true,mode:0o755});
      else {
        const handle=await io.open(from,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        let content;try{const pinned=await handle.stat();if(!pinned.isFile()||pinned.ino!==st.ino||pinned.dev!==st.dev||pinned.mode!==st.mode)throw new Error('Copy source swapped');content=await handle.readFile();}finally{await handle.close();}
        await io.writeFile(to,content,{flag:'wx',mode:entry.executable?0o755:0o644});
        await io.chmod(to,entry.executable?0o755:0o644);
      }
    }
  }
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
  const keep=new Set([...ready.slice(0,4).map(r=>r.sha),...active]);
  for(const name of await io.readdir(root)) {
    if((revision(name)&&!keep.has(name))||/^[a-f0-9]{40,64}\.tmp$/.test(name)||name.endsWith('.tmp'))await io.rm(join(root,name),{recursive:true,force:true});
  }
}
