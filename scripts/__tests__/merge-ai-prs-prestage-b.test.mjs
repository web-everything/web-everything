import { describe, it, expect, vi } from 'vitest';
vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
// Allow the CLI's label-lag repolls and fresh imports under Vitest's async test timer.
vi.setConfig({ testTimeout: 120_000 });
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canConsumePrestagedAdmission, prestageFixClaimHeld } from '../merge-ai-prs.mjs';
import { reserve } from '../readiness/file-locks.mjs';
import { fixDispatchResource } from '../conveyor/fix-claim-store.mjs';
import { readLiveFixClaim } from '../conveyor/fix-procedure.mjs';
import { createPrestageCache, resolvePrestageSettings, enqueuePrestage } from '../lib/drain-prestage.mjs';
import { buildLedgerEvent, EVENT_TYPES } from '../lib/verdict-ledger.mjs';
import { createAsyncShadow } from '../lib/drain-async-shadow.mjs';

import { script, sha, world } from './helpers/merge-ai-prs-prestage-world.mjs';

describe('real drain pre-stage path', () => {
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
});
