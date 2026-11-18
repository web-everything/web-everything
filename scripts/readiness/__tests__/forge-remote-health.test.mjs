// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {checkRemoteHealth,recordRemoteResult,peekRemoteTelemetry} from '../forge-remote-health.mjs';

const roots=[];
const scratch=()=>{const root=mkdtempSync(join(process.env.TMPDIR,'forge-health-quar-'));roots.push(root);return root;};
afterEach(()=>{vi.restoreAllMocks();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const now=Date.parse('2026-10-29T12:00:00.000-04:00');
const settings={backoffMs:120000,maxLoadPerCore:0.8,minFreeRamPct:15};
const sample=(over={})=>({sampledAtET:easternTimestamp(now),cores:8,loadPerCore:0.12,memFreePct:96,activeRuns:0,recent:[],...over});
const check=(root,t)=>checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>t,ping:async()=>false});
const invalid=root=>readdirSync(root).filter(n=>n.startsWith('health-g2.json.invalid-')).sort();
const legacy=()=>({v:1,lastReadAt:now,telemetry:sample(),failures:0,backoffUntil:0,trigger:'',lastGoodAt:now,lastGoodTelemetry:sample()});

describe('health state generation isolation',()=>{
  it.each(['forge','other-forge'])('seeds an active legacy breaker for %s without carrying telemetry or touching legacy bytes',async host=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const root=scratch(),suffix=host==='forge'?'':'-'+createHash('sha256').update(host).digest('hex');
    const file=join(root,`health${suffix}.json`),read=vi.fn(async()=>sample());
    const bytes=JSON.stringify({...legacy(),telemetry:{invalid:true},failures:3,backoffUntil:now+60000,trigger:'copy-failed'},null,2)+'\n';
    writeFileSync(file,bytes);
    expect(await checkRemoteHealth({root,host,settings,clock:()=>now,readTelemetry:read})).toEqual({ok:false,reason:'backoff-copy-failed'});
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root,`health-g2${suffix}.json`),'utf8'))).toEqual({
      v:1,lastReadAt:null,telemetry:null,failures:3,backoffUntil:now+60000,trigger:'copy-failed',
    });
    expect(readFileSync(file,'utf8')).toBe(bytes);
    expect(readdirSync(root).filter(n=>n.includes('.invalid-'))).toEqual([]);
  });
  it.each([
    ['invalid JSON','not json'],
    ['null','null'],
    ['unsafe timestamp',JSON.stringify({...legacy(),backoffUntil:Number.MAX_SAFE_INTEGER+1})],
    ['oversized',' '.repeat(70001)],
  ])('seeds nothing from %s legacy state and leaves it untouched',async(_label,bytes)=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const root=scratch(),file=join(root,'health.json'),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    writeFileSync(file,bytes);
    expect(await checkRemoteHealth({root,settings,clock:()=>now-1000,readTelemetry:async()=>sample()})).toEqual({ok:true});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toEqual({
      v:1,lastReadAt:now-1000,telemetry:sample(),failures:0,backoffUntil:0,trigger:'',
    });
    expect(readFileSync(file,'utf8')).toBe(bytes);
    expect(readdirSync(root).filter(n=>n.includes('.invalid-'))).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
  it('seeds failures-only legacy state so the next failure reaches the breaker threshold',async()=>{
    const root=scratch(),file=join(root,'health.json');
    const bytes=JSON.stringify({...legacy(),failures:1});
    writeFileSync(file,bytes);
    expect(await check(root,sample())).toEqual({ok:true});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toEqual({
      v:1,lastReadAt:now,telemetry:sample(),failures:1,backoffUntil:0,trigger:'',
    });
    await recordRemoteResult({root,settings:{...settings,backoffFailures:2},clock:()=>now,
      result:{mode:'not-started',terminated:true,reason:'copy-failed'}});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toMatchObject({
      failures:2,backoffUntil:now+settings.backoffMs,trigger:'copy-failed',
    });
    expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it.each([
    ['expired',now-1,now-1],
    ['expires now',now,now],
    ['missing',undefined,0],
    ['string',String(now+60000),0],
    ['negative',-1,0],
    ['fractional',1.5,0],
    ['unsafe',Number.MAX_SAFE_INTEGER+1,0],
  ])('seeds valid failures and trigger independently of a %s legacy timestamp',async(_label,backoffUntil,expectedBackoff)=>{
    const root=scratch(),file=join(root,'health.json');
    const bytes=JSON.stringify({...legacy(),failures:1,backoffUntil,trigger:'copy-failed'});
    writeFileSync(file,bytes);
    expect(await check(root,sample())).toEqual({ok:true});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toEqual({
      v:1,lastReadAt:now,telemetry:sample(),failures:1,backoffUntil:expectedBackoff,trigger:'copy-failed',
    });
    expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('seeds defaults for malformed legacy breaker fields without importing telemetry',async()=>{
    const root=scratch(),file=join(root,'health.json'),fresh=sample({loadPerCore:0.25}),read=vi.fn(async()=>fresh);
    const bytes=JSON.stringify({...legacy(),failures:'2',backoffUntil:-1,trigger:'bad trigger'});
    writeFileSync(file,bytes);
    expect(await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:read})).toEqual({ok:true});
    expect(read).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toEqual({
      v:1,lastReadAt:now,telemetry:fresh,failures:0,backoffUntil:0,trigger:'',
    });
    expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it.each([
    [-1,'copy-failed',0,'copy-failed'],
    [1.5,'copy-failed',0,'copy-failed'],
    [Number.MAX_SAFE_INTEGER+1,'copy-failed',0,'copy-failed'],
    [4,'bad trigger',4,''],
    [4,'x'.repeat(81),4,''],
    [4,123,4,''],
  ])('validates legacy breaker fields independently (%#)',async(failures,trigger,expectedFailures,expectedTrigger)=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const root=scratch();
    writeFileSync(join(root,'health.json'),JSON.stringify({failures,trigger,backoffUntil:now+60000}));
    expect(await check(root,sample())).toEqual({ok:false,reason:`backoff-${expectedTrigger}`});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'))).toEqual({
      v:1,lastReadAt:null,telemetry:null,failures:expectedFailures,backoffUntil:now+60000,trigger:expectedTrigger,
    });
  });
  it('ignores legacy read errors silently without quarantining the legacy path',async()=>{
    const root=scratch(),file=join(root,'health.json'),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    symlinkSync(join(root,'missing-target'),file);
    expect(await check(root,sample())).toEqual({ok:true});
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readdirSync(root).filter(n=>n.includes('.invalid-'))).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
  it('does not reseed an existing g2 state from an active legacy breaker',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const root=scratch();
    expect(await check(root,sample())).toEqual({ok:true});
    writeFileSync(join(root,'health.json'),JSON.stringify({...legacy(),failures:3,backoffUntil:now+60000,trigger:'copy-failed'}));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8')).backoffUntil).toBe(0);
  });
  it.each(['not json',JSON.stringify(legacy())])('leaves legacy state untouched: %s',async bytes=>{
    const root=scratch(),file=join(root,'health.json');
    writeFileSync(file,bytes);
    expect(peekRemoteTelemetry({root})).toBe(null);
    expect(await check(root,sample())).toEqual({ok:true});
    await recordRemoteResult({root,settings,result:{mode:'remote',code:0}});
    expect(peekRemoteTelemetry({root})).toEqual(sample());
    expect(readFileSync(file,'utf8')).toBe(bytes);
    expect(readdirSync(root).filter(n=>n.startsWith('health.json.invalid-'))).toEqual([]);
    expect(existsSync(join(root,'health-g2.json'))).toBe(true);
  });
  it('isolates other hosts using the generation and host hash for writes and peeks',async()=>{
    const root=scratch(),host='other-forge',hash=createHash('sha256').update(host).digest('hex');
    const file=join(root,`health-${hash}.json`);
    writeFileSync(file,'not json');
    expect(peekRemoteTelemetry({root,host})).toBe(null);
    expect(await checkRemoteHealth({root,host,settings,clock:()=>now,readTelemetry:async()=>sample()})).toEqual({ok:true});
    expect(peekRemoteTelemetry({root,host})).toEqual(sample());
    expect(peekRemoteTelemetry({root})).toBe(null);
    expect(readFileSync(file,'utf8')).toBe('not json');
    expect(readdirSync(root).filter(n=>n.startsWith(`health-${hash}.json.invalid-`))).toEqual([]);
    expect(existsSync(join(root,`health-g2-${hash}.json`))).toBe(true);
  });
});

describe('malformed Forge health state',()=>{
  it('quarantines extra-key state and passes on a fresh good read',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),JSON.stringify(legacy()));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(invalid(root)).toHaveLength(1);
    const state=JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8'));
    expect(Object.keys(state).sort()).toEqual(['backoffUntil','failures','lastReadAt','telemetry','trigger','v']);
    expect(JSON.parse(readFileSync(join(root,invalid(root)[0]),'utf8')).lastGoodAt).toBe(now);
  });
  it('still falls back when telemetry is bad after quarantine',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),JSON.stringify(legacy()));
    expect(await check(root,sample({loadPerCore:5}))).toEqual({ok:false,reason:'maxLoadPerCore',detail:'quarantined:invalid state'});
    expect(invalid(root)).toHaveLength(1);
  });
  it('carries valid failure and backoff evidence across quarantine, never old telemetry',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch(),read=vi.fn(async()=>sample());
    writeFileSync(join(root,'health-g2.json'),JSON.stringify({...legacy(),failures:2,backoffUntil:now+60000,trigger:'copy-failed'}));
    expect(await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:read,ping:async()=>false})).toEqual({ok:false,reason:'backoff-copy-failed',detail:'quarantined:invalid state'});
    expect(read).not.toHaveBeenCalled();
    expect(invalid(root)).toHaveLength(1);
  });
  it('preserves quarantine and probe details within 300 characters',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),JSON.stringify(legacy()));
    const result=await checkRemoteHealth({root,settings,clock:()=>now,ping:async()=>false,readTelemetry:async()=>{
      const error=new Error('forge-unreachable');error.detail='x'.repeat(1000);throw error;
    }});
    expect(result).toEqual({ok:false,reason:'forge-unreachable',detail:'x'.repeat(200)+'; quarantined:invalid state'});
    expect(result.detail.length).toBeLessThanOrEqual(300);
  });
  it.each(['clock failed','x'.repeat(1000)])('bounds caught-error detail and preserves quarantine detail (%#)',async detail=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),JSON.stringify(legacy()));
    const result=await checkRemoteHealth({root,settings,clock:()=>{const error=new Error('clock failed');error.detail=detail;throw error;}});
    expect(result).toEqual({ok:false,reason:'remote-health-unreadable',detail:detail.slice(0,273)+'; quarantined:invalid state'});
    expect(result.detail.length).toBeLessThanOrEqual(300);
  });
  it('keeps only the newest 3 quarantined files',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();
    for(let i=0;i<5;i++){
      writeFileSync(join(root,'health-g2.json'),'not json');
      await check(root,sample());
      await new Promise(r=>setTimeout(r,5));
    }
    expect(invalid(root)).toHaveLength(3);
  });
  it('quarantines a symlink without following it',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch(),target=join(root,'target.txt');
    writeFileSync(target,JSON.stringify({v:1}));symlinkSync(target,join(root,'health-g2.json'));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(lstatSync(join(root,invalid(root)[0])).isSymbolicLink()).toBe(true);
    expect(readFileSync(target,'utf8')).toBe('{"v":1}');
    expect(lstatSync(join(root,'health-g2.json')).isFile()).toBe(true);
  });
  it('quarantines an oversized file',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),'x'.repeat(80000));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(invalid(root)).toHaveLength(1);
    expect(existsSync(join(root,'health-g2.json'))).toBe(true);
  });
  it('logs an operator-visible line',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health-g2.json'),'{}');
    await check(root,sample());
    expect(log.mock.calls.join('\n')).toMatch(/quarantined malformed state/);
  });
});

describe('forge-unreachable backoff is short, lifted by a good probe, and carries detail',()=>{
  const down=()=>{const e=new Error('forge-unreachable');e.transport=true;e.detail='ssh exit 255: Connection closed by 148.251.135.244 port 22';return e;};
  it('backs off only briefly after an unreachable read and reports the probe error',async()=>{
    const root=scratch();
    const r=await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>{throw down();},ping:async()=>false});
    expect(r.ok).toBe(false);expect(r.reason).toBe('forge-unreachable');
    expect(r.detail).toContain('Connection closed');
    expect(JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8')).backoffUntil-now).toBeLessThanOrEqual(15000);
  });
  it('keeps the backoff while the host still fails the probe',async()=>{
    const root=scratch();
    await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>{throw down();},ping:async()=>false});
    const r=await checkRemoteHealth({root,settings,clock:()=>now+1000,readTelemetry:async()=>sample({sampledAtET:easternTimestamp(now+1000)}),ping:async()=>false});
    expect(r.reason).toBe('backoff-forge-unreachable');
  });
  it('lifts the backoff when the next probe succeeds',async()=>{
    const root=scratch();
    await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>{throw down();},ping:async()=>false});
    const t=now+1000;
    const r=await checkRemoteHealth({root,settings,clock:()=>t,readTelemetry:async()=>sample({sampledAtET:easternTimestamp(t)}),ping:async()=>true});
    expect(r).toEqual({ok:true});
  });
  it('does not lift a load backoff on a good ping',async()=>{
    const root=scratch();
    await check(root,sample({loadPerCore:5}));
    const r=await checkRemoteHealth({root,settings,clock:()=>now+1000,readTelemetry:async()=>sample(),ping:async()=>true});
    expect(r.reason).toBe('backoff-maxLoadPerCore');
  });
});

describe('repeated forge-unreachable failures keep backing off',()=>{
  it('grows 15s,30s,60s,120s and caps at the full backoff',async()=>{
    const root=scratch();let t=now;const waits=[];
    const down=async()=>{const e=new Error('forge-unreachable');e.transport=true;throw e;};
    for(let i=0;i<6;i++){
      await checkRemoteHealth({root,settings,clock:()=>t,readTelemetry:down,ping:async()=>false});
      const until=JSON.parse(readFileSync(join(root,'health-g2.json'),'utf8')).backoffUntil;waits.push(until-t);t=until;
    }
    expect(waits).toEqual([15000,30000,60000,120000,120000,120000]);
  });
  it('an unreachable run result never relabels or shortens an active load backoff',async()=>{
    const root=scratch();
    await check(root,sample({loadPerCore:5}));
    for(let i=0;i<3;i++)await recordRemoteResult({root,settings:{...settings,backoffFailures:3},clock:()=>now+1000,result:{mode:'not-started',terminated:true,reason:'forge-unreachable'}});
    const r=await checkRemoteHealth({root,settings,clock:()=>now+2000,readTelemetry:async()=>sample(),ping:async()=>true});
    expect(r.reason).toBe('backoff-maxLoadPerCore');
  });
});
