import { describe, it, expect, vi } from 'vitest';
import { prestagePorts } from './fixtures/merge-ai-prs-fake-ports.mjs';
import { runInProcess } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';
vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
// Allow the CLI's label-lag repolls and fresh imports under Vitest's async test timer.
vi.setConfig({ testTimeout: 120_000 });
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { canConsumePrestagedAdmission, prestageFixClaimHeld } from '../merge-ai-prs.mjs';
import { recordRedTeamStatus } from '../lib/drain-red-team-evidence.mjs';
import { reserve } from '../readiness/file-locks.mjs';
import { fixDispatchResource } from '../conveyor/fix-claim-store.mjs';
import { readLiveFixClaim } from '../conveyor/fix-procedure.mjs';
import { createPrestageCache, resolvePrestageSettings, enqueuePrestage } from '../lib/drain-prestage.mjs';
import { buildLedgerEvent, EVENT_TYPES } from '../lib/verdict-ledger.mjs';
import { createAsyncShadow } from '../lib/drain-async-shadow.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const sha = 'a'.repeat(40);
const prestageWorld = createPrestageWorld((argv, options) => runInProcess(argv, { ...options, ports: prestagePorts }));
const world = (fn, options) => prestageWorld(fn, { slug: 'web-everything/web-everything', ...options });

describe('real drain pre-stage path', () => {
  it.each(['dependency-held', 'cascade', 'prestage'])('shadow adds zero gh calls compared with off (%s)', async path => {
    const traces = [];
    for (const shadowMode of ['off', 'shadow']) {
      await world(async ({pr,run,dir,coord}) => {
        if (path === 'dependency-held') {
          pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({
            item:'xabc123', repos:[{repo:'we',ref:pr.headRefName}], blockedBy:[], stackParents:['xpar123'],
          }) + '\n```\n<!-- lane-manifest:end -->';
        }
        const calls = [];
        if (path === 'prestage') {
          const prepared = (await run(false, { shadowMode }));
          expect(prepared.stderr).toContain('eligible=true');
          calls.push(...prepared.calls);
        }
        pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
        const next = (await run(path === 'prestage', { shadowMode }));
        calls.push(...next.calls);
        if (path === 'dependency-held') {
          expect(next.report.deferred, next.stderr).toEqual(expect.arrayContaining([
            expect.objectContaining({num:42,waitOn:['xpar123']}),
          ]));
          expect(next.report.enqueueOutcomes ?? []).toEqual([]);
          // Off's no-op still evaluates its arguments: equality alone could miss
          // the same accidental readyInfoOf/label read in BOTH modes.
          expect(calls.filter(a => a[0] === 'api' && a.some(x => x.includes('/issues/42/events')))).toEqual([]);
          if (shadowMode === 'shadow') {
            const rows = JSON.parse(readFileSync(join(coord, 'drain-async-shadow', 'state.json'), 'utf8')).records;
            expect(rows).toEqual([expect.objectContaining({num:42,headSha:sha,actualEnqueueAt:null})]);
          }
        } else {
          expect(next.report.enqueueOutcomes).toMatchObject([{num:42,outcome:'enqueued'}]);
          if (path === 'prestage') expect(next.report.prestaged).toBe(true);
        }
        // Fixture roots differ; preserve every gh argument and its ordering.
        traces.push(calls.filter(a => a[0] !== 'git').map(a => a.map(x => x.replaceAll(dir, '<fixture>'))));
      });
    }
    expect(traces[1]).toEqual(traces[0]);
  });

  it.each([false, true])('scoped drain preserves another PR pending timing (prestage: %s)', green => world(async ({pr,run,coord,slug}) => {
    const dir = join(coord, 'drain-async-shadow');
    const other = { repo: slug, num: 43, headSha: 'b'.repeat(40) };
    if (green) expect((await run(false, { shadowMode:'shadow' })).stderr).toContain('eligible=true');
    const firstSeen = Date.now() - 1000;
    const target = { repo: slug, num: 42, headSha: sha };
    createAsyncShadow({ mode: 'shadow', dir, now: () => firstSeen }).observePass({ candidates: [target, other] });
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    expect((await run(green, { shadowMode:'shadow' })).report.enqueueOutcomes).toMatchObject([{num:42,outcome:'enqueued'}]);
    const pending = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records.find(row => row.num === 43);
    expect(pending).toMatchObject({ wouldEnqueueAt: firstSeen, readyNotReached: 0, actualEnqueueAt: null });
    expect(pending.retired).not.toBe(true);
    createAsyncShadow({ mode: 'shadow', dir }).recordActual(other);
    const rows = readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.num === 42)).toMatchObject({ headSha: sha, actualEnqueueAt: expect.any(Number) });
    expect(rows.find(row => row.num === 43)).toMatchObject({ wouldEnqueueAt: firstSeen, actualEnqueueAt: expect.any(Number) });
  }));
  it('a drain run with json=true and WE_ASYNC_DRAIN=shadow writes rows with unchanged stdout', () => world(async ({pr,run,coord}) => {
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(false, { shadowMode:'shadow' }));
    expect(JSON.parse(next.stdout)).toEqual(next.report);
    expect(next.report.enqueueOutcomes).toMatchObject([{num:42,outcome:'enqueued'}]);
    const rows = readFileSync(join(coord, 'drain-async-shadow', 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toEqual([expect.objectContaining({num:42,headSha:sha,actualEnqueueAt:expect.any(Number)})]);
  }));
  it('prestage enqueue records shadow timing', () => world(async ({pr,run,coord}) => {
    expect((await run(false, { shadowMode:'shadow' })).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { shadowMode:'shadow' }));
    expect(next.report).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const rows = readFileSync(join(coord, 'drain-async-shadow', 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toEqual([expect.objectContaining({num:42,headSha:sha,actualEnqueueAt:expect.any(Number)})]);
    expect(rows[0].actualEnqueueAt).toBeGreaterThanOrEqual(rows[0].wouldEnqueueAt);
    expect(rows[0].deltaMs).toBe(rows[0].actualEnqueueAt - rows[0].wouldEnqueueAt);
    expect(next.calls.filter(a => a.some(x => x.includes('enqueuePullRequest')))).toHaveLength(1);
  }));
  it.each([false, true])('drain wiring records enqueue refusal kind in shadow reasons (prestage: %s)', green => world(async ({pr,run,coord}) => {
    if (green) expect((await run(false, { shadowMode:'shadow' })).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = (await run(green, { shadowMode:'shadow' }));
    expect(next.report.enqueueOutcomes).toMatchObject([{outcome:'not-enqueued',kind:'mq-same-head-failed'}]);
    const summaries = readFileSync(join(coord, 'drain-async-shadow', 'summary.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(summaries.at(-1).reasons).toEqual({'mq-same-head-failed':1});
  }));
  it('both enqueue sites use one local helper that guards before the only mergeStrategy.enqueue call', () => {
    // The local helper is not exported; pin its wiring here and exercise each caller below.
    const source = readFileSync(script, 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bmqSameHeadGuard\b[^}]*\}\s*from\s*['"]\.\/lib\/drain-queue-safety\.mjs['"]/);
    const hook = source.match(/enqueue:\s*\(c,\s*sha,\s*entry\)\s*=>\s*(\w+)\(c,\s*sha,/);
    expect(hook, 'prestage enqueue hook must call a shared local helper').not.toBeNull();
    const helperName = hook[1];
    expect(source).toMatch(new RegExp(`return\\s+${helperName}\\(c,\\s*traceHeadSha,`));
    // Accept a function declaration or a local arrow function, without fixing its name.
    const definition = source.match(new RegExp(`^([ \\t]*)(?:function\\s+${helperName}\\([^\\n]*|const\\s+${helperName}\\s*=\\s*[^\\n]*)\\{[ \\t]*$`, 'm'));
    expect(definition, 'shared enqueue helper must be local to the drain').not.toBeNull();
    const start = definition.index + definition[0].length;
    const end = source.indexOf(`\n${definition[1]}}`, start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toMatch(/\bmqSameHeadGuard\s*\(/);
    expect(body).toMatch(/if\s*\([^)]*\.hold\s*\)\s*(?:\{\s*)?return\s*\{/);
    expect(body).toMatch(/enqueued:\s*false/);
    expect(body).toMatch(/kind:\s*['"]mq-same-head-failed['"]/);
    expect(body).toMatch(/reason:\s*\w+\.line/);
    expect(body.indexOf('mqSameHeadGuard(')).toBeLessThan(body.indexOf('mergeStrategy.enqueue('));
    expect(body.match(/mergeStrategy\.enqueue\s*\(/g)).toHaveLength(1);
    expect((source.slice(0, definition.index) + source.slice(end)).match(/mergeStrategy\.enqueue\s*\(/g) || []).toHaveLength(0);
  });
  it.each([false, true])('same-head failed_checks holds without enqueueing through the cascade/prestage path (green event: %s)', green => world(async ({pr,run}) => {
    if (green) expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = (await run(green));
    const line = `mq-same-head-failed: #42 head ${sha} — failed_checks`;
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).toContain(line);
    expect(next.calls.filter(a => a.some(x => x.includes('timelineItems(')))).toHaveLength(1);
  }));
  it.each([false, true])('manual removal permits re-enqueue through the cascade/prestage path (green event: %s)', green => world(async ({pr,run}) => {
    if (green) expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'manual', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = (await run(green));
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(true);
    expect(next.calls.filter(a => a.some(x => x.includes('timelineItems(')))).toHaveLength(2);
  }));
  it.each([false, true])('a human same-head re-enqueue preserves already-queued recording through cascade/prestage (green event: %s)', green => world(async ({pr,run,coord,ledger,slug}) => {
    if (green) expect((await run()).stderr).toContain('eligible=true');
    mkdirSync(ledger, { recursive: true });
    const ledgerFile = join(ledger, `${slug.replace('/', '-')}.jsonl`);
    writeFileSync(ledgerFile, JSON.stringify(buildLedgerEvent({ type: EVENT_TYPES.HOLD, repo: slug, pr: 42, at: new Date().toISOString(),
      source: 'merge-ai-prs', declaredActor: 'drain', reasonCode: 'ci-red', holdSource: 'drain' })) + '\n');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.inQueue = true;
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = (await run(green));
    expect(next.report.enqueueOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({num:42,outcome:'enqueued',already:true})]));
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).not.toContain('mq-same-head-failed');
    expect(next.calls.filter(a => a.some(x => x.includes('timelineItems(')))).toHaveLength(0);
    const queueState = JSON.parse(readFileSync(join(coord, 'drain-merge-queue-followups.json'), 'utf8'));
    expect(queueState.pending).toEqual(expect.arrayContaining([expect.objectContaining({num:42,headSha:sha})]));
    const facts = readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(facts.filter(f => f.type === EVENT_TYPES.RELEASE)).toEqual([
      expect.objectContaining({pr:42,reasonCode:'ci-red',holdSource:'drain'}),
    ]);
  }));
  it.each([false, true])('a concurrent queue failure cannot turn already-queued admission into a fresh enqueue (green event: %s)', green => world(async ({pr,run}) => {
    if (green) expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.inQueue = true;
    pr.loseQueueAfterAdmission = true;
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = (await run(green));
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).toContain('mq-same-head-failed');
    expect(next.calls.some(a => a.some(x => x.includes('timelineItems(')))).toBe(true);
  }));
  it.each([false, true])('a force-push cannot erase an unbound failure through cascade/prestage (green event: %s)', green => world(async ({pr,run}) => {
    if (green) expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [
      { __typename:'RemovedFromMergeQueueEvent', reason:'ci_failure', createdAt:'2026-11-01T12:00:00Z', beforeCommit:null },
      { __typename:'HeadRefForcePushedEvent', createdAt:'2026-11-01T13:00:00Z', beforeCommit:{oid:'c'.repeat(40)}, afterCommit:{oid:sha} },
    ];
    const next = (await run(green));
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).toContain('mq-same-head-failed');
  }));
  it.each(['--repos=frontier-ui/frontierui', '--repos=frontierui'])('a green event cannot enqueue WE#42 outside %s', scope => world(async ({pr,run,coord}) => {
    expect((await run()).stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { thisRepo:false, args:[scope] }));
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }, {slug:'web-everything/web-everything'}));
  it('a green event under --this-repo --base=release cannot consume main preparation', () => world(async ({pr,run,coord}) => {
    expect((await run()).stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { args:['--base=release'] }));
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }));
  it('a green event preserves preparation without enqueueing outside --label', () => world(async ({pr,run,coord}) => {
    expect((await run()).stderr).toContain('eligible=true');
    const cacheDir = join(coord, 'drain-prestage');
    const file = join(cacheDir, readdirSync(cacheDir)[0]);
    const prepared = readFileSync(file, 'utf8');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { args:['--label=other'] }));
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(prepared);
  }));
  it.each([
    {thisRepo:true,args:['--base=main']},
    {thisRepo:false,args:['--repos=web-everything/web-everything','--base=main']},
  ])('a green event retains the shortcut for a matching scope (%j)', opts => world(async ({pr,run}) => {
    expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, opts));
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    expect(next.calls.some(a => a.some(x => x.includes('pullRequests(')))).toBe(false);
  }, {slug:'web-everything/web-everything'}));
  it('a fix claim acquired after preparation prevents cached enqueue', () => world(async ({pr,run,coord}) => {
    expect((await run()).stderr).toContain('eligible=true');
    const now = Date.now();
    expect(reserve(join(coord, 'fix-dispatch-claims'), fixDispatchResource({repo:'we',pr:42,kind:'fixing'}),
      'fixer:fix-42', now, new Date(now).toISOString(), process.pid, 'unknown', 20,
      {who:'fix-42',ttlMinutes:20}).ok).toBe(true);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }, {slug:'web-everything/web-everything'}));
  it('a fix claim acquired while waiting for the enqueue lock prevents cached enqueue', () => world(async ({pr,run,coord}) => {
    expect((await run()).stderr).toContain('eligible=true');
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
  it('a green-event enqueue releases the open drain hold, like the full cascade', () => world(async ({pr,run,ledger,slug}) => {
    expect((await run()).stderr).toContain('eligible=true');
    mkdirSync(ledger, { recursive: true });
    const file = join(ledger, `${slug.replace('/', '-')}.jsonl`);
    writeFileSync(file, JSON.stringify(buildLedgerEvent({ type: EVENT_TYPES.HOLD, repo: slug, pr: 42, at: new Date().toISOString(),
      source: 'merge-ai-prs', declaredActor: 'drain', reasonCode: 'ci-red', holdSource: 'drain' })) + '\n');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.filter(r => r.type === EVENT_TYPES.RELEASE)).toEqual([expect.objectContaining({ pr: 42, reasonCode: 'ci-red', holdSource: 'drain' })]);
  }));
  it('a failed explicitly selected --check is never prepared', () => world(async ({pr,run,coord}) => {
    pr.statusCheckRollup.push({name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha});
    expect((await run(false, { args:['--check=smoke'] })).stderr).not.toContain('prepared while CI pending');
    expect(() => readdirSync(join(coord,'drain-prestage'))).toThrow();
  }));
  it('a green event re-checks the explicitly selected --check that failed after preparation', () => world(async ({pr,run}) => {
    pr.statusCheckRollup.push({name:'smoke',status:'IN_PROGRESS',conclusion:null,head_sha:sha});
    expect((await run(false, { args:['--check=smoke'] })).stderr).toContain('eligible=true');
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha}];
    const next = (await run(true, { args:['--check=smoke'] }));
    expect(next.report.prestaged, next.stderr).toBe(true);
    expect(next.report.enqueueOutcomes).toMatchObject([{num:42,outcome:'not-enqueued',reason:'required checks red'}]);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a green event reads the selected --check past the 100-context rollup cap, as the full drain does', () => world(async ({pr,run}) => {
    const filler = Array.from({length:98}, (_, i) => ({name:`lint-${i}`,status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}));
    const smokeRun = (id, status, conclusion) => [{check_runs:[{id,name:'smoke',head_sha:sha,status,conclusion}]}];
    pr.statusCheckRollup.push({name:'smoke',status:'IN_PROGRESS',conclusion:null,head_sha:sha});
    expect((await run(false, { args:['--check=smoke'] })).stderr).toContain('eligible=true');
    // The capped rollup still shows an older passing smoke run; the newer failing one is only in the full read.
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {__typename:'CheckRun',databaseId:1,name:'smoke',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}, ...filler];
    pr.checkRuns = smokeRun(2, 'completed', 'failure');
    const next = (await run(true, { args:['--check=smoke'] }));
    expect(next.calls.some(a => a[0] === 'api' && a.some(x => x.includes('/check-runs?check_name=smoke')))).toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a green event under a different --check than preparation still checks it', () => world(async ({pr,run}) => {
    expect((await run()).stderr).toContain('eligible=true');
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
      {name:'smoke',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha}];
    const next = (await run(true, { args:['--check=smoke'] }));
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it('a native changes-requested review filed after preparation falls back to the full drain', () => world(async ({pr,run}) => {
    expect((await run()).stderr).toContain('eligible=true');
    Object.assign(pr, { reviewDecision: 'CHANGES_REQUESTED' });
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it.each([[], ['checking']])('does not admit an accepted PR without ready-to-merge (%j)', (...labels) => world(async ({pr,run}) => {
    pr.labels = [{name:'review:accepted'}, ...labels.map(name => ({name}))];
    expect((await run()).stderr).not.toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
  }));
  it.each([true, false])('pending-CI manifest candidates cannot trigger head or review writes (accepted head=%s)', accepted => world(async ({pr,run,coord}) => {
    pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({ item:'xabc123', repos:[{repo:'we',ref:pr.headRefName}], blockedBy:[],stackParents:[] }) + '\n```\n<!-- lane-manifest:end -->';
    if (!accepted) pr.comments = [];
    const first = (await run(false, { rebaseDrop:true }));
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
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('coupled candidates cannot consume prestaged admission', () => world(async ({pr,run,coord}) => {
    const admission = { ready:true, branchPreparationRequired:false, queueAdmission:{allowed:true} };
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false,coupleCarrier:{num:43}}, admission)).toBe(false);
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:true,crossRepo:true}, admission)).toBe(false);
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false}, admission)).toBe(true);
    pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({ item:'xabc123', repos:[{repo:'we',ref:pr.headRefName},{repo:'fui',ref:'lane/impl'}], blockedBy:[],stackParents:[] }) + '\n```\n<!-- lane-manifest:end -->';
    (await run());
    const entries = readdirSync(join(coord,'drain-prestage')).map(file => JSON.parse(readFileSync(join(coord,'drain-prestage',file),'utf8')));
    expect(entries).toHaveLength(1);
    expect(entries[0].eligible).toBe(false);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('branches requiring preparation retain the full cascade', () => world(async ({pr,run,coord}) => {
    expect(canConsumePrestagedAdmission({decision:'merge',hasManifest:false}, {
      ready:true, branchPreparationRequired:true, queueAdmission:{allowed:true},
    })).toBe(false);
    (await run(false, { numbering:true }));
    const entries = readdirSync(join(coord,'drain-prestage')).map(file => JSON.parse(readFileSync(join(coord,'drain-prestage',file),'utf8')));
    expect(entries).toHaveLength(1);
    expect(entries[0].eligible).toBe(false);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { numbering:true }));
    expect(next.stderr).toContain('full fast drain');
    expect(next.report.prestaged).not.toBe(true);
  }));
  it('prepares while pending, then a green event enqueues without listing or gate reads', () => world(async ({pr,run,coord}) => {
    const first = (await run());
    expect(first.stderr).toContain('prepared while CI pending (eligible=true)');
    expect(first.report.enqueueOutcomes ?? []).toHaveLength(0);
    expect(readdirSync(join(coord,'drain-prestage'))).toHaveLength(1);
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true));
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    // The only list is the stacked-set read scoped to this head (`--base lane/readme`), never an open-PR listing.
    expect(next.calls.some(a => a[0] === 'pr' && a[1] === 'list' && !a.includes('--base') || a.some(x => x.includes('pullRequests(')))).toBe(false);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(true);
  }));
  it.each(['off', 'shadow'])('a green-event enqueue runs the cascade pre-landing steps: stacked retarget and review-coverage notice (async drain: %s)', shadowMode => world(async ({pr,run}) => {
    expect((await run(false, { shadowMode })).stderr).toContain('eligible=true');
    // The pre-landing read is fresh: the reviewed-sha record is gone by green time, so coverage is announced.
    pr.comments = [];
    pr.stacked = [{ number: 43, baseRefName: pr.headRefName }];
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = (await run(true, { shadowMode }));
    expect(next.report, next.stderr).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const at = pred => next.calls.findIndex(pred);
    const enqueued = at(a => a.some(x => x.includes('enqueuePullRequest')));
    const listed = at(a => a[0] === 'pr' && a[1] === 'list' && a.includes('--base') && a.includes(pr.headRefName));
    const retargeted = at(a => a[0] === 'pr' && a[1] === 'edit' && a[2] === '43' && a.includes('--base') && a.includes('main'));
    const announced = at(a => a[0] === 'pr' && a[1] === 'comment' && a[2] === '42' && a.some(x => x.includes('Incomplete review')));
    expect([listed, retargeted, announced].every(i => i >= 0 && i < enqueued), JSON.stringify(next.calls)).toBe(true);
  }));
  it('a moved head falls back to a full listing', () => world(async ({pr,run}) => {
    expect((await run()).stderr).toContain('eligible=true');
    pr.headRefOid = 'b'.repeat(40);
    const next = (await run(true));
    expect(next.stderr).toContain('full fast drain');
    expect(next.calls.some(a => a[0] === 'pr' && a[1] === 'list' || a.some(x => x.includes('pullRequests(')))).toBe(true);
  }));
});


const failedGatePr = pr => {
  pr.failedGate = true;
  pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha},
    {name:'merge-gate',status:'COMPLETED',conclusion:'FAILURE',head_sha:sha}];
  pr.labels.push({ name:'red-team:clear' });
};
const repairEnv = { WE_MERGE_QUEUE_REFRESH_ON_STALE_MERGE_GATE:'on',
  WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE:'off' };
const refreshPushes = calls => calls.filter(a => a[0] === 'git' && a[1] === 'push');
describe('failed-gate trigger through the real drain', () => {
  it('zero per-pass budget disables the failed-gate rebuild', () => world(async ({pr,run}) => {
    failedGatePr(pr);
    const out = await run(false, {env:{...repairEnv,WE_DRAIN_STALE_GATE_UPDATE_BRANCH_MAX:'0'}});
    expect(refreshPushes(out.calls)).toEqual([]);
  }));
  it.each([false, true])('startup_failure uses shared admission (red-team hold: %s)', held => world(async ({pr,run}) => {
    pr.startupFailure = true;
    pr.statusCheckRollup = [{name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha}];
    if (held) pr.labels.push({name:'red-team:blocked'});
    const out = await run(false, {env:repairEnv});
    expect(refreshPushes(out.calls), JSON.stringify(out.report)).toHaveLength(held ? 0 : 1);
    expect(out.report.merged).toEqual([]);
    expect(out.report.revalidationAborted[0].reason).toContain(held ? 'red-team:blocked' : 'rebased');
  }));
  it('rebuilds through refreshStalePr and preserves the original BLOCKED skip, once per head', () => world(async ({pr,run,slug}) => {
    failedGatePr(pr);
    const first = await run(false, {env:repairEnv});
    expect(first.report.merged).toEqual([]);
    expect(first.report.toMerge).toEqual([]);
    expect(first.report.skipped).toEqual([expect.objectContaining({num:42, reason:expect.stringContaining('merge state BLOCKED')})]);
    expect(first.report.revalidationAborted).toEqual([expect.objectContaining({reason:expect.stringContaining('rebased')})]);
    expect(first.calls.filter(a => a[0] === 'node')).toEqual([[
      'node', expect.stringMatching(/\/review-set-label\.mjs$/), '42', `--repo=${slug}`,
      '--to=restamp', '--actor=drain', '--channel=drain-rebase',
      `--reason=head moved to ${'b'.repeat(40)} by this drain's own content-preserving rebase`,
      `--new-head=${'b'.repeat(40)}`,
    ]]);
    expect(refreshPushes(first.calls), JSON.stringify(first.report) + first.stderr).toHaveLength(1);
    expect(first.calls).toContainEqual(['git', 'ls-remote', 'origin', `refs/heads/${pr.headRefName}`]);
    expect(refreshPushes(first.calls)[0]).toContain(`--force-with-lease=refs/heads/${pr.headRefName}:${sha}`);
    expect(first.calls.some(a => a[0] === 'git' && a[1] === 'merge-tree')).toBe(true);
    const second = await run(false, {env:repairEnv});
    expect(refreshPushes(second.calls)).toEqual([]);
    expect(second.calls.filter(a => a[0] === 'node')).toEqual([]);
    expect(second.report.skipped).toEqual(first.report.skipped);
  }));
  it.each([
    ['fork', pr => { pr.isCrossRepository = true; }],
    ['remote head moved after admission', pr => { pr.remoteHead = 'd'.repeat(40); }],
    ['head moved during fetch', pr => { pr.fetchedHead = 'd'.repeat(40); }],
    ['non-default base', pr => { pr.baseRefName = 'release'; }],
    ['missing ready-to-merge', pr => { pr.labels = pr.labels.filter(l => l.name !== 'ready-to-merge'); }],
    ['missing review:accepted', pr => { pr.labels = pr.labels.filter(l => l.name !== 'review:accepted'); }],
    ['not MERGEABLE', pr => { pr.mergeable = 'CONFLICTING'; }],
    ['not BLOCKED', pr => { pr.mergeStateStatus = 'UNSTABLE'; }],
    ['another required failure', pr => { pr.statusCheckRollup[0].conclusion = 'FAILURE'; }],
    ['red-team:blocked', pr => pr.labels.push({name:'red-team:blocked'})],
    ['red-team:pending', pr => pr.labels.push({name:'red-team:pending'})],
    ['missing red-team:clear', pr => { pr.labels = pr.labels.filter(l => l.name !== 'red-team:clear'); }],
    ['unknown queue history', pr => { pr.unknownMqHistory = true; }],
    ['exhausted queue history', pr => { pr.mqTimeline = [{__typename:'RemovedFromMergeQueueEvent',reason:'failed_checks',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}}}]; }],
    ['review hold', pr => { pr.labels = pr.labels.filter(l => l.name !== 'review:accepted'); pr.labels.push({name:'review:pending'}); }],
    ['send-back hold', pr => pr.labels.push({name:'review:changes'})],
    ['GitHub review hold', pr => { pr.reviewDecision = 'CHANGES_REQUESTED'; }],
    ['workflow edit without license', pr => { pr.workflowEdit = true; }],
  ])('keeps the existing %s guard', (_name, change) => world(async ({pr,run}) => {
    failedGatePr(pr); change(pr);
    const out = await run(false, {env:{...repairEnv,WE_DRAIN_WORKFLOW_EDIT_HUMAN:pr.workflowEdit ? 'on' : 'off'}});
    expect(refreshPushes(out.calls)).toEqual([]);
    expect(out.calls.some(a => a[0] === 'git' && a[1] === 'commit-tree')).toBe(false);
  }));
  it('refuses missing red-team evidence when the existing evidence gate is enabled', () => world(async ({pr,run,dir,slug}) => {
    failedGatePr(pr);
    recordRedTeamStatus({repo:slug, pr:42, head:sha, status:'queued',
      loopPayload:{verdict:{verdict:'accept'},findings:{read:{netBasis:{rev:sha}}}}},
      {env:{WE_SHARED_RUNS_DIR:join(dir,'runs')}, publish:false});
    const out = await run(false, {env:{...repairEnv,WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE:'on'}});
    expect(refreshPushes(out.calls), JSON.stringify(out.report)).toEqual([]);
    expect(out.calls.some(a => a[0] === 'git' && a[1] === 'commit-tree' || a[0] === 'node')).toBe(false);
    expect(out.report.revalidationAborted).toEqual([expect.objectContaining({reason:expect.stringContaining('queue head mutation authorization refused')})]);
  }));
  it('refuses a live fix claim', () => world(async ({pr,run,dir}) => {
    failedGatePr(pr);
    reserve(join(dir,'coord','fix-dispatch-claims'), fixDispatchResource({repo:'we',pr:42,kind:'fixing'}), 'fixer', Date.now(), new Date().toISOString(), process.pid, 'unknown', 15, {who:'fixer',claimedAt:new Date().toISOString()});
    const out = await run(false,{env:repairEnv});
    expect(refreshPushes(out.calls), JSON.stringify(out.report)).toEqual([]);
    expect(out.calls.some(a => a[0] === 'git' && a[1] === 'commit-tree' || a[0] === 'node')).toBe(false);
    expect(out.report.skipped).toEqual([expect.objectContaining({reason:expect.stringContaining('merge state BLOCKED')})]);
    expect(out.report.revalidationAborted).toEqual([expect.objectContaining({reason:expect.stringContaining('live PR admission refused')})]);
  }, {slug:CONSTELLATION_REPOS.we.slug}));
});


it.each(['source', 'combined', 'unreadable'])('failed-gate trigger holds %s card-group state without consuming the retry', role => world(async ({pr,run,dir,slug}) => {
  failedGatePr(pr);
  const state = join(dir,'groups.json');
  writeFileSync(state, role === 'unreadable' ? '{broken' : JSON.stringify({groups:[{id:'fixture',repo:slug,
    pr:role === 'combined' ? 42 : 77,branch:role === 'combined' ? pr.headRefName : 'lane/card-group-fixture',createdAt:Date.now(),
    sources:[{num:role === 'source' ? 42 : 99,headSha:sha}],files:['backlog/xfixture.md']}],failed:{},lastReconcileAt:Date.now()}));
  const env = {...repairEnv,WE_DRAIN_CARD_GROUP_STATE:state};
  const out = await run(false, {env});
  expect(refreshPushes(out.calls)).toEqual([]);
  expect(out.calls.some(a => a[0] === 'git' && a[1] === 'commit-tree' || a[0] === 'node'), JSON.stringify(out.calls)).toBe(false);
  expect(out.report.revalidationAborted).toEqual([expect.objectContaining({reason:expect.stringContaining('card group')})]);
  // A hold must leave the once-per-head repair available when ownership is released or state repaired.
  writeFileSync(state, JSON.stringify({groups:[],failed:{},lastReconcileAt:Date.now()}));
  const released = await run(false, {env});
  expect(refreshPushes(released.calls)).toHaveLength(1);
  expect(released.report.merged).toEqual([]);
}));

it('failed-gate trigger retains an approved human-surface head through refreshApprovedHeadChecked', () => world(async ({pr,run}) => {
  failedGatePr(pr); pr.humanSurface = true;
  pr.comments[0].body += '\n<!-- cleared-human: operator -->';
  const out = await run(false, {env:{...repairEnv,WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE:'on'}});
  expect(refreshPushes(out.calls)).toEqual([]);
  expect(out.calls.some(a => a[0] === 'git' && a[1] === 'commit-tree' || a[0] === 'node')).toBe(false);
  expect(out.report.skipped).toEqual([expect.objectContaining({reason:expect.stringContaining('merge state BLOCKED')})]);
  expect(out.report.revalidationAborted[0].reason).toContain('approved head retained');
}));
