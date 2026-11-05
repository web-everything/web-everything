// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {Readable, PassThrough} from 'node:stream';
import * as runner from '../forge-exec-run.mjs';
import {DEFAULT_LIMITS, readLimits} from '../forge-exec-limits.mjs';
import {readForgeTelemetry} from '../forge-telemetry.mjs';
import {verifyReceipt} from '../remote-exec.mjs';
import {resolveAdmissionPolicy, resolveRemoteSlotUnits} from '../heavy-admission.mjs';

const io=vi.hoisted(()=>({open:vi.fn(),readdir:vi.fn(),writeFile:vi.fn(),rename:vi.fn(),rm:vi.fn(),lstat:vi.fn(),mkdir:vi.fn()}));
vi.mock('node:fs/promises',async original=>({...await original(),...io}));
vi.mock('../forge-exec-limits.mjs',async original=>({...await original(),readLimits:vi.fn()}));
const legacyTelemetry=['activeRuns','cores','loadPerCore','memFreePct','recent','sampledAtET'];
const legacyReceipt=['argvDigest','code','inputDigest','lock','manifestDigest','nonce','phase','resources','run','timings','v'];
const expected={v:1,nonce:'a'.repeat(32),run:'r-'+'b'.repeat(32),inputDigest:'c'.repeat(64),
  argvDigest:'d'.repeat(64),lock:'e'.repeat(64),manifestDigest:'f'.repeat(64)};
const payload={...expected,phase:'test',code:0,resources:{memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:24},timings:{installMs:1,runMs:2}};
beforeEach(()=>{
  vi.clearAllMocks();
  vi.spyOn(process,'getuid').mockReturnValue(501);
  io.open.mockResolvedValue({stat:async()=>({isDirectory:()=>true,uid:501,gid:process.getgid(),mode:0o40700}),close:async()=>{}});
  io.readdir.mockResolvedValue([]);io.lstat.mockResolvedValue({mode:0o40700});
  vi.mocked(readLimits).mockResolvedValue({limits:DEFAULT_LIMITS,warnings:[]});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

describe('production protocol capability negotiation',()=>{
  it('production telemetry keeps the exact legacy schema without an opt-in request',async()=>{
    const value=await runner.createRunner().telemetry();
    expect(Object.keys(value).sort()).toEqual(legacyTelemetry);
    expect(readLimits).not.toHaveBeenCalled();
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.open).toHaveBeenCalledWith('/srv/forge-exec',expect.any(Number));
  });
  it('production telemetry adds limits only to an opted-in response, never the cached document',async()=>{
    const value=await runner.createRunner().telemetry({capabilities:{limits:1}});
    expect(value.limits).toEqual({parent:{cpuQuota:'2800%'},slot:{cpuQuota:'800%'}});
    expect(readLimits).toHaveBeenCalledTimes(1);
    for(const [,contents] of io.writeFile.mock.calls)expect(Object.keys(JSON.parse(contents)).sort()).toEqual(legacyTelemetry);
    expect(Object.keys(await runner.createRunner().telemetry()).sort()).toEqual(legacyTelemetry);
  });
  it.each([undefined,null,{}, {capabilities:{limits:true}},{capabilities:{limits:'1'}}])
  ('does not negotiate limits from incomplete or mistyped requests: %j',async request=>{
    expect(Object.keys(await runner.createRunner().telemetry(request)).sort()).toEqual(legacyTelemetry);
  });
  it('reports unreadable opted-in limits as unknown rather than silently using invented limits',async()=>{
    vi.mocked(readLimits).mockResolvedValue({limits:DEFAULT_LIMITS,warnings:['unreadable']});
    expect((await runner.createRunner().telemetry({capabilities:{limits:1}})).limits).toBeNull();
  });
  it('new telemetry client sends the opt-in envelope while accepting an old runner response',async()=>{
    const legacy=await runner.createRunner().telemetry();
    const end=vi.fn(),exec=vi.fn((_file,_args,_options,done)=>{
      done(null,JSON.stringify(legacy));return {stdin:{end,on:vi.fn()}};
    });
    expect(await readForgeTelemetry({exec})).toEqual(legacy);
    expect(exec.mock.calls[0][1].at(-1)).toBe('sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs telemetry');
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({capabilities:{limits:1}});
    const policy=resolveAdmissionPolicy();
    expect(resolveRemoteSlotUnits({policy,kind:'FULL',telemetry:legacy})).toEqual({units:3,source:'setting'});
  });
  it('production stdin decoder accepts a new opt-in envelope and treats legacy EOF as no capabilities',async()=>{
    expect(await runner.readTelemetryRequest(Readable.from(['{"capabilities":{"limits":1}}']))).toEqual({capabilities:{limits:1}});
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
  it('production receipt serializer emits all four diagnostic fields only for a declared capability',()=>{
    const receipt=runner.createRunReceipt({v:1,nonce:expected.nonce,run:expected.run,slotUnits:3,
      receiptCapabilities:{taskPressure:1}},payload,runner.taskPressureNote(5850,6144));
    expect(receipt).toMatchObject({processCount:5850,tasksMax:6144,tasksNear:true,tasksNote:expect.any(String)});
    expect(receipt).not.toHaveProperty('receiptCapabilities');expect(receipt).not.toHaveProperty('slotUnits');
    expect(verifyReceipt(JSON.stringify(receipt),expected,0)).toBe(true);
  });
});
