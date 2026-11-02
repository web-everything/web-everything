#!/usr/bin/env node
// Installed root-owned; only anonymous public Git is accessed on this host.
import * as filesystem from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyManifestPath,credentialContentFinding,manifestEntry,manifestWire,digestManifest,parseGitTree,validateTestNames,isTestFile,bytePath,pathParts,decodeManifest} from './forge-exec-manifest.mjs';
import {baseGuard,copyLeaves,createBasePin,prewarmDirectory,prewarmEntry,baseDirectory,baseFile,readBase,readyBases,pruneBases,PUBLIC_REPOSITORY,anonymousGitEnv} from './forge-exec-bases.mjs';
import {createRunner,verifyManifest,digestLock} from './forge-exec-run.mjs';
const URL=PUBLIC_REPOSITORY;
const LIMIT=4*1024*1024;
function run({file,args,cwd,env,input}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd,env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']}),out=[];let bytes=0,overflow=false;
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    const timer=setTimeout(()=>{overflow=true;child.kill('SIGKILL');},120000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMIT){overflow=true;child.kill('SIGKILL');}else if(stream===child.stdout)out.push(chunk);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);if(overflow)reject(new Error('Warm command bound exceeded: full shipping remains available'));else resolve({code,stdout:Buffer.concat(out)});});
  });
}
// This is a metadata digest, not a substitute for the runner's full content
// verification. It cheaply detects tree changes between timer ticks.
async function treeMarker(tree,manifest,manifestDigest,fs) {
  await baseDirectory(tree,fs);
  const expected=new Map(decodeManifest(manifest).entries.map(e=>[e.path.toString('hex'),e]));
  const hash=createHash('sha256');let fileCount=0,budget=0;
  async function walk(prefix,depth=0) {
    if(depth>128)throw new Error('Warm tree depth bound exceeded: full shipping remains available');
    const names=await fs.readdir(prefix.length?bytePath(tree,prefix):tree,{encoding:'buffer'});
    for(const name of names.sort(Buffer.compare)) {
      const path=prefix.length?Buffer.concat([prefix,Buffer.from('/'),name]):name;pathParts(path);
      budget+=path.length+1;
      if(budget>LIMIT)throw new Error('Warm tree inventory bound exceeded: full shipping remains available');
      const st=await fs.lstat(bytePath(tree,path));
      if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))throw new Error('Unsafe warm tree component');
      hash.update(JSON.stringify([path.toString('base64'),st.dev,st.ino,st.mode,st.size,st.mtimeMs,st.ctimeMs])+'\n');
      if(st.isDirectory())await walk(path,depth+1);
      else {
        const entry=expected.get(path.toString('hex'));
        if(!entry||entry.executable!==!!(st.mode&0o111))throw new Error('Warm tree inventory mismatch');
        fileCount++;
      }
    }
  }
  await walk(Buffer.alloc(0));
  if(fileCount!==expected.size)throw new Error('Warm tree file count mismatch');
  return {manifestDigest,fileCount,treeDigest:hash.digest('hex')};
}
async function revalidateBase(root,ready,fs) {
  const {tree,manifest}=await readBase(root,ready.sha,ready.manifestDigest,fs);
  const observed=await treeMarker(tree,manifest,ready.manifestDigest,fs);
  const path=join(root,ready.sha,'tree-digest.json');
  const bytes=await baseFile(path,fs).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(bytes===undefined) {
    // Upgrade old READY records once. Never turn an existing bad marker into
    // trusted evidence by simply overwriting it.
    await verifyManifest(tree,manifest,ready.manifestDigest,{fs});
    if(JSON.stringify(await treeMarker(tree,manifest,ready.manifestDigest,fs))!==JSON.stringify(observed))throw new Error('Warm tree changed during verification');
    await fs.writeFile(path,JSON.stringify(observed),{flag:'wx',mode:0o600});
  } else {
    const marker=JSON.parse(bytes);
    if(!marker||Object.keys(marker).sort().join(',')!=='fileCount,manifestDigest,treeDigest'
      ||marker.manifestDigest!==observed.manifestDigest||marker.fileCount!==observed.fileCount||marker.treeDigest!==observed.treeDigest)throw new Error('Warm tree marker mismatch');
  }
}
async function installWarm(tree,manifest) {
  const pool=(await filesystem.readdir('/srv/forge-exec')).some(name=>/^slot-[1-9]\d*$/.test(name));
  if(!pool)return createRunner().warmInstall(tree,manifest);
  const result=await run({file:'/usr/bin/sudo',args:['-n','/usr/local/libexec/forge-exec-run.mjs','warm-install'],
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent'},input:JSON.stringify({source:tree,manifest})});
  if(result.code!==0)throw new Error('Warm worker unavailable; full shipping remains available');
  return {code:0};
}
// The base tree contains only manifest leaves (including its exact dependency
// state). Never import caches or links from a worker into the prewarm pool.
async function prewarmPins(root,fs,ownPin) {
  const active=new Set();
  await baseDirectory(join(root,'active'),fs);
  for(const name of await fs.readdir(join(root,'active'))) {
    const sha=(await baseFile(join(root,'active',name),fs)).toString();
    if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))throw new Error('Invalid active pin: prewarm pruning refused');
    if(name!==ownPin)active.add(sha);
  }
  return active;
}
const prewarmExists=(path,fs)=>fs.lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
async function prewarmSlots(root,runs,receipts,fs,log) {
  // The timer's flock serializes warmers. Pin the base while copying outside
  // the runner's guard; keep staging out of the advertised pool entirely.
  const staging=await fs.mkdtemp(join(root,'.prewarm-')),ownPin=basename(staging);
  let pinned=false;
  try {
    const plan=await baseGuard(root,async()=>{
      const newest=(await readyBases(root,fs))[0];if(!newest)return;
      await prewarmPins(root,fs);
      // With the timer flock held, every previous build is abandoned. Reclaim
      // its reserved pin even if disposal finished before pin release failed.
      const abandoned=name=>/^\.prewarm-[A-Za-z0-9]{6}$/.test(name)&&name!==ownPin;
      for(const name of (await fs.readdir(root)).filter(abandoned)) {
        await prewarmDirectory(join(root,name),fs);
        await fs.rename(join(root,name),join(staging,name));
      }
      for(const name of (await fs.readdir(join(root,'active'))).filter(abandoned))await fs.rm(join(root,'active',name),{force:true});
      const active=await prewarmPins(root,fs);
      const pool=join(root,'prewarm');await fs.mkdir(pool,{recursive:true,mode:0o700});await prewarmDirectory(pool,fs);
      const shas=await fs.readdir(pool);
      // Validate the whole pool before pruning any entry.
      for(const sha of shas) {
        if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))throw new Error('Unknown prewarm entry: pruning refused');
        await prewarmDirectory(join(pool,sha),fs);
      }
      for(const sha of shas)if(sha!==newest.sha&&!active.has(sha))await fs.rename(join(pool,sha),join(staging,'prune-'+sha));
      if(!await prewarmExists(runs,fs))return;
      await prewarmDirectory(runs,fs);
      const names=(await fs.readdir(runs)).filter(name=>/^slot-[1-9]\d*$/.test(name));
      if(names.length>128)throw new Error('Prewarm slot bound exceeded: ordinary copying remains available');
      if(!names.length)return;
      await prewarmDirectory(receipts,fs);
      const base=await readBase(root,newest.sha,newest.manifestDigest,fs);
      const parent=join(pool,newest.sha);await fs.mkdir(parent,{recursive:true,mode:0o700});await prewarmDirectory(parent,fs);
      await createBasePin(root,ownPin,newest.sha,undefined,fs);pinned=true;
      return {newest,names,base,parent};
    },fs);
    if(!plan)return;
    const {newest,names,base,parent}=plan;
    // Re-read busy state and external pins both before building and before
    // publishing. A runner may claim a tree or reserve a slot during the copy.
    const needed=async n=>{
      if((await readyBases(root,fs))[0]?.sha!==newest.sha)return false;
      const active=await prewarmPins(root,fs,ownPin);
      for(const path of [runs,join(runs,'slot-'+n),receipts,join(root,'prewarm'),parent])await prewarmDirectory(path,fs);
      if(await prewarmExists(join(receipts,'worker-active-'+n),fs))return false;
      const dest=join(parent,n);
      if(await prewarmExists(dest,fs)) {
        if(active.has(newest.sha))return false;
        try{await prewarmEntry(root,newest.sha,n,newest.manifestDigest,fs);return false;}catch{ /* Rebuild untrusted publication evidence only. */ }
        await prewarmDirectory(dest,fs);
      }
      return true;
    };
    for(const name of names) {
      const n=name.slice(5),tree=join(staging,name),dest=join(parent,n),marker=dest+'.json';
      let built=false;
      try {
        if(!await baseGuard(root,()=>needed(n),fs))continue;
        built=true;
        await fs.mkdir(tree,{mode:0o700});
        await copyLeaves(base.tree,tree,decodeManifest(base.manifest).entries,fs);
        await verifyManifest(tree,base.manifest,newest.manifestDigest,{fs});
        await fs.writeFile(tree+'.json',JSON.stringify({sha:newest.sha,manifestDigest:newest.manifestDigest}),{flag:'wx',mode:0o600});
        await baseGuard(root,async()=>{
          if(!await needed(n))return;
          if(await prewarmExists(dest,fs))await fs.rename(dest,join(staging,'old-'+n));
          await fs.rm(marker,{force:true});
          await fs.rename(tree,dest);
          try{await fs.rename(tree+'.json',marker);}
          catch(error){await fs.rename(dest,tree);throw error;}
        },fs);
      }catch(error){log('prewarm slot '+n+': '+String(error.message));}
      finally{
        // Free partial copies before trying the next slot after ENOSPC.
        if(built)for(const path of [tree,tree+'.json',join(staging,'old-'+n)]) {
          try{await fs.rm(path,{recursive:true,force:true});}
          catch(error){log('prewarm cleanup slot '+n+': '+String(error.message));}
        }
      }
    }
  }finally{
    // Recursive disposal can be as slow as copying; it also stays outside the
    // shared guard. Always attempt pin release even if disposal fails.
    try{await fs.rm(staging,{recursive:true,force:true});}
    finally{if(pinned)await baseGuard(root,()=>fs.rm(join(root,'active',ownPin),{force:true}),fs);}
  }
}
export async function warmTick({root='/srv/forge-base',exec=run,clock=Date.now,fs=filesystem,install=installWarm,runs='/srv/forge-exec',receipts='/srv/forge-receipts',log=message=>process.stderr.write('forge-warm-base: '+String(message).replace(/[\x00-\x1f\x7f]/g,' ')+'\n')}={}) {
  await baseDirectory(root,fs);
  // The timer's flock serializes ticks. The short base guard is also shared
  // with runner pin creation, closing the prune-vs-prepare race.
  const rebuild=new Set();
  await baseGuard(root,async()=>{
    const ready=new Map((await readyBases(root,fs)).map(record=>[record.sha,record]));
    for(const sha of await fs.readdir(root)) {
      if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))continue;
      try {
        if(!ready.has(sha))throw new Error('Malformed READY record');
        await revalidateBase(root,ready.get(sha),fs);
      } catch {
        await fs.rm(join(root,sha),{recursive:true,force:true});
        rebuild.add(sha);
      }
    }
    await pruneBases(root,fs);
  },fs);
  const repo=join(root,'repo.git');
  const env=anonymousGitEnv();
  const git=async args=>{
    const result=await exec({file:'git',args:['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-c','http.followRedirects=false','--git-dir',repo,...args],cwd:root,env});
    if(result.code!==0||!Buffer.isBuffer(result.stdout)||result.stdout.length>LIMIT)throw new Error('Anonymous Git unavailable: full shipping remains available');return result.stdout;
  };
  const exists=await fs.lstat(repo).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(!exists)await git(['init','--bare',repo]);
  await baseDirectory(repo,fs);
  await git(['fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head',URL,'+refs/heads/main:refs/remotes/origin/main']);
  const fetchedAtMs=Math.floor(clock()),sha=(await git(['rev-parse','refs/remotes/origin/main'])).toString('ascii').trim();
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))throw new Error('Invalid public main SHA');
  const publish=async sha=>{
    const pending=join(root,sha+'.tmp'),tree=join(pending,'tree');
    await fs.mkdir(pending,{mode:0o700});await fs.mkdir(tree,{mode:0o755});
    try {
      // Checkout exactly the tracked regular blobs. No archive extraction,
      // submodule operation, hooks, credentials, or private sibling lookup.
      const inventory=parseGitTree(await git(['ls-tree','-r','-z',sha]));validateTestNames(inventory.map(e=>e.path));
      const entries=[],excluded=[];
      for(const entry of inventory.sort((a,b)=>Buffer.compare(a.path,b.path))) {
        const policy=classifyManifestPath(entry.path);
        if((policy.excluded&&!policy.credentialSource)||policy.names.includes('node_modules')) {
          if(isTestFile(entry.path)||/\.(test|spec)\./.test(policy.parts.at(-1).toString('latin1')))throw new Error('Excluded test: base refused');
          excluded.push(entry.path);continue;
        }
        const content=await git(['cat-file','blob',entry.oid]);
        // Git object identity plus a fresh manifest hash bind exported bytes.
        const oid=createHash(entry.oid.length===64?'sha256':'sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
        if(oid!==entry.oid)throw new Error('Public blob changed');
        // R321: a name-flagged public file with secret-like content stays out of the base.
        if(policy.credentialSource&&credentialContentFinding(entry.path,content)){excluded.push(entry.path);continue;}
        let dest=Buffer.from(tree);const parts=pathParts(entry.path);
        for(const [i,part] of parts.entries()){dest=bytePath(dest,part);if(i<parts.length-1)await fs.mkdir(dest,{recursive:true,mode:0o755});else await fs.writeFile(dest,content,{flag:'wx',mode:entry.executable?0o755:0o644});}
        entries.push(manifestEntry(entry.path,content,entry.executable,true));
      }
      const manifest=manifestWire({entries,excluded}),manifestDigest=digestManifest(manifest);
      if(Buffer.byteLength(JSON.stringify(manifest))>LIMIT-16384)throw new Error('Warm manifest bound exceeded: use full shipping');
      await verifyManifest(tree,manifest,manifestDigest,{fs});
      const lockDigest=await digestLock(tree);
      const installed=await install(tree,manifest,{lockDigest,manifestDigest});
      if(installed?.code!==0)throw new Error('Warm npm install failed: full shipping remains available');
      const marker=await treeMarker(tree,manifest,manifestDigest,fs);
      await verifyManifest(tree,manifest,manifestDigest,{fs});
      if(JSON.stringify(await treeMarker(tree,manifest,manifestDigest,fs))!==JSON.stringify(marker))throw new Error('Warm tree changed during verification');
      const mergeCommitDate=(await git(['show','-s','--format=%cI',sha])).toString('ascii').trim();
      if(!Number.isFinite(Date.parse(mergeCommitDate)))throw new Error('Invalid public commit date');
      const readyAtMs=Math.floor(clock()),ready={sha,manifestDigest,lockDigest,readyAtMs,fetchedAtMs};
      await fs.writeFile(join(pending,'manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
      await fs.writeFile(join(pending,'tree-digest.json'),JSON.stringify(marker),{flag:'wx',mode:0o600});
      await fs.writeFile(join(pending,'READY'),JSON.stringify(ready),{flag:'wx',mode:0o600});
      await baseGuard(root,async()=>{
        await fs.rename(pending,join(root,sha));
        await pruneBases(root,fs);
      },fs);
      await fs.appendFile(join(root,'latency.log'),JSON.stringify({sha,mergeCommitDate,fetchedAt:new Date(fetchedAtMs).toISOString(),readyAt:new Date(readyAtMs).toISOString(),latencyMs:readyAtMs-Date.parse(mergeCommitDate)})+'\n',{mode:0o600});
      return ready;
    }catch(error){await fs.rm(pending,{recursive:true,force:true});throw error;}
  };
  // Repair historical candidates too; a healthy current main must not mask a
  // damaged retained base. Failure leaves it unadvertised and full ship available.
  for(const revision of rebuild)if(revision!==sha)await publish(revision);
  const result=(await readyBases(root,fs)).some(base=>base.sha===sha)?{sha,reused:true}:await publish(sha);
  try{await prewarmSlots(root,runs,receipts,fs,log);}
  catch(error){log('prewarm unavailable; ordinary copying remains available: '+String(error.message));}
  return result;
}
const cliPath = (()=>{try{return realpathSync(process.argv[1]);}catch{return '';}})();
if(process.argv[1]&&cliPath===realpathSync(fileURLToPath(import.meta.url))) {
  // Bases refuse group/other-writable directories. Imports must not change the
  // host process mask, and worker runtimes may expose an unsupported umask.
  try {if(typeof process.umask==='function')process.umask(0o022);} catch { /* unsupported runtime */ }
  (async()=>{
    try{if(process.argv.length!==2)throw new Error('No arguments accepted');await warmTick();}
    catch(error){process.stderr.write('forge-warm-base: '+String(error.message).replace(/[\x00-\x1f\x7f]/g,' ')+'\n');process.exitCode=1;}
  })();
}
