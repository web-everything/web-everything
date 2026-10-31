import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {PUBLIC_REPOSITORY,anonymousGitEnv} from '../../forge-exec-bases.mjs';

// Replace only public transport with the fixture mirror's objects. Never fetch
// from the network (or a developer remote); all remaining Git commands are real.
export async function cachedPublicGitExec(call) {
  let args=call.args;
  const fetch=args.indexOf('fetch');
  if(fetch!==-1) {
    assert.deepEqual(args.slice(fetch, -1),['fetch','--no-tags','--no-write-fetch-head','origin',
      '+refs/heads/main:refs/remotes/origin/main']);
    assert.match(args.at(-1),/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    assert.deepEqual({...call.env,GIT_TEST_ASSUME_DIFFERENT_OWNER:undefined},
      {...anonymousGitEnv(),GIT_TEST_ASSUME_DIFFERENT_OWNER:undefined});
    const origin=spawnSync('git',[...args.slice(0,fetch),'remote','get-url','origin'],{cwd:call.cwd,env:call.env,encoding:'utf8',timeout:10000});
    assert.equal(origin.status,0,origin.stderr);
    assert.equal(origin.stdout.trim(),PUBLIC_REPOSITORY);
    args=[...args.slice(0,fetch),'cat-file','-e',args.at(-1)+'^{commit}'];
  }
  const result=spawnSync(call.file,args,{cwd:call.cwd,env:call.env,input:call.input,timeout:15000,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  return {code:result.status,stdout:result.stdout};
}
