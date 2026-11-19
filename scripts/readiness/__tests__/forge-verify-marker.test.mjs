// @vitest-environment node
import {afterEach, beforeEach, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

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

it('real verify-lane runGate hands WE_FORGE_GATE_DISPATCH=1 without a held local slot to heavy admission for remote dispatch',()=>{
  const gate=join(scratch,'admission-gate.mjs'),wire=join(scratch,'admission.json');
  const pool=join(scratch,'pool'),preferences=join(scratch,'preferences.json');mkdirSync(pool);
  writeFileSync(preferences,JSON.stringify({heavyAdmission:{remote:{enabled:true,mode:'always'}}}));
  // Exercise the eligible npm wrapper; raw node gates deliberately retain local admission.
  writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{'check:standards':`node ${JSON.stringify(gate)}`}}));
  // Only telemetry IO is fake: verify's real policy, health check and admission plan still run.
  const loader=join(scratch,'telemetry-loader.mjs'),preload=join(scratch,'preload.mjs');
  const telemetry=new URL('../forge-telemetry.mjs',import.meta.url).href;
  const telemetrySource=`
export * from ${JSON.stringify(telemetry+'?actual')};
import {easternTimestamp} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
export async function readForgeTelemetry(){return {sampledAtET:easternTimestamp(Date.now()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]};}
`;
  writeFileSync(loader,`export async function load(url,context,next) {
    if(url===${JSON.stringify(telemetry)})return {format:'module',shortCircuit:true,source:${JSON.stringify(telemetrySource)}};
    return next(url,context);
  }`);
  writeFileSync(preload,`import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  writeFileSync(gate,`
import {main} from ${JSON.stringify(new URL('../heavy-admission.mjs',import.meta.url).href)};
import {easternTimestamp} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
import {writeFileSync} from 'node:fs';
const evidence={held:process.env.WE_HEAVY_ADMISSION_HELD??null,dispatch:process.env.WE_FORGE_GATE_DISPATCH};
writeFileSync(${JSON.stringify(wire)},JSON.stringify(evidence));
await main(['run','--repo='+process.cwd(),'--','npm','run','check:standards'],{
  remoteExec:async options=>{
    writeFileSync(${JSON.stringify(wire)},JSON.stringify({...evidence,argv:options.argv}));
    return {mode:'remote',code:0,run:'r-fixture'};
  },
  readTelemetry:async()=>({sampledAtET:easternTimestamp(Date.now()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]}),
});
`);
  const result=spawnSync(process.execPath,['--import',preload,verify,'--gate=npm run check:standards','--json'],{
    cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
    env:{...process.env,CI:'',WE_HEAVY_ADMISSION:'on',WE_HEAVY_ADMISSION_HELD:'',WE_FORGE_GATE_DISPATCH:'',
      WE_HEAVY_ADMISSION_CONTAINER:'',WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES:'',
      LANE_POOL_ROOT:pool,WE_PLATFORM_PREFERENCES:preferences,CONVEYOR_RUNNER_LOCK_ROOT:join(scratch,'locks')},
  });
  expect(result.error).toBeUndefined();
  expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(wire,'utf8'))).toEqual({held:null,dispatch:'1',argv:['npm','run','check:standards']});
  const marker=JSON.parse(readFileSync(join(repo,'.git','.lane-verify'),'utf8'));
  expect(marker.status).toBe('green');
  expect(marker.ranOn).toEqual({location:'remote',phases:{standards:{location:'remote',receiptId:'r-fixture'}}});
  expect(result.stderr).toContain('verify-lane: remote admission');
  expect(result.stderr).not.toContain('heavy-command admission: acquired');
},40000);

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
