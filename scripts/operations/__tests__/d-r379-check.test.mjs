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
const verdict = (pr, headSha, extra = {}) => buildVerdictRecord({
  repo: CONSTELLATION_REPOS.we.slug, pr, headSha, verdict: 'accepted',
  at: '2026-11-02T10:00:00Z', source: 'd-r379-fixture', writer: 'fixture', ...extra,
});
function deps(f = fixture(6223), overrides = {}) {
  return { readPr: async () => f, readLabels: async () => f.labels,
    fetchNetDiff: async () => ({paths: f.netDiffPaths, base}),
    readReviewLedger: async pr => [verdict(pr, f.headRefOid)], readAudits: async () => [audit(f.headRefOid)],
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
  it.each(['red-team:held','red-team:pending','red-team:blocked','red-team:future-hold','review:changes','review:blocked','review:held-mechanical'])('rejects %s', async label => {
    expect(condition(await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,label]})),2).status).toBe('FAIL');
  });
  it('review:human alongside acceptance fails', async () => {
    expect((await checkPr(1,deps({...fixture(6223),labels:[...fixture(6223).labels,'review:human']}))).eligible).toBe(false);
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
  it('reads configured ledger store through the shared reader', async () => {
    const calls = [], rows = [verdict(6223,fixture(6223).headRefOid)];
    const adapter = createCheckDeps({env:{FIXTURE:'yes'},readLedger:async (repo,opts)=>{
      calls.push([repo,opts.env]); return {status:'ok',rows};
    }});
    expect(await adapter.readReviewLedger(6223)).toEqual(rows);
    expect(calls).toEqual([[CONSTELLATION_REPOS.we.slug,{FIXTURE:'yes'}]]);
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
  it.each(['docs/foo.md','scripts/lib/format-date.mjs','docs/gate-policy.md'])('keeps innocuous %s eligible', async path => {
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
  it('preserves the R391 exception for a pure decision ruling-record', async () => {
    const f = {...fixture(6223),title:'R391 record',body:'> Operator ruling',netDiffPaths:['backlog/123-rulings.md']};
    const r = await checkPr(6223,deps(f,{readHeadFile:()=>card('resolved'),readBaseFile:()=>card('resolved')}));
    expect(condition(r,3)).toMatchObject({status:'PASS',evidence:expect.arrayContaining(['R391 ruling-record'])});
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
