import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { resolve } from 'node:path';
import { checkPr, main, matchesGlob } from '../d-r379-check.mjs';
import { createCheckDeps } from '../d-r379-check-io.mjs';
import { buildVerdictRecord, buildLedgerEvent } from '../../lib/verdict-ledger.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const settings = JSON.parse(readFileSync(fileURLToPath(new NodeURL('../../settings/d-r379-protected-paths.json', import.meta.url))));
const fixture = pr => JSON.parse(readFileSync(fileURLToPath(new NodeURL(`../__fixtures__/d-r379/${pr}.json`, import.meta.url))));
const audit = (head, extra = {}) => ({ head, base: 'a'.repeat(40), at: '2026-11-02T10:00:00Z',
  verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, findings: [], ...extra });
const base = 'a'.repeat(40);
const rulingEntry = '- **R391** (2026-11-02) Operator: "Recorded ruling."\n';
const rulingDiff = added => `diff --git a/record b/record\n--- a/record\n+++ b/record\n@@ -1,0 +2,${added.slice(0, -1).split('\n').length} @@\n${added.slice(0, -1).split('\n').map(line => '+' + line).join('\n')}\n`;
const verdict = (pr, headSha, extra = {}) => buildVerdictRecord({
  repo: CONSTELLATION_REPOS.we.slug, pr, headSha, verdict: 'accepted',
  at: '2026-11-02T10:00:00Z', source: 'd-r379-fixture', writer: 'fixture', ...extra,
});
function deps(f = fixture(6223), overrides = {}) {
  return { readPr: async () => f, readLabels: async () => f.labels,
    fetchNetDiff: async () => ({paths: f.netDiffPaths, base}),
    readLabelEvents: async () => ['review:human','review:pending'].map(name =>
      ({event:'labeled',label:{name},created_at:'2026-11-02T09:00:00Z'})),
    readHeadPushedAt: async () => '2026-11-02T09:30:00Z',
    readReviewLedger: async pr => [verdict(pr, f.headRefOid)], readAudits: async () => [audit(f.headRefOid)],
    readRulingFile: async (sha) => sha === base ? 'Original rule.\n' : `Original rule.\n${rulingEntry}`,
    readRulingDiff: async () => rulingDiff(rulingEntry),
    readRulings: async () => rulingEntry,
    readRulingNumstat: async (_base, _head, paths) => paths.map(path => `1\t0\t${path}\0`).join(''),
    readBaseFile: async () => '---\ntype: story\nstatus: open\n---\n',
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
describe('PR target branch evidence', () => {
  it.each(['release', 'lane/stacked', undefined, null, '', 42, 'MAIN', 'main\n', ' main', 'ｍａｉｎ', 'ma\u200bin'])
    ('refuses target %j before reading a main-based diff', async baseRefName => {
      let fetched = false;
      const f = {...fixture(6223), baseRefName};
      const r = await checkPr(6223, deps(f, {fetchNetDiff: () => {
        fetched = true;
        return {paths:['docs/examples/example.md'],base};
      }}));
      expect(r.eligible).toBe(false);
      expect(condition(r,3).status).toBe('UNKNOWN');
      expect(condition(r,4).status).toBe('UNKNOWN');
      expect(condition(r,4).evidence.join(' ')).toContain('human review');
      expect(r.netDiffPaths).toEqual([]);
      expect(fetched).toBe(false);
    });

  it.each(['main', 'release'])('wires live target %s from the adapter through the JSON CLI', async baseRefName => {
    const f = {...fixture(6223), baseRefName};
    const calls = [];
    const adapter = createCheckDeps({exec:(bin,args) => {
      calls.push([bin,...args]);
      if (bin === 'gh') return JSON.stringify(f);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return f.headRefOid;
      if (args[0] === 'merge-base') return base;
      if (args[0] === 'diff') return 'docs/examples/example.md\0';
      throw Error('unexpected command');
    }});
    let output = '';
    const code = await main(['--pr=6223','--json'],deps(f, {
      readPr:adapter.readPr, readLabels:adapter.readLabels,
      fetchNetDiff:adapter.fetchNetDiff, stdout:s=>{output+=s;},
    }));
    expect(code).toBe(baseRefName === 'main' ? 0 : 1);
    expect(JSON.parse(output).eligible).toBe(baseRefName === 'main');
    expect(calls[0].at(-1).split(',')).toContain('baseRefName');
    expect(calls.some(([bin])=>bin === 'git')).toBe(baseRefName === 'main');
  });

  it.each(['release', undefined, null])('refuses a retargeted or missing live label target %j', async baseRefName => {
    const f = fixture(6223), calls = [];
    const adapter = createCheckDeps({exec:(bin,args)=>{
      calls.push([bin,...args]);
      return JSON.stringify({...f,baseRefName});
    }});
    const r = await checkPr(6223,deps(f,{readLabels:adapter.readLabels}));
    expect(r.eligible).toBe(false);
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(calls[0].at(-1).split(',')).toContain('baseRefName');
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
  it.each(['red-team:held','red-team:pending','red-team:blocked','red-team:future-hold','review:changes','review:blocked','review:held-mechanical','advisory:ruling-needed','advisory:needs-human','advisory:changes'])('rejects %s', async label => {
    expect(condition(await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,label]})),2).status).toBe('FAIL');
  });
  it.each(['review:pending', 'review:human'])('%s coexists with accepted label and current-head ledger acceptance', async label => {
    expect((await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,label]}))).eligible).toBe(true);
  });
  it.each(['review:pending', 'review:human'])('%s needs ledger acceptance even without accepted label', async label => {
    const f = {...fixture(6223),labels:['red-team:clear',label]};
    expect((await checkPr(1,deps(f))).eligible).toBe(true);
  });
  it.each(['review:pending', 'review:human'])('%s without current-head acceptance fails explicitly', async label => {
    const f = {...fixture(6223),labels:['red-team:clear',label]};
    for (const rows of [[], [verdict(1,'f'.repeat(40))]]) {
      const r = await checkPr(1,deps(f,{readReviewLedger:()=>rows}));
      expect(r.eligible).toBe(false);
      expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:expect.arrayContaining(['acceptance not in ledger'])});
    }
  });
  it.each(['review:pending', 'review:human'])('%s cannot bypass a later ledger hold or changes', async label => {
    const f = {...fixture(6223),labels:[...fixture(6223).labels,label]};
    for (const held of ['human','changes']) {
      const r = await checkPr(1,deps(f,{readReviewLedger:()=>[verdict(1,f.headRefOid),
        verdict(1,f.headRefOid,{verdict:held,at:'2026-11-02T11:00:00Z'})]}));
      expect(r.eligible).toBe(false);
      expect(condition(r,2).status).toBe('FAIL');
    }
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
    const r = await checkPr(1,deps(undefined,{fetchNetDiff:()=>({paths:[],base})}));
    expect(condition(r,4).status).toBe('UNKNOWN'); expect(r.eligible).toBe(false);
  });
  it('oversized diff stays closed and requests human review', async () => {
    const r = await checkPr(1,deps(undefined,{fetchNetDiff:()=>({paths:Array(10001).fill('x'),base})}));
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
    const f = {...fixture(6223),title:'R391 record',body,netDiffPaths:['docs/agent/platform-decisions.md']};
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
  it.each(['resolved','ratified'])('touched previously ratified decision %s fails even with unchanged status', async status => {
    const card = `---\nkind: decision\nstatus: ${status}\n---\n`;
    const d = deps({...fixture(6223),netDiffPaths:['backlog/123-test.md']},{readHeadFile:()=>card,readBaseFile:()=>card});
    expect(condition(await checkPr(1,d),3).status).toBe('FAIL');
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
  it.each([
    ['--rulings='], ['--rulings=  '], ['--rulings=a.md', '--rulings=b.md'],
    ['--rulings=a.md', '--unknown'], ['--json', '--json'],
  ])('rejects invalid, duplicate or unknown flags %j', async flags => {
    expect(await main(['--pr=6223', ...flags], deps())).toBe(2);
  });
  it('parses --rulings and passes its path to the evidence reader', async () => {
    const calls = [];
    const f = {...fixture(6223), title:'R391 record', body:'Recorded verbatim',
      netDiffPaths:['docs/agent/platform-decisions.md']};
    expect(await main(['--pr=6223', '--rulings=operator/rulings.md'], deps(f, {
      readRulings:path=>{ calls.push(path); return rulingEntry; },
    }))).toBe(0);
    expect(calls).toEqual(['operator/rulings.md']);
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
    expect(await d.fetchNetDiff(6223,head)).toEqual({paths:['docs/a.md','docs/b.md'],base});
    expect(calls).toEqual([
      ['git','fetch','origin','main'],['git','fetch','origin','pull/6223/head'],
      ['git','rev-parse','--verify','FETCH_HEAD^{commit}'],['git','merge-base','origin/main',head],
      ['git','diff','--no-relative','--no-ext-diff','a'.repeat(40),head,'--name-only','-z'],
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
    ['invalid path policy', {readSettings:()=>({...settings,protectedPaths:null})}],
    ['malformed diff', {fetchNetDiff:()=>({paths:['../AGENTS.md'],base})}],
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


describe('audit range binding regressions', () => {
  it.each(['head', 'different base'])('refuses a clear audit based on %s', async range => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {
      readAudits: () => [audit(head, {base: range === 'head' ? head : 'b'.repeat(40)})],
    }));
    expect(condition(r,2).status).toBe('FAIL');
    expect(r.eligible).toBe(false);
  });
  it('cannot review an unknown merge-base', async () => {
    const r = await checkPr(6223,deps(undefined,{fetchNetDiff:()=>({paths:['docs/a.md']})}));
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
});

describe('current-head ledger acceptance regressions', () => {
  it.each(['missing', 'stale', 'latest stale', 'changes', 'human', 'open finding'])('fails readable ledger with %s despite clear labels', async kind => {
    const head = fixture(6223).headRefOid;
    const accepted = verdict(6223,head);
    const rows = kind === 'missing' ? [] : kind === 'stale' ? [verdict(6223,'f'.repeat(40))]
      : kind === 'latest stale' ? [accepted,verdict(6223,'f'.repeat(40),{at:'2026-11-02T11:00:00Z'})]
      : kind === 'changes' ? [accepted,verdict(6223,head,{verdict:'changes'})]
      : kind === 'human' ? [accepted,verdict(6223,head,{verdict:'human'})]
      : [accepted,buildLedgerEvent({type:'referral',repo:CONSTELLATION_REPOS.we.slug,pr:6223,
        headSha:head,findingKeys:['unresolved'],at:'2026-11-02T11:00:00Z',source:'fixture',writer:'fixture'})];
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:()=>rows}));
    expect(condition(r,2).status).toBe('FAIL');
    expect(r.eligible).toBe(false);
  });
  it.each(['throw', 'null', 'malformed', 'oversized'])('returns UNKNOWN for %s ledger evidence with human fallback', async kind => {
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:()=>{
      if (kind === 'throw') throw Error('unavailable');
      return kind === 'null' ? null : kind === 'malformed' ? [{}] : Array(100001).fill({});
    }}));
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
  it('reads raw configured ledger evidence before schema normalization', async () => {
    const calls = [], rows = [verdict(6223,fixture(6223).headRefOid)];
    const adapter = createCheckDeps({env:{FIXTURE:'yes'},readLedger:async (repo,opts)=>{
      calls.push([repo,opts.env]); return {status:'ok',text:rows.map(row=>JSON.stringify(row)).join('\n')};
    }});
    expect(await adapter.readReviewLedger(6223)).toEqual(rows.map(row=>({...row,type:'verdict'})));
    expect(calls).toEqual([[CONSTELLATION_REPOS.we.slug,{FIXTURE:'yes'}]]);
  });

  it.each([
    ['schema-invalid human hold', JSON.stringify({pr:6223,repo:CONSTELLATION_REPOS.we.slug,verdict:'human'})],
    ['unparseable hold', '{"pr":6223,"verdict":"human"'],
    ['unknown PR', JSON.stringify({verdict:'human'})],
    ['invalid PR', JSON.stringify({pr:'6223',verdict:'human'})],
  ])('raw ledger fails closed after valid acceptance: %s', async (_kind, bad) => {
    const text = `${JSON.stringify(verdict(6223,fixture(6223).headRefOid))}\n${bad}\n`;
    const adapter = createCheckDeps({readLedger:async()=>({status:'ok',text})});
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}));
    expect(r.eligible).toBe(false);
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
  });
  it('schema-invalid evidence attributed to another PR does not block this PR', async () => {
    const text = [verdict(6223,fixture(6223).headRefOid), {pr:99,verdict:'human'}].map(row=>JSON.stringify(row)).join('\n');
    const adapter = createCheckDeps({readLedger:async()=>({status:'ok',text})});
    expect((await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}))).eligible).toBe(true);
  });
  it.each(['missing raw text', 'oversized raw text', 'oversized raw row count'])('refuses %s with human fallback', async kind => {
    const adapter = createCheckDeps({readLedger:async()=>({status:'ok',rows:[],
      ...(kind === 'oversized raw text' ? {text:'x'.repeat(8*1024*1024+1)}
        : kind === 'oversized raw row count' ? {text:'{"pr":99}\n'.repeat(100001)} : {})})});
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}));
    expect(r.eligible).toBe(false);
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
  });
  it('configured git path validates raw text rather than filtered records', async () => {
    const head = fixture(6223).headRefOid;
    const adapter = createCheckDeps({
      env:{WE_VERDICT_LEDGER_READ_STORE:'git',WE_VERDICT_LEDGER_BOARD:'fixture-board'},
      readGitLedger:async opts => {
        expect(opts.board).toBe('fixture-board');
        expect(opts.repo).toBe(CONSTELLATION_REPOS.we.slug);
        return {status:'ok',records:[verdict(6223,head)],
          text:[verdict(6223,head),{pr:6223,verdict:'human'}].map(row=>JSON.stringify(row)).join('\n')};
      },
    });
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}));
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
  it.each(['unreadable result', 'rejected read'])
    ('does not fall back to home when configured Git ledger is unreadable: %s', async failure => {
      // Home has an older acceptance but cannot establish the configured store's current state.
      const content = Buffer.from(`${JSON.stringify(verdict(6223,fixture(6223).headRefOid))}\n`);
      let position = 0;
      const fs = {
        constants:{O_RDONLY:0,O_NONBLOCK:2048},
        openSync:vi.fn(path=>{
          expect(String(path)).toMatch(/^fixture-ledger[\\/]/);
          position = 0;
          return 73;
        }),
        fstatSync:vi.fn(()=>({size:content.length,isFile:()=>true})),
        readSync:vi.fn((_fd,buffer,offset,length)=>{
          const count = Math.min(length,content.length-position);
          content.copy(buffer,offset,position,position+count);position+=count;return count;
        }),
        closeSync:vi.fn(),
      };
      const env = {WE_VERDICT_LEDGER_READ_STORE:'git',WE_VERDICT_LEDGER_BOARD:'fixture-board',
        WE_VERDICT_LEDGER_DIR:'fixture-ledger'};
      const readGitLedger = vi.fn(async ()=>{
        if (failure === 'rejected read') throw Error('configured Git ledger unavailable');
        return {status:'unreadable',reason:'fetch-failed'};
      });
      const adapter = createCheckDeps({env,fs,readGitLedger,stderr:()=>{}});
      const r = await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}));
      expect(readGitLedger).toHaveBeenCalledTimes(1);
      expect(readGitLedger).toHaveBeenCalledWith(expect.objectContaining({
        board:'fixture-board',repo:CONSTELLATION_REPOS.we.slug,env,
      }));
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(condition(r,2).status).toBe('UNKNOWN');
      expect(condition(r,2).evidence.join(' ')).toContain('human review');
      expect(r.eligible).toBe(false);
      expect(r.conditions.filter(c=>[1,3,4].includes(c.id)).map(c=>c.status)).toEqual(['PASS','PASS','PASS']);

      // Prove the home fixture really is readable and would otherwise authorize this head.
      const home = createCheckDeps({env:{...env,WE_VERDICT_LEDGER_READ_STORE:'home'},fs,readGitLedger,stderr:()=>{}});
      const control = await checkPr(6223,deps(undefined,{readReviewLedger:home.readReviewLedger}));
      expect(condition(control,2).status).toBe('PASS');
      expect(control.eligible).toBe(true);
      expect(fs.openSync).toHaveBeenCalledTimes(1);
      expect(fs.readSync).toHaveBeenCalled();
      expect(fs.closeSync).toHaveBeenCalledWith(73);
      expect(readGitLedger).toHaveBeenCalledTimes(1);
    });
  it('configured home path validates raw lines and closes the descriptor', async () => {
    const content = Buffer.from([verdict(6223,fixture(6223).headRefOid),
      {pr:6223,verdict:'human'}].map(row=>JSON.stringify(row)).join('\n'));
    let position = 0, closed = false;
    const adapter = createCheckDeps({env:{WE_VERDICT_LEDGER_READ_STORE:'home',WE_VERDICT_LEDGER_DIR:'fixture-ledger'},
      fs:{constants:{O_RDONLY:0,O_NONBLOCK:2048},
        openSync:path=>{expect(String(path)).toMatch(/^fixture-ledger[\\/]/);return 73;},
        fstatSync:()=>({size:content.length,isFile:()=>true}),
        readSync:(_fd,buffer,offset,length)=>{
          const count = Math.min(length,content.length-position);
          content.copy(buffer,offset,position,position+count);position+=count;return count;
        },
        closeSync:()=>{closed=true;},
      }});
    await expect(adapter.readReviewLedger(6223)).rejects.toThrow(/invalid ledger/);
    expect(closed).toBe(true);
  });
  it('shared store unreadability remains UNKNOWN', async () => {
    const adapter = createCheckDeps({readLedger:async()=>({status:'unreadable',reason:'ledger-exceeds-read-cap'})});
    const r = await checkPr(6223,deps(undefined,{readReviewLedger:adapter.readReviewLedger}));
    expect(condition(r,2).status).toBe('UNKNOWN');
  });
});

describe('merge-base decision ratification regressions', () => {
  const path = 'backlog/123-test.md';
  const card = (status, key = 'kind', kind = 'decision') => `---\n${key}: ${kind}\nstatus: ${status}\n---\n`;
  const check = overrides => checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]},overrides));
  it.each([['kind','resolved'],['type','resolved'],['kind','ratified'],['type','ratified']])('rejects a new %s: decision with status %s', async (key,status) => {
    const r = await check({readHeadFile:()=>card(status,key),readBaseFile:()=>null});
    expect(condition(r,3).status).toBe('FAIL'); expect(r.eligible).toBe(false);
  });
  it.each([['open','resolved'],['draft','resolved'],['open','ratified'],['draft','ratified']])('rejects rewriting a %s decision as %s', async (before,after) => {
    const r = await check({readHeadFile:()=>card(after),readBaseFile:()=>card(before)});
    expect(condition(r,3).status).toBe('FAIL'); expect(r.eligible).toBe(false);
  });
  it('cannot hide a base decision by rewriting its head kind', async () => {
    const r = await check({readHeadFile:()=>card('resolved','kind','story'),readBaseFile:()=>card('open')});
    expect(condition(r,3).status).toBe('FAIL');
  });
  it('binds the historical read to the net diff base and rejects resolved to ratified', async () => {
    const calls = [], diffBase = 'b'.repeat(40);
    const r = await check({fetchNetDiff:()=>({paths:[path],base:diffBase}),
      readHeadFile:()=>card('ratified','type'),readBaseFile:(sha,p)=>{calls.push([sha,p]);return card('resolved','type');}});
    expect(calls).toEqual([[diffBase,path]]); expect(condition(r,3).status).toBe('FAIL');
  });
  it.each(['kind','type'])('rejects a body-only edit to a resolved %s decision', async key => {
    const r = await check({readHeadFile:()=>`${card('resolved',key)}Reversed ruling.\n`,
      readBaseFile:()=>`${card('resolved',key)}Original ruling.\n`});
    expect(condition(r,3).status).toBe('FAIL'); expect(r.eligible).toBe(false);
  });
  it('cannot hide a resolved base decision by rewriting its head kind', async () => {
    const r = await check({readHeadFile:()=>card('resolved','kind','story'),readBaseFile:()=>card('resolved')});
    expect(condition(r,3).status).toBe('FAIL');
  });
  it('refuses the R391 exception for a resolved decision named rulings', async () => {
    const f = {...fixture(6223),title:'R391 record',body:'> Operator ruling',netDiffPaths:['backlog/123-rulings.md']};
    const r = await checkPr(6223,deps(f,{readHeadFile:()=>card('resolved'),readBaseFile:()=>card('resolved')}));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it('refuses R391 when a non-record decision body is also touched', async () => {
    const f = {...fixture(6223),title:'R391 record',body:'> Operator ruling',netDiffPaths:['rulings.md',path]};
    const r = await checkPr(6223,deps(f,{readHeadFile:()=>`${card('resolved')}Reversed ruling.\n`,readBaseFile:()=>card('resolved')}));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it.each(['error','malformed','oversized','undefined'])('keeps %s base evidence UNKNOWN with a human fallback', async kind => {
    const r = await check({readHeadFile:()=>card('resolved'),readBaseFile:()=>{
      if(kind === 'error') throw Error('unreadable');
      return kind === 'malformed' ? 'broken' : kind === 'oversized' ? 'x'.repeat(1024*1024+1) : undefined;
    }});
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review'); expect(r.eligible).toBe(false);
  });
  it('rejects reopening a previously resolved decision', async () => {
    expect(condition(await check({readHeadFile:()=>card('open'),readBaseFile:()=>card('resolved')}),3).status).toBe('FAIL');
  });
});

describe('merge-base card reader', () => {
  const path = 'backlog/123-test.md';
  it('reads historical bytes with git show base:path', async () => {
    const calls = [];
    const d = createCheckDeps({exec:(bin,args)=>{calls.push([bin,...args]);return 'historical card';}});
    expect(await d.readBaseFile(base,path)).toBe('historical card');
    expect(calls).toEqual([['git','show',`${base}:${path}`]]);
  });
  it('returns null only for a verified absent base path', async () => {
    const calls = [];
    const d = createCheckDeps({exec:(_bin,args)=>{calls.push(args);if(args[0]==='show')throw Error('missing');return '';}});
    expect(await d.readBaseFile(base,path)).toBeNull();
    expect(calls).toEqual([['show',`${base}:${path}`],['ls-tree','-z',base,'--',path]]);
  });
  it.each(['present','unreadable','oversized'])('refuses to mistake %s tree evidence for a new card', async kind => {
    const d = createCheckDeps({exec:(_bin,args)=>{
      if(args[0]==='show' || kind==='unreadable')throw Error('read failed');
      return kind==='oversized' ? 'x'.repeat(8*1024*1024+1) : '100644 blob hash\tbacklog/123-test.md\0';
    }});
    await expect(d.readBaseFile(base,path)).rejects.toThrow();
  });
  it('validates base and card path before issuing commands', async () => {
    const d = createCheckDeps({exec:()=>{throw Error('must not execute');}});
    await expect(d.readBaseFile('HEAD',path)).rejects.toThrow('invalid commit');
    await expect(d.readBaseFile(base,'../card.md')).rejects.toThrow('invalid card path');
  });
});

describe('round 4 append-only R391 evidence', () => {
  const path = 'docs/agent/platform-decisions.md';
  const f = {...fixture(6223),title:'R391 record',body:'> Operator ruling',netDiffPaths:[path]};
  it('passes an append-only listed ruling record with R-id and blockquote', async () => {
    const calls = [];
    const r = await checkPr(6223,deps(f,{readRulingNumstat:(...args)=>{
      calls.push(args); return `1\t0\t${path}\0`;
    }}));
    expect(calls).toEqual([[base,f.headRefOid,[path]]]);
    expect(condition(r,3)).toMatchObject({status:'PASS',evidence:expect.arrayContaining(['R391 ruling-record'])});
  });
  it.each(['backlog/123-rulings.md', '.operations/rulings.md'])('rejects reversal of resolved text through unlisted %s', async record => {
    const card = '---\ntype: decision\nstatus: resolved\n---\n';
    const r = await checkPr(6223,deps({...f,netDiffPaths:[record]}, {
      readHeadFile:()=>`${card}Reversed ruling.`,readBaseFile:()=>`${card}Original ruling.`,
    }));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it.each(['1\t1', '0\t1', '0\t0'])('rejects non-append numstat %s in a listed record', async counts => {
    const r = await checkPr(6223,deps(f,{readRulingNumstat:()=>`${counts}\t${path}\0`}));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it('rejects a decision card even if explicitly listed as a record', async () => {
    const record = 'backlog/123-rulings.md';
    const card = '---\ntype: decision\nstatus: resolved\n---\n';
    const r = await checkPr(6223,deps({...f,netDiffPaths:[record]}, {
      readSettings:()=>({...settings,rulingRecordPaths:[record]}),readHeadFile:()=>card,readBaseFile:()=>card,
    }));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it('rejects a ruling append mixed with unrelated implementation changes', async () => {
    const r = await checkPr(6223,deps({...f,netDiffPaths:[path,'scripts/example.mjs']}));
    expect(condition(r,3).status).toBe('FAIL');
  });
  it.each(['throw','empty','binary','truncated','wrong path','duplicate','oversized'])
  ('keeps %s numstat UNKNOWN with human fallback', async kind => {
    const r = await checkPr(6223,deps(f,{readRulingNumstat:()=>{
      if (kind === 'throw') throw Error('unreadable');
      return {empty:'',binary:`-\t-\t${path}\0`,truncated:`1\t0\t${path}`,
        'wrong path':'1\t0\tother.md\0',duplicate:`1\t0\t${path}\0`.repeat(2),
        oversized:'x'.repeat(8*1024*1024+1)}[kind];
    }}));
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
  it.each([undefined,[],['**/rulings.md'],['../rulings.md'],Array(1001).fill(path)].map(rulingRecordPaths => ({rulingRecordPaths})))
  ('keeps invalid exact ruling-record policy closed (%j)', async ({rulingRecordPaths}) => {
    const r = await checkPr(6223,deps(f,{readSettings:()=>({...settings,rulingRecordPaths})}));
    expect(condition(r,3).status).toBe('UNKNOWN');
  });
  it.each([{title:'story 391'}, {body:'paraphrase'}])('rejects missing R-id or quotation on listed records: %j', async extra => {
    expect(condition(await checkPr(6223,deps({...f,...extra})),3).status).toBe('FAIL');
  });
  it('fixture 6223 retains condition 4 PASS without test-file exemptions', async () => {
    const original = fixture(6223);
    expect(original.netDiffPaths).toHaveLength(7);
    expect(original.netDiffPaths.every(path => !settings.protectedPaths.some(glob => matchesGlob(path,glob)))).toBe(true);
    expect(condition(await checkPr(6223,deps(original)),4).status).toBe('PASS');
  });
  it('keeps missing numstat rows for a second listed record UNKNOWN', async () => {
    const second = 'docs/agent/another-record.md';
    const r = await checkPr(6223,deps({...f,netDiffPaths:[path,second]}, {
      readSettings:()=>({...settings,rulingRecordPaths:[path,second]}),
      readRulingNumstat:()=>`1\t0\t${path}\0`,
    }));
    expect(condition(r,3).status).toBe('UNKNOWN');
  });
  it.each(['command failure','oversized output'])('keeps adapter %s UNKNOWN', async kind => {
    const adapter = createCheckDeps({exec:()=>{
      if (kind === 'command failure') throw Error('git failed');
      return 'x'.repeat(8*1024*1024+1);
    }});
    const r = await checkPr(6223,deps(f,{readRulingNumstat:adapter.readRulingNumstat}));
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review');
  });
  it('adapter requests bounded literal-path numstat for the classified range', async () => {
    const calls = [];
    const adapter = createCheckDeps({exec:(bin,args,options)=>{
      calls.push([bin,args]); expect(options.maxBuffer).toBe(8*1024*1024);
      return `4\t0\t${path}\0`;
    }});
    expect(await adapter.readRulingNumstat(base,f.headRefOid,[path])).toBe(`4\t0\t${path}\0`);
    expect(calls).toEqual([['git',['--literal-pathspecs','diff','--no-relative','--no-ext-diff','--numstat','-z',base,f.headRefOid,'--',path]]]);
  });
});


describe('R391 EOF-only ruling records', () => {
  const path = 'docs/agent/platform-decisions.md';
  const f = {...fixture(6223),title:'R391 record',body:'> Operator ruling',netDiffPaths:[path]};
  const original = 'First rule.\nSecond rule.\n';
  it.each([
    ['insertion into existing ruling text', 'First rule.\n> Exception to first rule.\nSecond rule.\n'],
    ['prepend to existing ruling text', '> Overriding ruling.\nFirst rule.\nSecond rule.\n'],
    ['unchanged ruling text', original],
  ])('rejects %s despite zero-deletion numstat', async (_name, changed) => {
    const r = await checkPr(6223,deps(f,{
      readRulingFile:async sha => sha === base ? original : changed,
    }));
    expect(condition(r,3).status).toBe('FAIL');
    expect(r.eligible).toBe(false);
  });
  it('passes only an EOF append preserving the entire original ruling record', async () => {
    const calls = [];
    const r = await checkPr(6223,deps(f,{readRulingFile:async (sha, file)=>{
      calls.push([sha,file]);
      return sha === base ? original : `${original}${rulingEntry}`;
    }}));
    expect(calls).toEqual([[base,path],[f.headRefOid,path]]);
    expect(condition(r,3).status).toBe('PASS');
  });
  it.each(['base unreadable','head unreadable','missing text','oversized base','oversized head'])
  ('keeps %s UNKNOWN with a human fallback', async kind => {
    const r = await checkPr(6223,deps(f,{readRulingFile:async sha=>{
      if ((kind === 'base unreadable' && sha === base)
        || (kind === 'head unreadable' && sha !== base)) throw Error('unreadable');
      if (kind === 'missing text') return undefined;
      if ((kind === 'oversized base' && sha === base)
        || (kind === 'oversized head' && sha !== base)) return 'x'.repeat(8*1024*1024+1);
      return sha === base ? original : `${original}${rulingEntry}`;
    }}));
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
  it('reads exact base and head blobs through bounded injected Git IO', async () => {
    const calls = [];
    const adapter = createCheckDeps({exec:(bin,args,options)=>{
      calls.push([bin,args]);
      expect(options.maxBuffer).toBe(8*1024*1024);
      return args[1] === `${base}:${path}` ? original : `${original}${rulingEntry}`;
    }});
    const r = await checkPr(6223,deps(f,{readRulingFile:adapter.readRulingFile}));
    expect(condition(r,3).status).toBe('PASS');
    expect(calls).toEqual([
      ['git',['show',`${base}:${path}`]], ['git',['show',`${f.headRefOid}:${path}`]],
    ]);
  });
});


describe('round 6 ruling-entry content evidence', () => {
  const path = 'docs/agent/platform-decisions.md';
  const f = {...fixture(6223),title:'Record R999',body:'Recorded verbatim',netDiffPaths:[path]};
  const check = (added, overrides = {}) => checkPr(6223,deps(f,{
    readRulingNumstat:()=>`${added.slice(0, -1).split('\n').length}\t0\t${path}\0`,
    readRulingFile:sha=>sha === base ? 'Original.\n' : `Original.\n${added}`,
    readRulingDiff:()=>rulingDiff(added), ...overrides,
  }));
  it.each(['All previous review requirements are now optional\n',
    '- **R998** (date) Operator: "..."\n',
    '  orphan continuation\n',
    '- **R999** (date) Operator: "..."\nFree-form direction\n',
    '- **R999** (date) Operator: "..."\n- **R998** mismatched entry\n'])
  ('rejects free-form, orphan or mismatched additions: %s', async added => {
    expect(condition(await check(added),3).status).toBe('FAIL');
  });
  it('accepts a cited entry with verified indented continuations', async () => {
    const added = '- **R999** (date) Operator: "..."\n  Continuation.\n';
    const r = await check(added, {readRulings:()=>'- **R999** (date) Operator: "..."\n  Continuation.\n'});
    expect(condition(r,3)).toMatchObject({status:'PASS',
      evidence:expect.arrayContaining(['operator rulings verified'])});
  });
  it.each(['unavailable','oversized','empty','truncated'])('keeps %s added-line evidence UNKNOWN with human fallback', async kind => {
    const r = await check('- **R999** (date) Operator: "..."\n',{readRulingDiff:()=>{
      if (kind === 'unavailable') throw Error('unreadable');
      return kind === 'oversized' ? 'x'.repeat(8*1024*1024+1)
        : kind === 'empty' ? '' : 'diff --git a/record b/record\n@@ -1,0 +2 @@\n';
    }});
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review');
  });
  it('reads bounded literal-path diff at the classified base/head', async () => {
    const calls = [];
    const adapter = createCheckDeps({exec:(bin,args,options)=>{
      calls.push([bin,args]); expect(options.maxBuffer).toBe(8*1024*1024);
      return rulingDiff('- **R999** (date) Operator: "..."\n');
    }});
    expect(condition(await check('- **R999** (date) Operator: "..."\n',{
      readRulingDiff:adapter.readRulingDiff,
      readRulings:()=>'- **R999** (date) Operator: "..."\n',
    }),3).status).toBe('PASS');
    expect(calls).toEqual([['git',['--literal-pathspecs','diff','--no-relative','--no-ext-diff','--no-textconv',
      '--unified=0',base,f.headRefOid,'--',path]]]);
  });
  it.each(['failure','oversized'])('keeps adapter %s closed', async kind => {
    const adapter = createCheckDeps({exec:()=>{
      if (kind === 'failure') throw Error('git failed');
      return 'x'.repeat(8*1024*1024+1);
    }});
    const r = await check('- **R999** (date) Operator: "..."\n',{readRulingDiff:adapter.readRulingDiff});
    expect(condition(r,3).status).toBe('UNKNOWN');
    expect(condition(r,3).evidence.join(' ')).toContain('human review');
  });
});


describe('round 7 path and audit evidence', () => {
  it('matches globstars across newline segments', () => {
    expect(matchesGlob('scripts/hidden\n/guard-custom.mjs', '**/guard-*.mjs')).toBe(true);
    expect(matchesGlob('scripts/hidden\n/guard-custom.mjs', 'scripts/**')).toBe(true);
  });
  it.each(['scripts/hidden\n/guard-custom.mjs','docs/a\r.md','docs/a\t.md',
    'docs/a\x7f.md','docs/a\x85.md','docs/\ud800.md'])
  ('keeps unsafe path %j UNKNOWN in both path conditions', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    for (const id of [3,4]) {
      expect(condition(r,id).status).toBe('UNKNOWN');
      expect(condition(r,id).evidence.join(' ')).toContain('human review');
    }
    expect(r.eligible).toBe(false);
  });
  it('preserves valid UTF8 path bytes including a leading BOM', async () => {
    const head = fixture(6223).headRefOid;
    const adapter = createCheckDeps({exec:(_bin,args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return head;
      if (args[0] === 'merge-base') return base;
      if (args[0] === 'diff') return Buffer.from('\ufeffdocs/caf\u00e9.md\0');
      throw Error('unexpected command');
    }});
    expect(await adapter.fetchNetDiff(6223,head)).toEqual({paths:['\ufeffdocs/caf\u00e9.md'],base});
  });
  it('rejects non-UTF8 net-diff bytes before lossy decoding', async () => {
    const head = fixture(6223).headRefOid;
    const adapter = createCheckDeps({exec:(_bin,args,options) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return head;
      if (args[0] === 'merge-base') return base;
      if (args[0] === 'diff') {
        expect(options.encoding).toBe(null);
        return Buffer.concat([Buffer.from('docs/'),Buffer.from([0xff]),Buffer.from('.md\0')]);
      }
      throw Error('unexpected command');
    }});
    const r = await checkPr(6223,deps(undefined,{fetchNetDiff:adapter.fetchNetDiff}));
    expect([condition(r,3).status,condition(r,4).status]).toEqual(['UNKNOWN','UNKNOWN']);
    expect(r.eligible).toBe(false);
  });
  it.each([null,undefined,'finding',[null],[42],['finding',42],{}])('rejects invalid findings %j', async findings => {
    const r = await checkPr(6223,deps(undefined,{
      readAudits:()=>[audit(fixture(6223).headRefOid,{findings})],
    }));
    expect(condition(r,2).status).toBe('UNKNOWN');
  });
  it('does not hide an intervening foreign-base WEAKENED behind a later foreign-base clear', async () => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223,deps(undefined,{readAudits:()=>[
      audit(head),
      audit(head,{base:'b'.repeat(40),at:'2026-11-02T11:00:00Z',verdict:'WEAKENED'}),
      audit(head,{base:'b'.repeat(40),at:'2026-11-02T12:00:00Z'}),
    ]}));
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:['latest audit: WEAKENED']});
  });
});

describe('round 7 live hold chronology', () => {
  const event = (name, at, kind = 'labeled') => ({event:kind,label:{name},created_at:at});
  const check = (label, readLabelEvents) => checkPr(6223,deps({
    ...fixture(6223),labels:['red-team:clear','review:accepted',label],
  },{readLabelEvents}));
  it.each(['review:human','review:pending'])('%s applied after acceptance fails even before ledger mirror', async label => {
    const r = await check(label,()=>[
      event(label,'2026-11-02T09:00:00Z'),event(label,'2026-11-02T09:30:00Z','unlabeled'),
      event(label,'2026-11-02T11:00:00Z'),
    ]);
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:[`hold applied after acceptance: ${label}`]});
  });
  it.each(['2026-11-02T09:00:00Z'])('permits a hold applied at %s strictly before acceptance', async at => {
    expect(condition(await check('review:human',()=>[event('review:human',at)]),2).status).toBe('PASS');
  });
  it('a hold applied at the same instant as acceptance fails', async () => {
    expect(condition(await check('review:human',()=>[event('review:human','2026-11-02T10:00:00Z')]),2).status).toBe('FAIL');
  });
  it.each(['throw','missing','malformed','invalid time','oversized'])('keeps %s timeline UNKNOWN with human fallback', async kind => {
    const r = await check('review:human',()=>{
      if (kind === 'throw') throw Error('unreadable');
      if (kind === 'missing') return [];
      if (kind === 'malformed') return null;
      if (kind === 'oversized') return Array(1001).fill(event('review:human','2026-11-02T09:00:00Z'));
      return [event('review:human','bad time')];
    });
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
  });
  it('checks both live holds independently instead of accepting the older one', async () => {
    const r = await checkPr(6223,deps({...fixture(6223),
      labels:['red-team:clear','review:accepted','review:human','review:pending'],
    },{readLabelEvents:()=>[
      event('review:human','2026-11-02T09:00:00Z'),event('review:pending','2026-11-02T11:00:00Z'),
    ]}));
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:['hold applied after acceptance: review:pending']});
  });
  it('bounds cumulative timeline bytes across individually bounded pages', async () => {
    let calls = 0;
    const rows = Array.from({length:100},()=>({event:'commented'}));
    rows[0].body = 'x'.repeat(1024*1024);
    const adapter = createCheckDeps({exec:()=>{ calls++; return JSON.stringify(rows); }});
    const r = await check('review:human',adapter.readLabelEvents);
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
    expect(calls).toBe(8);
  });
  const clean = (readLabelEvents, extra = {}) => checkPr(6223,deps(undefined,{readLabelEvents,...extra}));
  it.each(['review:human','review:pending','red-team:blocked','review:changes','review:held-mechanical','advisory:x'])(
    'fails a %s hold applied after the head push and removed again', async label => {
    const r = await clean(()=>[event(label,'2026-11-02T09:40:00Z'),event(label,'2026-11-02T09:50:00Z','unlabeled')]);
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:[`hold applied since head push: ${label}`]});
  });
  it('permits a hold applied and removed before the head push', async () => {
    const r = await clean(()=>[event('review:human','2026-11-02T09:00:00Z'),event('review:human','2026-11-02T09:10:00Z','unlabeled')]);
    expect(condition(r,2).status).toBe('PASS');
  });
  it('fails a live hold that was also applied and removed since the head push', async () => {
    const r = await checkPr(6223,deps({...fixture(6223),labels:['red-team:clear','review:accepted','review:pending']},{readLabelEvents:()=>[
      event('review:pending','2026-11-02T09:35:00Z'),event('review:pending','2026-11-02T09:36:00Z','unlabeled'),
      event('review:pending','2026-11-02T09:37:00Z')]}));
    expect(condition(r,2)).toMatchObject({status:'FAIL',evidence:['hold applied since head push: review:pending']});
  });
  it.each(['timeline throws','head time throws','head time malformed'])('is UNKNOWN when %s with no live hold', async kind => {
    const r = await clean(kind === 'timeline throws' ? ()=>{throw Error('x');} : ()=>[],
      kind === 'timeline throws' ? {} : {readHeadPushedAt: kind === 'head time throws' ? ()=>{throw Error('x');} : async()=>'bad'});
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
  });
  it('reads the server push time for the head, not the commit date', async () => {
    const head = 'b'.repeat(40), calls = [];
    const exec = (...a) => { calls.push(a); return a[1][0] === 'pr' ? JSON.stringify({headRefName:'lane/x',headRefOid:head})
      : JSON.stringify([{after:'c'.repeat(40),timestamp:'2030-01-01T00:00:00Z'},{after:head,timestamp:'2026-11-02T09:30:00Z'}]); };
    expect(await createCheckDeps({exec}).readHeadPushedAt(6223,head)).toBe('2026-11-02T09:30:00Z');
    expect(JSON.stringify(calls)).toContain('activity_type=push');
    await expect(createCheckDeps({exec}).readHeadPushedAt(6223,'main; rm')).rejects.toThrow();
  });
  it.each(['no matching push','head moved','oversized page'])('refuses head push time on %s', async kind => {
    const head = 'b'.repeat(40);
    const exec = (...a) => a[1][0] === 'pr' ? JSON.stringify({headRefName:'lane/x',headRefOid: kind === 'head moved' ? 'c'.repeat(40) : head})
      : JSON.stringify(kind === 'oversized page' ? Array(101).fill({after:head,timestamp:'2026-11-02T09:30:00Z'}) : [{after:'c'.repeat(40),timestamp:'2026-11-02T09:30:00Z'}]);
    await expect(createCheckDeps({exec}).readHeadPushedAt(6223,head)).rejects.toThrow();
  });
  it('paginates explicit-repo issue events and filters hold label events', async () => {
    const calls = [];
    const rows = Array.from({length:100},()=>({event:'commented'}));
    rows[0] = event('review:human','2026-11-02T09:00:00Z');
    const adapter = createCheckDeps({exec:(bin,args)=>{
      calls.push([bin,args]);
      return JSON.stringify(calls.length === 1 ? rows : [event('review:pending','2026-11-02T11:00:00Z')]);
    }});
    expect(await adapter.readLabelEvents(6223)).toEqual([rows[0],event('review:pending','2026-11-02T11:00:00Z')]);
    expect(calls).toEqual([1,2].map(page=>['gh',['api',
      `repos/${CONSTELLATION_REPOS.we.slug}/issues/6223/events?per_page=100&page=${page}`]]));
  });
  it.each(['unreadable','non-array','oversized page','page cap','byte cap'])('adapter keeps %s timeline closed', async kind => {
    let calls = 0;
    const adapter = createCheckDeps({exec:()=>{
      calls++;
      if (kind === 'unreadable') throw Error('gh unavailable');
      if (kind === 'non-array') return '{}';
      if (kind === 'byte cap') return 'x'.repeat(8*1024*1024+1);
      return JSON.stringify(Array(kind === 'oversized page' ? 101 : 100).fill({event:'commented'}));
    }});
    const r = await check('review:human',adapter.readLabelEvents);
    expect(condition(r,2).status).toBe('UNKNOWN');
    expect(condition(r,2).evidence.join(' ')).toContain('human review');
    expect(calls).toBe(kind === 'page cap' ? 10 : 1);
  });
});

describe('round 8 malformed audit evidence', () => {
  it('a newer malformed WEAKENED record for the head does not revive the older clearance', async () => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(1, deps(undefined, { readAudits: () => [audit(head), audit(head, { at: '2026-11-02T11:00:00Z', verdict: 'WEAKENED', findings: null })] }));
    expect(condition(r, 2).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
});


describe('audit structure validation for the canonical question', () => {
  const malformed = [
    ['missing timestamp', {at: undefined}], ['null timestamp', {at: null}],
    ['numeric timestamp', {at: 0}], ['unparseable timestamp', {at: 'not-a-date'}],
    ['object timestamp', {at: {}}], ['missing base', {base: undefined}],
    ['short base', {base: 'abc'}], ['base with trailing newline', {base: 'a'.repeat(40) + '\n'}],
    ['non-hex base', {base: 'z'.repeat(40)}],
    ['non-string base', {base: 42}], ['missing verdict', {verdict: undefined}],
    ['unknown verdict', {verdict: 'CLEAR'}], ['missing findings', {findings: undefined}],
    ['non-array findings', {findings: 'finding'}], ['non-string finding', {findings: ['finding', 42]}],
    ['missing question hash', {questionHash: undefined}], ['empty question hash', {questionHash: ''}],
    ['blank question hash', {questionHash: '  '}], ['non-string question hash', {questionHash: 42}],
  ];
  it.each(malformed)('keeps same-head %s UNKNOWN despite an existing clearance', async (_name, extra) => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {
      readAudits: () => [audit(head), audit(head, extra)],
    }));
    expect(condition(r, 2).status).toBe('UNKNOWN');
    expect(condition(r, 2).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
  it.each(malformed)('ignores different-head %s', async (_name, extra) => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {
      readAudits: () => [audit(head), audit('f'.repeat(40), extra)],
    }));
    expect(condition(r, 2).status).toBe('PASS');
  });
  it.each(malformed.filter(([, extra]) => !Object.hasOwn(extra, 'questionHash')))
  ('ignores foreign-question same-head %s', async (_name, extra) => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {
      readAudits: () => [audit(head), audit(head, {questionHash: 'foreign', ...extra})],
    }));
    expect(condition(r, 2).status).toBe('PASS');
    expect(r.eligible).toBe(true);
  });
  it('ignores a structurally valid foreign-question weakened audit', async () => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {
      readAudits: () => [audit(head), audit(head, {questionHash: 'foreign', verdict: 'WEAKENED',
        at: '2026-11-02T11:00:00Z'})],
    }));
    expect(condition(r, 2).status).toBe('PASS');
  });
});

describe('round 9 rejected canonical audits', () => {
  it.each([
    ['opposite verdict line', 'WEAKENED', ['NOT WEAKENED']],
    ['opposite clear verdict line', 'NOT WEAKENED', ['WEAKENED']],
    ['embedded verdict line', 'WEAKENED', ['file:1 finding\nNOT WEAKENED']],
    ['disguised verdict line', 'WEAKENED', ['NOT\u200b WEAKENED']],
    ['bad findings shape', 'WEAKENED', null],
  ])('keeps %s UNKNOWN instead of reviving older clearance', async (_name, verdict, findings) => {
    const head = fixture(6223).headRefOid;
    const r = await checkPr(6223, deps(undefined, {readAudits: () => [
      audit(head), audit(head, {at: '2026-11-02T11:00:00Z', verdict, findings}),
    ]}));
    expect(condition(r, 2).status).toBe('UNKNOWN');
    expect(condition(r, 2).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
});

describe('round 14 clear-human acceptance', () => {
  it('a clear-human ledger clearance is not delegated acceptance', async () => {
    const f = fixture(6223);
    const r = await checkPr(1, deps(f, { readReviewLedger: async pr => [verdict(pr, f.headRefOid, { verdict: 'clear-human', approval: 'clear-human' })] }));
    expect(condition(r, 2).status).not.toBe('PASS');
    expect(r.eligible).toBe(false);
  });
});

describe('round 16 svg and unknown review labels', () => {
  it('an svg outside protected paths passes condition 4', async () => {
    const r = await checkPr(1, deps({ ...fixture(6223), netDiffPaths: ['src/assets/active.svg'] }));
    expect(condition(r, 4).status).toBe('PASS');
  });
  it.each(['review:awaiting-advisory', 'advisory:needs-panel', 'review:something-new'])('label %s blocks', async label => {
    const f = fixture(6223);
    const r = await checkPr(1, deps({ ...f, labels: [...f.labels, label] }, { readLabels: async () => [...f.labels, label] }));
    expect(condition(r, 2).status).toBe('FAIL');
  });
});


describe('R391 operator ruling provenance', () => {
  const path = 'docs/agent/platform-decisions.md';
  const rulings = readFileSync(new NodeURL('../__fixtures__/d-r379/operator-rulings.md', import.meta.url), 'utf8');
  const realEntry = rulings.split('\n')[0];
  const check = (added, overrides = {}, metadata = {}) => checkPr(6223, deps({
    ...fixture(6223), title:'Record R391 R392 R999', body:'Recorded verbatim', netDiffPaths:[path], ...metadata,
  }, {
    readRulings:()=>rulings,
    readRulingNumstat:()=>`${added.slice(0, -1).split('\n').length}\t0\t${path}\0`,
    readRulingFile:sha=>sha === base ? 'Original.\n' : `Original.\n${added}`,
    readRulingDiff:()=>rulingDiff(added), ...overrides,
  }));
  it('rejects an appended R999 absent from operator rulings despite its PR citation', async () => {
    expect(condition(await check('- **R999** Invented operator ruling.\n'), 3).status).toBe('FAIL');
  });
  it('rejects an empty operator rulings file', async () => {
    expect(condition(await check(`${realEntry}\n`, {readRulings:()=>''}), 3).status).toBe('FAIL');
  });
  it('accepts the whole real R391 entry verbatim', async () => {
    const r = await check(`${realEntry}\n`);
    expect(condition(r, 3)).toMatchObject({status:'PASS', evidence:expect.arrayContaining(['operator rulings verified'])});
  });
  it.each([realEntry.split('. D-R379')[0], realEntry.replace(' and is delegable if the other conditions hold.', '')])
  ('rejects a truncated R391 entry even when it is a verbatim substring: %s', async line => {
    expect(condition(await check(`${line}\n`), 3).status).toBe('FAIL');
  });
  it('rejects altered text with the same real R391 id', async () => {
    expect(condition(await check(`${realEntry.replace('"Yes"', '"No"')}\n`), 3).status).toBe('FAIL');
  });
  it('rejects reordered fragments that contradict the cited ruling', async () => {
    const added = `${realEntry}\n  PR\n  does\n  "set direction"\n`;
    expect(condition(await check(added), 3).status).toBe('FAIL');
  });
  it('rejects duplicated source fragments within a cited entry', async () => {
    const added = '- **R392** Synthetic continuation fixture.\n  Only this indented continuation belongs to R392.\n  Only this indented continuation belongs to R392.\n';
    expect(condition(await check(added), 3).status).toBe('FAIL');
  });
  it('rejects source fragments in order when the excerpt is not contiguous', async () => {
    const added = `${realEntry}\n  D-R379 condition 3 amended:\n  is delegable if the other conditions hold.\n`;
    expect(condition(await check(added), 3).status).toBe('FAIL');
  });
  it('accepts a whole entry including its verbatim indented continuation', async () => {
    expect(condition(await check('- **R392** Synthetic continuation fixture.\n  Only this indented continuation belongs to R392.\n'), 3).status).toBe('PASS');
  });
  it('accepts whole entries with only line endings normalized', async () => {
    const added = `${realEntry}\n\n- **R392** Synthetic continuation fixture.\n  Only this indented continuation belongs to R392.\n`;
    expect(condition(await check(added, {readRulings:()=>rulings.replace(/\n/g, '\r\n')}), 3).status).toBe('PASS');
    expect(condition(await check(added.replace(/\n/g, '\r\n')), 3).status).toBe('PASS');
  });
  it.each([
    '- **R392** Synthetic continuation fixture.\n',
    '- **R392** Synthetic continuation fixture.\n  Only this indented continuation\n',
    '- **R392** Synthetic continuation fixture.\n    Only this indented continuation belongs to R392.  \n',
    '- **R392** Synthetic continuation fixture.  \n  Only this indented continuation belongs to R392.\n',
    '- **R392** Synthetic continuation fixture.\n\n  Only this indented continuation belongs to R392.\n',
  ])('rejects incomplete or whitespace-altered whole entries: %s', async added => {
    expect(condition(await check(added), 3).status).toBe('FAIL');
  });
  it.each(['This continuation belongs to R393.', 'Unindented text outside the entry.'])
  ('rejects continuation text outside the cited entry: %s', async text => {
    expect(condition(await check(`- **R392** Synthetic continuation fixture.\n  ${text}\n`), 3).status).toBe('FAIL');
  });
  it('still rejects a genuine entry when the PR cites a different id', async () => {
    expect(condition(await check(`${realEntry}\n`, {}, {title:'Record R999'}), 3).status).toBe('FAIL');
  });
  it.each(['unreadable', 'missing reader', 'invalid', 'oversized'])
  ('keeps %s operator rulings UNKNOWN with a human-review fallback', async kind => {
    const readRulings = kind === 'missing reader' ? undefined : () => {
      if (kind === 'unreadable') throw Error('unreadable');
      return kind === 'oversized' ? 'x'.repeat(8 * 1024 * 1024 + 1) : null;
    };
    const r = await check(`${realEntry}\n`, {readRulings});
    expect(condition(r, 3).status).toBe('UNKNOWN');
    expect(condition(r, 3).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
  });
  it('does not use a legacy settings rulingsFile as an evidence source', async () => {
    const calls = [];
    const reader = createCheckDeps({env:{}}).readRulings;
    const r = await check(`${realEntry}\n`, {
      readSettings:()=>({...settings, rulingsFile:'operator/rulings.md'}),
      readRulings:(...args)=>{ calls.push(args); return reader(...args); },
    });
    expect(calls).toEqual([[]]);
    expect(condition(r, 3).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
  it('no path makes condition 3 UNKNOWN when the R391 exception is needed', async () => {
    const r = await check(`${realEntry}\n`, {readRulings:createCheckDeps({env:{}}).readRulings});
    expect(condition(r, 3).status).toBe('UNKNOWN');
    expect(condition(r, 3).evidence.join(' ')).toContain('human review');
    expect(r.eligible).toBe(false);
    expect(condition(r, 4).status).toBe('PASS');
  });
  it('missing path leaves conditions that do not need the exception unaffected', async () => {
    const r = await checkPr(6223, deps(undefined, {readRulings:createCheckDeps({env:{}}).readRulings}));
    expect(r.conditions.slice(0, 4).map(c=>c.status)).toEqual(['PASS','PASS','PASS','PASS']);
    expect(r.eligible).toBe(true);
  });
});

describe('operator rulings filesystem adapter', () => {
  function adapter(content, {size = Buffer.byteLength(content), ...options} = {}) {
    const bytes = Buffer.from(content), opened = [], closed = [];
    let position = 0;
    const deps = createCheckDeps({home:'fixture-home', cwd:'fixture-checkout', env:{}, stderr:()=>{}, ...options, fs:{
      constants:{O_RDONLY:0, O_NONBLOCK:2048},
      openSync:path=>{ opened.push(path); return 79; },
      fstatSync:()=>({size, isFile:()=>true}),
      readSync:(_fd, buffer, offset, length)=>{
        const count = Math.min(length, bytes.length - position);
        bytes.copy(buffer, offset, position, position + count);
        position += count;
        return count;
      },
      closeSync:fd=>closed.push(fd),
    }});
    return {deps, opened, closed};
  }
  it('uses D_R379_RULINGS_FILE as the env fallback', async () => {
    const {deps, opened, closed} = adapter(rulingEntry, {env:{D_R379_RULINGS_FILE:'operator/env-rulings.md'}});
    expect(await deps.readRulings()).toBe(rulingEntry);
    expect(opened).toEqual([resolve('fixture-checkout', 'operator/env-rulings.md')]);
    expect(closed).toEqual([79]);
  });
  it('CLI --rulings overrides the environment path', async () => {
    const {deps:reader, opened} = adapter(rulingEntry, {env:{D_R379_RULINGS_FILE:'operator/env-rulings.md'}});
    const f = {...fixture(6223), title:'R391 record', body:'Recorded verbatim',
      netDiffPaths:['docs/agent/platform-decisions.md']};
    expect(await main(['--pr=6223', '--rulings=operator/flag-rulings.md'], deps(f, {
      readRulings:reader.readRulings,
    }))).toBe(0);
    expect(opened).toEqual([resolve('fixture-checkout', 'operator/flag-rulings.md')]);
  });
  it.each(['~/custom/rulings.md', 'operator/rulings.md'])('reads explicit rulings path %s', async rulingsFile => {
    const {deps, opened} = adapter(rulingEntry);
    expect(await deps.readRulings(rulingsFile)).toBe(rulingEntry);
    const expected = rulingsFile.startsWith('~/') ? 'fixture-home/custom/rulings.md'
      : resolve('fixture-checkout', rulingsFile);
    expect(opened).toEqual([expected]);
  });
  it('rejects oversized rulings before reading and closes the evidence descriptor', async () => {
    const {deps, closed} = adapter('', {size:8 * 1024 * 1024 + 1});
    await expect(Promise.resolve().then(()=>deps.readRulings('operator/rulings.md'))).rejects.toThrow(/human review/);
    expect(closed).toEqual([79]);
  });
  it.each([undefined, '', '  ', null, 42])('rejects missing or invalid rulings path %j', async rulingsFile => {
    const {deps, opened} = adapter(rulingEntry);
    await expect(Promise.resolve().then(()=>deps.readRulings(rulingsFile))).rejects.toThrow(/rulings/i);
    expect(opened).toEqual([]);
  });
  it('unreadable env rulings make condition 3 UNKNOWN when the exception is needed', async () => {
    const reader = createCheckDeps({env:{D_R379_RULINGS_FILE:'operator/unreadable.md'},
      fs:{constants:{O_RDONLY:0, O_NONBLOCK:2048}, openSync:()=>{ throw Error('unreadable'); }}});
    const f = {...fixture(6223), title:'R391 record', body:'Recorded verbatim',
      netDiffPaths:['docs/agent/platform-decisions.md']};
    const r = await checkPr(6223, deps(f, {readRulings:reader.readRulings}));
    expect(condition(r, 3).status).toBe('UNKNOWN');
    expect(r.eligible).toBe(false);
  });
});

describe('condition 4 operator exclusions', () => {
  const minimal = {rulingRecordPaths: settings.rulingRecordPaths};
  const empty = {...minimal, protectedPaths: [], directionPaths: []};
  const protectedCases = [
    'scripts/check-standards.mjs', 'scripts/lib/enforcement/rule-x.mjs',
    'scripts/readiness/x.mjs', 'scripts/lint-x.mjs',
    'docs/gate-policy.md', 'scripts/settings/pr-limit.json',
    'package-lock.json', 'playwright.config.ts',
    'skills-src/review/SKILL.md', 'packages/reviewer/CLAUDE.md',
    'prompts/review.md', '.claude/commands/review.md', '.github/helper.yml',
    '.github/image.png', 'config/settings/x.json', 'nested/.github/x.txt',
    'nested/.claude/x.txt', 'nested/package.json', 'nested/package-lock.json',
    'custom.config.json', 'nested/widget.config.ts', 'forge.config.json',
    'forge-exec.toml', 'forge-exec.yaml', 'nested/.FORGERC',
    'tools/D-R379-check-helper.txt', 'tools/d-r379-fixtures/x.json',
    ...['guard', 'gate', 'review', 'red-team', 'approval', 'audit',
      'check-standards', 'enforcement', 'readiness', 'lint', 'hook', 'hooks',
      'pr-state', 'standards-sections', 'codex-audit', 'verdict', 'ledger',
      'codeql', 'secret', 'permission', 'label', 'policy', 'jury', 'migrations',
      'test-cache', 'verify-lane', 'heavy-admission', 'hermetic-tests']
      .flatMap(name => [`other/prefix${name.toUpperCase()}suffix.txt`,
        `other/prefix${name.toUpperCase()}suffix/x.txt`]),
    'scripts/guard-bash.mjs', 'scripts/review-set-label.mjs',
    'scripts/lib/red-team-gate-core.mjs', 'scripts/lib/red-team-gate.mjs',
    'scripts/lib/jury-core.mjs', 'scripts/lib/secret-scrub.mjs',
    'scripts/lib/github-app-token.mjs', '.claude/hooks/x.mjs',
    '.githooks/pre-commit', 'scripts/hooks/pre-push', '.claude/settings.json',
    'settings.json', 'nested/settings.json', 'guard-custom.mjs',
    'tools/review-set-label-helper.mjs', 'tools/red-team-helper.mjs',
    'tools/referral-helper.mjs', 'scripts/lib/__tests__/guard-foo.test.mjs',
    'scripts/lib/__tests__/jury-core.test.mjs',
    'scripts/lib/__tests__/secret-scrub.test.mjs',
    'scripts/lib/__tests__/github-app-token.test.mjs',
    'scripts/readiness/forge-setup.sh', 'scripts/readiness/forge-exec-limits.mjs',
    'forge-exec/limits.json', 'etc/forge-exec/limits.json',
    'migrations/001.sql', 'data/migrations/001.sql',
    '.github/workflows/ci.yml', '.github/workflows/nested/check.yml',
    'scripts/operations/d-r379-check.mjs', 'scripts/operations/d-r379-check-io.mjs',
    'scripts/settings/d-r379-protected-paths.json',
    'scripts/operations/__tests__/d-r379-check.test.mjs',
    'scripts/operations/__tests__/d-r379-check-io-real.test.mjs',
    'scripts/operations/__fixtures__/d-r379/6223.json',
    'scripts/lib/pr-state.mjs', 'scripts/lib/pr-state/snapshot.mjs',
    'scripts/lib/pr-state/holds/index.mjs', 'scripts/lib/standards-sections.mjs',
    'scripts/operations/codex-audit.mjs', 'scripts/operations/codex-audit-io.mjs',
    'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.js',
    'package.json', 'scripts/test-cache/runner.mjs', 'scripts/test-cache/nested/cache.mjs',
    'scripts/readiness/heavy-admission.mjs', 'scripts/readiness/heavy-admission-io.mjs',
    'scripts/verify-lane.mjs', 'scripts/lib/hermetic-tests.mjs',
    ...['gate','guard','verdict','ledger','codeql','secret','approval','permission','label','policy']
      .flatMap(name => ['scripts', '.github'].flatMap(tree => [
        `${tree}/lib/custom-${name}-helper.mjs`,
        `${tree}/lib/__tests__/custom-${name}-helper.test.mjs`,
      ])),
  ];
  it.each(protectedCases)('protects %s even with empty or omitted JSON additions', async path => {
    for (const policy of [settings, empty, minimal]) {
      const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}, {
        readSettings: () => policy,
      }));
      expect(condition(r, 4)).toMatchObject({status: 'FAIL', evidence: [`protected path: ${path}`]});
      expect(r.eligible).toBe(false);
    }
  });
  it.each([
    'scripts/conveyor/foo.mjs', 'docs/examples/x.md', 'tests/a/b.test.mjs',
    'scripts/lib/__tests__/format-date.test.mjs', 'widget.spec.ts',
    'lib/__tests__/assertions.mjs', 'tests/helper.js', 'tests/a11y/helper.ts',
    'blocks/__tests__/e2e/helper.js', 'blocks/widget.js', 'blocks/foo.ts', 'blocks/foo/README.md',
    'src/assets/js/runtime.js', 'src/assets/active.svg', 'src/content.md',
    'docs/examples/access-control.tsx', 'docs/agent/testing.md',
    'scripts/lib/format-date.mjs',
    'scripts/gen-inventory.mjs', 'scripts/lib/gh-throttle.mjs',
    'scripts/ci/shard-runner.mjs',
    'scripts/image.svg', 'new-tree/future.code',
    'LICENSE.txt', 'backlog/nested/story.md', 'image.jpg',
  ])('passes non-protected path %s with explicit evidence', async path => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}));
    expect(condition(r, 4)).toMatchObject({status: 'PASS', evidence: ['no protected paths']});
  });
  it('passes a mixed diff when no path is protected', async () => {
    const r = await checkPr(6223, deps({...fixture(6223),
      netDiffPaths: ['docs/examples/x.md', 'scripts/conveyor/foo.mjs', 'tests/a/b.test.mjs']}));
    expect(condition(r, 4)).toMatchObject({status: 'PASS', evidence: ['no protected paths']});
    expect(r.eligible).toBe(true);
  });
  it('fails a mixed diff if any path is protected', async () => {
    const r = await checkPr(6223, deps({...fixture(6223),
      netDiffPaths: ['scripts/conveyor/foo.mjs', 'scripts/guard-bash.mjs']}));
    expect(condition(r, 4)).toMatchObject({status: 'FAIL', evidence: ['protected path: scripts/guard-bash.mjs']});
  });
  it.each([undefined, null, [], ['**'], Array(1001).fill('docs/**')])
  ('ignores removed classification keys regardless of value: %j', async value => {
    const policy = {...empty, harmlessPaths: value, enforcementTrees: value, reviewedSafePaths: value};
    for (const [path, status] of [['scripts/conveyor/foo.mjs', 'PASS'], ['scripts/guard-bash.mjs', 'FAIL']]) {
      const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}, {readSettings: () => policy}));
      expect(condition(r, 4).status).toBe(status);
    }
  });
  it.each([
    ['protectedPaths', 'docs/examples/protected.md', 4],
    ['directionPaths', 'docs/examples/direction.md', 3],
  ])('JSON %s additions extend the built-in policy', async (key, path, id) => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}, {
      readSettings: () => ({...empty, [key]: [path]}),
    }));
    expect(condition(r, id).status).toBe('FAIL');
  });
  it.each(['protectedPaths', 'directionPaths'])('oversized %s additions require human review', async key => {
    const r = await checkPr(6223, deps(undefined, {
      readSettings: () => ({...empty, [key]: Array(1001).fill('extra/**')}),
    }));
    for (const id of [3, 4]) {
      expect(condition(r, id).status).toBe('UNKNOWN');
      expect(condition(r, id).evidence.join(' ')).toContain('human review');
    }
  });
  it.each(['conformance-vectors/x.md', 'conformance-evidence/x.md', 'contracts/x.md',
    'schemas/x.md', 'wrapper-conformance/x.md'])('retains condition 3 direction protection for %s', async path => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}, {readSettings: () => empty}));
    expect(condition(r, 3)).toMatchObject({status: 'FAIL', evidence: [`direction path: ${path}`]});
    expect(condition(r, 4)).toMatchObject({status: 'PASS', evidence: ['no protected paths']});
  });
});
