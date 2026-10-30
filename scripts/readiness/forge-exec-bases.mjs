import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {pathParts,bytePath,decodeManifest,digestManifest} from './forge-exec-manifest.mjs';
const revision=sha=>typeof sha==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha);
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
