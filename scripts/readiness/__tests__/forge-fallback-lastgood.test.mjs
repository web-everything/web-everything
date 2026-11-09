// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {checkRemoteHealth} from '../forge-remote-health.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {resolveAdmissionPolicy, formatAdmissionPolicy, runWithRemoteDecision} from '../heavy-admission.mjs';

const roots=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const now=Date.parse('2026-11-09T12:00:00-05:00');
const sample=(at=now, patch={})=>({sampledAtET:easternTimestamp(at),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[],...patch});
const settings={backoffMs:120000,backoffFailures:3,maxLoadPerCore:0.8,minFreeRamPct:15,lastGoodMaxAgeMin:10};
const scratch=()=>{const root=mkdtempSync(join(process.env.TMPDIR,'forge-lastgood-'));roots.push(root);return root;};
const saved=root=>JSON.parse(readFileSync(join(root,'health.json'),'utf8'));
function healthFixture() {
  const root=scratch();let time=now;
  const sleep=vi.fn(async()=>{});
  return {root,sleep,advance:ms=>{time+=ms;},
    check:(readTelemetry,overrides={})=>checkRemoteHealth({root,settings,clock:()=>time,sleep,readTelemetry,...overrides})};
}
const offline=()=>vi.fn(async()=>{throw new Error('forge-unreachable');});

describe('Forge transient read fallback',()=>{
  it('persists last-good telemetry and uses it after two failed reads without extending its age',async()=>{
    const f=healthFixture();
    expect(await f.check(async()=>sample())).toEqual({ok:true});
    expect(saved(f.root)).toMatchObject({lastGoodAt:now,lastGoodTelemetry:sample()});
    f.advance(60000);
    const read=offline();
    expect(await f.check(read)).toEqual({ok:true,lastGood:true});
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.sleep).toHaveBeenCalledWith(500);
    expect(saved(f.root)).toMatchObject({lastGoodAt:now,lastGoodTelemetry:sample(),backoffUntil:0});
  });
  it('retries exactly once and fails closed as forge-unreachable without last-good',async()=>{
    const f=healthFixture(),read=offline();
    expect(await f.check(read)).toEqual({ok:false,reason:'forge-unreachable'});
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.sleep).toHaveBeenCalledWith(500);
  });
  it.each([
    ['malformed schema',async()=>({invalid:true})],
    ['unparseable reply',async()=>{throw new SyntaxError('Unexpected token');}],
    ['unknown read error',async()=>{throw new Error('unknown');}],
  ])('fails closed on %s despite last-good, including a transport failure on retry',async(_name,badRead)=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(60000);
    const read=vi.fn().mockImplementationOnce(badRead).mockRejectedValue(new Error('forge-unreachable'));
    expect(await f.check(read)).toEqual({ok:false,reason:'forge-unreachable'});
    expect(read).toHaveBeenCalledTimes(2);
    expect(saved(f.root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
    f.advance(settings.backoffMs+1);
    expect(await f.check(offline())).toEqual({ok:false,reason:'forge-unreachable'});
  });
  it.each([600000,600001])('uses an inclusive last-good age cap at %i ms',async age=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(age);
    expect(await f.check(offline())).toEqual(age===600000?{ok:true,lastGood:true}:{ok:false,reason:'forge-unreachable'});
  });
  it('hard-caps last-good at thirty minutes even when a caller bypasses setting validation',async()=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(1800001);
    expect(await f.check(offline(),{settings:{...settings,lastGoodMaxAgeMin:1440}}))
      .toEqual({ok:false,reason:'forge-unreachable'});
  });
  it('rejects repeated malformed replies despite a recent last-good sample',async()=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(60000);
    const read=vi.fn(async()=>({invalid:true}));
    expect(await f.check(read)).toEqual({ok:false,reason:'forge-unreachable'});
    expect(read).toHaveBeenCalledTimes(2);
    expect(saved(f.root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
  });
  it('recovers on the single retry with fresh telemetry',async()=>{
    const f=healthFixture(),read=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(sample());
    expect(await f.check(read)).toEqual({ok:true});
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('keeps fresh reads fail-closed when their age is non-finite',async()=>{
    const f=healthFixture(),clock=vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(NaN).mockReturnValue(now);
    expect(await f.check(async()=>sample(),{clock})).toEqual({ok:false,reason:'telemetry-stale'});
  });
  it('does not renew last-good time when serving the ten-second cache',async()=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(9999);
    const read=offline();expect(await f.check(read)).toEqual({ok:true});
    expect(read).not.toHaveBeenCalled();expect(saved(f.root).lastGoodAt).toBe(now);
  });
  it.each([['maxLoadPerCore',{loadPerCore:0.9}],['minFreeRamPct',{memFreePct:10}]])
  ('never overrides explicit %s telemetry with last-good',async(reason,patch)=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(60000);
    const read=vi.fn(async()=>sample(now+60000,patch));
    expect(await f.check(read)).toEqual({ok:false,reason});
    expect(read).toHaveBeenCalledTimes(1);
    expect(await f.check(offline())).toEqual({ok:false,reason:`backoff-${reason}`});
    expect(saved(f.root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
  });
  it.each([
    ['maxLoadPerCore',{loadPerCore:0.9},now+60000],
    ['minFreeRamPct',{memFreePct:10},now+60000],
    ['telemetry-stale',{},now],
  ])('invalidates last-good after %s refusal and fails closed after backoff expires',async(reason,patch,sampledAt)=>{
    const f=healthFixture();
    expect(await f.check(async()=>sample())).toEqual({ok:true});
    f.advance(60000);
    expect(await f.check(async()=>sample(sampledAt,patch))).toEqual({ok:false,reason});
    expect(saved(f.root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
    f.advance(120001);
    const read=offline();
    expect(await f.check(read)).toEqual({ok:false,reason:'forge-unreachable'});
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.sleep).toHaveBeenCalledWith(500);
    expect(saved(f.root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
  });
  it('still rejects stale successful reads even with last-good',async()=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(60000);
    expect(await f.check(async()=>sample())).toEqual({ok:false,reason:'telemetry-stale'});
  });
  it('evaluates last-good telemetry against current thresholds',async()=>{
    const f=healthFixture();await f.check(async()=>sample());f.advance(60000);
    expect(await f.check(offline(),{settings:{...settings,minFreeRamPct:95}})).toEqual({ok:false,reason:'minFreeRamPct'});
  });
  it('migrates legacy state and preserves its last-good time',async()=>{
    const f=healthFixture();
    writeFileSync(join(f.root,'health.json'),JSON.stringify({v:1,lastReadAt:now,telemetry:sample(),failures:0,backoffUntil:0,trigger:''}));
    f.advance(60000);
    expect(await f.check(offline())).toEqual({ok:true,lastGood:true});
    expect(saved(f.root)).toMatchObject({lastGoodAt:now,lastGoodTelemetry:sample()});
  });
  it('rejects unknown persisted state keys without reading telemetry',async()=>{
    const f=healthFixture();await f.check(async()=>sample());
    writeFileSync(join(f.root,'health.json'),JSON.stringify({...saved(f.root),unknown:true}));
    const read=offline();expect(await f.check(read)).toEqual({ok:false,reason:'remote-health-unreadable'});
    expect(read).not.toHaveBeenCalled();
  });
});

describe('last-good setting provenance',()=>{
  it('defaults to ten minutes and logs platform overrides',()=>{
    const standard=resolveAdmissionPolicy({env:{}});
    expect(standard.settings.remote.lastGoodMaxAgeMin).toBe(10);
    expect(formatAdmissionPolicy(standard)).toContain('remote.lastGoodMaxAgeMin=10 (standard)');
    const policy=resolveAdmissionPolicy({platform:{remote:{lastGoodMaxAgeMin:2}},env:{}});
    expect(policy.settings.remote.lastGoodMaxAgeMin).toBe(2);
    expect(formatAdmissionPolicy(policy)).toContain('remote.lastGoodMaxAgeMin=2 (platform)');
  });
  it('accepts the thirty-minute maximum',()=>{
    expect(resolveAdmissionPolicy({platform:{remote:{lastGoodMaxAgeMin:30}},env:{}}).settings.remote.lastGoodMaxAgeMin).toBe(30);
  });
  it.each([-1,0,31,1440,1441,Infinity,'10'])('rejects invalid/oversized last-good bound %s with visible default',value=>{
    const policy=resolveAdmissionPolicy({platform:{remote:{lastGoodMaxAgeMin:value}},env:{}});
    expect(policy.settings.remote.lastGoodMaxAgeMin).toBe(10);
    expect(formatAdmissionPolicy(policy)).toContain('invalid: platform.remote.lastGoodMaxAgeMin=');
  });
});

function remoteFixture() {
  const root=scratch();
  return {argv:['npx','vitest','run','fixture.test.mjs'],cwd:'fixture-checkout',env:{},
    lockRoot:join(root,'heavy'),clock:()=>now,sleep:vi.fn(async()=>{}),loadPerCore:()=>4,hostOverloaded:()=>false,
    policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always'}},env:{}}),
    readTelemetry:vi.fn(async()=>sample()),remoteExec:vi.fn(),log:vi.fn()};
}
const copyFailed={mode:'not-started',terminated:true,reason:'copy-failed',detail:'fixture.mjs'};
const rows=f=>readFileSync(join(f.lockRoot,'remote-fallbacks.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
describe('legacy migration rejects unusable telemetry',()=>{
  it.each([
    ['stale timestamp',{telemetry:sample(now-30001)},'forge-unreachable'],
    ['future timestamp beyond skew allowance',{telemetry:sample(now+60001)},'forge-unreachable'],
    ['nonempty refusal trigger',{trigger:'maxLoadPerCore'},'forge-unreachable'],
    ['active backoff',{backoffUntil:now+120000},'backoff-'],
  ])('never seeds last-good or dispatches remotely from legacy %s',async(_name,patch,reason)=>{
    const f=remoteFixture(),root=join(f.lockRoot,'..','remote');mkdirSync(root);
    writeFileSync(join(root,'health.json'),JSON.stringify({v:1,lastReadAt:now,telemetry:sample(),
      failures:0,backoffUntil:0,trigger:'',...patch}));
    f.clock=()=>now+60000;f.readTelemetry=offline();
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(saved(root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(rows(f)).toEqual([expect.objectContaining({reason})]);
    expect(f.log).toHaveBeenLastCalledWith(expect.stringContaining(reason));
    if(patch.backoffUntil){
      expect(f.readTelemetry).not.toHaveBeenCalled();
      // Expiring the backoff must not make its rejected legacy sample usable.
      f.clock=()=>patch.backoffUntil+1;
      expect(await runWithRemoteDecision(f)).toEqual({handled:false});
      expect(saved(root)).toMatchObject({lastGoodAt:null,lastGoodTelemetry:null});
      expect(f.remoteExec).not.toHaveBeenCalled();
      expect(rows(f).at(-1)).toMatchObject({reason:'forge-unreachable'});
      expect(f.log).toHaveBeenLastCalledWith(expect.stringContaining('forge-unreachable'));
    }
    expect(f.readTelemetry).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.sleep).toHaveBeenCalledWith(500);
  });
});
describe('remote copy retry and fallback evidence',()=>{
  it('retries copy-failed exactly once then records and logs local fallback reason and retried marker',async()=>{
    const f=remoteFixture();f.remoteExec.mockResolvedValue(copyFailed);
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
    expect(saved(join(f.lockRoot,'..','remote')).failures).toBe(1);
    expect(rows(f)).toEqual([expect.objectContaining({reason:'copy-failed',retried:true,detail:'fixture.mjs'})]);
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/copy-failed.*retry/i));
    expect(f.log).toHaveBeenLastCalledWith(expect.stringMatching(/copy-failed.*retried.*falling back to local/i));
  });
  it('returns remote when the copy retry succeeds',async()=>{
    const f=remoteFixture();f.remoteExec.mockResolvedValueOnce(copyFailed).mockImplementation(async()=>{
      expect(saved(join(f.lockRoot,'..','remote')).failures).toBe(1);
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0,remoteResult:{mode:'remote',code:0}});
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
    expect(saved(join(f.lockRoot,'..','remote'))).toMatchObject({failures:0,backoffUntil:0,trigger:''});
    expect(existsSync(join(f.lockRoot,'remote-fallbacks.jsonl'))).toBe(false);
  });
  it.each([
    {mode:'not-started',terminated:true,reason:'forge-busy'},
    {mode:'cancelled',terminated:true,reason:'copy-failed'},
  ])('does not retry other confirmed refusals: %j',async result=>{
    const f=remoteFixture();f.remoteExec.mockResolvedValue(result);
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(rows(f)[0].reason).toBe(result.reason);
  });
  it.each([false,undefined])('never retries an unconfirmed copy termination (%s)',async terminated=>{
    const f=remoteFixture();f.remoteExec.mockResolvedValue({...copyFailed,terminated});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:124});
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(existsSync(join(f.lockRoot,'remote-fallbacks.jsonl'))).toBe(false);
  });
  it('refuses local execution if the retry has unconfirmed termination',async()=>{
    const f=remoteFixture();f.remoteExec.mockResolvedValueOnce(copyFailed).mockResolvedValue({...copyFailed,terminated:false});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:124});
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
    expect(existsSync(join(f.lockRoot,'remote-fallbacks.jsonl'))).toBe(false);
  });
  it('records and logs forge-unreachable on health failure without dispatching',async()=>{
    const f=remoteFixture();f.readTelemetry=offline();
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.readTelemetry).toHaveBeenCalledTimes(2);
    expect(rows(f)).toEqual([expect.objectContaining({reason:'forge-unreachable'})]);
    expect(f.log).toHaveBeenLastCalledWith(expect.stringMatching(/forge-unreachable.*falling back to local/i));
  });
  it('dispatches remotely on last-good health after persistent read failure',async()=>{
    const f=remoteFixture(),root=join(roots.at(-1),'remote');mkdirSync(root);
    await checkRemoteHealth({root,settings,clock:()=>now,readTelemetry:async()=>sample()});
    f.clock=()=>now+60000;f.readTelemetry=offline();f.remoteExec.mockResolvedValue({mode:'remote',code:0});
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.readTelemetry).toHaveBeenCalledTimes(2);
  });
});
