import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPostmortem, shouldPostmortem, publishPostmortem, resolvePostmortemSettings, collectPrTimeline, withCoronerLock } from '../coroner-pr-postmortem.mjs';
import { runPostmortemPass, listMergedSince } from '../../conveyor/pass-daemons/pr-postmortem-pass.mjs';
import { hostname } from 'node:os';
import { reserve } from '../../readiness/file-locks.mjs';

const at = m => new Date(Date.UTC(2026, 9, 17, 0, m)).toISOString();
const comment = (m, body) => ({ createdAt: at(m), body, author: { login: 'web-everything' } });
function fixture(pr = 1) {
  return { repo: 'example/repo', pr, openedAt: at(0), mergedAt: at(600),
    labels: [[0, 'checking'], [10, 'status:awaiting-ci'], [20, 'review:queued'], [40, 'review:running'], [50, 'review:changes'], [80, 'status:needs-you'], [100, 'ready-to-merge'], [200, 'merge-queue']].map(([m,label]) => ({ event: 'labeled', created_at: at(m), label: { name: label } })),
    comments: [comment(50, '🔁 review — changes requested\nRecorded by agent\nfor head `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n### Findings\n**judge/correctness** (1)\n- `src/a.js:2` — missing guard'), comment(60, '🔒 conveyor fix-begin\n**Who:** `fixer`'), comment(70, '🔓 conveyor fix-end\n`fixer` released'), comment(90, 'conveyor fix — stood down: does not reproduce'), comment(120, 'drain-skip: required check test is not green')],
    commits: [{ sha: 'a'.repeat(40), commit: { committer: { date: at(0) }, message: 'build' } }, { sha: 'b'.repeat(40), commit: { committer: { date: at(75) }, message: 'fix' } }],
    checks: [{ name: 'test', head_sha: 'a'.repeat(40), created_at: at(0), started_at: at(10), completed_at: at(20), conclusion: 'failure' }],
    verdicts: [{ at: at(55), verdict: 'accept', coverage: { headSha: 'a'.repeat(40) } }], fixLoop: [], files: [{ filename: 'src/a.js' }, { filename: 'extra.js' }], scope: ['src/**'], prepares: [{ at: at(-1440), ref: 'prepare-1' }] };
}
const temp = () => fs.mkdtempSync(join(process.cwd(), '.coroner-test-'));
const settings = { value: { minLeadHours: 8, minFixRounds: 4, minLostApprovals: 2, onStandDown: true } };
function collectorGh(overrides = {}) {
  return args => {
    const path = args.at(-1);
    for (const [match, response] of Object.entries(overrides)) if (match === '/pulls/1' ? path.endsWith(match) : path.includes(match)) return typeof response === 'function' ? response(path) : response;
    if (path.endsWith('/pulls/1')) return { merged_at:at(600), created_at:at(0), head:{ref:'lane/no-card'}, base:{sha:'z'} };
    if (path.includes('/commits?')) return [fixture().commits];
    if (path.includes('/check-runs?')) return [{check_runs:fixture().checks}];
    if (path.includes('/contents/')) throw Error('optional data unavailable');
    return [[]];
  };
}
const collectWith = gh => collectPrTimeline('example/repo',1,{gh,comments:() => fixture().comments,env:{WE_FIX_LOOP_LEDGER:join(process.cwd(),'.absent-coroner-ledger')}});
describe('per PR postmortem', () => {
  it('retries a removed quarantine entry after cursor advancement', async () => {
    const dir = temp(); const reads = []; let fail = true;
    const file = join(dir,'merge-cursor-example%2Frepo.json');
    const args = { repo:'example/repo',dir,settings,
      listMerged:(_repo,since) => at(600) >= since ? [{number:2,merged_at:at(600)}] : [],
      collect:(_repo,pr) => { reads.push(pr); if (fail) throw Error('temporarily unavailable'); return fixture(pr); } };
    try {
      for (const now of [at(700),at(701)]) await expect(runPostmortemPass({...args,now})).rejects.toThrow('unavailable');
      await runPostmortemPass({...args,now:at(730)});
      await runPostmortemPass({...args,now:at(740)});
      expect(reads).toEqual([2,2,2]);
      const state = JSON.parse(fs.readFileSync(file)); state.quarantined = [];
      fs.writeFileSync(file,JSON.stringify(state));
      fail = false;
      await runPostmortemPass({...args,now:at(741)});
      expect(reads).toEqual([2,2,2,2]);
      expect(JSON.parse(fs.readFileSync(file))).toMatchObject({done:[2],failures:{},quarantined:[]});
      expect(fs.existsSync(join(dir,'postmortem-example%2Frepo-2.md'))).toBe(true);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('keeps rapid collection failures retryable across restarts until the minimum duration', async () => {
    const dir = temp(); let fail = true;
    const file = join(dir,'merge-cursor-example%2Frepo.json');
    const args = { repo:'example/repo',dir,settings,listMerged:() => [{number:2}],
      collect:() => { if (fail) throw Error('rate limited'); return fixture(2); } };
    try {
      for (const now of [at(700),new Date(Date.parse(at(700))+15000).toISOString(),new Date(Date.parse(at(700))+30000).toISOString(),at(701)]) {
        await expect(runPostmortemPass({...args,now})).rejects.toThrow('rate limited');
        expect(JSON.parse(fs.readFileSync(file))).toMatchObject({quarantined:[],failures:{2:{firstFailedAt:at(700)}}});
      }
      fail = false;
      await runPostmortemPass({...args,now:at(702)});
      expect(JSON.parse(fs.readFileSync(file))).toMatchObject({done:[2],failures:{},quarantined:[]});
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('upgrades legacy quarantine subjects and retries after operator removal', async () => {
    const dir = temp(); const file = join(dir,'merge-cursor-example%2Frepo.json'); const reads = [];
    const failure = {pr:2,attempts:3,at:at(702),incomplete:true,error:'old collection failure'};
    const args = {repo:'example/repo',dir,settings,listMerged:() => [],collect:(_repo,pr) => {reads.push(pr); return fixture(pr);}};
    try {
      fs.writeFileSync(file,JSON.stringify({cursor:at(740),done:[],failures:{},quarantined:[failure]}));
      await runPostmortemPass({...args,now:at(741)});
      expect(reads).toEqual([]);
      const state = JSON.parse(fs.readFileSync(file));
      expect(state.failures[2]).toEqual(failure);
      state.quarantined = []; fs.writeFileSync(file,JSON.stringify(state));
      await runPostmortemPass({...args,now:at(742)});
      expect(reads).toEqual([2]);
      expect(fs.existsSync(join(dir,'postmortem-example%2Frepo-2.md'))).toBe(true);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('preserves the elapsed failure budget when upgrading a retry without firstFailedAt', async () => {
    const dir = temp(); const file = join(dir,'merge-cursor-example%2Frepo.json');
    try {
      fs.writeFileSync(file,JSON.stringify({cursor:at(650),done:[],failures:{2:{pr:2,attempts:2,at:at(700)}}}));
      const args = {repo:'example/repo',dir,settings,listMerged:() => [],collect:() => {throw Error('unavailable');}};
      await expect(runPostmortemPass({...args,now:at(701)})).rejects.toThrow('unavailable');
      expect(JSON.parse(fs.readFileSync(file))).toMatchObject({quarantined:[],failures:{2:{attempts:3,firstFailedAt:at(700)}}});
      await runPostmortemPass({...args,now:at(730)});
      expect(JSON.parse(fs.readFileSync(file)).quarantined).toMatchObject([{pr:2,attempts:4,firstFailedAt:at(700)}]);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it.each(['labeled','unlabeled','added_to_merge_queue','removed_from_merge_queue'])('rejects %s events with invalid timestamps', event => {
    for (const stamp of [undefined,null,'','invalid']) {
      const labels = [...fixture().labels,{event,created_at:stamp,label:{name:'checking'}}];
      expect(() => collectWith(collectorGh({'/events?':[labels]}))).toThrow(/incomplete.*timestamp/);
      expect(() => buildPostmortem({...fixture(),labels})).toThrow(/timestamp/);
    }
  });
  it.each(['labeled','unlabeled'])('rejects %s events with invalid label names', event => {
    for (const label of [undefined,null,{}, {name:''}, {name:' '}, {name:42}]) {
      const labels = [{event,created_at:at(10),label}];
      expect(() => collectWith(collectorGh({'/events?':[labels]}))).toThrow(/incomplete.*label/);
      expect(() => buildPostmortem({...fixture(),labels})).toThrow(/label/);
    }
  });
  it('preserves ambiguous legacy files and starts fresh encoded discovery', async () => {
    const dir = temp(); const legacy = {
      'merge-cursor-a-b-c.json':JSON.stringify({cursor:at(690),done:[1]}),
      'postmortem-a-b-c-1.json':'legacy json', 'postmortem-a-b-c-1.md':'legacy markdown',
    };
    const windows = [];
    try {
      for (const [name,contents] of Object.entries(legacy)) fs.writeFileSync(join(dir,name),contents);
      for (const repo of ['a-b/c','a/b-c']) await runPostmortemPass({repo,dir,now:at(700),settings,
        listMerged:(subject,since,until) => { windows.push([subject,since,until]); return [{number:1}]; },
        collect:() => ({...fixture(),repo})});
      expect(windows).toEqual(['a-b/c','a/b-c'].map(repo => [repo,at(700-1440-1),at(700)]));
      for (const [name,contents] of Object.entries(legacy)) expect(fs.readFileSync(join(dir,name),'utf8')).toBe(contents);
      for (const key of ['a-b%2Fc','a%2Fb-c']) expect(fs.existsSync(join(dir,`postmortem-${key}-1.md`))).toBe(true);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('bounds local ledger read ranges', () => {
    const dir = temp(); const file = join(dir,'ledger.jsonl'); const cap = 1024*1024;
    try {
      fs.writeFileSync(file,' '.repeat(cap*2)+'\n'+JSON.stringify({v:1,repo:'example/repo',pr:1,kind:'fix',head:'a'.repeat(40),at:at(20)})+'\n');
      const size = fs.statSync(file).size;
      // Vitest can snapshot named builtin imports before a default-export spy is
      // installed. Native ESM keeps syncBuiltinESMExports effective for the reader.
      const { raw, reads } = JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { collectPrTimeline } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),'../coroner-pr-postmortem.mjs')).href)};
        const { file, snapshot } = JSON.parse(fs.readFileSync(0,'utf8'));
        const gh = args => {
          const path = args.at(-1);
          if (path.endsWith('/pulls/1')) return { created_at:snapshot.openedAt, merged_at:snapshot.mergedAt, head:{ref:'lane/no-card'}, base:{sha:'z'} };
          if (path.includes('/commits?')) return [snapshot.commits];
          if (path.includes('/check-runs?')) return [{check_runs:snapshot.checks}];
          if (path.includes('/contents/')) throw Error('optional data unavailable');
          return [[]];
        };
        const reads = [], original = fs.readSync;
        fs.readSync = (fd,buffer,offset,length,position) => {
          reads.push({length,position}); return original(fd,buffer,offset,length,position);
        };
        syncBuiltinESMExports();
        let raw;
        try { raw = collectPrTimeline('example/repo',1,{gh,comments:() => [],env:{WE_FIX_LOOP_LEDGER:file}}); }
        finally { fs.readSync = original; syncBuiltinESMExports(); }
        process.stdout.write(JSON.stringify({raw,reads}));
      `],{input:JSON.stringify({file,snapshot:fixture()}),encoding:'utf8',timeout:30000}));
      expect(raw.fixLoop).toHaveLength(1);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((sum,r) => sum+r.length,0)).toBeLessThanOrEqual(cap);
      expect(reads.every(r => r.position >= size-cap && r.position+r.length <= size)).toBe(true);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('refuses oversized journals before publication', () => {
    const dir = temp(); const file = join(dir,'incidents.jsonl'); const cap = 64*1024*1024;
    try {
      fs.writeFileSync(file,''); fs.truncateSync(file,cap+1);
      const spy = vi.spyOn(fs,'readSync');
      try {
        expect(() => publishPostmortem(buildPostmortem(fixture()),{dir})).toThrow(/exceeds read cap/);
        expect(spy.mock.calls.reduce((sum,args) => sum+args[3],0)).toBeLessThanOrEqual(cap);
      } finally { spy.mockRestore(); }
      expect(fs.statSync(file).size).toBe(cap+1);
      expect(fs.readdirSync(dir)).toEqual(['incidents.jsonl']);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it.each(['journal','report'])('retains cursor and retries publication failures without quarantine: %s', async target => {
    const dir = temp(); const cursor = join(dir,'merge-cursor-example%2Frepo.json');
    const report = join(dir,'postmortem-example%2Frepo-2.md');
    const blocked = target === 'journal' ? join(dir,'incidents.jsonl') : report;
    const initial = {cursor:at(650),done:[],failures:{},quarantined:[]};
    const args = {repo:'example/repo',dir,settings,now:at(700),listMerged:() => [{number:2}],collect:() => fixture(2)};
    try {
      fs.writeFileSync(cursor,JSON.stringify(initial)); fs.mkdirSync(blocked);
      await expect(runPostmortemPass(args)).rejects.toThrow();
      expect(JSON.parse(fs.readFileSync(cursor))).toEqual(initial);
      fs.rmSync(blocked,{recursive:true});
      await runPostmortemPass({...args,now:at(701)});
      expect(JSON.parse(fs.readFileSync(cursor))).toMatchObject({cursor:at(701),done:[2],failures:{},quarantined:[]});
      expect(fs.existsSync(report)).toBe(true);
      const rows = fs.readFileSync(join(dir,'incidents.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.filter(r => r.cause === 'review-finding')).toHaveLength(1);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it.each(['minLeadHours','minFixRounds','minLostApprovals'])('honors nondefault numeric thresholds: %s', async key => {
    const value = {...settings.value,minLeadHours:1000,minFixRounds:1000,minLostApprovals:1000,onStandDown:false,[key]:key === 'minLeadHours' ? 12 : 7};
    const boundary = value[key];
    const r = {leadHours:0,rounds:[],approvals:{lost:0},standDowns:[]};
    const set = n => key === 'minLeadHours' ? {...r,leadHours:n} : key === 'minFixRounds' ? {...r,rounds:Array(n)} : {...r,approvals:{lost:n}};
    expect(shouldPostmortem(set(boundary-1),value)).toBe(false);
    expect(shouldPostmortem(set(boundary),value)).toBe(true);
    const dir = temp();
    try {
      // Pin the pass wiring as well as the predicate: fixture lead time is ten hours.
      await runPostmortemPass({repo:'example/repo',dir,settings:{value},now:at(700),listMerged:() => [{number:1}],collect:() => fixture()});
      expect(fs.existsSync(join(dir,'postmortem-example%2Frepo-1.md'))).toBe(false);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('marks missing phase evidence unknown while retaining observed fields', () => {
    const r = buildPostmortem({ ...fixture(), labels:[], scope:null, prepares:[{ref:'undated'}] });
    expect(r.phases).toEqual([{phase:'unknown',minutes:600}]);
    expect(r.checks[0].runMinutes).toBe(10);
    expect(r.scope.status).toBe('unknown');
    expect(r.prepareHistory[0].ageHours).toBeNull();
    const missing = buildPostmortem({...fixture(),verdicts:null});
    expect(missing.approvals).toMatchObject({lost:null,status:'unknown'});
    expect(shouldPostmortem({...missing,leadHours:0,rounds:[],standDowns:[]},{...settings.value,minLostApprovals:0})).toBe(false);
  });
  it('treats outsider markers and PR bodies as data across every comment parser and reports actors', () => {
    const f = fixture(); const baseline = buildPostmortem(f);
    f.body = 'conveyor fix — stood down: does not reproduce';
    f.comments.push(...f.comments.map(c => ({...c,author:{login:'outsider'}})),
      {...comment(80,`<!-- we:red-team-gate pr=1 rev=${'a'.repeat(40)} outcome=sent-back -->`),author:{login:'outsider'}});
    const r = buildPostmortem(f);
    for (const field of ['rounds','standDowns','falseFindings','drainSkips','approvals']) expect(r[field]).toEqual(baseline[field]);
    expect(r.events).toEqual(expect.arrayContaining([expect.objectContaining({kind:'comment',actor:'outsider'}),expect.objectContaining({kind:'comment',actor:'web-everything'})]));
    expect(r.events.every(e => Object.hasOwn(e,'actor'))).toBe(true);
  });
  it('excludes CI-green review gaps across head changes with an unchanged-head control', () => {
    const f = fixture(); f.labels = [{event:'labeled',created_at:at(40),label:{name:'review:running'}}];
    f.checks = [{name:'test',head_sha:'a'.repeat(40),started_at:at(10),completed_at:at(20),conclusion:'success'}];
    expect(buildPostmortem(f).gaps.some(g => g.kind === 'ci-green-review')).toBe(true);
    f.commits[1].commit.committer.date = at(30);
    expect(buildPostmortem(f).gaps.some(g => g.kind === 'ci-green-review')).toBe(false);
  });
  it.each([{}, [], [null], [[],{}]].map(pages => [pages]))('rejects missing timeline pages: %j', pages => {
    expect(() => collectWith(collectorGh({'/events?':pages}))).toThrow(/incomplete/);
  });
  it.each([{}, [], [null], [{check_runs:null}]].map(pages => [pages]))('rejects invalid check-run pages: %j', pages => {
    expect(() => collectWith(collectorGh({'/check-runs?':pages}))).toThrow(/incomplete/);
  });
  it('rejects excessive observed heads', () => {
    const commits = Array.from({length:201},(_,i) => ({...fixture().commits[0],sha:String(i).padStart(40,'0')}));
    expect(() => collectWith(collectorGh({'/commits?':[commits]}))).toThrow(/incomplete.*200 observed heads/);
  });
  it('rejects missing comment pages instead of returning an apparently clean report', () => {
    let error;
    try { collectPrTimeline('example/repo',1,{gh:collectorGh(),comments:() => null,env:{}}); } catch (e) { error = e; }
    expect(error).toMatchObject({incomplete:true,message:expect.stringContaining('incomplete')});
  });
  it('marks missing local ledgers incomplete and truncated local ledgers bounded', () => {
    const dir = temp(); const file = join(dir,'ledger.jsonl');
    const read = () => collectPrTimeline('example/repo',1,{gh:collectorGh(),comments:() => [],env:{WE_FIX_LOOP_LEDGER:file}});
    try {
      expect(read().completeness.fixLoop).toBe('incomplete');
      fs.writeFileSync(file,' '.repeat(1024*1024)+'\n'+JSON.stringify({v:1,repo:'example/repo',pr:1,kind:'fix',head:'a'.repeat(40),at:at(20)})+'\n');
      const raw = read();
      expect(raw.completeness.fixLoop).toBe('bounded'); expect(raw.fixLoop).toHaveLength(1);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('marks malformed verdict ledger rows incomplete rather than reporting zero lost approvals', () => {
    const raw = collectWith(collectorGh({'/events?':[fixture().labels],'/contents/':{content:Buffer.from('{"truncated":\n').toString('base64')}}));
    expect(raw.completeness.verdicts).toBe('incomplete');
    const r = buildPostmortem(raw);
    expect(r.approvals.lost).toBeNull();
    expect(raw.comments).toEqual(fixture().comments);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({waitMinutes:10,runMinutes:10});
    expect(r.phases).toEqual(buildPostmortem(fixture()).phases);
    expect(r.rounds).toHaveLength(1);
  });
  it('marks failed card history incomplete while preserving core evidence', () => {
    const gh = collectorGh({
      '/pulls/1':{merged_at:at(600),created_at:at(0),head:{ref:'lane/xvi6k7s-build'},base:{sha:'z'}},
      '/contents/backlog?':[{name:'xvi6k7s-card.md',path:'backlog/xvi6k7s-card.md'}],
      '/commits?path=':[[{sha:'new',commit:{committer:{date:at(20)}}},{sha:'old',commit:{committer:{date:at(-10)}}}]],
      '/contents/backlog/':path => { if (path.endsWith('ref=new')) throw Error('missing revision'); return {content:Buffer.from('---\nscope: ["src/**"]\npreparedDate: "2026-10-16"\n---\n').toString('base64')}; },
    });
    const raw = collectWith(gh); const r = buildPostmortem(raw);
    expect(raw.completeness.card).toBe('incomplete');
    expect(raw.warnings).toContain('Card scope/prepare history unavailable');
    expect(r.scope.status).toBe('unknown'); expect(r.prepareHistory).toEqual([]);
    expect(raw.comments).toHaveLength(fixture().comments.length); expect(r.checks).toHaveLength(1);
    expect(r.approvals.lost).toBeNull();
  });
  it('rejects excessive card revisions as incomplete optional evidence', () => {
    const raw = collectWith(collectorGh({
      '/pulls/1':{merged_at:at(600),created_at:at(0),head:{ref:'lane/xvi6k7s-build'},base:{sha:'z'}},
      '/contents/backlog?':[{name:'xvi6k7s-card.md',path:'backlog/xvi6k7s-card.md'}],
      '/commits?path=':[Array.from({length:101},() => ({sha:'revision'}))],
    }));
    expect(raw.completeness.card).toBe('incomplete'); expect(raw.scope).toBeNull(); expect(raw.prepares).toEqual([]);
  });
  it('reclaims a dead local owner and preserves a live owner', async () => {
    const dir = temp(); const root = join(dir,'locks'); const key = 'coroner-postmortem';
    try {
      // An exited child gives a real dead PID rather than assuming a magic PID is unused.
      const { spawnSync } = await import('node:child_process');
      const child = spawnSync(process.execPath,['-e','process.exit(0)']);
      const dead = child.pid;
      expect(() => process.kill(dead,0)).toThrow();
      expect(reserve(root,key,`${hostname()}:${dead}:dead`,Date.now(),new Date().toISOString(),dead,() => 'dead',120,null,true).ok).toBe(true);
      let called = 0;
      await withCoronerLock(dir,async () => { called++; await expect(withCoronerLock(dir,() => {called++;})).rejects.toThrow('already running'); });
      expect(called).toBe(1);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('keeps colliding repository slugs independent in cursor and report filenames', async () => {
    const dir = temp();
    try {
      for (const repo of ['a-b/c','a/b-c']) await runPostmortemPass({repo,dir,now:at(700),settings,listMerged:() => [{number:1}],collect:() => ({...fixture(),repo})});
      for (const key of ['a-b%2Fc','a%2Fb-c']) {
        expect(JSON.parse(fs.readFileSync(join(dir,`merge-cursor-${key}.json`))).done).toEqual([1]);
        expect(fs.existsSync(join(dir,`postmortem-${key}-1.md`))).toBe(true);
      }
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('quarantines a permanently failing PR after three attempts without blocking later merges', async () => {
    const dir = temp(); const reads = [];
    const settings = { value: { minLeadHours: 8, minFixRounds: 4, minLostApprovals: 2, onStandDown: true } };
    const collect = (_repo, pr) => { reads.push(pr); if (pr === 2) throw Error('invalid check-run pages'); return fixture(pr); };
    const listMerged = (_repo, since) => [2, 3].filter(number => at(600) >= since).map(number => ({ number, merged_at: at(600) }));
    try {
      for (const now of [at(700), at(701)]) {
        await expect(runPostmortemPass({ repo:'example/repo', dir, now, settings, collect, listMerged })).rejects.toThrow('invalid check-run pages');
        const state = JSON.parse(fs.readFileSync(join(dir,'merge-cursor-example%2Frepo.json')));
        expect(state.cursor).toBe(at(-740));
        expect(state.done).toContain(3);
      }
      const result = await runPostmortemPass({ repo:'example/repo', dir, now:at(730), settings, collect, listMerged });
      expect(result).toMatchObject({ cursor:at(730), quarantined:[{ pr:2, attempts:3, error:'invalid check-run pages' }] });
      expect(fs.existsSync(join(dir,'postmortem-example%2Frepo-3.md'))).toBe(true);
      await runPostmortemPass({ repo:'example/repo', dir, now:at(731), settings, collect, listMerged });
      expect(reads).toEqual([2,3,2,2]);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('extracts deterministic phases, benchmark gaps, rounds, checks, approvals and scope', () => {
    const r = buildPostmortem(fixture());
    expect(r).toEqual(buildPostmortem(fixture()));
    expect(r.phases.find(p => p.phase === 'ci-wait').minutes).toBe(10);
    expect(r.checks[0]).toMatchObject({ waitMinutes: 10, runMinutes: 10 });
    expect(r.gaps.find(g => g.kind === 'ready-enqueued')).toMatchObject({ minutes: 100, p90: 75.2, minutesLost: 24.8 });
    expect(r.rounds[0].causes.map(c => c.cause)).toContain('ci-heal');
    expect(r.rounds[0].causes.map(c => c.cause)).toContain('review-finding');
    expect(r.approvals.lost).toBe(1);
    expect(r.scope.outside).toEqual(['extra.js']);
    expect(r.prepareHistory[0].ageHours).toBe(24);
    expect(r.drainSkips).toHaveLength(1);
  });
  it('retains REST check runs that expose started_at without created_at', () => {
    const f = fixture();
    f.checks = [{id:1,name:'test',head_sha:'a'.repeat(40),started_at:at(10),completed_at:at(20),conclusion:'failure'}];
    const r = buildPostmortem(f);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({waitMinutes:null,runMinutes:10});
    expect(r.rounds.flatMap(x => x.causes)).toEqual(expect.arrayContaining([expect.objectContaining({cause:'ci-heal',check:'test'})]));
  });
  it('respects every threshold including equality and stand-down', () => {
    const r = { leadHours: 1, rounds: [], approvals: { lost: 0 }, standDowns: [] };
    expect(shouldPostmortem(r)).toBe(false);
    expect(shouldPostmortem({ ...r, leadHours: 8 })).toBe(true);
    expect(shouldPostmortem({ ...r, rounds: Array(4) })).toBe(true);
    expect(shouldPostmortem({ ...r, approvals: { lost: 2 } })).toBe(true);
    expect(shouldPostmortem({ ...r, standDowns: [{}] })).toBe(true);
    expect(shouldPostmortem({ ...r, standDowns: [{}] }, { minLeadHours: 8, minFixRounds: 4, minLostApprovals: 2, onStandDown: false })).toBe(false);
  });
  it('logs cascade sources and ignores invalid overrides', () => {
    const logs = [];
    const s = resolvePostmortemSettings({ tool: { minLeadHours: 3 }, platform: { minFixRounds: 2 }, env: { WE_CORONER_POSTMORTEM_MIN_LEAD_HOURS: '-1' }, log: l => logs.push(l) });
    expect(s.value.minLeadHours).toBe(3);
    expect(s.sources.minFixRounds).toBe('platform');
    expect(logs.join('')).toContain('tool');
  });
  it('publishes once across reruns and emits one candidate for three distinct PRs in 24 hours', () => {
    const dir = temp();
    try {
      for (const pr of [1, 1, 2, 3, 3, 4]) publishPostmortem(buildPostmortem(fixture(pr)), { dir });
      const rows = fs.readFileSync(join(dir, 'incidents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.filter(r => r.repo === 'example/repo' && r.pr === 1 && r.cause === 'review-finding')).toHaveLength(1);
      expect(rows.filter(r => r.kind === 'triage-candidate' && r.cause === 'review-finding')).toHaveLength(1);
      expect(fs.existsSync(join(dir, 'postmortem-example%2Frepo-1.md'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses production labels and queue events, excludes outsiders and post-merge evidence', () => {
    const f = fixture();
    f.labels = [
      { event: 'labeled', created_at: at(10), label: { name: 'review-status:fixing' } },
      { event: 'unlabeled', created_at: at(20), label: { name: 'review-status:fixing' } },
      { event: 'labeled', created_at: at(20), label: { name: 'review-status:reviewing' } },
      { event: 'unlabeled', created_at: at(30), label: { name: 'review-status:reviewing' } },
      { event: 'added_to_merge_queue', created_at: at(550) },
    ];
    f.scope = ['we:src/**']; f.repo = 'web-everything/web-everything';
    f.comments.push({ ...comment(90,'conveyor fix — stood down: does not reproduce'), author: {login:'outsider'} }, comment(700,'conveyor fix — stood down: does not reproduce'));
    f.checks.push({ id: 8, name:'test', created_at:at(700), completed_at:at(800), conclusion:'failure' });
    const r = buildPostmortem(f);
    expect(r.phases).toEqual(expect.arrayContaining([{phase:'fix-running',minutes:10},{phase:'review-running',minutes:10},{phase:'queue-checks',minutes:50}]));
    expect(r.standDowns).toHaveLength(1);
    expect(r.falseFindings).toHaveLength(1);
    expect(r.checks).toHaveLength(1);
    expect(r.scope.outside).toEqual(['extra.js']);
  });
  it('records observed carry, confirmed red-team send-back and unconfirmed findings separately', () => {
    const f = fixture();
    f.comments.push(comment(80, `<!-- review-verdict-carried from=${'a'.repeat(40)} to=${'b'.repeat(40)} patch-id=${'c'.repeat(40)} -->`),
      comment(81, `<!-- we:red-team-gate pr=1 rev=${'b'.repeat(40)} outcome=sent-back -->`),
      comment(82, '### Post-accept red team — 1 possible break(s)\n· red team codex/test · re-check ok\n1. [not confirmed] (correctness, broken) `src/a.js:2` — claim\n   - Re-check: deliberate design'));
    const r = buildPostmortem(f);
    expect(r.approvals.lost).toBe(0);
    expect(r.approvals.headChanges[0].carryApplied).toBe(true);
    expect(r.rounds.flatMap(x => x.causes).filter(c => c.cause === 'red-team-break')).toHaveLength(1);
    expect(r.falseFindings.some(f => f.source === 'red-team')).toBe(true);
  });
  it('keeps independent cause windows separate and recovers journal-first publication', async () => {
    const dir = temp();
    try {
      const r = buildPostmortem(fixture());
      await withCoronerLock(dir, async () => {
        await expect(withCoronerLock(dir, () => {})).rejects.toThrow('already running');
        publishPostmortem(r,{dir});
      });
      fs.unlinkSync(join(dir,'postmortem-example%2Frepo-1.md'));
      publishPostmortem(r,{dir});
      expect(fs.existsSync(join(dir,'postmortem-example%2Frepo-1.md'))).toBe(true);
      publishPostmortem(buildPostmortem(fixture(2)),{dir});
      const later = fixture(3); later.mergedAt = at(2100);
      publishPostmortem(buildPostmortem(later),{dir});
      const rows = fs.readFileSync(join(dir,'incidents.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.filter(r => r.kind === 'triage-candidate')).toHaveLength(0);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('collects paginated read-only evidence and fails on incomplete core reads', () => {
    const calls = [];
    const gh = args => {
      calls.push(args);
      const path = args.at(-1);
      if (path.endsWith('/pulls/1')) return { merged_at:at(600), created_at:at(0), head:{ref:'lane/no-card'}, base:{sha:'z'} };
      if (path.includes('/commits?')) return [fixture().commits];
      if (path.includes('/check-runs?')) return [{check_runs:fixture().checks}];
      if (path.includes('/contents/')) return {content:Buffer.from('').toString('base64')};
      return [[]];
    };
    const r = collectPrTimeline('example/repo',1,{gh,comments:() => fixture().comments,env:{WE_FIX_LOOP_LEDGER:join(process.cwd(),'.absent-coroner-ledger')}});
    expect(r.checks).toHaveLength(2);
    expect(r.warnings).toContain('Verdict ledger unavailable');
    expect(calls.every(args => args[0] === 'api' && !args.includes('POST') && !args.includes('PATCH'))).toBe(true);
    expect(() => collectPrTimeline('example/repo',1,{gh:() => { throw Error('network failed'); }})).toThrow('network failed');
  });
  it('discovers recent merges without search and refuses a saturated listing', () => {
    const page = Array.from({length:100},(_,i) => ({number:i+1,updated_at:at(610),merged_at:i < 2 ? at(600) : null}));
    const calls = [];
    const rows = listMergedSince('example/repo',at(500),at(700),{gh:args => { calls.push(args); return calls.length === 1 ? page : []; }});
    expect(rows.map(r => r.number)).toEqual([1,2]);
    expect(calls.every(args => !args.at(-1).includes('search/'))).toBe(true);
    expect(() => listMergedSince('example/repo',at(500),at(700),{gh:() => page,maxPages:1})).toThrow('page cap');
  });
  it('persists cursor and done set, skips short PRs, and retries a failed read after restart', async () => {
    const dir = temp(); let fail = true; const reads = [];
    const listMerged = (_repo,since) => [{ number: 1, merged_at: at(600) }, { number: 2, merged_at: at(601) }].filter(p => p.merged_at >= since);
    const collect = (_repo, pr) => { reads.push(pr); if (pr === 2 && fail) throw Error('read failed'); return { ...fixture(pr), ...(pr === 1 ? { mergedAt: at(1), comments: [], labels: [], checks: [], verdicts: [] } : {}) }; };
    try {
      await expect(runPostmortemPass({ repo: 'example/repo', dir, now: at(700), settings, listMerged, collect })).rejects.toThrow('read failed');
      expect(JSON.parse(fs.readFileSync(join(dir,'merge-cursor-example%2Frepo.json')))).toMatchObject({cursor:at(-740),done:[1],failures:{2:{attempts:1}}});
      fail = false;
      await runPostmortemPass({ repo: 'example/repo', dir, now: at(701), settings, listMerged, collect });
      await runPostmortemPass({ repo: 'example/repo', dir, now: at(702), settings, listMerged, collect });
      expect(reads).toEqual([1, 2, 2]);
      expect(fs.existsSync(join(dir, 'postmortem-example%2Frepo-1.md'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(dir, 'merge-cursor-example%2Frepo.json')))).toMatchObject({cursor:at(702),done:[1,2],failures:{}});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
