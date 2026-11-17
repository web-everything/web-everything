import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isInfraCancelledJob, isInfraStepTimeoutJob, isAggregateGateFailure, classifyInfraCancelled, isInfraCancelledOnlyRun, resolveInfraCancelledMode,
  authoritativeCheckRuns, isHungJob, hasCleanCancellationSteps, DEFAULT_INFRA_CANCELLED_MODE, DEFAULT_INFRA_CANCELLED_MAX_RERUNS,
} from '../infra-cancelled.mjs';
import { computeMainRedWindows, currentMainGreen } from '../main-red-recovery.mjs';
import { enrichPrsWithTimeoutEvidence, readTimeoutEvidence, defaultReadMainRuns } from '../reconcile-pass.mjs';

const cancelledJob = { name: 'daemon-soak', status: 'completed', conclusion: 'cancelled', runner_name: '', steps: [] };
const realFail = { name: 'test-shard (1)', status: 'completed', conclusion: 'failure', runner_name: 'GitHub Actions 1', steps: [{}] };

describe('hung job (ran to its own timeout) is NOT an infra cancellation', () => {
  const ran = (mins, extra = {}) => ({ name: 'soak-shard (1)', status: 'completed', conclusion: 'cancelled', runner_name: 'GitHub Actions 7',
    started_at: '2026-10-07T20:32:52Z', completed_at: new Date(Date.parse('2026-10-07T20:32:52Z') + mins * 60_000).toISOString(),
    steps: [{ name: 'Soak shard 1/4', conclusion: 'cancelled' }], ...extra });
  it('a cancelled job that held a runner for 15 min is hung, not infra-only', () => {
    expect(isInfraCancelledJob(ran(15))).toBe(false);
    expect(isHungJob(ran(15))).toBe(true);
    expect(isInfraCancelledOnlyRun([ran(15)])).toBe(false);
  });
  it('a short cancel, a no-runner cancel and a disabled knob stay infra', () => {
    expect(isInfraCancelledJob(ran(2))).toBe(true);
    expect(isInfraCancelledJob(ran(15, { runner_name: '' }))).toBe(true);
    expect(isInfraCancelledJob(ran(15), { hungMinutes: 0 })).toBe(true);
    expect(isInfraCancelledJob(ran(15), { hungMinutes: 30 })).toBe(true);
  });
  it.each(['failure', 'timed_out'])('an earlier %s before cancellation stays real', conclusion => {
    const job = ran(15, { steps: [{ name: 'Assertions', conclusion }, { name: 'Cleanup', conclusion: 'cancelled' }] });
    expect(hasCleanCancellationSteps(job)).toBe(false);
    expect(isInfraCancelledJob(job)).toBe(false);
    expect(isInfraCancelledOnlyRun([job])).toBe(false);
  });
  it('allows passing steps and only the last started step to be cancelled', () => {
    expect(hasCleanCancellationSteps({ steps: [
      { conclusion: 'success' }, { conclusion: 'neutral' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    ] })).toBe(true);
    expect(hasCleanCancellationSteps({ steps: [{ conclusion: 'cancelled' }, { conclusion: 'success' }] })).toBe(false);
    expect(hasCleanCancellationSteps({ steps: [{ conclusion: 'cancelled' }, { conclusion: 'cancelled' }] })).toBe(false);
    expect(hasCleanCancellationSteps({ steps: [{ conclusion: 'cancelled' }, { conclusion: 'skipped', started_at: '2026-11-17T10:01:00Z' }] })).toBe(false);
  });
  it('fails closed on unknown step evidence, retaining runner and duration requirements without a steps array', () => {
    expect(hasCleanCancellationSteps({ steps: [{}] })).toBe(false);
    expect(hasCleanCancellationSteps({ steps: [null] })).toBe(false);
    expect(hasCleanCancellationSteps(ran(15, { steps: undefined }))).toBe(true);
    expect(isHungJob(ran(15, { steps: undefined }))).toBe(true);
    expect(isHungJob(ran(15, { steps: undefined, runner_name: '' }))).toBe(false);
    expect(isHungJob(ran(15, { steps: undefined, completed_at: null }))).toBe(false);
  });
});

const infraStepJob = (name = 'Fetch main history (blobless)', duration = 180_000) => ({
  status: 'completed', conclusion: 'failure', runner_name: 'runner',
  steps: [{ name: 'Set up job', conclusion: 'success' },
    { name, conclusion: 'failure', started_at: '2026-11-17T10:00:00Z',
      completed_at: new Date(Date.parse('2026-11-17T10:00:00Z') + duration).toISOString() },
    { name: 'Run tests', status: 'completed', conclusion: 'skipped' }],
});

describe('infrastructure step timeout', () => {
  it.each(['Checkout', 'Run actions/checkout@v4', 'Check out repository', 'Fetch main history (blobless)',
    'Download artifact', 'Upload artifacts', 'actions/download-artifact@v4', 'actions/upload-artifact@v4',
    'Restore cache', 'Run actions/cache/restore@v4', 'actions/cache restore'])('recognizes a three-minute %s failure for PR retry only', name => {
    expect(isInfraStepTimeoutJob(infraStepJob(name))).toBe(true);
    expect(isInfraCancelledJob(infraStepJob(name))).toBe(false);
  });
  it.each(['Install + build FUI tools', 'Install dependencies', 'Setup Node', 'Set up Node', 'Build tools',
    'Cache dependencies', 'Run actions/setup-node@v4', 'actions/cache@v4', 'Fetch',
    'Checkout and run assertions', 'Checkout repository', 'Check out repository and build',
    'Fetch history and build', 'Fetch history run checks', 'Fetch test results', 'Fetch assert output',
    'Download artifact and run assertions', 'Upload artifact and test', 'Restore cache and build',
    'Run actions/checkout@v4 and run assertions'])('%s five-minute failure stays real', name => {
    const job = infraStepJob(name, 5 * 60_000);
    expect(isInfraStepTimeoutJob(job)).toBe(false);
    expect(isInfraCancelledJob(job)).toBe(false);
  });
  it('fast checkout failure remains real', () => {
    expect(isInfraStepTimeoutJob(infraStepJob('Checkout', 179_999))).toBe(false);
    expect(isInfraCancelledJob(infraStepJob('Checkout', 1000))).toBe(false);
  });
  it('fails closed on unknown timestamps, earlier failures, later executed or unknown steps and unfinished jobs', () => {
    const job = infraStepJob();
    for (const candidate of [
      { ...job, status: 'in_progress' },
      { ...job, steps: [job.steps[0], { ...job.steps[1], completed_at: null }] },
      { ...job, steps: [{ name: 'Tests', conclusion: 'failure' }, ...job.steps] },
      { ...job, steps: [...job.steps, { name: 'Tests', conclusion: 'success' }] },
      { ...job, steps: [...job.steps, {}] },
      infraStepJob('Run integration tests'),
    ]) expect(isInfraStepTimeoutJob(candidate)).toBe(false);
  });
});

describe('infra-cancelled classifier', () => {
  it('classifies cancelled / startup_failure / no-runner jobs as infra, real failures as not', () => {
    expect(isInfraCancelledJob(cancelledJob)).toBe(true);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'startup_failure' })).toBe(true);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'failure', runner_name: '', steps: [] })).toBe(true);
    expect(isInfraCancelledJob(realFail)).toBe(false);
    expect(isInfraCancelledJob({ status: 'completed', conclusion: 'success', steps: [] })).toBe(false);
    expect(isInfraCancelledJob({ status: 'in_progress', conclusion: null })).toBe(false);
  });

  it('infra-only dedupes by run; a real failure makes it mixed; only the aggregate gate failure is ignored', () => {
    const j = (run, job, infra, name = 'x', aggregateGate = false) => ({ run, job, attempt: 1, infra, name, aggregateGate });
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 11, true), j(2, 20, true)])).toEqual({
      kind: 'infra-only', runs: [{ run: 1, job: 10, attempt: 1 }, { run: 2, job: 20, attempt: 1 }] });
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 11, false)]).kind).toBe('mixed');
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 12, false, 'test', true)]).kind).toBe('infra-only');
    // A job merely NAMED `test` that is a real failure (not the aggregate gate step) is real evidence.
    expect(classifyInfraCancelled([j(1, 10, true), j(1, 12, false, 'test', false)]).kind).toBe('mixed');
    expect(classifyInfraCancelled([j(1, 11, false)]).kind).toBe('real');
    expect(classifyInfraCancelled([]).kind).toBe('none');
  });

  it('the aggregate gate failure is recognised structurally (its only failed step is the gate step), never by name alone', () => {
    const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
    const gateOnly = { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r',
      steps: [step('Set up job', 'success'), step('Gate on shard results', 'failure'), step('Run check:standards', 'skipped')] };
    const realLaterStep = { ...gateOnly, steps: [step('Set up job', 'success'), step('Gate on shard results', 'success'), step('Run check:standards', 'failure')] };
    const gateAndLater = { ...gateOnly, steps: [step('Gate on shard results', 'failure'), step('Run check:standards', 'failure')] };
    expect(isAggregateGateFailure(gateOnly)).toBe(true);
    expect(isAggregateGateFailure(realLaterStep)).toBe(false);
    expect(isAggregateGateFailure(gateAndLater)).toBe(false);
    expect(isAggregateGateFailure({ ...gateOnly, name: 'build' })).toBe(false);
    // `daemon-soak` is the other CI aggregate carrying the same gate step (over `soak-shard`).
    expect(isAggregateGateFailure({ ...gateOnly, name: 'daemon-soak' })).toBe(true);
    expect(isAggregateGateFailure({ ...realLaterStep, name: 'daemon-soak' })).toBe(false);
    expect(isAggregateGateFailure({ ...gateOnly, steps: [] })).toBe(false);
    expect(isAggregateGateFailure(undefined)).toBe(false);
  });

  it('a main run red only through cancelled shards + the aggregate gate failure is infra-only; a real `test` failure is not', () => {
    const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
    const agg = { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r', steps: [step('Gate on shard results', 'failure')] };
    const realTest = { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r',
      steps: [step('Gate on shard results', 'success'), step('Run check:standards', 'failure')] };
    expect(isInfraCancelledOnlyRun([cancelledJob, agg])).toBe(true);
    expect(isInfraCancelledOnlyRun([cancelledJob, realTest])).toBe(false);
    expect(isInfraCancelledOnlyRun([cancelledJob, realFail])).toBe(false);
    expect(isInfraCancelledOnlyRun([agg])).toBe(false);
  });

  // Scoped to this PR's own new template: XML forbids `--` inside a comment, so a plist carrying one is rejected by
  // plutil/launchctl and the watcher it installs never loads. (Older templates carry the same pattern; that is a
  // separate, pre-existing cleanup this repair deliberately does not fold in.)
  it('the ci-red-recovery-watch launchd template is XML-comment-safe: no `--` inside a comment', () => {
    // process.cwd() is the repo root under vitest — the same convention as the platformDefaults mirror test below.
    const file = resolve(process.cwd(), 'skills-src/conveyor/launchd/com.we.conveyor-pass-daemon.ci-red-recovery-watch-we.plist.example');
    const text = readFileSync(file, 'utf8');
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    expect(comments.length).toBeGreaterThan(0);
    for (const body of comments) expect({ bad: body.includes('--') || body.endsWith('-') }).toEqual({ bad: false });
    expect(text.replace(/<!--[\s\S]*?-->/g, '').includes('<!--')).toBe(false);
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
  it('a hung-test main run stays red after an earlier green run', () => {
    const at = '2026-11-17T10:15:00Z';
    const list = JSON.stringify([
      { databaseId: 7, conclusion: 'failure', status: 'completed', workflowName: 'CI', updatedAt: at },
      { databaseId: 6, conclusion: 'success', status: 'completed', workflowName: 'CI', updatedAt: '2026-11-17T09:00:00Z' },
    ]);
    const jobs = JSON.stringify({ total_count: 2, jobs: [
      { name: 'test-shard (1)', status: 'completed', conclusion: 'cancelled', runner_name: 'runner',
        started_at: '2026-11-17T10:00:00Z', completed_at: at,
        steps: [{ name: 'Run tests', conclusion: 'cancelled' }] },
      { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'runner',
        steps: [{ name: 'Gate on shard results', conclusion: 'failure' }] },
    ] });
    const runs = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? jobs : list) });
    expect(runs[0].infraCancelledOnly).toBeUndefined();
    expect(currentMainGreen(runs)).toEqual({ red: true, sha: null, at: null });
    expect(computeMainRedWindows(runs)).toEqual([{ start: at, end: null }]);
  });
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
    const agg = { name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'r', steps: [{ name: 'Gate on shard results', status: 'completed', conclusion: 'failure' }] };
    const jobs = JSON.stringify({ total_count: 2, jobs: [cancelledJob, agg] });
    const ok = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? jobs : list) });
    expect(ok[0].infraCancelledOnly).toBe(true);
    const bad = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => { if (argv[0] === 'api') throw new Error('x'); return list; } });
    expect(bad[0].infraCancelledOnly).toBeUndefined();
  });

  it('an incomplete job inventory (more jobs than the first page) keeps the run red — a real failure may sit on a later page', () => {
    const list = JSON.stringify([{ databaseId: 7, conclusion: 'failure', status: 'completed', workflowName: 'CI', updatedAt: 'x' }]);
    const page1 = Array.from({ length: 100 }, (_, i) => (i === 0 ? cancelledJob : { name: `ok-${i}`, status: 'completed', conclusion: 'success' }));
    const paged = JSON.stringify({ total_count: 150, jobs: page1 });
    const out = defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? paged : list) });
    expect(out[0].infraCancelledOnly).toBeUndefined();
    // No total_count at all is an unverifiable inventory: also left red (the safe direction).
    const noTotal = JSON.stringify({ jobs: [cancelledJob] });
    expect(defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? noTotal : list) })[0].infraCancelledOnly).toBeUndefined();
    // A complete inventory of exactly the page size is still trusted.
    const full = JSON.stringify({ total_count: 100, jobs: page1 });
    expect(defaultReadMainRuns({ repo: 'o/r', exec: (_c, argv) => (argv[0] === 'api' ? full : list) })[0].infraCancelledOnly).toBe(true);
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

  it.each(['job-timeout', 'step-timeout'])('%s is infra with cap one and never reads logs', timeoutKind => {
    const base = mkExec();
    const read = p => readTimeoutEvidence(p, { repo, exec: (cmd, args) => {
      const path = args[1];
      if (path.endsWith('/logs')) throw new Error('log read forbidden');
      if (path.endsWith('/actions/jobs/1')) {
        const job = JSON.parse(base(cmd, args));
        return JSON.stringify({ ...job, ...(timeoutKind === 'step-timeout' ? infraStepJob() : {
          name: 'integration', runner_name: 'runner', started_at: '2026-11-17T10:00:00Z', completed_at: '2026-11-17T10:10:00Z',
        }) });
      }
      return base(cmd, args);
    } });
    const [out] = enrichPrsWithTimeoutEvidence([{ ...pr, statusCheckRollup: [{ name: 'test', conclusion: 'failure', detailsUrl: url(100, 1) }] }],
      { repo, read, enabled: true, readBudget: () => ({ confirmed: 0, rejected: 0 }) });
    expect(out.timeoutRetry).toMatchObject({ eligible: true, infraCancelled: true, timeoutKind, cap: 1 });
  });

  it.each(['integration', 'test-shard (1)', 'soak-shard (1)'])('an earlier assertion failure then cancelled step in hung %s reads logs and stays real', name => {
    const base = mkExec();
    const logs = [];
    const e = readTimeoutEvidence(pr, { repo, exec: (cmd, args) => {
      const path = args[1];
      if (path.endsWith('/actions/jobs/1')) return JSON.stringify({ ...JSON.parse(base(cmd, args)),
        name, runner_name: 'runner', started_at: '2026-11-17T10:00:00Z', completed_at: '2026-11-17T10:15:00Z',
        steps: [{ name: 'Run assertions', conclusion: 'failure' }, { name: 'Cleanup', conclusion: 'cancelled' }],
      });
      if (path.endsWith('/actions/jobs/1/logs')) {
        logs.push(path);
        return 'FAIL scripts/x.test.mjs > assertion failure\n';
      }
      return base(cmd, args);
    } });
    expect(logs).toEqual([`repos/${repo}/actions/jobs/1/logs`]);
    expect(e).toEqual({ eligible: false, reason: 'mixed-infra-cancelled-and-real-failure' });
  });

  it('a hung job with passing earlier steps and a cancelled final step retries without logs', () => {
    const base = mkExec();
    const e = readTimeoutEvidence(pr, { repo, exec: (cmd, args) => {
      const path = args[1];
      if (path.endsWith('/logs')) throw new Error('log read forbidden');
      if (path.endsWith('/actions/jobs/1')) return JSON.stringify({ ...JSON.parse(base(cmd, args)),
        name: 'integration', runner_name: 'runner', started_at: '2026-11-17T10:00:00Z', completed_at: '2026-11-17T10:15:00Z',
        steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }],
      });
      return base(cmd, args);
    } });
    expect(e).toMatchObject({ eligible: true, infraCancelled: true, timeoutKind: 'job-timeout' });
  });

  // `test` is a real runner job here (cancelled `daemon-soak` sits beside it, so `test` is NOT dropped as a derived
  // aggregate of a failed test-shard). Whether it counts as the aggregate gate is decided by its failed step.
  const withTestJob = (steps) => {
    const base = mkExec();
    return (c, args) => {
      const path = args[1];
      if (/actions\/jobs\/1$/.test(path)) return JSON.stringify({ id: 1, run_id: 100, head_sha: head, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'GitHub Actions 1', steps });
      if (/actions\/jobs\/1\/logs$/.test(path)) return 'FAIL scripts/x.test.mjs > a real failure\n';
      return base(c, args);
    };
  };
  const step = (name, conclusion) => ({ name, status: 'completed', conclusion });

  it.each(['Install + build FUI tools', 'Checkout and run assertions'])('reconcile evidence keeps a five-minute %s failure real', name => {
    const e = readTimeoutEvidence(pr, { repo, exec: withTestJob(infraStepJob(name, 5 * 60_000).steps) });
    expect(e).toEqual({ eligible: false, reason: 'mixed-infra-cancelled-and-real-failure' });
  });

  it('a real failure in a job merely named `test` beside a cancelled job is NOT classed infra-only (no free mechanical re-runs)', () => {
    const e = readTimeoutEvidence(pr, { repo, exec: withTestJob([step('Gate on shard results', 'success'), step('Run check:standards', 'failure')]) });
    expect(e).toEqual({ eligible: false, reason: 'mixed-infra-cancelled-and-real-failure' });
  });

  it('the genuine aggregate gate failure beside a cancelled job is still infra-only', () => {
    const e = readTimeoutEvidence(pr, { repo, exec: withTestJob([step('Gate on shard results', 'failure'), step('Run check:standards', 'skipped')]) });
    expect(e).toMatchObject({ eligible: true, infraCancelled: true });
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


describe('authoritativeCheckRuns — newest check suite wins (#4651)', () => {
  it('prefers the newer cancelled suite even when the older success has a higher check-run id', () => {
    const cancelled = { name: 'soak-replay-gate', id: 11, check_suite: { id: 20 }, conclusion: 'cancelled' };
    const success = { name: 'soak-replay-gate', id: 12, check_suite: { id: 10 }, conclusion: 'success' };
    expect(authoritativeCheckRuns([success, cancelled])).toEqual([cancelled]);
    expect(authoritativeCheckRuns([cancelled, success])).toEqual([cancelled]);
  });

  it('breaks ties within the same suite by the highest check-run id', () => {
    const older = { name: 'test', id: 11, check_suite: { id: 20 } };
    const newer = { name: 'test', id: 12, check_suite: { id: 20 } };
    expect(authoritativeCheckRuns([older, newer])).toEqual([newer]);
    expect(authoritativeCheckRuns([newer, older])).toEqual([newer]);
  });

  it('returns exactly one authoritative row per distinct check name', () => {
    const test = { name: 'test', id: 12, check_suite: { id: 20 } };
    const soak = { name: 'soak-replay-gate', id: 11, check_suite: { id: 20 } };
    const rows = authoritativeCheckRuns([
      { ...test, id: 2, check_suite: { id: 10 } }, soak, test, { ...soak, id: 3, check_suite: { id: 10 } },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([test, soak]));
  });

  it('returns an empty array for non-array input', () => {
    for (const value of [undefined, null, {}, 'checks', 1, false]) {
      expect(authoritativeCheckRuns(value)).toEqual([]);
    }
  });
});
