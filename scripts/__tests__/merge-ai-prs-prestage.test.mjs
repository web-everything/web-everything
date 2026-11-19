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
  it.each(['dependency-held', 'cascade', 'prestage'])('shadow adds zero gh calls compared with off (%s)', async path => {
    const traces = [];
    for (const shadowMode of ['off', 'shadow']) {
      await world(({pr,run,dir,coord}) => {
        if (path === 'dependency-held') {
          pr.body += '\n<!-- lane-manifest:begin -->\n```json\n' + JSON.stringify({
            item:'xabc123', repos:[{repo:'we',ref:pr.headRefName}], blockedBy:[], stackParents:['xpar123'],
          }) + '\n```\n<!-- lane-manifest:end -->';
        }
        const calls = [];
        if (path === 'prestage') {
          const prepared = run(false, { shadowMode });
          expect(prepared.stderr).toContain('eligible=true');
          calls.push(...prepared.calls);
        }
        pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
        const next = run(path === 'prestage', { shadowMode });
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

  it.each([false, true])('scoped drain preserves another PR pending timing (prestage: %s)', green => world(({pr,run,coord,slug}) => {
    const dir = join(coord, 'drain-async-shadow');
    const other = { repo: slug, num: 43, headSha: 'b'.repeat(40) };
    if (green) expect(run(false, { shadowMode:'shadow' }).stderr).toContain('eligible=true');
    const firstSeen = Date.now() - 1000;
    const target = { repo: slug, num: 42, headSha: sha };
    createAsyncShadow({ mode: 'shadow', dir, now: () => firstSeen }).observePass({ candidates: [target, other] });
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    expect(run(green, { shadowMode:'shadow' }).report.enqueueOutcomes).toMatchObject([{num:42,outcome:'enqueued'}]);
    const pending = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records.find(row => row.num === 43);
    expect(pending).toMatchObject({ wouldEnqueueAt: firstSeen, readyNotReached: 0, actualEnqueueAt: null });
    expect(pending.retired).not.toBe(true);
    createAsyncShadow({ mode: 'shadow', dir }).recordActual(other);
    const rows = readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.num === 42)).toMatchObject({ headSha: sha, actualEnqueueAt: expect.any(Number) });
    expect(rows.find(row => row.num === 43)).toMatchObject({ wouldEnqueueAt: firstSeen, actualEnqueueAt: expect.any(Number) });
  }));
  it('a drain run with json=true and WE_ASYNC_DRAIN=shadow writes rows with unchanged stdout', () => world(({pr,run,coord}) => {
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(false, { shadowMode:'shadow' });
    expect(JSON.parse(next.stdout)).toEqual(next.report);
    expect(next.report.enqueueOutcomes).toMatchObject([{num:42,outcome:'enqueued'}]);
    const rows = readFileSync(join(coord, 'drain-async-shadow', 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toEqual([expect.objectContaining({num:42,headSha:sha,actualEnqueueAt:expect.any(Number)})]);
  }));
  it('prestage enqueue records shadow timing', () => world(({pr,run,coord}) => {
    expect(run(false, { shadowMode:'shadow' }).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    const next = run(true, { shadowMode:'shadow' });
    expect(next.report).toMatchObject({prestaged:true,enqueueOutcomes:[{num:42,outcome:'enqueued'}]});
    const rows = readFileSync(join(coord, 'drain-async-shadow', 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toEqual([expect.objectContaining({num:42,headSha:sha,actualEnqueueAt:expect.any(Number)})]);
    expect(rows[0].actualEnqueueAt).toBeGreaterThanOrEqual(rows[0].wouldEnqueueAt);
    expect(rows[0].deltaMs).toBe(rows[0].actualEnqueueAt - rows[0].wouldEnqueueAt);
    expect(next.calls.filter(a => a.some(x => x.includes('enqueuePullRequest')))).toHaveLength(1);
  }));
  it.each([false, true])('drain wiring records enqueue refusal kind in shadow reasons (prestage: %s)', green => world(({pr,run,coord}) => {
    if (green) expect(run(false, { shadowMode:'shadow' }).stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = run(green, { shadowMode:'shadow' });
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
  it.each([false, true])('same-head failed_checks holds without enqueueing through the cascade/prestage path (green event: %s)', green => world(({pr,run}) => {
    if (green) expect(run().stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = run(green);
    const line = `mq-same-head-failed: #42 head ${sha} — failed_checks`;
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).toContain(line);
    expect(next.calls.filter(a => a.some(x => x.includes('timelineItems(')))).toHaveLength(1);
  }));
  it.each([false, true])('manual removal permits re-enqueue through the cascade/prestage path (green event: %s)', green => world(({pr,run}) => {
    if (green) expect(run().stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'manual', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = run(green);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(true);
    expect(next.calls.filter(a => a.some(x => x.includes('timelineItems(')))).toHaveLength(2);
  }));
  it.each([false, true])('a human same-head re-enqueue preserves already-queued recording through cascade/prestage (green event: %s)', green => world(({pr,run,coord,ledger,slug}) => {
    if (green) expect(run().stderr).toContain('eligible=true');
    mkdirSync(ledger, { recursive: true });
    const ledgerFile = join(ledger, `${slug.replace('/', '-')}.jsonl`);
    writeFileSync(ledgerFile, JSON.stringify(buildLedgerEvent({ type: EVENT_TYPES.HOLD, repo: slug, pr: 42, at: new Date().toISOString(),
      source: 'merge-ai-prs', declaredActor: 'drain', reasonCode: 'ci-red', holdSource: 'drain' })) + '\n');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.inQueue = true;
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = run(green);
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
  it.each([false, true])('a concurrent queue failure cannot turn already-queued admission into a fresh enqueue (green event: %s)', green => world(({pr,run}) => {
    if (green) expect(run().stderr).toContain('eligible=true');
    pr.statusCheckRollup[0] = {name:'test',status:'COMPLETED',conclusion:'SUCCESS',head_sha:sha};
    pr.inQueue = true;
    pr.loseQueueAfterAdmission = true;
    pr.mqTimeline = [{ __typename:'RemovedFromMergeQueueEvent', reason:'failed_checks', createdAt:'2026-11-01T12:00:00Z',
      beforeCommit:{oid:'b'.repeat(40),parents:{nodes:[{oid:'c'.repeat(40)},{oid:sha}]}} }];
    const next = run(green);
    expect(next.calls.some(a => a.some(x => x.includes('enqueuePullRequest')))).toBe(false);
    expect(next.stderr).toContain('mq-same-head-failed');
    expect(next.calls.some(a => a.some(x => x.includes('timelineItems(')))).toBe(true);
  }));
});
