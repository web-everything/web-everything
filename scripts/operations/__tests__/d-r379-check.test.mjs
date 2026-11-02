import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
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
    readReviewLedger: async pr => [verdict(pr, f.headRefOid)], readAudits: async () => [audit(f.headRefOid)],
    readRulingFile: async (sha) => sha === base ? 'Original rule.\n' : `Original rule.\n${rulingEntry}`,
    readRulingDiff: async () => rulingDiff(rulingEntry),
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

describe('protected implementation and test regressions', () => {
  it.each(['gate','guard','verdict','ledger','codeql','secret','policy','permission','approval','label']
    .flatMap(name => ['scripts', '.github'].flatMap(tree => [
      `${tree}/lib/custom-${name}-helper.mjs`,
      `${tree}/lib/__tests__/custom-${name}-helper.test.mjs`,
    ])))('generic protection refuses condition 4 for %s', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4).status).toBe('FAIL'); expect(r.eligible).toBe(false);
  });
  it.each([
    'scripts/lib/codeql-gate.mjs',
    'scripts/lib/__tests__/merge-gate-verdict.test.mjs',
    'scripts/operations/d-r379-check-io.mjs',
    'scripts/operations/codex-audit.mjs',
    'scripts/operations/codex-audit-io.mjs',
    'scripts/lib/standards-sections.mjs',
    'scripts/check-standards.mjs',
    'scripts/check-standards-rules.mjs',
    'scripts/check-demos.mjs',
    'scripts/check-memory.mjs',
    'scripts/lib/policy-cascade.mjs',
    'scripts/lib/constellation-repos.mjs',
    'scripts/lib/gh-throttle.mjs',
    'scripts/lib/delivery-platform-preferences.json',
    'scripts/lib/delivery-priority-settings.json',
    'scripts/__tests__/check-standards.test.mjs',
    'scripts/lib/review-core.mjs',
    'scripts/lib/review-ledger-history.mjs',
    'scripts/lib/verdict-ledger.mjs',
    'scripts/lib/verdict-ledger-io.mjs',
    'scripts/lib/pr-state.mjs',
    'scripts/lib/review-escalation.mjs',
    'scripts/lib/review-labels.mjs',
    'scripts/review-ledger-check.mjs',
    'scripts/settings/pr-limit.json',
    'scripts/drain-gate-settings.json',
    'scripts/lib/review-policy.contract.json',
    'scripts/check-standards.contract.json',
    'scripts/__tests__/guard-bash.test.mjs',
    'scripts/__tests__/review-set-label.test.mjs',
    'scripts/lib/__tests__/jury-core.test.mjs',
    'scripts/operations/__tests__/d-r379-check.test.mjs',
    'scripts/operations/__tests__/d-r379-check-io-real.test.mjs',
    'scripts/lib/__tests__/verdict-ledger.test.mjs',
    'scripts/lib/__tests__/pr-limit.test.mjs',
    'scripts/lib/utc-day-slice-scan.mjs',
    'scripts/lib/invisible-source-scan.mjs',
    'scripts/lib/stdout-flush-scan.mjs',
    'scripts/lib/rust-scan-bridge.mjs',
    'scripts/lib/validate-rules-anchors.cjs',
    'scripts/lib/memory-freshness.cjs',
    'scripts/lib/verdict-totality.mjs',
    'scripts/lib/jury-core.mjs',
    'scripts/lib/review-skill-guard.mjs',
    'scripts/lib/mandate-fence-scan.mjs'
  ])('classifies %s as protected with the shipped glob policy', async path => {
    expect(settings.protectedPaths.some(glob => matchesGlob(path,glob))).toBe(true);
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4).status).toBe('FAIL');
    expect(r.eligible).toBe(false);
  });
  it.each(['docs/foo.md','docs/examples/x.md','docs/gate-policy.md'])('keeps innocuous %s eligible', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4).status).toBe('PASS'); expect(r.eligible).toBe(true);
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

describe('protected test, coverage and CI execution controls', () => {
  it.each([
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    'vitest.live.config.ts',
    'vitest.soak.config.ts',
    'vitest.maas-conformance.config.ts',
    'vitest.shared.ts',
    'vitest.setup.ts',
    'vitest.globalSetup.mjs',
    'playwright.config.ts',
    'bun-test.preload.ts',
    '.github/workflows/ci.yml',
    '.github/workflows/update-visual-baselines.yml',
    'scripts/merge-coverage.mjs',
    'scripts/ci-card-only.mjs',
    'scripts/ci/quarantine-skip.mjs',
    'scripts/ci/coverage-reach.mjs',
    'scripts/ci/shard-runner-compare.mjs',
    'scripts/ci/test-timings.json',
    'scripts/conveyor/soak/run-shard.mjs',
    'scripts/dev/regression.mjs',
    'scripts/hermetic-tests.settings.json',
    'scripts/hermetic-test-baseline.json',
    'scripts/lib/hermetic-tests.mjs',
    'scripts/lib/hermetic-tests-vitest.mjs',
    'scripts/lib/hermetic-git-overlay.mjs',
    'scripts/lib/trust-chain-tier.mjs',
    'scripts/lib/test-result-cache.mjs',
    'scripts/lib/test-cache-trace.mjs',
    'scripts/lib/test-result-store.mjs',
    'scripts/lib/related-test-selection.mjs',
    'scripts/test-cache/shadow-reporter.mjs',
    'scripts/test-cache/trace-setup.mjs',
    'scripts/lib/workflow-invariants.cjs',
    'scripts/readiness/heavy-admission.mjs'
  ])('refuses eligibility for %s', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4).status).toBe('FAIL'); expect(r.eligible).toBe(false);
  });
});


describe('round 4 wholesale test protection', () => {
  it.each(['tests/helper.js', 'src/widget.spec.ts', 'widget.test.js',
    'lib/__tests__/assertions.mjs', 'playwright.mobile.config.ts',
    'config/playwright.config.js', 'tests/a11y/helper.ts', 'blocks/__tests__/e2e/helper.js'])
  ('requires operator review for any edit or assertion removal in %s', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4)).toMatchObject({status:'FAIL',evidence:[`protected path: ${path}`]});
    expect(r.eligible).toBe(false);
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
    expect(calls).toEqual([['git',['--literal-pathspecs','diff','--numstat','-z',base,f.headRefOid,'--',path]]]);
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


describe('round 6 enforcement-tree classification', () => {
  it.each(['scripts/rust-scan/src/stdout_flush.rs', 'scripts/lib/we-scan-cache.mjs',
    'docs/agent/testing.md', 'scripts/lib/format-date.mjs', '.github/helper.yml',
    '.claude/commands/example.md', 'new-config.json', 'native/check.rs', 'tools/check.sh', 'README.rs'])
  ('keeps unclassified %s UNKNOWN with operator review', async path => {
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}));
    expect(condition(r,4)).toMatchObject({status:'UNKNOWN',
      evidence:[`unclassified enforcement-tree path: ${path}; operator review`]});
    expect(r.eligible).toBe(false);
  });
  it.each(['docs/examples/x.md','backlog/123-story.md','blocks/foo/README.md','src/content.md',
    'README.md','LICENSE.txt','CHANGELOG.md'])('passes content path %s', async path => {
    expect(condition(await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]})),4).status).toBe('PASS');
  });
  it('allows an explicitly reviewed safe path', async () => {
    const path = 'scripts/lib/format-date.mjs';
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:[path]}, {
      readSettings:()=>({...settings,reviewedSafePaths:[path]}),
    }));
    expect(condition(r,4).status).toBe('PASS');
  });
  it.each([[[]],[['scripts/**']]])('protected FAIL wins with reviewedSafePaths %j', async reviewedSafePaths => {
    const path = 'scripts/check-standards.mjs';
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:['scripts/new.mjs',path]}, {
      readSettings:()=>({...settings,reviewedSafePaths}),
    }));
    expect(condition(r,4)).toMatchObject({status:'FAIL',evidence:[`protected path: ${path}`]});
  });
  it('defaults absent reviewedSafePaths to empty for old settings', async () => {
    const {reviewedSafePaths, ...oldSettings} = settings;
    const r = await checkPr(6223,deps({...fixture(6223),netDiffPaths:['scripts/new.mjs']}, {
      readSettings:()=>oldSettings,
    }));
    expect(condition(r,4).status).toBe('UNKNOWN');
  });
  it.each([{enforcementTrees:[]},{enforcementTrees:null},{reviewedSafePaths:null},
    {reviewedSafePaths:['']},{reviewedSafePaths:Array(1001).fill('docs/**')}])
  ('keeps invalid classification settings closed: %j', async extra => {
    const r = await checkPr(6223,deps(undefined,{readSettings:()=>({...settings,...extra})}));
    expect(condition(r,4).status).toBe('UNKNOWN'); expect(r.eligible).toBe(false);
    expect(condition(r,4).evidence.join(' ')).toContain('human review');
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
  it.each(['R999','D-R999'])('accepts a cited %s entry with indented continuations', async id => {
    const r = await check(`- **${id}** (date) Operator: "..."\n\n  Continuation.\n- **${id}** (date) Operator: "More."\n`);
    expect(condition(r,3)).toMatchObject({status:'PASS',
      evidence:expect.arrayContaining(['provenance claimed by PR, not verified'])});
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
    }),3).status).toBe('PASS');
    expect(calls).toEqual([['git',['--literal-pathspecs','diff','--no-ext-diff','--no-textconv',
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
  it.each(['2026-11-02T09:00:00Z','2026-11-02T10:00:00Z'])('permits a hold applied at %s before or at acceptance', async at => {
    expect(condition(await check('review:human',()=>[event('review:human',at)]),2).status).toBe('PASS');
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
  it('does not read timeline when no live hold exists', async () => {
    expect((await checkPr(6223,deps(undefined,{readLabelEvents:()=>{throw Error('must not read');}}))).eligible).toBe(true);
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

describe('round 9 agent and review instruction enforcement', () => {
  it.each(['skills-src/review/SKILL.md', 'skills-src/review/review-agent-system-prompt.md',
    'packages/reviewer/SKILL.md', 'packages/reviewer/CLAUDE.md',
    'agent-memory-src/mandatory-guards.md', '.claude-plugin/review/instructions.md',
    'prompts/review.md', 'packages/reviewer/prompts/review.md',
    '.claude/commands/review.md', '.github/prompts/review.prompt.md',
    'skills/review/instructions.md', 'packages/reviewer/skills/review/instructions.md'])
  ('keeps instruction Markdown %s UNKNOWN with operator fallback', async path => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}));
    expect(condition(r, 4)).toMatchObject({status: 'UNKNOWN',
      evidence: [`unclassified enforcement-tree path: ${path}; operator review`]});
    expect(r.eligible).toBe(false);
  });
  it('keeps ordinary example Markdown PASS', async () => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: ['docs/examples/x.md']}));
    expect(condition(r, 4).status).toBe('PASS');
  });
});

describe('round 8 runtime source enforcement across trees', () => {
  it.each(['blocks/router/route-config.ts', 'blocks/widget.js', 'src/assets/js/runtime.js',
    'src/runtime/check.ts', 'src/runtime/check.mjs', 'apps/server/validate.cjs',
    'packages/schema/check.py', 'plateau/runtime/validate.rs', 'plateau-app/runtime/check.sh',
    'packages/runtime/config.json', 'validation-generation/provider.ts',
    'validator-resolution/provider.ts', 'validity-merge/provider.ts', 'capability-manifest/guard.ts',
    'conformance-vectors/schema.ts', 'conformance-evidence/provider.ts', 'explorer/schema.ts',
    'repro-bundle/schema.ts', 'guard/accessControl.ts', 'config/defineConfig.ts',
    'webcases/requirementValidator.ts', 'functions/runtime/check.js', 'tools/runtime/check.mjs'])
  ('keeps runtime source %s UNKNOWN with operator fallback', async path => {
    const r = await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]}));
    expect(condition(r, 4)).toMatchObject({status: 'UNKNOWN',
      evidence: [`unclassified enforcement-tree path: ${path}; operator review`]});
    expect(r.eligible).toBe(false);
  });
  it.each(['docs/examples/x.md', 'blocks/foo/README.md', 'blocks/foo/example.njk',
    'blocks/foo/style.css', 'blocks/foo/image.png', 'src/pages/example.njk',
    'src/assets/style.css', 'apps/docs/README.md', 'packages/docs/example.njk',
    'plateau/docs/image.svg', 'validation-generation/README.md'])
  ('keeps content %s PASS', async path => {
    expect(condition(await checkPr(6223, deps({...fixture(6223), netDiffPaths: [path]})), 4).status).toBe('PASS');
  });
});
