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
import { createAsyncShadow } from '../lib/drain-async-shadow.mjs';

import { script, sha, world } from './helpers/merge-ai-prs-prestage-world.mjs';

describe('real drain pre-stage path', () => {
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
  it.each(['off', 'shadow'])('a green-event enqueue runs the cascade pre-landing steps: stacked retarget and review-coverage notice (async drain: %s)', shadowMode => world(({pr,run}) => {
    expect(run(false, { shadowMode }).stderr).toContain('eligible=true');
    // The pre-landing read is fresh: the reviewed-sha record is gone by green time, so coverage is announced.
    pr.comments = [];
    pr.stacked = [{ number: 43, baseRefName: pr.headRefName }];
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { shadowMode });
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
