import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {materializeWorktree} from '../../forge-exec-bases.mjs';
import {manifestWire,digestManifest} from '../../forge-exec-manifest.mjs';
import {cachedPublicGitExec} from './forge-public-git.mjs';

// The same real Git attack runs on every host; Linux additionally drops to an
// actual worker UID while the materializer retains root, matching production.
export async function exerciseGitMetadataAttack(root,{workerUid,workerGid=workerUid}={}) {
  const source=join(root,'source'),base=join(root,'bases'),work=join(root,'work'),actor=join(root,'actor');
  await fs.chmod(root,0o755);
  for(const path of [source,work,actor])await fs.mkdir(path,{mode:0o755});
  await fs.mkdir(base,{mode:0o700});
  const run=call=>{
    const r=spawnSync(call.file,call.args,{cwd:call.cwd,env:call.env,input:call.input,timeout:15000,maxBuffer:1024*1024});
    assert.equal(r.error,undefined);return {code:r.status,stdout:r.stdout,stderr:r.stderr};
  };
  const git=(cwd,...args)=>{
    const r=run({file:'git',args,cwd,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    assert.equal(r.code,0,r.stderr.toString());return r.stdout.toString().trim();
  };
  git(source,'init','-b','main');
  await fs.writeFile(join(source,'tracked.txt'),'base');git(source,'add','.');
  git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base');
  const head=git(source,'rev-parse','HEAD');
  git(root,'clone','--bare',source,join(base,'repo.git'));
  git(join(base,'repo.git'),'update-ref','refs/remotes/origin/main',head);
  const evil=join(actor,'evil');await fs.cp(source,evil,{recursive:true});
  const payload=join(actor,'fsmonitor'),marker=payload+'.executed';
  await fs.writeFile(payload,'#!/bin/sh\nid -u > "$0.executed"\nprintf \'token\\000\'\n',{mode:0o755});
  git(evil,'config','core.fsmonitor',"'"+payload.replaceAll("'","'\\''")+"'");
  await fs.writeFile(join(work,'tracked.txt'),'changed');
  const chownTree=async path=>{
    const st=await fs.lstat(path);
    if(st.isDirectory())for(const name of await fs.readdir(path))await chownTree(join(path,name));
    await fs.chown(path,workerUid,workerGid);
  };
  if(workerUid!==undefined){assert.equal(process.getuid(),0);await chownTree(work);await chownTree(actor);}
  const asWorker=(script,cfg={})=>{
    const code=`import os,json,sys,shutil\ncfg=json.loads(sys.argv[1])\nif cfg.get('uid') is not None:\n os.setgroups([]); os.setgid(cfg['gid']); os.setuid(cfg['uid'])\n`+script;
    const r=run({file:'python3',args:['-I','-c',code,JSON.stringify({uid:workerUid,gid:workerGid,...cfg})],cwd:root,env:{PATH:process.env.PATH}});
    assert.equal(r.code,0,r.stderr.toString());return r.stdout.toString().trim();
  };
  // Positive control: this is an executable fsmonitor command, not inert config.
  asWorker("import subprocess\nsubprocess.run(['git','-c','core.hooksPath=/dev/null','update-index','--refresh'],cwd=cfg['evil'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\n",{evil});
  assert.equal(Number((await fs.readFile(marker,'utf8')).trim()),workerUid??process.getuid());
  await fs.rm(marker);
  const manifest={...manifestWire({entries:[{path:Buffer.from('tracked.txt'),sha256:createHash('sha256').update('changed').digest('hex'),executable:false,tracked:true}],excluded:[]}),git:{head}};
  let attacked=false,protectedGit,unsafeCwd=false;
  await materializeWorktree({work,root:base,head,manifest,manifestDigest:digestManifest(manifest),exec:async call=>{
    if(call.args.includes('clone'))protectedGit=call.args.at(-1);
    unsafeCwd ||= call.cwd===work;
    if(!call.args.includes('update-index'))return cachedPublicGitExec(call);
    attacked=true;
    asWorker(`
target=os.path.join(cfg['work'],'.git')
saved=target+'.displaced'
if os.path.lexists(target): os.rename(target,saved)
shutil.copytree(os.path.join(cfg['evil'],'.git'),target)
if cfg.get('uid') is not None:
 try: os.rename(os.path.join(cfg['protected'],'config'),os.path.join(cfg['protected'],'config.swapped'))
 except PermissionError: pass
 else: raise AssertionError('worker reached protected Git metadata')
`,{work,evil,protected:protectedGit});
    const result=run(call);
    asWorker(`
target=os.path.join(cfg['work'],'.git')
shutil.rmtree(target)
if os.path.lexists(target+'.displaced'): os.rename(target+'.displaced',target)
`,{work});
    return result;
  }});
  assert.equal(attacked,true,'the worker must substitute metadata at the update-index boundary');
  assert.equal(await fs.stat(marker).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}),false,'privileged Git executed the substituted fsmonitor payload');
  assert.equal(unsafeCwd,false,'privileged Git ran in a worker-writable directory');
  assert.equal((await fs.readFile(join(work,'.git','HEAD'),'utf8')).trim(),head);
  assert.equal((await fs.stat(join(work,'.git','index'))).isFile(),true);
}
