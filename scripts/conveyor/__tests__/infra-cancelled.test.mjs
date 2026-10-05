import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isInfraCancelledJob, classifyInfraCancelled, isInfraCancelledOnlyRun, resolveInfraCancelledMode,
  DEFAULT_INFRA_CANCELLED_MODE, DEFAULT_INFRA_CANCELLED_MAX_RERUNS,
} from '../infra-cancelled.mjs';
import { computeMainRedWindows } from '../main-red-recovery.mjs';
import { enrichPrsWithTimeoutEvidence, readTimeoutEvidence, defaultReadMainRuns } from '../reconcile-pass.mjs';

const cancelledJob = { name: 'daemon-soak', status: 'completed', conclusion: 'cancelled', runner_name: '', steps: [] };
const realFail = { name: 'test-shard (1)', status: 'completed', conclusion: 'failure', runner_name: 'GitHub Actions 1', steps: [{}] };

describe('infra-cancelled classifier', () => {
  it('classifies cancelled / startup_failure / no-runner jobs as infra, real failures as not', () => {
    expect(isInfraCancelledJob(cancelledJob)).toBe(true);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'startup_failure' })).toBe(true);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'failure', runner_name: '', steps: [] })).toBe(true);
    expect(isInfraCancelledJob(realFail)).toBe(false);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'success', steps: [] })).toBe(false);
    expect(isInfraCancelledJob({ status: 'in_progress', conclusion: null })).toBe(false);
  });

  it('infra-only dedupes by run; a real failure makes it mixed; the aggregate test job is ignored', () => {
    const j = (run, job, infra, name = 'x') => ({ run, job, attempt: 1, infra, name });
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 11, true), j(2, 20, true)])).toEqual({
      kind: 'infra-only', runs: [{ run: 1, job: 10, attempt: 1 }, { run: 2, job: 20, attempt: 1 }] });
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 11, false)]).kind).toBe('mixed');
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 12, false, 'test')]).kind).toBe('infra-only');
    expect(classifyInfraCancelled([j(1, 11, false)]).kind).toBe('real');
    expect(classifyInfraCancelled([]).kind).toBe('none');
  });

  it('a main run red only through cancelled shards + the aggregate test job is infra-only', () => {
    const agg = { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r', steps: [{}] };
    expect(isInfraCancelledOnlyRun([cancelledJob, agg])).toBe(true);
    expect(isInfraCancelledOnlyRun([cancelledJob, realFail])).toBe(false);
    expect(isInfraCancelledOnlyRun([agg])).toBe(false);
  });

  it('mode defaults to rerun, honours env and a per-repo override, ignores junk', () => {
    expect(resolveInfraCancelledMode('we', {})).toBe(DEFAULT_INFRA_CANCELLED_MODE);
    expect(resolveInfraCancelledMode('we', { WE_CI_HEAL_INFRA_CANCELLED: 'heal' })).toBe('heal');
    expect(resolveInfraCancelledMode('plateau-app', { WE_CI_HEAL_INFRA_CANCELLED: 'heal', WE_CI_HEAL_INFRA_CANCELLED_PLATEAU_APP: 'rerun' })).toBe('rerun');
    expect(resolveInfraCancelledMode('we', { WE_CI_HEAL_INFRA_CANCELLED: 'bogus' })).toBe('rerun');
  });

  it('mirrors the declared platform defaults', () => {
    const ts = readFileSync(resolve(process.cwd(), 'config/platformDefaults.ts'), 'utf8');
    expect(ts).toContain(`infraCancelled: '${DEFAULT_INFRA_CANCELLED_MODE}'`);
    expect(ts).toContain(`infraCancelledMaxReruns: ${DEFAULT_INFRA_CANCELLED_MAX_RERUNS}`);
  });
});

describe('main-red judgement', () => {
  it('an outage-cancelled main run neither opens nor extends a red window', () => {
    const runs = [
      { status: 'completed', conclusion: 'success', updatedAt: '2026-10-05T19:14:00Z' },
      { status: 'completed', conclusion: 'failure', updatedAt: '2026-10-05T19:44:00Z', infraCancelledOnly: true },
    ];
    expect(computeMainRedWindows(runs)).toEqual([]);
    expect(computeMainRedWindows([{ ...runs[1], infraCancelledOnly: false }])).toEqual([{ start: '2026-10-05T19:44:00Z', end: null }]);
  });

  it('defaultReadMainRuns annotates a failure run whose jobs are infra-only; a failed read leaves it red', () => {
    const list = JSON.stringify([{ databaseId: 7, conclusion: 'failure', status: 'completed', workflowName: 'CI', updatedAt: 'x' }]);
    const jobs = JSON.stringify({ jobs: [cancelledJob, { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r', steps: [{}] }] });
    const ok = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? jobs : list) });
    expect(ok[0].infraCancelledOnly).toBe(true);
    const bad = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => { if (argv[0] === 'api') throw new Error('x'); return list; } });
    expect(bad[0].infraCancelledOnly).toBeUndefined();
  });
});

describe('infra-cancelled evidence + planning', () => {
  const head = 'a'.repeat(40);
  const repo = 'o/r';
  const pr = { number: 5, headRefOid: head };
  const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
  const mkExec = () => (_c, [, path]) => {
    const body = (v) => JSON.stringify(v);
    if (/\/pulls\/5$/.test(path)) return body({ head: { sha: head }, base: { sha: 'b' }, state: 'open', changed_files: 1 });
    if (/pulls\/5\/files/.test(path)) return body([{ filename: 'a.ts' }]);
    if (/check-runs/.test(path)) return body({ total_count: 2, check_runs: [
      { name: 'test', status: 'completed', conclusion: 'failure', details_url: url(100, 1) },
      { name: 'daemon-soak', status: 'completed', conclusion: 'cancelled', details_url: url(100, 2) }] });
    if (/\/status$/.test(path)) return body({ total_count: 0 });
    if (/actions\/jobs\/1$/.test(path)) return body({ id: 1, run_id: 100, head_sha: head, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'cancelled', runner_name: '', steps: [] });
    if (/actions\/jobs\/2$/.test(path)) return body({ id: 2, run_id: 100, head_sha: head, run_attempt: 1, name: 'daemon-soak', status: 'completed', conclusion: 'cancelled', runner_name: '', steps: [] });
    if (/actions\/runs\/100$/.test(path)) return body({ id: 100, head_sha: head, run_attempt: 1, path: '.github/workflows/ci.yml', repository: { full_name: repo } });
    if (/\/logs$/.test(path)) throw new Error('gh: HTTP 404');
    throw new Error(`unexpected ${path}`);
  };

  it('never reads the (nonexistent) log of a cancelled job and returns rerunnable infra evidence', () => {
    const e = readTimeoutEvidence(pr, { repo, exec: mkExec() });
    expect(e).toMatchObject({ eligible: true, infraCancelled: true, repo, pr: 5, head });
    expect(e.jobs).toEqual([{ repo, head, run: 100, job: 1, attempt: 1 }]);
  });

  it('enrichment: rerun mode carries the cap, heal mode falls back to ci-heal', () => {
    const rollup = [{ name: 'test', conclusion: 'CANCELLED', detailsUrl: url(100, 1) }];
    const read = () => ({ eligible: true, infraCancelled: true, repo, pr: 5, head, signature: 's', jobs: [] });
    const rerun = enrichPrsWithTimeoutEvidence([{ ...pr, statusCheckRollup: rollup }], { repo, read, enabled: true, infraMode: 'rerun', infraMaxReruns: 4, readBudget: () => ({ confirmed: 0 }) });
    expect(rerun[0].timeoutRetry).toMatchObject({ eligible: true, infraCancelled: true, cap: 4 });
    const heal = enrichPrsWithTimeoutEvidence([{ ...pr, statusCheckRollup: rollup }], { repo, read, enabled: true, infraMode: 'heal', readBudget: () => ({ confirmed: 0 }) });
    expect(heal[0].timeoutRetry).toEqual({ eligible: false, reason: 'infra-cancelled-heal-mode' });
  });
});
