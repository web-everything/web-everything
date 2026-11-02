import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkPr, main, matchesGlob } from '../d-r379-check.mjs';
import { createCheckDeps } from '../d-r379-check-io.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const settings = JSON.parse(readFileSync(new URL('../../settings/d-r379-protected-paths.json', import.meta.url)));
const fixture = pr => JSON.parse(readFileSync(new URL(`../__fixtures__/d-r379/${pr}.json`, import.meta.url)));
const audit = (head, extra = {}) => ({ head, base: 'a'.repeat(40), at: '2026-11-02T10:00:00Z',
  verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, findings: [], ...extra });
function deps(f = fixture(6223), overrides = {}) {
  return { readPr: async () => f, readLabels: async () => f.labels,
    fetchNetDiff: async () => f.netDiffPaths, readAudits: async () => [audit(f.headRefOid)],
    readSettings: async () => settings, readHeadFile: async () => '---\ntype: story\nstatus: open\n---\n',
    stdout: () => {}, stderr: () => {}, ...overrides };
}
const condition = (result, id) => result.conditions.find(c => c.id === id);
describe('D-R379 synthetic PR scenarios (not captured PR evidence)', () => {
  it('6223 scenario: seven harmless paths pass conditions 1–4', async () => {
    const r = await checkPr(6223, deps());
    expect(r.eligible).toBe(true);
    expect(r.netDiffPaths).toHaveLength(7);
    expect(r.conditions.slice(0, 4).map(c => c.status)).toEqual(['PASS','PASS','PASS','PASS']);
  });
  it.each([[6188,4],[6195,3]])('%s scenario fails condition %s', async (pr, id) => {
    expect(condition(await checkPr(pr, deps(fixture(pr))), id).status).toBe('FAIL');
  });
});
describe('fail-closed evidence', () => {
  it('fetch failure is UNKNOWN and ineligible', async () => {
    const r = await checkPr(1, deps(undefined, { fetchNetDiff: async () => { throw Error(); } }));
    expect(r.eligible).toBe(false); expect(condition(r,3).status).toBe('UNKNOWN');
  });
  it('three-dot inflated files never leak into net diff', async () => {
    const f = { ...fixture(6223), files: [{path:'AGENTS.md'}] };
    expect((await checkPr(1,deps(f))).eligible).toBe(true);
  });
  it.each(['red-team:held','red-team:pending','review:changes'])('rejects %s', async label => {
    expect(condition(await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,label]})),2).status).toBe('FAIL');
  });
  it('review:human alongside acceptance is allowed', async () => {
    expect((await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,'review:human']}))).eligible).toBe(true);
  });
  it('label read failure is UNKNOWN', async () => {
    expect(condition(await checkPr(1,deps(undefined,{readLabels:()=>{throw Error();}})),2).status).toBe('UNKNOWN');
  });
  it('unreadable audits are UNKNOWN', async () => {
    expect(condition(await checkPr(1,deps(undefined,{readAudits:()=>{throw Error();}})),2).status).toBe('UNKNOWN');
  });
  it('latest WEAKENED across distinct bases fails', async () => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(1,deps(undefined,{readAudits:()=>[audit(head),audit(head,{base:'b'.repeat(40),at:'2026-11-02T11:00:00Z',verdict:'WEAKENED'})]}));
    expect(condition(r,2).status).toBe('FAIL');
  });
  it('audit for different head fails', async () => {
    const r = await checkPr(1,deps(undefined,{readAudits:()=>[audit('f'.repeat(40))]}));
    expect(condition(r,2).evidence.join(' ')).toContain('no audit for head');
  });
  it('empty diff is UNKNOWN', async () => {
    const r = await checkPr(1,deps(undefined,{fetchNetDiff:()=>[]}));
    expect(condition(r,4).status).toBe('UNKNOWN'); expect(r.eligible).toBe(false);
  });
  it('oversized diff stays closed and requests human review', async () => {
    const r = await checkPr(1,deps(undefined,{fetchNetDiff:()=>Array(10001).fill('x')}));
    expect(r.eligible).toBe(false); expect(condition(r,4).evidence.join(' ')).toContain('human review');
  });
  it('no direction citation fails', async () => {
    expect(condition(await checkPr(1,deps({...fixture(6223),title:'Fix code',body:''})),1).status).toBe('FAIL');
  });
  it.each(['#123','story 123','focus item 123','D-R379'])('recognizes direction %s', async title => {
    expect(condition(await checkPr(1,deps({...fixture(6223),title,body:''})),1).status).toBe('PASS');
  });
});
describe('direction paths and R391', () => {
  it.each(['> Operator ruling text','Recorded verbatim'])('allows ruling-record with %s', async body => {
    const f = {...fixture(6223),title:'R391 record',body,netDiffPaths:['.operations/rulings.md']};
    expect(condition(await checkPr(1,deps(f)),3)).toMatchObject({status:'PASS',evidence:expect.arrayContaining(['R391 ruling-record'])});
  });
  it.each([
    {title:'R391',body:'paraphrase',netDiffPaths:['rulings.md']},
    {title:'story 391',body:'> quote',netDiffPaths:['rulings.md']},
    {title:'R391',body:'> quote',netDiffPaths:['rulings.md','AGENTS.md']},
    {title:'R391',body:'> quote',netDiffPaths:['src/_data/blocks.json']},
  ])('refuses non-exception %j', async extra => {
    expect(condition(await checkPr(1,deps({...fixture(6223),...extra})),3).status).toBe('FAIL');
  });
  it.each(['open','draft'])('unratified decision %s fails', async status => {
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>`---\ntype: decision\nstatus: ${status}\n---\n`});
    expect(condition(await checkPr(1,d),3).status).toBe('FAIL');
  });
  it.each(['resolved','ratified'])('ratified decision %s passes', async status => {
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>`---\ntype: decision\nstatus: ${status}\n---\n`});
    expect(condition(await checkPr(1,d),3).status).toBe('PASS');
  });
  it('unreadable decision stays UNKNOWN', async () => {
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>{throw Error();}});
    expect(condition(await checkPr(1,d),3).status).toBe('UNKNOWN');
  });
});
describe('glob matching', () => {
  it.each([['guard-x.mjs','**/guard-*.mjs',true],['scripts/guard-x.mjs','**/guard-*.mjs',true],
    ['myguard.txt','**/guard-*.mjs',false],['x/migrations/a.sql','**/migrations/**',true],
    ['src/x/y','src/*',false],['.claude/hooks/a/b','.claude/hooks/**',true]])('%s vs %s', (p,g,want) => {
    expect(matchesGlob(p,g)).toBe(want);
  });
});
describe('CLI and real adapter with injected IO', () => {
  it('validates usage', async () => {
    expect(await main(['--pr=x'],deps())).toBe(2);
    expect(await main(['--pr=1','--pr=2'],deps())).toBe(2);
  });
  it('prints JSON and uses eligibility exit codes', async () => {
    let output='';
    expect(await main(['--pr=6223','--json'],deps(undefined,{stdout:s=>{output+=s;}}))).toBe(0);
    expect(JSON.parse(output)).toMatchObject({pr:6223,eligible:true});
    expect(await main(['--pr=6188'],deps(fixture(6188)))).toBe(1);
  });
  it('fetches main and PR head before exact merge-base diff without gh files', async () => {
    const calls=[]; const head=fixture(6223).headRefOid;
    const d=createCheckDeps({exec:(bin,args)=>{
      calls.push([bin,...args]);
      if(args[0]==='fetch')return '';
      if(args[0]==='rev-parse')return head;
      if(args[0]==='merge-base')return 'a'.repeat(40);
      if(args[0]==='diff')return 'docs/a.md\0docs/b.md\0';
      throw Error('unexpected command');
    }});
    expect(await d.fetchNetDiff(6223,head)).toEqual(['docs/a.md','docs/b.md']);
    expect(calls).toEqual([
      ['git','fetch','origin','main'],['git','fetch','origin','pull/6223/head'],
      ['git','rev-parse','--verify','FETCH_HEAD^{commit}'],['git','merge-base','origin/main',head],
      ['git','diff','a'.repeat(40),head,'--name-only','-z'],
    ]);
  });
  it('fetch head mismatch refuses diff', async () => {
    const d=createCheckDeps({exec:(_b,a)=>a[0]==='rev-parse'?'f'.repeat(40):''});
    await expect(d.fetchNetDiff(1,fixture(6223).headRefOid)).rejects.toThrow();
  });
});
