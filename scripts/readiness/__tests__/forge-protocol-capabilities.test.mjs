// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {Readable, PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as runner from '../forge-exec-run.mjs';
import {DEFAULT_LIMITS, readLimits} from '../forge-exec-limits.mjs';
import {main as telemetryMain, readForgeTelemetry} from '../forge-telemetry.mjs';
import {verifyReceipt} from '../remote-exec.mjs';
import {resolveAdmissionPolicy, resolveRemoteSlotUnits} from '../heavy-admission.mjs';

const io=vi.hoisted(()=>({open:vi.fn(),readdir:vi.fn(),writeFile:vi.fn(),rename:vi.fn(),rm:vi.fn(),lstat:vi.fn(),mkdir:vi.fn(),statfs:vi.fn()}));
vi.mock('node:fs/promises',async original=>({...await original(),...io}));
// Keep host samples identical so byte-compatibility assertions measure the protocol.
vi.mock('node:os',async original=>({...await original(),freemem:()=>1024,totalmem:()=>2048,loadavg:()=>[1,1,1]}));
vi.mock('../forge-exec-limits.mjs',async original=>({...await original(),readLimits:vi.fn()}));
// Production prepare refuses every run unless nft table inet forge_exec_egress exists (R595 S1). CI hosts have no
// such table, so answer ONLY that one probe as present; every other spawn still reaches the real child_process.
vi.mock('node:child_process',async original=>{
  const actual=await original();
  const {EventEmitter}=await import('node:events');
  return {...actual,spawn:(file,...rest)=>{
    if(file!=='/usr/sbin/nft')return actual.spawn(file,...rest);
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
    queueMicrotask(()=>child.emit('close',0));
    return child;
  }};
});
// The production base document: R518 publishes activeRunIds when two listings agree (the mocked listing is empty and stable).
// R951 publishes disk pressure without opt-in; this fixture has no readable prune status.
// Opt-in fields such as `limits` must never appear in it.
const legacyTelemetry=['activeRunIds','activeRuns','cores','loadPerCore','memFreePct','recent','sampledAtET'];
// Deploy drain publishes deploy.draining without opt-in.
const baseTelemetry=[...legacyTelemetry,'diskUsedPct','deploy'].sort();
const legacyReceipt=['argvDigest','code','inputDigest','lock','manifestDigest','nonce','phase','resources','run','timings','v'];
const expected={v:1,nonce:'a'.repeat(32),run:'r-'+'b'.repeat(32),inputDigest:'c'.repeat(64),
  argvDigest:'d'.repeat(64),lock:'e'.repeat(64),manifestDigest:'f'.repeat(64)};
const payload={...expected,phase:'test',code:0,resources:{memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:24},timings:{installMs:1,runMs:2}};
beforeEach(()=>{
  vi.clearAllMocks();
  vi.spyOn(process,'getuid').mockReturnValue(501);
  io.open.mockResolvedValue({stat:async()=>({isDirectory:()=>true,uid:501,gid:process.getgid(),mode:0o40700}),close:async()=>{}});
  io.readdir.mockResolvedValue([]);io.lstat.mockImplementation(async path=>{if(path==='/run/forge-deploy/drain')throw Object.assign(new Error('missing'),{code:'ENOENT'});return {mode:0o40700};});
  io.statfs.mockResolvedValue({blocks:100,bfree:65,bavail:65});
  vi.mocked(readLimits).mockResolvedValue({limits:DEFAULT_LIMITS,warnings:[]});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

describe('production protocol capability negotiation',()=>{
  it('production telemetry includes disk pressure in the exact base schema without an opt-in request',async()=>{
    const value=await runner.createRunner().telemetry();
    expect(Object.keys(value).sort()).toEqual(baseTelemetry);
    expect(value.diskUsedPct).toBe(35);
    expect(io.statfs).toHaveBeenCalledWith('/');
    expect(readLimits).not.toHaveBeenCalled();
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.open).toHaveBeenCalledWith('/srv/forge-exec',expect.any(Number));
  });
  it('production telemetry adds limits only to an opted-in response, never the cached document',async()=>{
    const value=await runner.createRunner().telemetry({capabilities:{limits:1}});
    expect(value.limits).toEqual({parent:{cpuQuota:'2800%'},slot:{cpuQuota:'800%'}});
    expect(readLimits).toHaveBeenCalledTimes(1);
    for(const [,contents] of io.writeFile.mock.calls)expect(Object.keys(JSON.parse(contents)).sort()).toEqual(baseTelemetry);
    expect(Object.keys(await runner.createRunner().telemetry()).sort()).toEqual(baseTelemetry);
  });
  it.each([undefined,null,{}, {capabilities:{limits:true}},{capabilities:{limits:'1'}}])
  ('does not negotiate limits from incomplete or mistyped requests: %j',async request=>{
    expect(Object.keys(await runner.createRunner().telemetry(request)).sort()).toEqual(baseTelemetry);
  });
  it('omits unavailable disk evidence without adding negotiated fields',async()=>{
    io.statfs.mockRejectedValue(new Error('unreadable root disk'));
    const value=await runner.createRunner().telemetry();
    expect(Object.keys(value).sort()).toEqual([...legacyTelemetry,'deploy'].sort());
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(readLimits).not.toHaveBeenCalled();
  });
  it('reports unreadable opted-in limits as unknown rather than silently using invented limits',async()=>{
    vi.mocked(readLimits).mockResolvedValue({limits:DEFAULT_LIMITS,warnings:['unreadable']});
    expect((await runner.createRunner().telemetry({capabilities:{limits:1}})).limits).toBeNull();
  });
  it('new telemetry client sends the opt-in envelope while accepting an old runner response',async()=>{
    const legacy={sampledAtET:'2026-10-29T21:40:00.000-04:00',cores:8,loadPerCore:0.12,
      memFreePct:96,activeRuns:0,activeRunIds:[],recent:[]};
    expect(Object.keys(legacy).sort()).toEqual(legacyTelemetry);
    const end=vi.fn(),exec=vi.fn((_file,_args,_options,done)=>{
      done(null,JSON.stringify(legacy));return {stdin:{end,on:vi.fn()}};
    });
    expect(await readForgeTelemetry({exec})).toEqual(legacy);
    expect(exec.mock.calls[0][1].at(-1)).toBe('sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs telemetry');
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({capabilities:{limits:1,deploy:1}});
    const policy=resolveAdmissionPolicy();
    expect(resolveRemoteSlotUnits({policy,kind:'FULL',telemetry:legacy})).toEqual({units:3,source:'setting'});
  });
  it('production stdin decoder accepts a new opt-in envelope and treats legacy EOF as no capabilities',async()=>{
    expect(await runner.readTelemetryRequest(Readable.from(['{"capabilities":{"limits":1,"deploy":1}}']))).toEqual({capabilities:{limits:1,deploy:1}});
    expect(await runner.readTelemetryRequest(Readable.from([]))).toEqual({});
  });
  it.each(['broken','x'.repeat(1025)])('invalid or oversized telemetry envelopes stay legacy: %s',async input=>{
    expect(await runner.readTelemetryRequest(Readable.from([input]))).toEqual({});
  });
  it('bounds a legacy open stdin without waiting indefinitely for an opt-in',async()=>{
    vi.useFakeTimers();
    const input=new PassThrough(),pending=runner.readTelemetryRequest(input);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({});input.destroy();
  });
  it.each([undefined,{}, {taskPressure:true},{taskPressure:'1'}])
  ('production receipt serializer preserves the exact legacy schema without a valid opt-in: %j',capabilities=>{
    const prepared={v:1,nonce:expected.nonce,run:expected.run,slot:'forge-exec-1',slotUnits:3,receiptCapabilities:capabilities};
    const receipt=runner.createRunReceipt(prepared,payload,runner.taskPressureNote(5850,6144));
    expect(Object.keys(receipt).sort()).toEqual(legacyReceipt);
    expect(verifyReceipt(JSON.stringify(receipt),expected,0)).toBe(true);
  });
  describe('production prepare validates an elastic grant against operator limits',()=>{
    const nonce='a'.repeat(32);
    it('unreadable limits reject the grant and leave no run state',async()=>{
      vi.mocked(readLimits).mockResolvedValue({limits:DEFAULT_LIMITS,warnings:['unreadable']});
      await expect(runner.createRunner().prepare({nonce,slotUnits:3})).rejects.toThrow('Unreadable elastic limits');
      expect(readLimits).toHaveBeenCalledTimes(1);
      for(const [file] of io.writeFile.mock.calls)expect(String(file)).not.toMatch(/\.prepared$/);
    });
    it.each([
      ['parent below the grant',{parent:{cpuQuota:'2000%'}},'Slot units exceed parent CPU quota'],
      ['unreadable parent quota',{parent:{cpuQuota:'bad'}},'Slot units exceed parent CPU quota'],
      ['unreadable memory cap',{slot:{...DEFAULT_LIMITS.slot,memoryMax:'bad'}},'Unreadable slot memory limit'],
    ])('rejects a grant with %s',async(_name,override,message)=>{
      vi.mocked(readLimits).mockResolvedValue({limits:{...DEFAULT_LIMITS,...override},warnings:[]});
      await expect(runner.createRunner().prepare({nonce,slotUnits:3})).rejects.toThrow(message);
    });
    it('a single unit never reads operator limits',async()=>{
      await runner.createRunner().prepare({nonce,slotUnits:1}).catch(()=>{});
      expect(readLimits).not.toHaveBeenCalled();
    });
  });
  it('production receipt serializer emits all four diagnostic fields only for a declared capability',()=>{
    const receipt=runner.createRunReceipt({v:1,nonce:expected.nonce,run:expected.run,slotUnits:3,
      receiptCapabilities:{taskPressure:1}},payload,runner.taskPressureNote(5850,6144));
    expect(receipt).toMatchObject({processCount:5850,tasksMax:6144,tasksNear:true,tasksNote:expect.any(String)});
    expect(receipt).not.toHaveProperty('receiptCapabilities');expect(receipt).not.toHaveProperty('slotUnits');
    expect(verifyReceipt(JSON.stringify(receipt),expected,0)).toBe(true);
  });
});

const installedSet = {forgeSetSha:'a'.repeat(40),setDigest:'b'.repeat(64),hostTier:1};
const installedState = {...installedSet,schema:1,installedAtET:'2026-11-03T15:00:00.000-05:00'};
function stateFile(text, {size=Buffer.byteLength(text),isFile=true}={}) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return {stat:async()=>({size,isFile:()=>isFile}),close:vi.fn(),read:vi.fn(async (buffer,start,length)=>{
    const count = bytes.copy(buffer,start,offset,offset+length);
    offset += count;
    return {bytesRead:count};
  })};
}
function injectState(file) {
  const original = io.open.getMockImplementation();
  io.open.mockImplementation((path,...args)=>path==='installed-state.json' ?
    (file instanceof Error ? Promise.reject(file) : Promise.resolve(file)) : original(path,...args));
}
describe('S0 installed-set capability negotiation',()=>{
  it.each(['symlink','directory'])('refuses a real %s state.json without throwing or publishing installed evidence',async kind=>{
    const fs=await vi.importActual('node:fs/promises');
    const root=await fs.mkdtemp(join(tmpdir(),'forge-deploy-state-'));
    const path=join(root,'state.json');
    try {
      if (kind==='symlink') {
        const target=join(root,'installed.json');
        await fs.writeFile(target,JSON.stringify(installedState));
        await fs.symlink(target,path);
      } else await fs.mkdir(path);
      const original=io.open.getMockImplementation();
      io.open.mockImplementation((name,...args)=>name===path ? fs.open(name,...args) : original(name,...args));
      const value=await runner.createRunner({testDeployStatePath:path}).telemetry({capabilities:{deploy:1}});
      expect(value.deploy).toEqual({draining:false});
      expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });
  it.each(['stat','read'])('omits installed evidence when state.json %s fails without throwing',async operation=>{
    const file=stateFile(JSON.stringify(installedState));
    file[operation]=vi.fn().mockRejectedValue(new Error(`injected ${operation} failure`));
    injectState(file);
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(value.deploy).toEqual({draining:false});
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(file[operation]).toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('still returns fully-read evidence when closing state.json fails, without throwing',async()=>{
    const file=stateFile(JSON.stringify(installedState));
    file.close=vi.fn().mockRejectedValue(new Error('injected close failure'));
    injectState(file);
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(value.deploy).toMatchObject({forgeSetSha:installedState.forgeSetSha});
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('adds installed evidence only to an opted-in response, preserving draining and the cached base',async()=>{
    const file = stateFile(JSON.stringify(installedState));
    injectState(file);
    const value = await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1,limits:1}});
    expect(value.deploy).toEqual({draining:false,...installedSet});
    expect(value.limits).toBeTruthy();
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(file.close).toHaveBeenCalledTimes(1);
    for (const [,text] of io.writeFile.mock.calls) expect(JSON.parse(text).deploy).toEqual({draining:false});
    const output = vi.fn();
    await telemetryMain(['--json'],{read:async()=>value,write:output});
    expect(JSON.parse(output.mock.calls[0][0]).deploy.forgeSetSha).toBe(installedSet.forgeSetSha);
  });
  it.each([undefined,null,{}, {capabilities:{deploy:true}},{capabilities:{deploy:'1'}},{capabilities:{limits:1}}])
  ('old Mac / new Forge keeps identical serialized output without deploy:1: %j',async request=>{
    injectState(stateFile(JSON.stringify(installedState)));
    const server = runner.createRunner({testDeployStatePath:'installed-state.json',clock:()=>1793736000000});
    const legacy = await server.telemetry();
    const value = await server.telemetry(request);
    if (request?.capabilities?.limits===1) delete value.limits;
    expect(JSON.stringify(value)).toBe(JSON.stringify(legacy));
    expect(io.open.mock.calls.some(([path])=>path==='installed-state.json')).toBe(false);
  });
  it.each([
    ['missing',()=>new Error('ENOENT')], ['unreadable',()=>new Error('EACCES')],
    ['malformed',()=>stateFile('{')], ['truncated',()=>stateFile(JSON.stringify(installedState).slice(0,-1))],
    ['oversized stat',()=>stateFile(' ',{size:4097})],
    ['wrong file type',()=>stateFile('{}',{isFile:false})],
    ['wrong JSON type',()=>stateFile('null')], ['array',()=>stateFile('[]')],
    ['wrong schema',()=>stateFile(JSON.stringify({...installedState,schema:2}))],
    ['wrong field type',()=>stateFile(JSON.stringify({...installedState,hostTier:'1'}))],
    ['invalid SHA',()=>stateFile(JSON.stringify({...installedState,forgeSetSha:'bad'}))],
    ['invalid digest',()=>stateFile(JSON.stringify({...installedState,setDigest:'bad'}))],
    ['missing field',()=>stateFile(JSON.stringify(installedSet))],
    ['unknown key',()=>stateFile(JSON.stringify({...installedState,extra:true}))],
    ['invalid time',()=>stateFile(JSON.stringify({...installedState,installedAtET:'bad'}))],
  ])('omits installed evidence for %s state, still returning telemetry',async(_label,fixture)=>{
    const file=fixture();injectState(file);
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(value.deploy).toEqual({draining:false});
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    if (!(file instanceof Error)) expect(file.close).toHaveBeenCalledOnce();
  });
  it('caps cumulative requested and read bytes at 4097 when state grows beyond its reported size',async()=>{
    const file=stateFile(' '.repeat(16384),{size:1});
    injectState(file);
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(file.read).toHaveBeenCalledOnce();
    const [buffer,start,length,position]=file.read.mock.calls[0];
    expect(buffer.length).toBe(4097);
    expect({start,length,position}).toEqual({start:0,length:4097,position:null});
    const requested=file.read.mock.calls.reduce((total,call)=>total+call[2],0);
    const reads=await Promise.all(file.read.mock.results.map(result=>result.value));
    const returned=reads.reduce((total,result)=>total+result.bytesRead,0);
    expect(requested).toBe(4097);
    expect(returned).toBe(4097);
    expect(value.deploy).toEqual({draining:false});
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('rejects invalid UTF-8 inside installedAtET before JSON parsing while preserving unrelated telemetry',async()=>{
    const raw=Buffer.from(JSON.stringify(installedState));
    const timestampStart=raw.indexOf(installedState.installedAtET);
    expect(timestampStart).toBeGreaterThan(0);
    raw[timestampStart]=0xc3;
    raw[timestampStart+1]=0x28; // Invalid continuation byte, inside a JSON string.
    const decoded=raw.toString('utf8');
    expect(Buffer.from(decoded).equals(raw)).toBe(false);
    // Replacement decoding still yields syntactically valid JSON; this tests
    // encoding refusal independently of the later ET schema validation.
    expect(JSON.parse(decoded).forgeSetSha).toBe(installedSet.forgeSetSha);
    const parse=vi.spyOn(JSON,'parse');
    const file=stateFile(raw);
    injectState(file);
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(parse).not.toHaveBeenCalledWith(decoded);
    expect(file.read).toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
    expect(value.deploy).toEqual({draining:false});
    expect(value).toMatchObject({activeRuns:0,diskUsedPct:35});
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it('accepts null installed hashes and the exact 4 KiB boundary',async()=>{
    const state={...installedState,forgeSetSha:null,setDigest:null};
    injectState(stateFile(JSON.stringify(state).padEnd(4096,' ')));
    const value=await runner.createRunner({testDeployStatePath:'installed-state.json'}).telemetry({capabilities:{deploy:1}});
    expect(value.deploy).toEqual({draining:false,forgeSetSha:null,setDigest:null,hostTier:1});
  });
});
