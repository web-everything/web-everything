import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { checkPr, main, matchesGlob } from '../d-r379-check.mjs';
import { createCheckDeps } from '../d-r379-check-io.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const settings = JSON.parse(readFileSync(fileURLToPath(new NodeURL('../../settings/d-r379-protected-paths.json', import.meta.url))));
const fixture = pr => JSON.parse(readFileSync(fileURLToPath(new NodeURL(`../__fixtures__/d-r379/${pr}.json`, import.meta.url))));
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
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>`---\nkind: decision\nstatus: ${status}\n---\n`});
    expect(condition(await checkPr(1,d),3).status).toBe('FAIL');
  });
  it.each(['resolved','ratified'])('ratified decision %s passes', async status => {
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>`---\nkind: decision\nstatus: ${status}\n---\n`});
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

describe('bounded descriptor evidence reader', () => {
  const limit = 8 * 1024 * 1024;
  const missing = () => { throw Object.assign(new Error('missing preference'), {code:'ENOENT'}); };
  it('caps requested and consumed bytes at MAX_BYTES + 1 when evidence grows after fstat', () => {
    const reads = [], closed = [];
    let consumed = 0;
    const fs = {
      constants: {O_RDONLY:0, O_NONBLOCK:2048},
      openSync: () => 71,
      fstatSync: fd => { expect(fd).toBe(71); return {size:1,isFile:()=>true}; },
      readSync: (fd, buffer, offset, length, position) => {
        reads.push({fd,offset,length,position});
        // The opened ledger has grown beyond the limit since the descriptor stat.
        buffer.fill(120, offset, offset + length);
        consumed += length;
        return length;
      },
      closeSync: fd => closed.push(fd),
      readFileSync: () => { throw Error('unbounded read forbidden'); },
    };
    const d = createCheckDeps({fs, env:{}, stderr:()=>{}});
    expect(() => d.readSettings()).toThrow(/human review/);
    expect(reads).toEqual([{fd:71,offset:0,length:limit+1,position:null}]);
    expect(consumed).toBe(limit+1);
    expect(closed).toEqual([71]);
  });
  it('keeps the opened descriptor through path replacement and bounds every partial read range', () => {
    const original = Buffer.from(JSON.stringify(settings));
    let pathContent = original, openedContent, position = 0;
    const reads = [], closed = [];
    const fs = {
      constants: {O_RDONLY:0, O_NONBLOCK:2048},
      openSync: path => {
        if (!String(path).endsWith('/d-r379-protected-paths.json')) return missing();
        openedContent = pathContent;
        return 72;
      },
      fstatSync: () => {
        pathContent = Buffer.from('replacement that is not valid JSON');
        return {size:original.length,isFile:()=>true};
      },
      readSync: (fd, buffer, offset, length, at) => {
        expect(fd).toBe(72); expect(at).toBeNull();
        reads.push({offset,length});
        const count = Math.min(31, length, openedContent.length-position);
        openedContent.copy(buffer, offset, position, position+count);
        position += count;
        return count;
      },
      closeSync: fd => closed.push(fd),
      readFileSync: () => { throw Error('path must never be reopened for reading'); },
    };
    expect(createCheckDeps({fs,env:{},stderr:()=>{}}).readSettings()).toEqual(settings);
    expect(pathContent).not.toEqual(original);
    expect(position).toBe(original.length);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every(({offset,length}) => offset+length === limit+1)).toBe(true);
    expect(closed).toEqual([72]);
  });
});

describe('eligibility guard regression guarantees', () => {
  it.each([
    ['default Git configuration', {}],
    ['explicit Git configuration', {GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'diff.renames',GIT_CONFIG_VALUE_0:'true',
      GIT_CONFIG_KEY_1:'user.name',GIT_CONFIG_VALUE_1:'fixture'}],
  ])('rejects a protected-source rename with %s and preserves existing configuration', async (_name, env) => {
    const f = fixture(6223), originalEnv = {...env};
    const index = Number(env.GIT_CONFIG_COUNT ?? 0);
    const adapter = createCheckDeps({env,exec:(_bin,args,options)=>{
      expect(options.env).toMatchObject({ ...originalEnv, GIT_CONFIG_COUNT: String(index + 1) });
      expect(options.env.GIT_CONFIG_COUNT).toBe(String(index+1));
      expect(options.env[`GIT_CONFIG_KEY_${index}`]).toBe('diff.renames');
      expect(options.env[`GIT_CONFIG_VALUE_${index}`]).toBe('false');
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return f.headRefOid;
      if (args[0] === 'merge-base') return 'a'.repeat(40);
      if (args[0] === 'diff') {
        const preserveSource = options.env[`GIT_CONFIG_VALUE_${index}`] === 'false';
        return `${preserveSource ? 'scripts/guard-bash.mjs\0' : ''}docs/moved.md\0`;
      }
      throw Error('unexpected command');
    }});
    const r = await checkPr(6223,deps(f,{fetchNetDiff:adapter.fetchNetDiff}));
    expect(condition(r,4)).toMatchObject({status:'FAIL',evidence:['protected path: scripts/guard-bash.mjs']});
    expect(r.eligible).toBe(false);
    expect(env).toEqual(originalEnv);
  });
  it('rejects labels from a moved PR head and leaves eligibility closed', async () => {
    const adapter = createCheckDeps({exec:()=>JSON.stringify({labels:fixture(6223).labels,headRefOid:'f'.repeat(40)})});
    const r = await checkPr(6223,deps(undefined,{readLabels:adapter.readLabels}));
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('labels unavailable');
    expect(r.eligible).toBe(false);
  });
  it('refuses a mismatched fetched head before issuing any merge-base or diff command', async () => {
    const calls = [];
    const adapter = createCheckDeps({exec:(_bin,args)=>{
      calls.push(args[0]);
      return args[0] === 'rev-parse' ? 'f'.repeat(40) : '';
    }});
    const r = await checkPr(6223,deps(undefined,{fetchNetDiff:adapter.fetchNetDiff}));
    expect(calls).toEqual(['fetch','fetch','rev-parse']);
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,4).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
  it.each([
    ['missing path policy', {readSettings:()=>({})}],
    ['incomplete path policy', {readSettings:()=>({...settings,protectedPaths:[]})}],
    ['malformed diff', {fetchNetDiff:()=>['../AGENTS.md']}],
    ['missing diff', {fetchNetDiff:()=>null}],
  ])('refuses eligibility for %s', async (_name, overrides) => {
    const r = await checkPr(6223,deps(undefined,overrides));
    expect(r.eligible).toBe(false);
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,4).status).toBe('UNKNOWN');
    expect(condition(r,4).evidence.join(' ')).toContain('human review');
  });
  it.each(['title','body','headRefOid'])('returns error without approval for incomplete PR %s', async field => {
    const f = {...fixture(6223),[field]:null};
    let output = '';
    expect(await main(['--pr=6223','--json'],deps(f,{stdout:s=>{output+=s;}}))).toBe(2);
    expect(output).toBe('');
  });
  it('keeps eligibility closed for malformed canonical audit evidence', async () => {
    const r = await checkPr(6223,deps(undefined,{readAudits:()=>null}));
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
  it('selects latest canonical audit by time across bases rather than append order or foreign hash', async () => {
    const head = fixture(6223).headRefOid;
    const records = [
      audit(head,{base:'b'.repeat(40),at:'2026-11-02T12:00:00Z',verdict:'WEAKENED'}),
      audit(head,{at:'2026-11-02T11:00:00Z'}),
      audit(head,{at:'2026-11-02T13:00:00Z',questionHash:'foreign'}),
    ];
    const r = await checkPr(6223,deps(undefined,{readAudits:()=>records}));
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:['latest audit: WEAKENED']});
    expect(r.eligible).toBe(false);
  });
  it('breaks canonical audit timestamp ties by last append even across bases', async () => {
    const head = fixture(6223).headRefOid;
    const records = [audit(head),audit(head,{base:'b'.repeat(40),verdict:'WEAKENED'})];
    const r = await checkPr(6223,deps(undefined,{readAudits:()=>records}));
    expect(condition(r,2).status).toBe('FAIL');
    expect(r.eligible).toBe(false);
  });
  it('allows the newer canonical clear to supersede a prior weakened audit on the same base', async () => {
    const head = fixture(6223).headRefOid;
    const records = [audit(head,{verdict:'WEAKENED'}),audit(head,{at:'2026-11-02T11:00:00Z'})];
    const r = await checkPr(6223,deps(undefined,{readAudits:()=>records}));
    expect(condition(r,2).status).toBe('PASS');
    expect(r.eligible).toBe(true);
  });
});
