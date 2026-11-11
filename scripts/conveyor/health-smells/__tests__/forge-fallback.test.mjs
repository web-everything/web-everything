// @vitest-environment node
import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import smell from '../forge-fallback.mjs';
import {probeForgeFallback,forgeFallbackEventLine} from '../../forge-down-probe.mjs';
import {loadForgeShareSettings} from '../../../lib/forge-share.mjs';
import {resolveAdmissionPolicy,formatAdmissionPolicy} from '../../../readiness/heavy-admission.mjs';
import {NOTIFY_EVEN_IN_SHADOW} from '../../health-smells-notify-list.mjs';
import {validateSmellShape} from '../../health-smells-shape.mjs';
import {SMELLS} from '../index.mjs';
import {emptyHealthState,stepEpisodes,planActions} from '../../health-watch-core.mjs';
const roots=[],now=Date.parse('2026-11-10T13:00:00Z');
const at=min=>new Date(now-min*60000).toISOString();
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(values=[]) {
  const lockRoot=mkdtempSync(join(process.env.TMPDIR,'forge-fallback-'));roots.push(lockRoot);
  const file=join(lockRoot,'remote-fallbacks.jsonl');
  writeFileSync(file,[{ts:at(300),reason:'history-start'},...values].map(r=>JSON.stringify(r)+'\n').join(''));
  return {lockRoot,now,settings:resolveAdmissionPolicy({}).settings.remote,
    expectedLocalReasons:loadForgeShareSettings().expectedLocalReasons,file};
}
it('registers a high host blocker with shape contract and immediate shadow notification',()=>{
  expect(validateSmellShape(smell,'forge-fallback.mjs')).toBe(smell);
  expect(SMELLS).toContain(smell);
  expect(smell).toMatchObject({scope:'host',severity:'high',action:'alert',openAfter:1,probes:['forgeFallback']});
  expect(NOTIFY_EVEN_IN_SHADOW.has(smell.id)).toBe(true);
  const results=smell.evaluate({forgeFallback:probeForgeFallback(fixture([{ts:at(1),reason:'ENOENT'}]))});
  const stepped=stepEpisodes(emptyHealthState(),[{smell,results}],now);
  expect(planActions(stepped.transitions,{[smell.id]:smell},{mode:'shadow'}))
    .toContainEqual(expect.objectContaining({kind:'notify',suppressed:null}));
});
it('fires on a replayed fallback window with counts per normalized reason and latest top detail',()=>{
  const p=probeForgeFallback(fixture([
    {ts:at(20),reason:'old'}, {ts:at(15),reason:'boundary'}, {ts:at(-1),reason:'future'},
    {ts:at(4),reason:'remote-full (30s wait exhausted)',detail:'old detail'},
    {ts:at(3),reason:'ENOENT',detail:'ssh missing'},
    {ts:at(2),reason:'remote-full',detail:'tests/fixture.test.mjs'},
  ]));
  expect(p).toMatchObject({status:'ok',breach:true,topReason:'remote-full',
    byReason:{'remote-full':2,ENOENT:1},topDetail:'tests/fixture.test.mjs'});
  expect(forgeFallbackEventLine(p)).toBe('FORGE-FALLBACK remote full x2 in the last 15 min (ENOENT x1); top detail: tests/fixture.test.mjs');
});
it('stays quiet on a covered empty window',()=>{
  const p=probeForgeFallback(fixture());
  expect(p).toMatchObject({status:'ok',breach:false,byReason:{}});
  expect(forgeFallbackEventLine(p)).toBeNull();
});
it('never counts intended local reasons or explicitly justified local runs',()=>{
  const f=fixture([
    {ts:at(1),reason:'command-not-allowed: browser fixture'},
    {ts:at(2),reason:'needs-git'},
    {ts:at(3),reason:'remote-full',localJustification:'Mac browser support probe'},
  ]);
  expect(probeForgeFallback(f)).toMatchObject({breach:false,byReason:{}});
  // A blank justification does not hide an unintended fallback.
  writeFileSync(f.file,JSON.stringify({ts:at(300),reason:'history-start'})+'\n'+JSON.stringify({ts:at(1),reason:'remote-full',localJustification:'  '})+'\n');
  expect(probeForgeFallback(f).breach).toBe(true);
});
it('keeps dynamic reason and detail text free of monitor filter words and terminal controls',()=>{
  const p=probeForgeFallback(fixture([{ts:at(1),reason:'waiting-refused',detail:'red-team\n\u001b[31m needs-decision tests/my-file.test.mjs'}]));
  const line=forgeFallbackEventLine(p);
  expect(line).toContain('waiting refused x1');
  expect(line).toContain('red team');
  expect(line.slice('FORGE-FALLBACK'.length)).not.toMatch(/-|[\x00-\x1f\x7f-\x9f]/);
});
it('fails closed with operator escalation on missing, empty, rotated, corrupt, torn and oversized histories',()=>{
  const f=fixture();rmSync(f.file);
  expect(forgeFallbackEventLine(probeForgeFallback(f))).toContain('FORGE-FALLBACK UNKNOWN');
  for(const text of ['',JSON.stringify({ts:at(1),reason:'recent'})+'\n','bad\n',
    JSON.stringify({ts:at(300),reason:'history-start'})+'\n{torn',
    JSON.stringify({ts:at(300),reason:null})+'\n',
    (JSON.stringify({ts:at(1),reason:'recent',padding:'x'.repeat(10000)})+'\n').repeat(430)]) {
    writeFileSync(f.file,text);
    const p=probeForgeFallback(f);
    expect(p).toMatchObject({status:'unknown',breach:true});
    expect(forgeFallbackEventLine(p)).toContain('restore admission history');
  }
  expect(smell.evaluate()[0]).toMatchObject({breach:true,measure:{status:'unknown'}});
});
it('uses the admission setting cascade with provenance, validates bounds and honors the configured window',()=>{
  const p=resolveAdmissionPolicy({platform:{remote:{forgeFallbackMinutes:5}}});
  expect(p.settings.remote.forgeFallbackMinutes).toBe(5);
  expect(formatAdmissionPolicy(p)).toContain('remote.forgeFallbackMinutes=5 (platform)');
  for(const value of [-1,0,1441,'15']) {
    expect(resolveAdmissionPolicy({platform:{remote:{forgeFallbackMinutes:value}}}).invalid)
      .toContainEqual(expect.stringContaining('forgeFallbackMinutes'));
  }
  const f=fixture([{ts:at(10),reason:'ENOENT'}]);
  expect(probeForgeFallback(f).breach).toBe(true);
  expect(probeForgeFallback({...f,settings:p.settings.remote}).breach).toBe(false);
  expect(probeForgeFallback({...f,settings:{forgeFallbackMinutes:0}})).toMatchObject({status:'unknown',breach:true});
});
