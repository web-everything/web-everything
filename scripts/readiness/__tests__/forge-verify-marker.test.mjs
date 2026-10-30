// @vitest-environment node
import {afterEach, beforeEach, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';

let scratch,repo;
const verify=resolve('scripts/verify-lane.mjs'),client=new URL('../remote-exec.mjs',import.meta.url).href;
beforeEach(()=>{
  scratch=mkdtempSync(join(process.env.TMPDIR,'forge-marker-'));repo=join(scratch,'mac');mkdirSync(repo);
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});expect(r.status,r.stderr).toBe(0);};
  git('init','-q');
  writeFileSync(join(repo,'package.json'),'{}');writeFileSync(join(repo,'package-lock.json'),'{}');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','snapshot');
});
afterEach(()=>rmSync(scratch,{recursive:true,force:true}));

it.each([
  {code:0,confirmed:true,green:true},
  {code:17,confirmed:true,green:false},
  {code:0,confirmed:false,green:false},
])('the real Mac verify writer stamps green only for confirmed remote exit zero: %j',({code,confirmed,green})=>{
  const gate=join(scratch,'gate.mjs'),wire=join(scratch,'transport.json');
  writeFileSync(gate,`
import {main} from ${JSON.stringify(client)};
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const transport=[];let request;
const exec=async call=>{
  if(call.file==='git'){const r=spawnSync('git',call.args,{cwd:call.cwd});return {code:r.status,stdout:r.stdout};}
  transport.push({file:call.file,args:call.args,input:call.input});
  if(call.file==='rsync')return {code:0,stdout:''};
  const action=call.args.at(-1).split(' ').at(-1);
  if(action==='true')return {code:0,stdout:''};
  if(action==='bases')return {code:254,stdout:''};
  if(action==='prepare'){const p=JSON.parse(call.input);return {code:0,stdout:JSON.stringify({run:'r-'+p.nonce,capabilities:{commandClasses:1,gitWorktree:2}})};}
  if(action==='run'){request=JSON.parse(call.input);return {code:${code},stdout:''};}
  if(action==='finish')return {code:0,stdout:${confirmed}?JSON.stringify({v:1,nonce:request.nonce,run:request.run,inputDigest:request.inputDigest,argvDigest:request.argvDigest,lock:request.lock,manifestDigest:request.manifestDigest,phase:'test',code:${code}}):'unconfirmed'};
  throw new Error('Unexpected transport');
};
const result=await main({argv:['npm','run','check:standards'],cwd:process.cwd(),env:process.env,exec,
  listFiles:async()=>['package.json','package-lock.json'],lockRoot:${JSON.stringify(join(scratch,'heavy'))},
  readTelemetry:async()=>({sampledAtET:(await import(${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)})).easternTimestamp(Date.now()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]}),
  local:async()=>19,log:()=>{},stderr:()=>{}});
writeFileSync(${JSON.stringify(wire)},JSON.stringify(transport));process.exitCode=result;
`);
  const marker=join(repo,'.git','.lane-verify');
  const result=spawnSync(process.execPath,[verify,`--gate=node ${gate}`,'--json'],{cwd:repo,encoding:'utf8',timeout:30000,
    env:{...process.env,CONVEYOR_RUNNER_LOCK_ROOT:join(scratch,'locks'),FORGE_PRIVATE_MARKER:marker}});
  expect(result.error).toBeUndefined();
  expect(result.status,result.stderr).toBe(green?0:2);
  const record=JSON.parse(readFileSync(marker,'utf8'));
  expect(record.status).toBe(green?'green':'red');
  const sent=readFileSync(wire,'utf8');
  expect(sent).not.toContain(marker);expect(sent).not.toContain('.lane-verify');expect(sent).not.toContain('FORGE_PRIVATE_MARKER');
  expect(JSON.parse(sent).filter(c=>c.args.at(-1)?.endsWith(' run'))).toHaveLength(1);
},40000);
