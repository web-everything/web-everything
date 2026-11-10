// @vitest-environment node
import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import smell from '../forge-down.mjs';
import {probeForgeDown,forgeDownEventLine} from '../../forge-down-probe.mjs';
import {NOTIFY_EVEN_IN_SHADOW} from '../../health-smells-notify-list.mjs';
import {validateSmellShape} from '../../health-smells-shape.mjs';
import {SMELLS} from '../index.mjs';
const roots=[],now=Date.parse('2026-11-10T13:00:00Z');
const settings={forgeDownMinutes:15,forgeDownShare:0.3,forgeDownMinRuns:5};
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(){const lockRoot=mkdtempSync(join(process.env.TMPDIR,'forge-down-'));roots.push(lockRoot);
 for(const name of ['remote-runs.jsonl','remote-fallbacks.jsonl','durations.jsonl'])writeFileSync(join(lockRoot,name),'');
 return {lockRoot,now,settings};}
function rows(f,name,values){writeFileSync(join(f.lockRoot,name),values.map(r=>JSON.stringify(r)+'\n').join(''));}
const at=min=>new Date(now-min*60000).toISOString();
it('registers high host alert, shadow notification, and shape contract',()=>{
 expect(validateSmellShape(smell,'forge-down.mjs')).toBe(smell);expect(SMELLS).toContain(smell);
 expect(smell).toMatchObject({scope:'host',severity:'high',probes:['forgeDown']});expect(NOTIFY_EVEN_IN_SHADOW.has(smell.id)).toBe(true);
});
it('fires on a replayed 35 minute outage and prints the operator FORGE-DOWN summary',()=>{
 const f=fixture();writeFileSync(join(f.lockRoot,'remote-fallbacks.jsonl'),readFileSync(new URL('./fixtures/forge-down-outage.jsonl',import.meta.url)));
 const p=probeForgeDown(f);expect(p).toMatchObject({breach:true,topReason:'ENOENT',span:35*60000});
 expect(smell.evaluate({forgeDown:p})[0].breach).toBe(true);expect(forgeDownEventLine(p)).toBe(`FORGE-DOWN ${p.summary}`);
});
it('stays quiet on a healthy window, including infra failures before its remote success',()=>{
 const f=fixture();rows(f,'remote-fallbacks.jsonl',[{ts:at(50),reason:'ENOENT'},{ts:at(30),reason:'ENOENT'}]);
 rows(f,'remote-runs.jsonl',Array.from({length:5},(_,i)=>({ts:at(i+1),ms:60000})));
 const p=probeForgeDown(f);expect(p.breach).toBe(false);expect(forgeDownEventLine(p)).toBe(null);
});
it('uses heavy minutes rather than run count and respects minimum volume and threshold',()=>{
 const f=fixture();rows(f,'remote-runs.jsonl',Array.from({length:5},()=>({ts:at(1),ms:1000})));
 rows(f,'durations.jsonl',[{at:at(1),ms:60000}]);
 expect(probeForgeDown(f)).toMatchObject({breach:true,runs:6});
 expect(probeForgeDown({...f,settings:{...settings,forgeDownMinRuns:7}}).breach).toBe(false);
 expect(probeForgeDown({...f,settings:{...settings,forgeDownShare:0.01}}).breach).toBe(false);
});
it('surfaces a failed canary and clears it after a later passing canary',()=>{
 const f=fixture();rows(f,'forge-canary.jsonl',[{ts:at(2),result:'fail',reason:'install-failed'}]);
 expect(forgeDownEventLine(probeForgeDown(f))).toContain('canary failed (install-failed)');
 rows(f,'forge-canary.jsonl',[{ts:at(2),result:'fail'},{ts:at(1),result:'pass'}]);expect(probeForgeDown(f).breach).toBe(false);
});
it('fails closed on missing, corrupt, invalid-duration and oversized incomplete histories',()=>{
 const f=fixture();rmSync(join(f.lockRoot,'remote-runs.jsonl'));expect(probeForgeDown(f).status).toBe('unknown');
 writeFileSync(join(f.lockRoot,'remote-runs.jsonl'),JSON.stringify({ts:at(1),ms:1})+'\n{torn');expect(probeForgeDown(f).status).toBe('unknown');
 writeFileSync(join(f.lockRoot,'remote-runs.jsonl'),'bad\n');expect(probeForgeDown(f).breach).toBe(true);
 rows(f,'remote-runs.jsonl',[{ts:at(1),ms:null}]);expect(probeForgeDown(f).status).toBe('unknown');
 const row=JSON.stringify({ts:at(1),ms:1,padding:'x'.repeat(10000)})+'\n';
 writeFileSync(join(f.lockRoot,'remote-runs.jsonl'),row.repeat(430));
 expect(probeForgeDown(f)).toMatchObject({status:'unknown',breach:true});
});

it('honors a configured outage span longer than the fixed share window',()=>{
 const f=fixture();rows(f,'remote-fallbacks.jsonl',[{ts:at(100),reason:'ENOENT'},{ts:at(5),reason:'ENOENT'}]);
 expect(probeForgeDown({...f,settings:{...settings,forgeDownMinutes:90}})).toMatchObject({breach:true,span:95*60000});
});

it('breaches after the configured outage duration when breaker-open fallbacks continue without completed runs',()=>{
 const f=fixture();
 const configured={...settings,forgeDownMinutes:20,backoffMs:30*60000};
 rows(f,'remote-fallbacks.jsonl',[
  {ts:at(30),reason:'ENOENT'},
  {ts:at(29.9),reason:'install-failed',detail:'code 97'},
  {ts:at(29.8),reason:'forge-unreachable'},
  {ts:at(29),reason:'forge-breaker-open'},
  {ts:at(20),reason:'forge-breaker-open'},
  {ts:at(10),reason:'forge-breaker-open'},
 ]);
 const boundary=now-10*60000;
 expect(probeForgeDown({...f,settings:configured,now:boundary-1})).toMatchObject({status:'ok',breach:false,runs:0,share:null});
 const p=probeForgeDown({...f,settings:configured,now:boundary});
 expect(p).toMatchObject({status:'ok',breach:true,runs:0,share:null,span:20*60000,topReason:'forge-breaker-open'});
 expect(smell.evaluate({forgeDown:p})[0].breach).toBe(true);
 expect(forgeDownEventLine(p)).toContain('FORGE-DOWN Forge infrastructure outage');
 expect(p.summary).toContain('top fallback: forge-breaker-open');
 // A later completed remote run ends the outage even though breaker refusals remain in the history.
 rows(f,'remote-runs.jsonl',[{ts:at(5),ms:1000}]);
 expect(probeForgeDown({...f,settings:configured})).toMatchObject({breach:false,span:0,runs:1});
});
