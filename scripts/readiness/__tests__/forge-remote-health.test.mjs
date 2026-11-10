// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {checkRemoteHealth} from '../forge-remote-health.mjs';

const roots=[];
const scratch=()=>{const root=mkdtempSync(join(process.env.TMPDIR,'forge-health-quar-'));roots.push(root);return root;};
afterEach(()=>{vi.restoreAllMocks();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const now=Date.parse('2026-10-29T12:00:00.000-04:00');
const settings={backoffMs:120000,maxLoadPerCore:0.8,minFreeRamPct:15};
const sample=(over={})=>({sampledAtET:easternTimestamp(now),cores:8,loadPerCore:0.12,memFreePct:96,activeRuns:0,recent:[],...over});
const check=(root,t)=>checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>t,ping:async()=>false});
const invalid=root=>readdirSync(root).filter(n=>n.startsWith('health.json.invalid-')).sort();
const legacy=()=>({v:1,lastReadAt:now,telemetry:sample(),failures:0,backoffUntil:0,trigger:'',lastGoodAt:now,lastGoodTelemetry:sample()});

describe('malformed Forge health state',()=>{
  it('quarantines extra-key state and passes on a fresh good read',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health.json'),JSON.stringify(legacy()));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(invalid(root)).toHaveLength(1);
    const state=JSON.parse(readFileSync(join(root,'health.json'),'utf8'));
    expect(Object.keys(state).sort()).toEqual(['backoffUntil','failures','lastReadAt','telemetry','trigger','v']);
    expect(JSON.parse(readFileSync(join(root,invalid(root)[0]),'utf8')).lastGoodAt).toBe(now);
  });
  it('still falls back when telemetry is bad after quarantine',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health.json'),JSON.stringify(legacy()));
    expect(await check(root,sample({loadPerCore:5}))).toEqual({ok:false,reason:'maxLoadPerCore'});
    expect(invalid(root)).toHaveLength(1);
  });
  it('keeps only the newest 3 quarantined files',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();
    for(let i=0;i<5;i++){
      writeFileSync(join(root,'health.json'),'not json');
      await check(root,sample());
      await new Promise(r=>setTimeout(r,5));
    }
    expect(invalid(root)).toHaveLength(3);
  });
  it('quarantines a symlink without following it',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch(),target=join(root,'target.txt');
    writeFileSync(target,JSON.stringify({v:1}));symlinkSync(target,join(root,'health.json'));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(lstatSync(join(root,invalid(root)[0])).isSymbolicLink()).toBe(true);
    expect(readFileSync(target,'utf8')).toBe('{"v":1}');
    expect(lstatSync(join(root,'health.json')).isFile()).toBe(true);
  });
  it('quarantines an oversized file',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health.json'),'x'.repeat(80000));
    expect(await check(root,sample())).toEqual({ok:true});
    expect(invalid(root)).toHaveLength(1);
    expect(existsSync(join(root,'health.json'))).toBe(true);
  });
  it('logs an operator-visible line',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const root=scratch();writeFileSync(join(root,'health.json'),'{}');
    await check(root,sample());
    expect(log.mock.calls.join('\n')).toMatch(/quarantined malformed state/);
  });
});
