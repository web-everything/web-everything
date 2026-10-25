import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openPrPageFixture } from './fixtures/open-pr-page-fixture.mjs';
import { canConsumePrestagedAdmission, prestageFixClaimHeld } from '../merge-ai-prs.mjs';
import { reserve } from '../readiness/file-locks.mjs';
import { fixDispatchResource } from '../conveyor/fix-claim-store.mjs';
import { readLiveFixClaim } from '../conveyor/fix-procedure.mjs';
import { createPrestageCache, resolvePrestageSettings, enqueuePrestage } from '../lib/drain-prestage.mjs';
import { buildLedgerEvent, EVENT_TYPES } from '../lib/verdict-ledger.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const sha = 'a'.repeat(40);
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), pr = JSON.parse(fs.readFileSync(process.env.PRESTAGE_PR, 'utf8'));
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(a) + '\\n');
// Synchronous writes: an async pipe write past 8KB would be cut off by the exit.
const out = x => { if (a.includes('-i')) fs.writeSync(1, 'HTTP/2 200 OK\\n\\n'); fs.writeSync(1, typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
const page = ${openPrPageFixture};
if (a[0] === 'repo') out('main');
if (a[0] === 'pr' && ['list', 'view'].includes(a[1]) && a.includes('--repo') && a[a.indexOf('--repo') + 1] !== process.env.PRESTAGE_REPO) out([]);
if (a[0] === 'pr' && a[1] === 'list' && a.includes('--base')) out(pr.stacked || []);
if (a[0] === 'pr' && a[1] === 'list') out([pr]);
if (a[0] === 'pr' && a[1] === 'view') out(pr);
if (a[0] === 'api') {
  if (a[1] === 'user') out('chalbert');
  const path = a.find(x => x.startsWith('repos/')) || '';
  if (path.includes('/rules/branches/')) out(a.includes('--slurp') ? [[{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]] : [{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]);
  if (path.endsWith('/branches/main')) out({ protected:false });
  if (path.includes('/comments')) out([pr.comments]);
  if (path.includes('/reviews')) out([[]]);
  if (path.includes('/files')) out([[{filename:'README.md',status:'modified'}]]);
  if (path.includes('/check-runs')) out(pr.checkRuns || [{check_runs:[]}]);
  if (a[1] === 'graphql') {
    const q = a.find(x => x.startsWith('query=')) || '';
    if (q.includes('enqueuePullRequest')) { fs.writeFileSync(process.env.PRESTAGE_PR+'.queued',''); out({ data: { enqueuePullRequest: { mergeQueueEntry: { id:'E',position:1,state:'QUEUED' } } } }); }
    if (q.includes('isInMergeQueue')) out({ data: { repository: { pullRequest: { headRefOid:pr.headRefOid, isInMergeQueue:fs.existsSync(process.env.PRESTAGE_PR+'.queued') } } } });
    if (q.includes('mergeQueue(')) out({ data: { repository: { mergeQueue: { entries: { nodes:[],pageInfo:{hasNextPage:false} } } } } });
    const [owner, name] = process.env.PRESTAGE_REPO.split('/');
    if (q.includes('pullRequests(') && !q.includes('repository(owner:"'+owner+'",name:"'+name+'")')) out(page([], q));
    out(page([pr], q));
  }
}
out([]);
`;
const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(['git', ...a]) + '\\n');
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:' + process.env.PRESTAGE_REPO + '.git\\n');
else if (a[0] === 'merge-base' || a[0] === 'rev-parse') process.stdout.write('${sha}\\n');
else if (a[0] === 'diff') {
  if (a.includes('--name-only')) process.stdout.write('README.md\\0');
  else if (a.includes('--numstat')) process.stdout.write('1\\t0\\tREADME.md\\n');
  else process.stdout.write('diff --git a/README.md b/README.md\\n--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-old\\n+new\\n');
} else if (a[0] === 'ls-tree' && a.includes('${sha}')) process.stdout.write('backlog/xabc123-card.md\\n');
else if (a[0] === 'show') {
  if (a[1] === 'origin/main:scripts/lib/queue-branch-numbering.mjs') process.stdout.write('drain-branch-numbering-ci-v1');
  else process.exit(1);
}
`;

async function world(fn, { slug = 'fixture/prestage' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prestage-cli-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    mkdirSync(join(dir, 'backlog'));
    for (const [name, body] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), body, { mode: 0o755 });
    const fixture = join(dir, 'pr.json'), log = join(dir, 'calls.jsonl'), settings = join(dir, 'settings.json'), coord = join(dir, 'coord'), ledger = join(dir, 'ledger');
    writeFileSync(settings, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
    const pr = { number: 42, id: 'PR_NODE', title: 'Update readme', body: 'Update the readme.', state: 'OPEN', isDraft: false,
      headRefOid: sha, headRefName: 'lane/readme', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      labels: [{name:'review:accepted'},{name:'ready-to-merge'}], files: [{path:'README.md',changeType:'MODIFIED'}],
      commits: [{oid:sha,messageHeadline:'Update readme',authors:[{name:'Claude',email:'noreply@anthropic.com'}]}],
      statusCheckRollup: [{name:'test',status:'IN_PROGRESS',conclusion:null,head_sha:sha}],
      comments: [{author:{login:'chalbert'},body:'<!-- reviewed-sha: '+sha+' -->',createdAt:new Date().toISOString()}], reviews: [] };
    const run = (green = false, { rebaseDrop = false, numbering = false, thisRepo = true, args = [] } = {}) => {
      writeFileSync(fixture, JSON.stringify(pr)); writeFileSync(log, '');
      const r = spawnSync(process.execPath, [script, ...(thisRepo ? ['--this-repo'] : []),'--label=ready-to-merge','--only=42', '--json', ...args,
        '--no-drain-lease','--no-red-main-freeze',...(!rebaseDrop ? ['--no-rebase-drop'] : []),'--no-heal-collision','--no-overlap-yield',
        ...(green ? ['--from-green-event'] : [])], { cwd:dir,encoding:'utf8',timeout:120_000, // a loaded host can push one real drain run past 30s
        env: { ...process.env, ...daemonAppEnv(dir), PATH:bin+':'+process.env.PATH, PRESTAGE_PR:fixture,PRESTAGE_LOG:log, PRESTAGE_REPO:slug,
          WE_COORDINATION_ROOT:coord, LANE_POOL_ROOT:dir, WE_MERGE_DELIVERY_SETTINGS_FILE:settings,
          WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE:'off',WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE:numbering ? 'on' : 'off',
          WE_DRAIN_WORKFLOW_EDIT_HUMAN:'off',WE_REVIEW_LEDGER_MODE:'off',WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES:'0',
          WE_VERDICT_LEDGER_DIR:ledger, WE_VERDICT_LEDGER_STORE:'home' } });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      return { report:JSON.parse(r.stdout), calls:readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), stderr:r.stderr };
    };
    await fn({pr,run,coord,ledger,slug});
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

describe('real drain pre-stage path', () => {
  it.each(['--repos=frontier-ui/frontierui', '--repos=frontierui'])('a green event cannot enqueue WE#42 outside %s', scope => world(({pr,run,coord}) => {
    expect(run().stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { thisRepo:false, args:[scope] });
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }, {slug:'web-everything/web-everything'}));
  it('a green event under --this-repo --base=release cannot consume main preparation', () => world(({pr,run,coord}) => {
    expect(run().stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { args:['--base=release'] });
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }));
  it('a green event preserves preparation without enqueueing outside --label', () => world(({pr,run,coord}) => {
    expect(run().stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { args:['--label=other'] });
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }));
  it.each([
    {thisRepo:true,args:['--base=main']},
    {thisRepo:false,args:['--repos=web-everything/web-everything','--base=main']},
  ])('a green event retains the shortcut for a matching scope (%j)', opts => world(({pr,run}) => {
    expect(run().stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, opts);
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    expect(next.calls.some(a => a.some(x => x.includes('pullRequests(')))).toBe(false);
  }, {slug:'web-everything/web-everything'}));
  it('a fix claim acquired after preparation prevents cached enqueue', () => world(({pr,run,coord}) => {
    expect(run().stderr).toContain('eligible=true');
    const now = Date.now();
    expect(reserve(join(coord, 'fix-dispatch-claims'), fixDispatchResource({repo:'we',pr:42,kind:'fixing'}),
      'fixer:fix-42', now, new Date(now).toISOString(), process.pid, 'unknown', 20,
      {who:'fix-42',ttlMinutes:20}).ok).toBe(true);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }, {slug:'web-everything/web-everything'}));
  it('a fix claim acquired while waiting for the enqueue lock prevents cached enqueue', () => world(async ({pr,run,coord}) => {
    expect(run().stderr).toContain('eligible=true');
    const lockRoot = join(coord, 'fix-dispatch-claims');
    const enqueue = vi.fn(() => ({ enqueued: true }));
    const result = await enqueuePrestage({ cache: createPrestageCache({ root: join(coord, 'drain-prestage') }), repo: 'web-everything/web-everything', num: 42,
      settings: resolvePrestageSettings({ env: {}, tool: {}, platform: {} }), recordLanded: vi.fn(), enqueue,
      readPr: async () => ({ ...pr, statusCheckRollup: [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}] }),
      fixClaimHeld: () => prestageFixClaimHeld(42, { claimKey: 'we', readClaim: q => readLiveFixClaim({ ...q, lockRoot }) }), beforeEnqueue: vi.fn(),
      // The initial read saw no claim; the fixer takes it while the drain waits for the merge-write lock.
      withLock: fn => {
        const now = Date.now();
        expect(reserve(lockRoot, fixDispatchResource({repo:'we',pr:42,kind:'fixing'}), 'fixer:fix-42', now, new Date(now).toISOString(),
          process.pid, 'unknown', 20, {who:'fix-42',ttlMinutes:20}).ok).toBe(true);
        return { ran: true, result: fn() };
      } });
    expect(result).toEqual({ fallback: true });
    expect(enqueue).not.toHaveBeenCalled();
  }, {slug:'web-everything/web-everything'}));
  it('a green-event enqueue releases the open drain hold, like the full cascade', () => world(({pr,run,ledger,slug}) => {
    expect(run().stderr).toContain('eligible=true');
    mkdirSync(ledger, { recursive: true });
    const file = join(ledger, `${slug.replace('/', '-')}.jsonl`);
    writeFileSync(file, JSON.stringify(buildLedgerEvent({ type: EVENT_TYPES.HOLD, repo: slug, pr: 42, at: new Date().toISOString(),
      source: 'merge-ai-prs', declaredActor: 'drain', reasonCode: 'ci-red', holdSource: 'drain' })) + '\n');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter(r => r.type === EVENT_TYPES.RELEASE)).toEqual([expect.objectContaining({ pr: 42, reasonCode: 'ci-red', holdSource: 'drain' })]);
  }));
  it('a failed explicitly selected --check is never prepared', () => world(({pr,run,coord}) => {
    pr.statusCheckRollup.push({name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha});
    expect(run(false, { args:['--check=smoke'] }).stderr).not.toContain('prepared while CI pending');
    expect(() => readdirSync(join(coord,'drain-prestage'))).toThrow();
  }));
  it('a green event re-checks the explicitly selected --check that failed after preparation', () => world(({pr,run}) => {
    pr.statusCheckRollup.push({name:'smoke',status:'IN_PROGRESS',conclusion:null,head_sha:sha});
    expect(run(false, { args:['--check=smoke'] }).stderr).toContain('eligible=true');
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha}];
    const next = run(true, { args:['--check=smoke'] });
    expect(next.report.prestaged, next.stderr).toBe(true);
    expect(next.report.enqueueOutcomes).toMatchObject([{num:42,outcome:'not-enqueued',reason:'required checks red'}]);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a green event reads the selected --check past the 100-context rollup cap, as the full drain does', () => world(({pr,run}) => {
    const filler = Array.from({length:98}, (_, i) => ({name:`lint-${i}`,status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}));
    const smokeRun = (id, status, conclusion) => [{check_runs:[{id,name:'smoke',head_sha:sha,status,conclusion}]}];
    pr.statusCheckRollup.push({name:'smoke',status:'IN_PROGRESS',conclusion:null,head_sha:sha});
    expect(run(false, { args:['--check=smoke'] }).stderr).toContain('eligible=true');
    // The capped rollup still shows an older passing smoke run; the newer failing one is only in the full read.
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {__typename:'CheckRun',databaseId:1,name:'smoke',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}, ...filler];
    pr.checkRuns = smokeRun(2, 'completed', 'failure');
    const next = run(true, { args:['--check=smoke'] });
    expect(next.calls.some(a => a[0] === 'api' && a.some(x => x.includes('/check-runs?check_name=smoke')))).toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a green event under a different --check than preparation still checks it', () => world(({pr,run}) => {
    expect(run().stderr).toContain('eligible=true');
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha}];
    const next = run(true, { args:['--check=smoke'] });
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a native changes-requested review filed after preparation falls back to the full drain', () => world(({pr,run}) => {
    expect(run().stderr).toContain('eligible=true');
    Object.assign(pr, { reviewDecision: 'CHANGES_REQUESTED' });
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it.each([[], ['checking']])('does not admit an accepted PR without ready-to-merge (%j)', (...labels) => world(({pr,run}) => {
    pr.labels = [{name:'review:accepted'}, ...labels.map(name => ({name}))];
    expect(run().stderr).not.toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it.each([true, false])('pending-CI manifest candidates cannot trigger head or review writes (accepted head=%s)', accepted => world(({pr,run,coord}) => {
    pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({ item:'xabc123', repos:[{repo:'we',ref:pr.headRefName}], blockedBy:[],stackParents:[] }) + '\n```\n<!-- lane-manifest:end -->';
    if (!accepted) pr.comments = [];
    const first = run(false, { rebaseDrop:true });
    expect(first.stderr).toContain('prepared while CI pending');
    expect(first.calls.filter(a => a[0] === 'git' && ['push','commit-tree','update-index','write-tree','read-tree'].includes(a[1]))).toEqual([]);
    // CI lifecycle bookkeeping precedes preparation and still reports checking.
    expect(first.calls.filter(a => a[0] === 'pr' && ['comment','merge'].includes(a[1])
      || a[0] === 'pr' && a[1] === 'edit' && !a.includes('checking')
      || a[0] === 'label' && a.some(x => x.startsWith('review:')))).toEqual([]);
    expect(first.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    const entries = readdirSync(join(coord,'drain-prestage')).map(file => JSON.parse(readFileSync(join(coord,'drain-prestage',file),'utf8')));
    expect(entries[0].eligible).toBe(false);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('coupled candidates cannot consume prestaged admission', () => world(({pr,run,coord}) => {
    const admission = { ready:true, branchPreparationRequired:false, queueAdmission:{allowed:true} };
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false,coupleCarrier:{num:43}}, admission)).toBe(false);
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:true,crossRepo:true}, admission)).toBe(false);
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false}, admission)).toBe(true);
    pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({ item:'xabc123', repos:[{repo:'we',ref:pr.headRefName},{repo:'fui',ref:'lane/impl'}], blockedBy:[],stackParents:[] }) + '\n```\n<!-- lane-manifest:end -->';
    run();
    const entries = readdirSync(join(coord,'drain-prestage')).map(file => JSON.parse(readFileSync(join(coord,'drain-prestage',file),'utf8')));
    expect(entries).toHaveLength(1);
    expect(entries[0].eligible).toBe(false);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('branches requiring preparation retain the full cascade', () => world(({pr,run,coord}) => {
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false}, {
      ready:true, branchPreparationRequired:true, queueAdmission:{allowed:true},
    })).toBe(false);
    run(false, { numbering:true });
    const entries = readdirSync(join(coord,'drain-prestage')).map(file => JSON.parse(readFileSync(join(coord,'drain-prestage',file),'utf8')));
    expect(entries).toHaveLength(1);
    expect(entries[0].eligible).toBe(false);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { numbering:true });
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('prepares while pending, then a green event enqueues without listing or gate reads', () => world(({pr,run,coord}) => {
    const first = run();
    expect(first.stderr).toContain('prepared while CI pending (eligible=true)');
    expect(first.report.enqueueOutcomes ?? []).toHaveLength(0);
    expect(readdirSync(join(coord,'drain-prestage'))).toHaveLength(1);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    // The only list is the stacked-set read scoped to this head (`--base lane/readme`), never an open-PR listing.
    expect(next.calls.some(a => a[0] === 'pr' && a[1] === 'list' && !a.includes('--base') || a.some(x => x.includes('pullRequests(')))).toBe(false);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(true);
  }));
  it('a green-event enqueue runs the cascade pre-landing steps: stacked retarget and review-coverage notice', () => world(({pr,run}) => {
    expect(run().stderr).toContain('eligible=true');
    // The pre-landing read is fresh: the reviewed-sha record is gone by green time, so coverage is announced.
    pr.comments = [];
    pr.stacked = [{ number: 43, baseRefName: pr.headRefName }];
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true);
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const at = pred => next.calls.findIndex(pred);
    const enqueued = at(a => a.some(x => x.includes('enqueuePullRequest')));
    const listed = at(a => a[0] === 'pr' && a[1] === 'list' && a.includes('--base') && a.includes(pr.headRefName));
    const retargeted = at(a => a[0] === 'pr' && a[1] === 'edit' && a[2] === '43' && a.includes('--base') && a.includes('main'));
    const announced = at(a => a[0] === 'pr' && a[1] === 'comment' && a[2] === '42' && a.some(x => x.includes('Incomplete review')));
    expect([listed, retargeted, announced].every(i => i >= 0 && i < enqueued), JSON.stringify(next.calls)).toBe(true);
  }));
  it('a moved head falls back to a full listing', () => world(({pr,run}) => {
    expect(run().stderr).toContain('eligible=true');
    pr.headRefOid = 'b'.repeat(40);
    const next = run(true);
    expect(next.stderr).toContain('full fast drain');
    expect(next.calls.some(a => a[0] === 'pr' && a[1] === 'list' || a.some(x => x.includes('pullRequests(')))).toBe(true);
  }));
});
