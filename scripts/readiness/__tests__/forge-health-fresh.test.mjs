// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {easternTimestamp, parseTelemetry} from '../forge-exec-run.mjs';
import {checkRemoteHealth} from '../forge-remote-health.mjs';

const roots=[];
const scratch=()=>{const root=mkdtempSync(join(process.env.TMPDIR,'forge-health-fresh-'));roots.push(root);return root;};
afterEach(()=>{
  vi.unstubAllEnvs();
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
const now=Date.parse('2026-10-29T12:00:00.000-04:00');
const settings={backoffMs:120000,maxLoadPerCore:0.8,minFreeRamPct:15};
const sample=(ms=now)=>({sampledAtET:easternTimestamp(ms),cores:8,loadPerCore:0.12,memFreePct:96,activeRuns:0,recent:[]});
const saved=(telemetry,lastReadAt)=>({v:1,lastReadAt,telemetry,failures:0,backoffUntil:0,trigger:''});
const persist=(root,state)=>writeFileSync(join(root,'health.json'),JSON.stringify(state));
const load=root=>JSON.parse(readFileSync(join(root,'health.json'),'utf8'));
const check=(root,readTelemetry,time=now)=>checkRemoteHealth({root,settings,clock:()=>time,readTelemetry});

describe('Forge health freshness',()=>{
  it.each([now-60000,now-1000])('refreshes stale persisted telemetry exactly once with lastReadAt=%s',async lastReadAt=>{
    const root=scratch(),fresh=sample(),readTelemetry=vi.fn(async()=>fresh);
    persist(root,saved(sample(now-60000),lastReadAt));
    expect(await check(root,readTelemetry)).toEqual({ok:true});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
    expect(readTelemetry).toHaveBeenCalledWith({host:'forge'});
    expect(load(root)).toEqual(saved(fresh,now));
  });

  it.each([
    [-60001,false],[-60000,true],[-5000,true],[0,true],[30000,true],[30001,false],
  ])('judges sample age %s ms with inclusive skew and staleness bounds',async(age,fresh)=>{
    const root=scratch(),readTelemetry=vi.fn(async()=>sample(now-age));
    expect(await check(root,readTelemetry)).toEqual(fresh?{ok:true}:{ok:false,reason:'telemetry-stale'});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
    if(!fresh)expect(load(root)).toMatchObject({trigger:'telemetry-stale',backoffUntil:now+settings.backoffMs});
  });

  it.each([
    ['maxLoadPerCore',{loadPerCore:0.95}],['minFreeRamPct',{memFreePct:14}],
  ])('keeps %s backoff without another telemetry read',async(reason,patch)=>{
    const root=scratch(),readTelemetry=vi.fn(async()=>({...sample(),...patch}));
    expect(await check(root,readTelemetry)).toEqual({ok:false,reason});
    expect(load(root)).toMatchObject({trigger:reason,backoffUntil:now+settings.backoffMs});
    expect(await check(root,readTelemetry,now+settings.backoffMs-1)).toEqual({ok:false,reason:`backoff-${reason}`});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
  });

  it.each(['offline','still-stale'])('refreshes a stale cached sample once and fails closed when %s',async outcome=>{
    const root=scratch(),readTelemetry=vi.fn(async()=>{
      if(outcome==='offline')throw new Error('offline');
      return sample(now-30001);
    });
    persist(root,saved(sample(now-60000),now-1000));
    const reason=outcome==='offline'?'forge-unreachable':'telemetry-stale';
    expect(await check(root,readTelemetry)).toEqual({ok:false,reason});
    expect(load(root)).toMatchObject({lastReadAt:now,trigger:reason,backoffUntil:now+settings.backoffMs});
    expect(await check(root,readTelemetry,now+10000)).toEqual({ok:false,reason:`backoff-${reason}`});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
  });

  it('reports a cold-start read failure as forge-unreachable',async()=>{
    const readTelemetry=vi.fn(async()=>{throw new Error('offline');});
    expect(await check(scratch(),readTelemetry)).toEqual({ok:false,reason:'forge-unreachable'});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a non-finite age without a second read',async()=>{
    const root=scratch(),readTelemetry=vi.fn(async()=>sample());
    const clock=vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(NaN).mockReturnValue(now);
    expect(await checkRemoteHealth({root,settings,clock,readTelemetry})).toEqual({ok:false,reason:'telemetry-stale'});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
    expect(load(root)).toMatchObject({trigger:'telemetry-stale',backoffUntil:now+settings.backoffMs});
  });

  it('shares a stale-cache refresh under the mutex and keeps fresh data cached for ten seconds',async()=>{
    const root=scratch(),readTelemetry=vi.fn(async()=>sample());
    persist(root,saved(sample(now-60000),now-1000));
    expect(await Promise.all([check(root,readTelemetry),check(root,readTelemetry)])).toEqual([{ok:true},{ok:true}]);
    expect(await check(root,readTelemetry,now+9999)).toEqual({ok:true});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
    expect(await check(root,readTelemetry,now+10000)).toEqual({ok:true});
    expect(readTelemetry).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['2026-11-15T09:00:00.000-05:00','2026-11-15T14:00:00.000Z',-5000],
    ['2026-11-15T09:00:00.000-05:00','2026-11-15T14:00:00.000Z',5000],
    ['2026-07-15T09:00:00.000-04:00','2026-07-15T13:00:00.000Z',-5000],
    ['2026-07-15T09:00:00.000-04:00','2026-07-15T13:00:00.000Z',5000],
  ])('compares %s to %s in Europe/Paris with clock offset %s ms',async(et,utc,offset)=>{
    vi.stubEnv('TZ','Europe/Paris');
    const instant=Date.parse(et);
    expect(instant).toBe(Date.parse(utc));
    const value=sample(instant);
    expect(value.sampledAtET).toBe(et);
    const readTelemetry=vi.fn(async()=>value);
    expect(await check(scratch(),readTelemetry,instant+offset)).toEqual({ok:true});
    expect(readTelemetry).toHaveBeenCalledTimes(1);
  });
});

describe('Forge optional prewarmed telemetry',()=>{
  const recent=()=>({code:0,runId:'r-'+'a'.repeat(32),stageMs:{install:1000,run:4000},startedAtET:easternTimestamp(now-5000)});
  it.each([true,false])('accepts a boolean prewarmed=%s while preserving legacy entries',prewarmed=>{
    const value={...sample(),recent:[recent(),{...recent(),prewarmed}]};
    expect(parseTelemetry(JSON.stringify(value))).toEqual(value);
  });
  it.each([null,0,1,'true',{},[]])('rejects non-boolean prewarmed=%j',prewarmed=>{
    expect(()=>parseTelemetry(JSON.stringify({...sample(),recent:[{...recent(),prewarmed}]}))).toThrow('Invalid telemetry schema');
  });
  it.each([{extra:true},{stageMs:{install:1000,run:4000,extra:0}},{code:256},{runId:'invalid'}])
  ('keeps recent entry validation strict with prewarmed: %j',patch=>{
    expect(()=>parseTelemetry(JSON.stringify({...sample(),recent:[{...recent(),prewarmed:true,...patch}]}))).toThrow('Invalid telemetry schema');
  });
});
